/**
 * KiroAdapter — the one concrete AgentAdapter implementation.
 *
 * Spawn behavior is byte-identical to the previous inline `acpSpawner`
 * lambda in src/index.ts. The encapsulation is the refactor.
 *
 * installHooks writes (or merges) ~/.kiro/agents/agent-router.json
 * with PostToolUse and agentStop hook entries pointing at the daemon's
 * /hooks/event endpoint. uninstallHooks removes those entries.
 *
 * The implementation is tolerant of filesystem errors — any write failure
 * logs a warning and continues rather than throwing, so a hook installation
 * failure never breaks session creation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { ACPClient } from '../acp.js';
import type { AgentAdapter, AdapterCapabilities, SpawnOpts, InstallHooksOpts } from '../agent-adapter.js';
import type { Logger } from '../log.js';
import { spawnACPClient } from '../acp.js';

export interface KiroAdapterDeps {
  /** Absolute path to the kiro executable. */
  kiroPath: string;
  log: Logger;
  /**
   * Agent-only socket path forwarded to the child as AGENT_ROUTER_AGENT_SOCK
   * when `useWorkerUid` is true. May be overridden per-spawn via
   * `SpawnOpts.agentSocketPath`.
   */
  agentSocketPath?: string;
  /**
   * Override the spawn function. Tests use this to assert the spawn args
   * without actually launching a child process.
   */
  spawnImpl?: (kiroPath: string, args: string[], env: Record<string, string>) => ACPClient;
  /**
   * Override the home directory used for writing ~/.kiro/agents/agent-router.json.
   * Tests pass a tmpdir to avoid touching the real filesystem.
   */
  homeDir?: string;
}

/** Hook entry written/managed by this adapter in the agent-router.json hooks object. */
interface KiroHookEntry {
  name: string;
  match?: { toolName: string };
  command: string;
}

/** Shape of a Kiro agent definition file (minimal — only fields we read/write). */
interface KiroAgentConfig {
  hooks?: {
    postToolUse?: KiroHookEntry[];
    agentStop?: KiroHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Name prefix we use to identify our hook entries for read-modify-write. */
const HOOK_NAME_PREFIX = 'agent-router:';

/**
 * Build the two hook entries for a session.
 *
 * We embed the session ID in the name so uninstallHooks can identify and
 * remove only the entries belonging to a specific session (useful if
 * multiple sessions are stacked — unlikely but defensive).
 */
function buildHookEntries(
  sessionId: string,
  daemonUrl: string,
  daemonTokenPath: string,
): { postToolUse: KiroHookEntry; agentStop: KiroHookEntry } {
  // Use a shell one-liner: read the token from disk at fire time (not at
  // install time) so the hook survives daemon restarts that rotate the token.
  const authHeader = `"Authorization: Bearer $(cat ${daemonTokenPath})"`;
  const baseCmd = (eventType: string, toolName?: string) => {
    const body: Record<string, string> = {
      event_type: eventType,
      session_id: '$AGENT_ROUTER_SESSION_ID',
      agent_name: 'kiro',
    };
    if (toolName !== undefined) {
      body['tool_name'] = toolName;
    }
    // Produce a compact JSON object inline. Use single-quote shell escaping
    // for the outer curl arg, double-escape the inner JSON quotes.
    const jsonBody = JSON.stringify(body).replace(/"/g, '\\"');
    return (
      `curl -s -X POST ${daemonUrl}/hooks/event ` +
      `-H ${authHeader} ` +
      `-H 'Content-Type: application/json' ` +
      `-d "${jsonBody}" >/dev/null 2>&1 || true`
    );
  };

  return {
    postToolUse: {
      name: `${HOOK_NAME_PREFIX} fire verifySession on merge_pr [${sessionId}]`,
      match: { toolName: '@agent-router/merge_pr' },
      command: baseCmd('tool.post', 'merge_pr'),
    },
    agentStop: {
      name: `${HOOK_NAME_PREFIX} fire verifySession on turn end [${sessionId}]`,
      command: baseCmd('turn.end'),
    },
  };
}

/**
 * Atomically write `content` to `filePath` using a tmp-file-plus-rename so
 * partial writes are never visible. Returns `true` on success, `false` on error.
 */
function atomicWriteJson(filePath: string, content: unknown, log: Logger): boolean {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.agent-router-hooks-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2) + '\n', { encoding: 'utf-8' });
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('KiroAdapter.installHooks: failed to write agent config', { path: filePath, error: msg });
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    return false;
  }
}

/**
 * Read and parse the Kiro agent JSON file. Returns an empty object if the
 * file does not exist or cannot be parsed.
 */
function readAgentConfig(filePath: string): KiroAgentConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as KiroAgentConfig;
    }
    return {};
  } catch {
    return {};
  }
}

export function createKiroAdapter(deps: KiroAdapterDeps): AgentAdapter {
  const spawnFn = deps.spawnImpl ?? spawnACPClient;
  const homeDir = deps.homeDir ?? os.homedir();

  function agentConfigPath(): string {
    return path.join(homeDir, '.kiro', 'agents', 'agent-router.json');
  }

  function daemonTokenPath(): string {
    // The daemon writes daemon-token to ~/.agent-router/daemon-token by default.
    // Hook scripts read it at fire time; we embed the path in the command string.
    return path.join(homeDir, '.agent-router', 'daemon-token');
  }

  return {
    name: 'kiro',

    capabilities(): AdapterCapabilities {
      // Kiro could drive all four event types if hooks were installed.
      // The interface reports the *potential* capability — the verifier
      // doesn't care whether hooks are wired today or hand-installed later.
      return {
        events: ['session.start', 'tool.post', 'turn.end', 'session.end'],
        perToolMatching: true,
      };
    },

    spawn(opts: SpawnOpts): ACPClient {
      const baseEnv = { ...(opts.env ?? {}) };

      if (opts.useWorkerUid === true) {
        // Agent process isolation (FR-2.2): drop privileges to `agentworker`
        // via sudo, withhold GITHUB_TOKEN, and hand the child only the agent
        // socket + cap token + proxy env it needs. All existing buildChildEnv
        // fields (WORKDIR, etc.) are preserved.
        const { GITHUB_TOKEN: _dropped, ...rest } = baseEnv;
        void _dropped;
        const agentSocketPath = opts.agentSocketPath ?? deps.agentSocketPath ?? '';
        const env: Record<string, string> = {
          ...rest,
          AGENT_ROUTER_SESSION_ID: opts.sessionId,
          AGENT_ROUTER_AGENT_SOCK: agentSocketPath,
          AGENT_ROUTER_CAP_TOKEN: opts.capToken ?? '',
          HTTPS_PROXY: 'http://127.0.0.1:8080',
        };
        return spawnFn('/usr/bin/sudo', ['-u', 'agentworker', deps.kiroPath, 'acp'], env);
      }

      // Default (useWorkerUid: false): unchanged existing behavior.
      return spawnFn(deps.kiroPath, ['acp'], {
        ...baseEnv,
        AGENT_ROUTER_SESSION_ID: opts.sessionId,
      });
    },

    async installHooks(opts: InstallHooksOpts): Promise<void> {
      const configPath = agentConfigPath();
      const tokenPath = daemonTokenPath();

      const existing = readAgentConfig(configPath);
      const { postToolUse: ptuEntry, agentStop: asEntry } = buildHookEntries(
        opts.sessionId,
        opts.daemonUrl,
        tokenPath,
      );

      // Merge: preserve existing hook entries that are NOT managed by this
      // adapter for this session; then append our new entries.
      const existingHooks = existing.hooks ?? {};
      const existingPtu: KiroHookEntry[] = Array.isArray(existingHooks['postToolUse'])
        ? (existingHooks['postToolUse'] as KiroHookEntry[])
        : [];
      const existingAs: KiroHookEntry[] = Array.isArray(existingHooks['agentStop'])
        ? (existingHooks['agentStop'] as KiroHookEntry[])
        : [];

      // Remove any stale entries from a prior installHooks call for this
      // sessionId (idempotent re-install).
      const sessionMarker = `[${opts.sessionId}]`;
      const filteredPtu = existingPtu.filter((e) => !e.name.endsWith(sessionMarker));
      const filteredAs = existingAs.filter((e) => !e.name.endsWith(sessionMarker));

      const updated: KiroAgentConfig = {
        ...existing,
        hooks: {
          ...existingHooks,
          postToolUse: [...filteredPtu, ptuEntry],
          agentStop: [...filteredAs, asEntry],
        },
      };

      const ok = atomicWriteJson(configPath, updated, deps.log);
      if (ok) {
        deps.log.info('KiroAdapter.installHooks: hook entries written', {
          path: configPath,
          sessionId: opts.sessionId,
        });
      }
      // On failure, atomicWriteJson already logged a warn; we return without
      // throwing so session creation can proceed (ACP fallback remains active).
    },

    async uninstallHooks(opts?: { sessionId?: string }): Promise<void> {
      const configPath = agentConfigPath();
      let existing: KiroAgentConfig;
      try {
        existing = readAgentConfig(configPath);
      } catch {
        return; // File does not exist — nothing to uninstall
      }

      if (!existing.hooks) {
        return; // Nothing to remove
      }

      const sessionFilter = opts?.sessionId !== undefined
        ? `[${opts.sessionId}]`
        : undefined;

      const existingPtu: KiroHookEntry[] = Array.isArray(existing.hooks['postToolUse'])
        ? (existing.hooks['postToolUse'] as KiroHookEntry[])
        : [];
      const existingAs: KiroHookEntry[] = Array.isArray(existing.hooks['agentStop'])
        ? (existing.hooks['agentStop'] as KiroHookEntry[])
        : [];

      const shouldRemove = (entry: KiroHookEntry): boolean => {
        if (!entry.name.startsWith(HOOK_NAME_PREFIX)) return false;
        if (sessionFilter !== undefined) return entry.name.endsWith(sessionFilter);
        return true; // Remove ALL agent-router-managed entries when no sessionId
      };

      const filteredPtu = existingPtu.filter((e) => !shouldRemove(e));
      const filteredAs = existingAs.filter((e) => !shouldRemove(e));

      // Nothing changed — skip write.
      if (filteredPtu.length === existingPtu.length && filteredAs.length === existingAs.length) {
        return;
      }

      const updated: KiroAgentConfig = {
        ...existing,
        hooks: {
          ...existing.hooks,
          postToolUse: filteredPtu,
          agentStop: filteredAs,
        },
      };

      atomicWriteJson(configPath, updated, deps.log);
      deps.log.info('KiroAdapter.uninstallHooks: hook entries removed', {
        path: configPath,
        sessionId: opts?.sessionId,
      });
    },
  };
}

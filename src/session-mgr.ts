import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Database } from './db.js';
import type { Logger } from './log.js';
import type { SessionFiles, SessionPaths, PromptSource, StreamEntry, SessionMeta } from './session-files.js';
import type { EventQueue } from './queue.js';
import { createEventQueue } from './queue.js';
import type { ACPClient, ACPNotification, McpServerEntry } from './acp.js';
import type { SessionTimeoutConfig } from './config.js';
import { isCommentCommand, extractCommentIds } from './comment-tracker.js';
import type { GitHubClient } from './github.js';
import type { VerifySessionFn, VerifyResult } from './verify-session.js';
import type { TurnQueue } from './turn-queue.js';
import { createTurnQueue } from './turn-queue.js';
import type { WorktreeManager } from './worktree-manager.js';
import type { TokenStore } from './token-store.js';
import { isValidRepoString } from './token-store.js';
import type { Reaper } from './reaper.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// MCP server entry construction — pure helper for ACP session wiring
// ---------------------------------------------------------------------------

/**
 * Build the ACP MCP server entry for a session, or `undefined` when no daemon
 * socket is configured (graceful degradation — the session then runs without
 * the daemon's MCP tools, preserving pre-feature behavior).
 *
 * Pure — no I/O, no `process.env` reads. The `.ts`/`.js` and loader-URL
 * decisions live in `index.ts` (via `resolveMcpServerCommand`); this helper
 * only forwards whatever `command`/`commandArgs`/`serverPath` it is given and
 * assembles the `env` array. Callers pass any extra env variables to forward
 * (e.g. `GITHUB_API_BASE_URL`) via `extraEnv`.
 *
 * The entry's `env` is an ARRAY of `{ name, value }` pairs (the ACP stdio
 * shape), NOT a Record.
 */
export function buildMcpServerEntry(
  sessionId: string,
  daemonSocket: string | undefined,
  serverPath: string,
  command: string,
  commandArgs: string[],
  extraEnv?: Array<{ name: string; value: string }>,
): McpServerEntry | undefined {
  if (daemonSocket === undefined) return undefined;
  return {
    name: 'agent-router',
    command,
    args: [...commandArgs, serverPath],
    env: [
      { name: 'AGENT_ROUTER_SESSION_ID', value: sessionId },
      { name: 'AGENT_ROUTER_SOCKET', value: daemonSocket },
      ...(extraEnv ?? []),
    ],
  };
}

// ---------------------------------------------------------------------------
// read_repos parsing — pure functions for extracting read_repos from prompts
// ---------------------------------------------------------------------------

/** Result of parsing read_repos from a prompt's YAML frontmatter. */
export interface ReadReposParseResult {
  /** Valid read_repos entries (owner/repo format). Empty array if none found. */
  repos: string[];
  /** Invalid entries that failed validation (for diagnostics). */
  invalid: string[];
}

/**
 * Extract YAML frontmatter from the beginning of a prompt string.
 *
 * Frontmatter is delimited by `---` on the first line and a closing `---`
 * on a subsequent line. Returns the raw frontmatter content (without
 * delimiters), or undefined if no valid frontmatter is found.
 */
export function extractFrontmatter(prompt: string): string | undefined {
  // Frontmatter must start at the very beginning of the string
  if (!prompt.startsWith('---')) return undefined;

  // Find the closing delimiter. The opening `---` may have trailing whitespace
  // or a newline immediately after it.
  const firstNewline = prompt.indexOf('\n');
  if (firstNewline === -1) return undefined;

  // Check that the first line is only `---` (with optional trailing whitespace)
  const firstLine = prompt.slice(0, firstNewline).trim();
  if (firstLine !== '---') return undefined;

  // Find the closing `---` on its own line
  const rest = prompt.slice(firstNewline + 1);
  const lines = rest.split('\n');
  let closingIndex = -1;
  let charCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      closingIndex = i;
      break;
    }
    charCount += lines[i]!.length + 1; // +1 for the newline
  }

  if (closingIndex === -1) return undefined;

  // Return the content between the two `---` lines
  return lines.slice(0, closingIndex).join('\n');
}

/**
 * Parse `read_repos` from YAML frontmatter content.
 *
 * Supports the common YAML list format:
 * ```
 * read_repos:
 *   - owner/repo
 *   - owner/other-repo
 * ```
 *
 * Also supports inline flow syntax:
 * ```
 * read_repos: [owner/repo, owner/other-repo]
 * ```
 *
 * This is a minimal YAML subset parser — it does NOT handle the full YAML spec.
 * Only the `read_repos` key is extracted; other keys are ignored.
 */
export function parseReadReposFromFrontmatter(frontmatter: string): ReadReposParseResult {
  const lines = frontmatter.split('\n');
  const repos: string[] = [];
  const invalid: string[] = [];

  let inReadRepos = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Check for the `read_repos:` key
    if (/^read_repos\s*:/.test(line)) {
      inReadRepos = true;

      // Check for inline flow syntax: read_repos: [owner/repo, owner/other]
      const inlineMatch = line.match(/^read_repos\s*:\s*\[([^\]]*)\]\s*$/);
      if (inlineMatch !== null) {
        const items = inlineMatch[1]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        for (const item of items) {
          if (isValidRepoString(item)) {
            repos.push(item);
          } else {
            invalid.push(item);
          }
        }
        inReadRepos = false;
        continue;
      }

      // Check for a single value on the same line: read_repos: owner/repo
      const singleValue = line.replace(/^read_repos\s*:\s*/, '').trim();
      if (singleValue.length > 0 && !singleValue.startsWith('-') && !singleValue.startsWith('[')) {
        if (isValidRepoString(singleValue)) {
          repos.push(singleValue);
        } else {
          invalid.push(singleValue);
        }
        inReadRepos = false;
        continue;
      }

      continue;
    }

    // If we're inside the read_repos block, look for list items
    if (inReadRepos) {
      // A line that is not indented or is a new key ends the block
      if (line.trim().length === 0) continue; // blank lines are ok inside the block
      if (/^\S/.test(line)) {
        // New top-level key — end of read_repos block
        inReadRepos = false;
        continue;
      }

      // List item: `  - owner/repo`
      const itemMatch = line.match(/^\s+-\s+(.+)$/);
      if (itemMatch !== null) {
        const value = itemMatch[1]!.trim();
        if (isValidRepoString(value)) {
          repos.push(value);
        } else {
          invalid.push(value);
        }
      }
      // Non-list-item indented lines (e.g., comments) are ignored
    }
  }

  return { repos, invalid };
}

/**
 * Parse `read_repos` from a prompt string.
 *
 * Extracts YAML frontmatter (if present) and parses `read_repos` from it.
 * Returns an empty result if no frontmatter or no `read_repos` key is found.
 */
export function parseReadReposFromPrompt(prompt: string): ReadReposParseResult {
  const frontmatter = extractFrontmatter(prompt);
  if (frontmatter === undefined) {
    return { repos: [], invalid: [] };
  }
  return parseReadReposFromFrontmatter(frontmatter);
}

/**
 * Resolve the final `read_repos` list for a session.
 *
 * Priority:
 * 1. Explicit `readRepos` parameter (if provided and non-empty, used as-is)
 * 2. Parsed from prompt YAML frontmatter
 *
 * All entries are validated as `owner/repo` format. Invalid entries are
 * filtered out (logged by the caller).
 *
 * Returns the validated repos array and any invalid entries for diagnostic logging.
 */
export function resolveReadRepos(
  prompt: string,
  explicitReadRepos?: string[],
): ReadReposParseResult {
  // Explicit parameter takes priority
  if (explicitReadRepos !== undefined && explicitReadRepos.length > 0) {
    const repos: string[] = [];
    const invalid: string[] = [];
    for (const repo of explicitReadRepos) {
      if (isValidRepoString(repo)) {
        repos.push(repo);
      } else {
        invalid.push(repo);
      }
    }
    return { repos, invalid };
  }

  // Fall back to prompt frontmatter parsing
  return parseReadReposFromPrompt(prompt);
}

export interface SessionHandle {
  sessionId: string;
  repo?: string | undefined;
  paths: SessionPaths;
  acp: ACPClient;
  eventQueue: EventQueue;
  turnQueue: TurnQueue;
  kiroPid: number;
  /** Project name this session is bound to for write operations. */
  boundProject?: string | undefined;
  /** Repos in the bound project (write-authorized). */
  boundProjectRepos?: string[] | undefined;
}

/** Thrown by completeSession when one or more registered PRs are still open on GitHub. */
export class OpenPRsError extends Error {
  openPRs: Array<{ repo: string; pr_number: number }>;
  constructor(openPRs: Array<{ repo: string; pr_number: number }>) {
    super(
      `Cannot complete session: ${openPRs.length} registered PR(s) still open: ` +
        openPRs.map((p) => `${p.repo}#${p.pr_number}`).join(', '),
    );
    this.name = 'OpenPRsError';
    this.openPRs = openPRs;
  }
}

export interface MergePRResult {
  sha: string;
  message: string;
}

/**
 * Per-session mutable state: timers and flags that track in-flight lifecycle.
 * Consolidates what was previously 4 parallel Maps/Set into a single record
 * per session, reducing the risk of one cleanup path missing a map.
 */
export interface SessionState {
  /** Inactivity timer — reset on every agent notification. */
  inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  /** Absolute max-lifetime timer — hard cap regardless of activity. */
  lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Grace-period timer — set when auto-completion fires. */
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set when the complete_session MCP call is received. */
  completionFlag: boolean;
}

export interface SessionManager {
  createSession(originalPrompt: string, repo?: string, readRepos?: string[]): Promise<SessionHandle>;
  hasActiveSessionForRepo(repo: string): boolean;
  injectPrompt(sessionId: string, prompt: string, source: PromptSource): Promise<void>;
  registerPR(sessionId: string, repo: string, prNumber: number): Promise<void>;
  mergePR(sessionId: string, repo: string, prNumber: number): Promise<MergePRResult>;
  completeSession(sessionId: string, reason: string): Promise<void>;
  terminateSession(sessionId: string, reason?: 'terminated_cli' | 'terminated_web' | 'killed_by_operator', actor?: string): Promise<void>;
  getActiveSession(sessionId: string): SessionHandle | null;
  resumeSessions(): Promise<{ resumed: number; terminated: number }>;
  shutdown(): Promise<void>;

  // --- Agent process isolation (FR-4) ---
  /** Store the per-session capability token presented on the agent socket. */
  setCapToken(sessionId: string, token: string): void;
  /** Constant-time cap-token validation. Empty tokens are rejected. */
  validateCapToken(sessionId: string, token: string): boolean;
  /** The bound repo for a session, or undefined. */
  getSessionRepo(sessionId: string): string | undefined;
  /** The read-scoped repos for a session (never undefined — empty when none). */
  getSessionReadRepos(sessionId: string): string[];
  /** The recorded worktree path for a session, or undefined. */
  getWorktreePath(sessionId: string): string | undefined;
  /** Count of currently-active sessions launched under useWorkerUid (pkill guard). */
  getActiveWorkerSessionCount(): number;
}

/** Default session timeout configuration. */
const DEFAULT_SESSION_TIMEOUT: SessionTimeoutConfig = {
  inactivityMinutes: 5,
  maxLifetimeMinutes: 120,
  gracePeriodAfterMergeSeconds: 60,
};

/** Default deadline (ms) for the verify() call inside the inactivity watchdog. */
export const DEFAULT_VERIFY_DEADLINE_MS = 30_000;

// ---------------------------------------------------------------------------
// Agent process isolation — pure guards (FR-4.6 / FR-4.7)
// ---------------------------------------------------------------------------

/** Minimal shape of an active session for the concurrent-project guard. */
export interface ActiveSessionInfo {
  sessionId: string;
  repo?: string | undefined;
}

/**
 * Per-session agent-isolation parameters threaded from the session manager to
 * the acpSpawner lambda (which forwards them to the adapter's `spawn`).
 */
export interface IsolationSpawnInfo {
  useWorkerUid: boolean;
  capToken: string;
  agentSocketPath: string;
}

/**
 * Refuse concurrent sessions for a *different* project when `useWorkerUid` is
 * on (FR-4.6). All sessions share the `agentworker` uid, so one agent could
 * read another's cap token from `/proc`; cross-project concurrency is the
 * attack surface closed here. No-op when `useWorkerUid` is false or `newRepo`
 * is undefined. Throws (does not return) on conflict. The `force` flag on
 * CLI `new_session` must NOT bypass this check — it is enforced in
 * `createSession`, below the force check.
 */
export function checkConcurrentProjectConflict(
  newRepo: string | undefined,
  activeSessions: ActiveSessionInfo[],
  useWorkerUid: boolean,
): void {
  if (useWorkerUid !== true || newRepo === undefined) return;
  const lower = newRepo.toLowerCase();
  const conflict = activeSessions.find(
    (s) => s.repo !== undefined && s.repo.toLowerCase() !== lower,
  );
  if (conflict !== undefined) {
    throw new Error(
      `Cannot spawn concurrent sessions for different projects in useWorkerUid mode — stop ${conflict.sessionId} first`,
    );
  }
}

/**
 * The pkill guard decision (FR-4.7): reap stray `agentworker` processes only
 * when NO worker sessions remain active. FR-4.6 permits concurrent
 * same-project sessions, so a blanket uid kill while siblings run would
 * SIGKILL their kiro processes.
 */
export function shouldReapWorkerProcesses(remainingWorkerSessions: number): boolean {
  return remainingWorkerSessions <= 0;
}

// ---------------------------------------------------------------------------
// Session Registry — in-memory Map<sessionId, SessionHandle>
// ---------------------------------------------------------------------------

interface SessionRegistry {
  add(handle: SessionHandle): void;
  remove(sessionId: string): void;
  get(sessionId: string): SessionHandle | undefined;
  has(sessionId: string): boolean;
  list(): SessionHandle[];
}

function createSessionRegistry(): SessionRegistry {
  const sessions = new Map<string, SessionHandle>();

  return {
    add(handle: SessionHandle): void {
      sessions.set(handle.sessionId, handle);
    },
    remove(sessionId: string): void {
      sessions.delete(sessionId);
    },
    get(sessionId: string): SessionHandle | undefined {
      return sessions.get(sessionId);
    },
    has(sessionId: string): boolean {
      return sessions.has(sessionId);
    },
    list(): SessionHandle[] {
      return [...sessions.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// Notification → StreamEntry translation
// ---------------------------------------------------------------------------

function translateNotification(notification: ACPNotification): StreamEntry {
  const params = notification.params as Record<string, unknown> | undefined;
  const type = (params?.['type'] as string | undefined) ?? notification.method;

  const entry: StreamEntry = {
    ts: new Date().toISOString(),
    source: 'agent',
    type,
  };

  // Copy additional params fields into the entry
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (key !== 'type') {
        entry[key] = value;
      }
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// createSessionManager
// ---------------------------------------------------------------------------

export function createSessionManager(deps: {
  db: Database;
  sessionFiles: SessionFiles;
  acpSpawner: (sessionId: string, repo?: string, isolation?: IsolationSpawnInfo) => ACPClient;
  log: Logger;
  sessionTimeout?: SessionTimeoutConfig;
  /** Seconds to wait for busy sessions during shutdown (default 60). */
  shutdownDrainSeconds?: number;
  /**
   * GitHub client used by mergePR. Open-PR validation in completeSession
   * is delegated to `verify` when wired. Optional — when omitted, mergePR
   * throws.
   */
  github?: GitHubClient;
  /**
   * Verification fn that determines a session's true terminal state from
   * GitHub. When wired, completeSession defers to it instead of trusting
   * the agent-provided reason for PR-bearing sessions. Optional — when
   * omitted, completeSession falls back to writing the agent's reason
   * directly (preserves prior behavior for tests that don't exercise
   * verification).
   */
  verify?: VerifySessionFn;
  /** Best-effort callback fired after a session reaches terminal state. */
  onSessionEnd?: (sessionId: string) => void;
  /** Optional worktree manager for isolated per-session working directories. */
  worktreeManager?: WorktreeManager;
  /** Optional Token_Store for project-scoped credential resolution. */
  tokenStore?: TokenStore;
  /** Credential delivery mode. Default: 'env'. */
  credentialMode?: 'env' | 'mcp';
  /** Optional session reaper for automatic disk reclamation. */
  reaper?: Reaper;
  /** Milliseconds to wait for verify() before treating as timed-out (default 30_000). */
  verifyDeadlineMs?: number;
  /** Unix socket path the per-session MCP server uses to reach the daemon. */
  daemonSocket?: string;
  /**
   * Resolved command/args/path for launching the per-session MCP server.
   * When present together with `daemonSocket`, each session forwards an MCP
   * server entry via ACP `session/new` / `session/load`. When either is
   * absent, sessions run without MCP tools (pre-feature behavior).
   */
  mcpServerCommand?: { command: string; args: string[]; serverPath: string };
  /** Extra env variables to forward to the MCP server (e.g. GITHUB_API_BASE_URL). */
  extraEnv?: Array<{ name: string; value: string }>;
  /**
   * Agent process isolation (FR-4.6/FR-4.7). When true, createSession and
   * resumeSessions refuse concurrent cross-project sessions, and the last
   * worker session's cleanup reaps stray `agentworker` processes.
   */
  useWorkerUid?: boolean;
  /**
   * Agent-only socket path forwarded to the per-session MCP server env
   * (AGENT_ROUTER_AGENT_SOCK) and to the adapter when useWorkerUid is on.
   */
  agentSocketPath?: string;
}): SessionManager {
  const { db, sessionFiles, acpSpawner, log } = deps;
  const github = deps.github;
  const verify = deps.verify;
  const onSessionEnd = deps.onSessionEnd;
  const worktreeManager = deps.worktreeManager;
  const tokenStore = deps.tokenStore;
  const credentialMode = deps.credentialMode ?? 'env';
  const reaper = deps.reaper;
  const verifyDeadlineMs = deps.verifyDeadlineMs ?? DEFAULT_VERIFY_DEADLINE_MS;
  const daemonSocket = deps.daemonSocket;
  const mcpServerCommand = deps.mcpServerCommand;
  const extraEnv = deps.extraEnv;
  const useWorkerUid = deps.useWorkerUid ?? false;
  const agentSocketPath = deps.agentSocketPath;
  const timeout = deps.sessionTimeout ?? DEFAULT_SESSION_TIMEOUT;
  const shutdownDrainSeconds = deps.shutdownDrainSeconds ?? 60;
  const inactivityMs = timeout.inactivityMinutes * 60 * 1000;
  const maxLifetimeMs = timeout.maxLifetimeMinutes * 60 * 1000;
  const gracePeriodMs = timeout.gracePeriodAfterMergeSeconds * 1000;
  const registry = createSessionRegistry();

  // Log MCP wiring state once at construction (active vs degraded).
  const mcpWiringActive = daemonSocket !== undefined && mcpServerCommand !== undefined;
  log.info('MCP session wiring', {
    active: mcpWiringActive,
    reason: mcpWiringActive
      ? 'daemonSocket and mcpServerCommand present'
      : 'daemonSocket or mcpServerCommand absent — sessions run without MCP tools',
  });

  /**
   * Build the per-session MCP server entry wrapped in the ACP array form
   * (`[entry]`), or `undefined` when wiring is not configured. Threaded into
   * `acp.newSessionWithPrompt` and `acp.loadSession`.
   */
  function mcpServersForSession(sessionId: string, capToken: string): McpServerEntry[] | undefined {
    if (daemonSocket === undefined || mcpServerCommand === undefined) return undefined;
    // Thread the agent socket (shared) + per-session cap token into the MCP
    // server env so the per-session MCP relay can authenticate to the agent
    // socket (agent process isolation, FR-4.5).
    const isolationEnv: Array<{ name: string; value: string }> = [];
    if (agentSocketPath !== undefined) {
      isolationEnv.push({ name: 'AGENT_ROUTER_AGENT_SOCK', value: agentSocketPath });
    }
    if (capToken.length > 0) {
      isolationEnv.push({ name: 'AGENT_ROUTER_CAP_TOKEN', value: capToken });
    }
    const mergedExtraEnv = [...(extraEnv ?? []), ...isolationEnv];
    const entry = buildMcpServerEntry(
      sessionId,
      daemonSocket,
      mcpServerCommand.serverPath,
      mcpServerCommand.command,
      mcpServerCommand.args,
      mergedExtraEnv,
    );
    return entry ? [entry] : undefined;
  }

  // Per-session mutable state consolidated into a single Map.
  // Replaces the prior 4 parallel Maps/Set (inactivityTimers, lifetimeTimers,
  // graceTimers, completionFlags).
  const sessionStates = new Map<string, SessionState>();

  // --- Agent process isolation (FR-4) state ---
  // Per-session capability token for the agent socket.
  const capTokens = new Map<string, string>();
  // Session ids currently running under useWorkerUid (for the pkill guard).
  const workerSessions = new Set<string>();

  /**
   * Refuse concurrent sessions for a *different* project when useWorkerUid is
   * on (FR-4.6). Delegates to the exported pure guard against the live
   * registry. The `force` flag must not bypass this.
   */
  function guardConcurrentProjectConflict(newRepo: string | undefined): void {
    checkConcurrentProjectConflict(
      newRepo,
      registry.list().map((h) => ({ sessionId: h.sessionId, repo: h.repo })),
      useWorkerUid,
    );
  }

  /**
   * Reap stray `agentworker` processes after the LAST active worker session
   * ends (FR-4.7). The guard is load-bearing: FR-4.6 permits concurrent
   * same-project sessions, and a blanket uid kill would SIGKILL siblings.
   * Called only after the ending session has left the worker set.
   */
  function maybeReapWorkerProcesses(): void {
    if (useWorkerUid !== true) return;
    if (!shouldReapWorkerProcesses(workerSessions.size)) return; // siblings active — never kill
    execFileAsync('/usr/bin/sudo', ['-n', '/usr/bin/pkill', '-KILL', '-u', 'agentworker']).catch(
      () => {
        // non-zero exit is expected when there are no processes to kill
      },
    );
  }

  /**
   * Tear down per-session isolation state on any terminal transition: forget
   * the cap token, drop worker-session membership, then (if this was the last
   * worker session) reap stray `agentworker` processes. Idempotent.
   */
  function cleanupIsolationState(sessionId: string): void {
    capTokens.delete(sessionId);
    if (workerSessions.delete(sessionId)) {
      maybeReapWorkerProcesses();
    }
  }


  /** Get or create a SessionState entry for the given session. */
  function getOrCreateState(sessionId: string): SessionState {
    let state = sessionStates.get(sessionId);
    if (state === undefined) {
      state = {
        inactivityTimer: undefined,
        lifetimeTimer: undefined,
        graceTimer: undefined,
        completionFlag: false,
      };
      sessionStates.set(sessionId, state);
    }
    return state;
  }

  /** Clear pending wakes for all PRs registered to a session. */
  function clearPendingWakesForSession(sessionId: string): void {
    try {
      const meta = sessionFiles.readMeta(sessionId);
      for (const pr of meta.prs) {
        db.clearPendingWake(pr.repo, pr.pr_number);
      }
    } catch {
      // Best effort — meta may not be readable
    }
  }

  /** Remove the worktree for a session. Best-effort. */
  function removeSessionWorktree(sessionId: string): void {
    if (worktreeManager === undefined) return;
    try {
      const meta = sessionFiles.readMeta(sessionId);
      if (meta.repo !== undefined) {
        worktreeManager.removeWorktree(meta.repo, sessionId);
      }
    } catch {
      // Best effort — meta may not be readable
    }
  }

  /** Set terminal_at on a session's meta and notify the reaper. */
  function markTerminalAndNotifyReaper(sessionId: string): void {
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      sessionFiles.updateMeta(sessionId, { terminal_at: nowSec });
    } catch {
      // Best effort — meta may already have been updated or session might be terminal
    }
    reaper?.onSessionTerminal(sessionId);
    // Agent process isolation (FR-4.7): forget cap token, drop worker-session
    // membership, and reap stray agentworker processes if this was the last one.
    cleanupIsolationState(sessionId);
  }

  /** Clear all timers for a session. */
  function clearSessionTimers(sessionId: string): void {
    const state = sessionStates.get(sessionId);
    if (state === undefined) return;

    if (state.inactivityTimer !== undefined) {
      clearTimeout(state.inactivityTimer);
      state.inactivityTimer = undefined;
    }
    if (state.lifetimeTimer !== undefined) {
      clearTimeout(state.lifetimeTimer);
      state.lifetimeTimer = undefined;
    }
    if (state.graceTimer !== undefined) {
      clearTimeout(state.graceTimer);
      state.graceTimer = undefined;
    }
  }

  /** Reset the inactivity timer for a session (called on every notification). */
  function resetInactivityTimer(sessionId: string, acp: ACPClient): void {
    const state = getOrCreateState(sessionId);

    if (state.inactivityTimer !== undefined) {
      clearTimeout(state.inactivityTimer);
    }

    const timer = setTimeout(() => {
      state.inactivityTimer = undefined;
      if (!registry.has(sessionId)) return;

      // Run verification first. If the agent finished its work and just
      // went idle, the verifier may transition the session to
      // completed:merged instead of failed:timeout_inactivity.
      //
      // Wrap the async work in an IIFE — setTimeout callbacks can't be async
      // (return value is ignored, and we need clean error handling).
      void (async () => {
        let verifyResult: VerifyResult | null = null;
        if (verify !== undefined) {
          try {
            const deadline = new Promise<'verify_timeout'>((resolve) =>
              setTimeout(() => resolve('verify_timeout'), verifyDeadlineMs),
            );
            const raceResult = await Promise.race([
              verify(sessionId).then((r) => ({ kind: 'result' as const, value: r })),
              deadline,
            ]);
            if (raceResult === 'verify_timeout') {
              log.warn('Inactivity-watchdog verify timed out', { sessionId, deadlineMs: verifyDeadlineMs });
              // Treat as verify-failed — session proceeds to inactivity termination
            } else {
              verifyResult = raceResult.value;
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Inactivity-watchdog verify threw', { sessionId, error: msg });
            // Fall through with verifyResult=null → treat as no verifier
          }
        }

        // GitHub-outage protection: if verification couldn't talk to GitHub,
        // don't write a false timeout_inactivity — give the session another
        // inactivity window. The watchdog will fire again; if GitHub is back
        // up, verification will either find a terminal state or proceed to
        // the timeout-failed path naturally.
        if (verifyResult !== null && !verifyResult.verified && verifyResult.reason === 'github_error') {
          log.warn('Inactivity watchdog: GitHub error during verify, resetting watchdog', {
            sessionId,
            error: verifyResult.error,
          });
          const stillActiveHandle = registry.get(sessionId);
          if (stillActiveHandle !== undefined) {
            resetInactivityTimer(sessionId, stillActiveHandle.acp);
          }
          return;
        }

        // If verifier wrote a terminal state, do NOT also write timeout_inactivity.
        // Just proceed to kill the subprocess.
        const verifiedTerminal: 'merged' | 'closed_without_merge' | null =
          verifyResult !== null && verifyResult.verified ? verifyResult.termination_reason : null;

        log.warn('Session exceeded inactivity timeout, terminating', {
          sessionId,
          inactivityMinutes: timeout.inactivityMinutes,
          verified_as: verifiedTerminal ?? 'timeout',
        });

        if (verifiedTerminal === null) {
          try {
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'timeout_inactivity',
            });
          } catch {
            // Best effort
          }

          try {
            sessionFiles.updateMeta(sessionId, {
              status: 'failed',
              completed_at: Math.floor(Date.now() / 1000),
              termination_reason: 'timeout_inactivity',
            });
          } catch {
            // Meta may already be in terminal state
          }
        }

        // Remove from registry before kill to prevent monitorSubprocessExit from overwriting
        registry.remove(sessionId);
        clearSessionTimers(sessionId);
        clearPendingWakesForSession(sessionId);
        removeSessionWorktree(sessionId);
        sessionStates.delete(sessionId);

        markTerminalAndNotifyReaper(sessionId);
        onSessionEnd?.(sessionId);

        acp.kill().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Failed to kill inactivity-timed-out session', { sessionId, error: msg });
        });
      })();
    }, inactivityMs);

    state.inactivityTimer = timer;
  }

  /**
   * Start a background notification consumer for a session.
   * Iterates over acp.notifications, translates each to a StreamEntry,
   * and writes via sessionFiles.appendStream.
   */
  function startNotificationConsumer(sessionId: string, acp: ACPClient): void {
    const consume = async (): Promise<void> => {
      try {
        for await (const notification of acp.notifications) {
          // Reset inactivity timer on every notification from the agent
          resetInactivityTimer(sessionId, acp);

          const entry = translateNotification(notification);
          try {
            sessionFiles.appendStream(sessionId, entry);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Failed to append stream entry', { sessionId, error: msg });
          }

          // Check if this is a complete_session MCP call
          if (notification.method === 'session/notification') {
            const params = notification.params as Record<string, unknown> | undefined;
            if (params?.['type'] === 'mcp_call' && params?.['tool'] === 'complete_session') {
              getOrCreateState(sessionId).completionFlag = true;
            }

            // Track outbound comments from tool call results.
            // When the agent runs a shell command that produces a GitHub comment,
            // record the comment ID so the wake policy can filter self-authored webhooks.
            if (params?.['type'] === 'tool_result' || params?.['type'] === 'tool_call_update') {
              const command = params?.['command'] as string | undefined;
              const output = params?.['output'] as string | undefined
                ?? params?.['content'] as string | undefined
                ?? params?.['stdout'] as string | undefined;

              if (typeof command === 'string' && isCommentCommand(command) && typeof output === 'string') {
                const comments = extractCommentIds(output);
                for (const parsed of comments) {
                  try {
                    const repo = parsed.repo || '';
                    const prNumber = parsed.prNumber || 0;
                    db.insertOutboundComment(parsed.commentId, sessionId, repo, prNumber);
                    log.info('Tracked outbound comment', {
                      sessionId,
                      commentId: parsed.commentId,
                      repo,
                      prNumber,
                    });
                  } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    log.warn('Failed to track outbound comment', { sessionId, error: errMsg });
                  }
                }
              }
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Notification consumer error', { sessionId, error: msg });
      }
    };

    // Fire and forget — runs in background
    consume().catch(() => {});
  }

  /**
   * Monitor subprocess exit and update meta.json accordingly.
   */
  function monitorSubprocessExit(sessionId: string, acp: ACPClient): void {
    acp.sessionEnded
      .then(() => {
        // Clear all timers
        clearSessionTimers(sessionId);

        // Only update if session is still in registry (not already terminated)
        if (!registry.has(sessionId)) {
          return;
        }

        try {
          const meta = sessionFiles.readMeta(sessionId);
          if (meta.status !== 'active') {
            // Already in terminal state
            registry.remove(sessionId);
            return;
          }

          if (sessionStates.get(sessionId)?.completionFlag === true) {
            // Agent completed normally — emit session_ended BEFORE terminal meta
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'completed',
            });
            sessionFiles.updateMeta(sessionId, {
              status: 'completed',
              completed_at: Math.floor(Date.now() / 1000),
              termination_reason: 'completed',
            });
            log.info('Session completed', { sessionId });
          } else {
            // Subprocess exited without completion — emit session_ended BEFORE terminal meta
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'failed',
            });
            sessionFiles.updateMeta(sessionId, {
              status: 'failed',
              completed_at: Math.floor(Date.now() / 1000),
              termination_reason: 'failed',
            });
            log.warn('Session failed — subprocess exited without completion', { sessionId });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Failed to update meta on subprocess exit', { sessionId, error: msg });
        }

        sessionStates.delete(sessionId);
        clearPendingWakesForSession(sessionId);
        removeSessionWorktree(sessionId);
        registry.remove(sessionId);
        markTerminalAndNotifyReaper(sessionId);
        onSessionEnd?.(sessionId);
      })
      .catch(() => {});
  }

  /**
   * Set up an absolute max-lifetime timer for a session.
   * On expiry, SIGTERM → 5s → SIGKILL regardless of activity.
   */
  function enforceMaxLifetime(sessionId: string, acp: ACPClient): void {
    const state = getOrCreateState(sessionId);
    const timer = setTimeout(() => {
      state.lifetimeTimer = undefined;
      if (!registry.has(sessionId)) return;

      log.warn('Session exceeded max lifetime, terminating', {
        sessionId,
        maxLifetimeMinutes: timeout.maxLifetimeMinutes,
      });

      // Emit session_ended BEFORE writing terminal meta
      try {
        sessionFiles.appendStream(sessionId, {
          ts: new Date().toISOString(),
          source: 'router',
          type: 'session_ended',
          reason: 'timeout_max_lifetime',
        });
      } catch {
        // Best effort
      }

      try {
        sessionFiles.updateMeta(sessionId, {
          status: 'failed',
          completed_at: Math.floor(Date.now() / 1000),
          termination_reason: 'timeout_max_lifetime',
        });
      } catch {
        // Meta may already be in terminal state
      }

      // Remove from registry before kill to prevent monitorSubprocessExit from overwriting
      registry.remove(sessionId);
      clearSessionTimers(sessionId);
      clearPendingWakesForSession(sessionId);
      removeSessionWorktree(sessionId);
      sessionStates.delete(sessionId);

      markTerminalAndNotifyReaper(sessionId);
      onSessionEnd?.(sessionId);

      acp.kill().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to kill max-lifetime session', { sessionId, error: msg });
      });
    }, maxLifetimeMs);

    state.lifetimeTimer = timer;
  }

  const manager: SessionManager = {
    async createSession(originalPrompt: string, repo?: string, readRepos?: string[]): Promise<SessionHandle> {
      // Agent process isolation (FR-4.6): refuse concurrent cross-project
      // sessions when useWorkerUid is on. The `force` flag does NOT bypass this.
      guardConcurrentProjectConflict(repo);

      const sessionId = crypto.randomUUID();
      const sessionLog = log.child({ sessionId });

      // 0. Resolve Bound_Project from Token_Store when available
      let boundProject: string | undefined;
      let boundProjectRepos: string[] | undefined;
      if (tokenStore !== undefined && repo !== undefined) {
        const projectName = tokenStore.findProjectByRepo(repo);
        if (projectName === undefined) {
          throw new Error(
            `Cannot create session: repo "${repo}" is not present in any project in the Token_Store`
          );
        }
        const project = tokenStore.getProject(projectName);
        if (project === undefined) {
          throw new Error(
            `Cannot create session: project "${projectName}" not found in Token_Store`
          );
        }
        boundProject = projectName;
        boundProjectRepos = [...project.repos];
        sessionLog.info('Bound_Project resolved', {
          project: projectName,
          repos: boundProjectRepos,
          credentialMode,
        });
      }

      // 0b. Resolve read_repos from explicit parameter or prompt frontmatter
      const readReposResult = resolveReadRepos(originalPrompt, readRepos);
      const boundProjectReadRepos = readReposResult.repos.length > 0
        ? readReposResult.repos
        : undefined;

      if (readReposResult.invalid.length > 0) {
        sessionLog.warn('Invalid read_repos entries ignored', {
          invalid: readReposResult.invalid,
        });
      }
      if (boundProjectReadRepos !== undefined) {
        sessionLog.info('read_repos resolved', { read_repos: boundProjectReadRepos });
      }

      // 1. Create session files on disk
      const paths = sessionFiles.createSession(sessionId, originalPrompt);
      if (repo !== undefined) {
        sessionFiles.updateMeta(sessionId, { repo });
      }

      // Write credential metadata to session
      if (boundProject !== undefined && boundProjectRepos !== undefined) {
        const credMeta: Partial<SessionMeta> = {
          bound_project: boundProject,
          bound_project_repos: boundProjectRepos,
          credential_mode: credentialMode,
        };
        if (boundProjectReadRepos !== undefined) {
          credMeta.bound_project_read_repos = boundProjectReadRepos;
        }
        sessionFiles.updateMeta(sessionId, credMeta);
      } else if (boundProjectReadRepos !== undefined) {
        // read_repos can be set even without a bound project (standalone sessions)
        sessionFiles.updateMeta(sessionId, {
          bound_project_read_repos: boundProjectReadRepos,
        });
      }
      sessionLog.info('Session files created');

      // 2. Spawn ACP client. Pass the bound repo so the spawner can inject the
      //    repo-specific GitHub token as GITHUB_TOKEN into the child env.
      //    Always generate a per-session capability token for the agent socket
      //    (available in both modes; agent process isolation FR-4.4/FR-4.5).
      const capToken = crypto.randomUUID().replace(/-/g, '');
      capTokens.set(sessionId, capToken);
      const acp = acpSpawner(sessionId, repo, {
        useWorkerUid,
        capToken,
        agentSocketPath: agentSocketPath ?? '',
      });

      // 3. Initialize ACP handshake
      await acp.initialize();
      sessionLog.info('ACP initialized');

      // 4. Create ACP session and send initial prompt immediately
      //    Kiro exits if no prompt arrives shortly after session/new,
      //    so we pipeline both requests to prevent a gap.
      const acpSessionId = await acp.newSessionWithPrompt(
        process.cwd(),
        originalPrompt,
        mcpServersForSession(sessionId, capToken),
      );
      sessionLog.info('ACP session created with prompt', { acpSessionId });

      // Persist kiro_session_id for session resumption across daemon restarts
      sessionFiles.updateMeta(sessionId, { kiro_session_id: acpSessionId });

      // 6. Create per-session event queue + worker
      const eventQueue = createEventQueue();

      // 6b. Create per-session turn queue for serialized prompt delivery
      const turnQueue = createTurnQueue(acp, sessionFiles, sessionId, log);

      // 5. Build handle
      const handle: SessionHandle = {
        sessionId,
        repo,
        paths,
        acp,
        eventQueue,
        turnQueue,
        kiroPid: 0, // Will be set if available; subprocess PID is internal to ACPClient
        boundProject,
        boundProjectRepos,
      };

      // 6. Insert into registry
      registry.add(handle);

      // Track worker sessions for the pkill guard (FR-4.7).
      if (useWorkerUid) {
        workerSessions.add(sessionId);
      }

      // 7. Append session_started stream entry
      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'session_started',
        original_prompt: originalPrompt,
      });

      // 7b. Record initial prompt
      sessionFiles.appendPrompt(sessionId, 'cli', originalPrompt);
      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'prompt_injected',
        prompt_source: 'cli',
      });

      // 8. Start background notification consumer
      startNotificationConsumer(sessionId, acp);

      // 9. Monitor subprocess exit for completion/failure detection
      monitorSubprocessExit(sessionId, acp);

      // 10. Start inactivity timer and max-lifetime timer
      resetInactivityTimer(sessionId, acp);
      enforceMaxLifetime(sessionId, acp);

      sessionLog.info('Session created');
      return handle;
    },

    async injectPrompt(sessionId: string, prompt: string, source: PromptSource): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Delegate to the per-session turn queue for serialized delivery
      await handle.turnQueue.enqueue(prompt, source);

      log.info('Prompt injected', { sessionId, source });

      // ACP-fallback fast trigger: fire verification now that the agent
      // has finished processing the prompt. Fire-and-forget — single-flight
      // in the verifier handles dedup against any concurrent hook-path call
      // or complete_session MCP call.
      if (verify !== undefined) {
        void verify(sessionId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Post-sendPrompt verify failed', { sessionId, error: msg });
        });
      }
    },

    async registerPR(sessionId: string, repo: string, prNumber: number): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Upsert session-PR mapping in DB (re-registration from a new session wins)
      db.insertSession(repo, prNumber, sessionId);

      // Read current meta and append PR entry
      const meta = sessionFiles.readMeta(sessionId);
      const existingPR = meta.prs.find(
        (pr) => pr.repo === repo && pr.pr_number === prNumber,
      );

      if (existingPR === undefined) {
        const updatedPRs = [
          ...meta.prs,
          { repo, pr_number: prNumber, registered_at: Math.floor(Date.now() / 1000) },
        ];
        sessionFiles.updateMeta(sessionId, { prs: updatedPRs });
      }

      // Append pr_registered stream entry
      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'pr_registered',
        repo,
        pr_number: prNumber,
      });

      log.info('PR registered', { sessionId, repo, prNumber });
    },

    async mergePR(sessionId: string, repo: string, prNumber: number): Promise<MergePRResult> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }
      if (github === undefined) {
        throw new Error('GitHub client not configured; cannot merge PR');
      }

      // Security: refuse to merge a PR that wasn't registered with this session.
      const meta = sessionFiles.readMeta(sessionId);
      const registered = meta.prs.some((pr) => pr.repo === repo && pr.pr_number === prNumber);
      if (!registered) {
        throw new Error(
          `PR ${repo}#${prNumber} is not registered with session ${sessionId}; ` +
            `call register_pr first`,
        );
      }

      const slash = repo.indexOf('/');
      if (slash < 1 || slash === repo.length - 1) {
        throw new Error(`Invalid repo "${repo}": expected "owner/name"`);
      }
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);

      const result = await github.mergePullRequest(owner, name, prNumber);

      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'pr_merged',
        repo,
        pr_number: prNumber,
        sha: result.sha,
      });

      log.info('PR merged', { sessionId, repo, prNumber, sha: result.sha });

      return { sha: result.sha, message: result.message };
    },

    async completeSession(sessionId: string, reason: string): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Delegate terminal-state authority to the centralized verifier when
      // wired. The verifier queries GitHub for each registered PR and writes
      // termination_reason from real state — never from the agent's reason
      // argument. This is the structural fix for the bug class where an
      // agent could claim merge while a PR remained open.
      //
      // When no verifier is wired (tests without a GitHub client) or when
      // the verifier reports no_prs/already_verified, fall through to write
      // the agent's reason directly — that's the only signal we have.
      let verifierWroteTerminal = false;
      if (verify !== undefined) {
        const result = await verify(sessionId);
        if (result.verified) {
          verifierWroteTerminal = true;
        } else if (result.reason === 'prs_still_open') {
          throw new OpenPRsError(result.open_prs);
        } else if (result.reason === 'github_error') {
          throw new Error(`GitHub verification failed: ${result.error}`);
        }
        // no_prs / already_verified / unknown_session → fall through
      }

      // Mark completion so monitorSubprocessExit knows this was intentional
      getOrCreateState(sessionId).completionFlag = true;

      // Clear pending wakes for this session's PRs
      clearPendingWakesForSession(sessionId);

      // Append session_ended stream entry BEFORE writing terminal meta
      try {
        sessionFiles.appendStream(sessionId, {
          ts: new Date().toISOString(),
          source: 'router',
          type: 'session_ended',
          reason,
        });
      } catch {
        // Best effort
      }

      // Write terminal state from the agent's reason only if the verifier
      // didn't already write one.
      if (!verifierWroteTerminal) {
        try {
          const terminationReason = reason as NonNullable<SessionMeta['termination_reason']>;
          sessionFiles.updateMeta(sessionId, {
            status: 'completed',
            completed_at: Math.floor(Date.now() / 1000),
            termination_reason: terminationReason,
          });
        } catch {
          // Meta may already be in terminal state
        }
      }

      markTerminalAndNotifyReaper(sessionId);
      onSessionEnd?.(sessionId);

      // Suppress inactivity timer — replace with grace period timer
      const state = getOrCreateState(sessionId);
      if (state.inactivityTimer !== undefined) {
        clearTimeout(state.inactivityTimer);
        state.inactivityTimer = undefined;
      }

      log.info('Session auto-completed, starting grace period', {
        sessionId,
        reason,
        gracePeriodSeconds: timeout.gracePeriodAfterMergeSeconds,
      });

      // Start grace period timer — after it expires, kill the subprocess cleanly
      const graceTimer = setTimeout(() => {
        state.graceTimer = undefined;
        if (!registry.has(sessionId)) return;

        log.info('Grace period expired, terminating session', { sessionId });

        // Remove from registry before kill to prevent monitorSubprocessExit from overwriting
        registry.remove(sessionId);
        clearSessionTimers(sessionId);
        removeSessionWorktree(sessionId);
        sessionStates.delete(sessionId);

        handle.acp.kill().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Failed to kill session after grace period', { sessionId, error: msg });
        });
      }, gracePeriodMs);

      state.graceTimer = graceTimer;
    },

    async terminateSession(sessionId: string, reason: 'terminated_cli' | 'terminated_web' | 'killed_by_operator' = 'terminated_cli', actor: string = 'local'): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Clear all timers
      clearSessionTimers(sessionId);

      // Clear pending wakes for this session's PRs
      clearPendingWakesForSession(sessionId);

      // Clean up worktree
      removeSessionWorktree(sessionId);

      // Remove from registry first to prevent monitorSubprocessExit from double-updating
      registry.remove(sessionId);
      sessionStates.delete(sessionId);

      // Kill the subprocess: SIGTERM → 5s → SIGKILL
      await handle.acp.kill();

      // Append session_ended stream entry BEFORE writing terminal meta
      try {
        sessionFiles.appendStream(sessionId, {
          ts: new Date().toISOString(),
          source: 'router',
          type: 'session_ended',
          reason,
          actor,
        });
      } catch {
        // Best effort
      }

      // Update meta.json to abandoned
      try {
        sessionFiles.updateMeta(sessionId, {
          status: 'abandoned',
          completed_at: Math.floor(Date.now() / 1000),
          termination_reason: reason,
        });
      } catch {
        // Meta may already be in terminal state if subprocess exited concurrently
      }

      // Shutdown the per-session event queue
      await handle.eventQueue.shutdown(5);

      markTerminalAndNotifyReaper(sessionId);
      onSessionEnd?.(sessionId);

      log.info('Session terminated', { sessionId, reason, actor });
    },

    getActiveSession(sessionId: string): SessionHandle | null {
      return registry.get(sessionId) ?? null;
    },

    // --- Agent process isolation (FR-4) ---

    setCapToken(sessionId: string, token: string): void {
      capTokens.set(sessionId, token);
    },

    validateCapToken(sessionId: string, token: string): boolean {
      const stored = capTokens.get(sessionId);
      if (stored === undefined || stored.length === 0) return false;
      if (typeof token !== 'string' || token.length === 0) return false;
      const a = Buffer.from(stored);
      const b = Buffer.from(token);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    },

    getSessionRepo(sessionId: string): string | undefined {
      const handle = registry.get(sessionId);
      if (handle !== undefined) return handle.repo ?? undefined;
      // Fall back to on-disk meta for sessions not in the live registry.
      try {
        return sessionFiles.readMeta(sessionId).repo ?? undefined;
      } catch {
        return undefined;
      }
    },

    getSessionReadRepos(sessionId: string): string[] {
      try {
        return sessionFiles.readMeta(sessionId).bound_project_read_repos ?? [];
      } catch {
        return [];
      }
    },

    getWorktreePath(sessionId: string): string | undefined {
      try {
        return sessionFiles.readMeta(sessionId).worktree_path ?? undefined;
      } catch {
        return undefined;
      }
    },

    getActiveWorkerSessionCount(): number {
      return workerSessions.size;
    },

    hasActiveSessionForRepo(repo: string): boolean {
      return registry.list().some((h) => h.repo === repo);
    },

    async resumeSessions(): Promise<{ resumed: number; terminated: number }> {
      const allSessions = sessionFiles.listSessions();
      const activeSessions = allSessions.filter((s) => s.status === 'active');
      let resumed = 0;
      let terminated = 0;

      for (const meta of activeSessions) {
        const sessionId = meta.session_id;
        const kiroSessionId = meta.kiro_session_id;

        if (kiroSessionId === undefined || kiroSessionId === '') {
          // No kiro_session_id — cannot resume, mark terminated
          log.warn('Cannot resume session: no kiro_session_id', { sessionId });
          try {
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'terminated_by_restart',
            });
            sessionFiles.updateMeta(sessionId, {
              status: 'abandoned',
              completed_at: Math.floor(Date.now() / 1000),
              termination_reason: 'terminated_by_restart',
            });
            markTerminalAndNotifyReaper(sessionId);
          } catch {
            // Best effort
          }
          terminated++;
          continue;
        }

        // Attempt to resume via session/load
        try {
          // FR-4.6: refuse to resume into a cross-project concurrent session.
          guardConcurrentProjectConflict(meta.repo);
          const capToken = crypto.randomUUID().replace(/-/g, '');
          capTokens.set(sessionId, capToken);
          const acp = acpSpawner(sessionId, meta.repo, {
            useWorkerUid,
            capToken,
            agentSocketPath: agentSocketPath ?? '',
          });
          await acp.initialize();
          await acp.loadSession(kiroSessionId, mcpServersForSession(sessionId, capToken));

          // Rebuild session handle
          const paths = sessionFiles.getSessionPaths(sessionId);

          const eventQueue = createEventQueue();
          const turnQueue = createTurnQueue(acp, sessionFiles, sessionId, log);

          const handle: SessionHandle = {
            sessionId,
            repo: meta.repo,
            paths,
            acp,
            eventQueue,
            turnQueue,
            kiroPid: 0,
            boundProject: meta.bound_project,
            boundProjectRepos: meta.bound_project_repos,
          };

          registry.add(handle);
          if (useWorkerUid) {
            workerSessions.add(sessionId);
          }
          startNotificationConsumer(sessionId, acp);
          monitorSubprocessExit(sessionId, acp);
          resetInactivityTimer(sessionId, acp);
          enforceMaxLifetime(sessionId, acp);

          log.info('Session resumed after restart', { sessionId, kiroSessionId });
          resumed++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('Failed to resume session, marking terminated_by_restart', { sessionId, error: msg });
          try {
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'terminated_by_restart',
            });
            sessionFiles.updateMeta(sessionId, {
              status: 'abandoned',
              completed_at: Math.floor(Date.now() / 1000),
              termination_reason: 'terminated_by_restart',
            });
            markTerminalAndNotifyReaper(sessionId);
          } catch {
            // Best effort
          }
          terminated++;
        }
      }

      return { resumed, terminated };
    },

    async shutdown(): Promise<void> {
      const activeSessions = registry.list();
      log.info('Shutting down session manager', { activeCount: activeSessions.length });

      // Shut down the reaper first (cancel pending timers, stop sweep)
      reaper?.shutdown();

      // Clear all timers
      for (const [, state] of sessionStates) {
        if (state.inactivityTimer !== undefined) clearTimeout(state.inactivityTimer);
        if (state.lifetimeTimer !== undefined) clearTimeout(state.lifetimeTimer);
        if (state.graceTimer !== undefined) clearTimeout(state.graceTimer);
      }
      sessionStates.clear();

      if (activeSessions.length === 0) {
        log.info('Session manager shutdown complete');
        return;
      }

      // Separate idle-active from busy sessions
      const idle: SessionHandle[] = [];
      const busy: SessionHandle[] = [];
      for (const handle of activeSessions) {
        if (handle.turnQueue.busy() || handle.turnQueue.pending() > 0) {
          busy.push(handle);
        } else {
          idle.push(handle);
        }
      }

      log.info('Shutdown: session classification', {
        idle: idle.length,
        busy: busy.length,
      });

      // Terminate idle sessions immediately
      const idlePromises: Promise<void>[] = [];
      for (const handle of idle) {
        const { sessionId } = handle;
        registry.remove(sessionId);
        sessionStates.delete(sessionId);
        cleanupIsolationState(sessionId);
        removeSessionWorktree(sessionId);

        // Emit session_ended BEFORE writing terminal meta
        try {
          sessionFiles.appendStream(sessionId, {
            ts: new Date().toISOString(),
            source: 'router',
            type: 'session_ended',
            reason: 'shutdown',
          });
        } catch {
          // Best effort
        }

        try {
          sessionFiles.updateMeta(sessionId, {
            status: 'abandoned',
            completed_at: Math.floor(Date.now() / 1000),
            termination_reason: 'shutdown',
          });
        } catch {
          // Meta may already be in terminal state
        }

        idlePromises.push(
          handle.acp.kill().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Failed to kill idle session during shutdown', { sessionId, error: msg });
          }),
        );
        idlePromises.push(handle.eventQueue.shutdown(5).catch(() => {}));
      }
      await Promise.all(idlePromises);

      if (busy.length === 0) {
        log.info('Session manager shutdown complete');
        return;
      }

      // Wait up to shutdownDrainSeconds for busy sessions to finish their current turn
      log.info('Waiting for busy sessions to drain', {
        count: busy.length,
        budgetSeconds: shutdownDrainSeconds,
      });

      const drainDeadline = Date.now() + shutdownDrainSeconds * 1000;

      // Drain each busy session's turn queue (rejects pending, waits for in-flight)
      const drainPromises = busy.map((handle) =>
        handle.turnQueue.drain().catch(() => {}),
      );

      const budgetTimeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), shutdownDrainSeconds * 1000),
      );

      const drainResult = await Promise.race([
        Promise.all(drainPromises).then(() => 'drained' as const),
        budgetTimeout,
      ]);

      if (drainResult === 'drained') {
        log.info('All busy sessions drained within budget');
      } else {
        const remaining = busy.filter((h) => h.turnQueue.busy());
        log.warn('Drain budget expired, force-killing remaining sessions', {
          remainingCount: remaining.length,
        });
      }

      // Terminate all busy sessions (either they drained or budget expired)
      const busyPromises: Promise<void>[] = [];
      for (const handle of busy) {
        const { sessionId } = handle;
        registry.remove(sessionId);
        sessionStates.delete(sessionId);
        cleanupIsolationState(sessionId);
        removeSessionWorktree(sessionId);

        // Check if the session already reached terminal state during drain
        try {
          const meta = sessionFiles.readMeta(sessionId);
          if (meta.status !== 'active') {
            // Already terminal — subprocess may have exited during drain
            busyPromises.push(handle.acp.kill().catch(() => {}));
            busyPromises.push(handle.eventQueue.shutdown(5).catch(() => {}));
            continue;
          }
        } catch {
          // Can't read meta — proceed with termination anyway
        }

        // Emit session_ended BEFORE writing terminal meta
        try {
          sessionFiles.appendStream(sessionId, {
            ts: new Date().toISOString(),
            source: 'router',
            type: 'session_ended',
            reason: 'shutdown',
          });
        } catch {
          // Best effort
        }

        try {
          sessionFiles.updateMeta(sessionId, {
            status: 'abandoned',
            completed_at: Math.floor(Date.now() / 1000),
            termination_reason: 'shutdown',
          });
        } catch {
          // Meta may already be in terminal state
        }

        busyPromises.push(
          handle.acp.kill().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Failed to kill busy session during shutdown', { sessionId, error: msg });
          }),
        );
        busyPromises.push(handle.eventQueue.shutdown(5).catch(() => {}));
      }

      await Promise.all(busyPromises);
      log.info('Session manager shutdown complete');
    },
  };

  return manager;
}

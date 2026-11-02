/**
 * Tier 2 tests: KiroAdapter.installHooks integration with session-mgr.
 *
 * Verifies that:
 * 1. createSession calls installHooksForSession after the session is created.
 * 2. installHooksForSession failure (Promise.reject) does NOT prevent session creation.
 * 3. The hook file written by KiroAdapter.installHooks is structurally correct.
 * 4. The hook commands reference the correct daemon URL.
 *
 * Uses the real KiroAdapter (with spawnImpl overridden to use FakeKiroBackend)
 * to exercise the actual file-writing path, not a stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { createKiroAdapter } from '../../src/adapters/kiro.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

interface HookEntry {
  name: string;
  match?: { toolName: string };
  command: string;
}

interface AgentConfig {
  hooks?: {
    postToolUse?: HookEntry[];
    agentStop?: HookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hooks-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
});

afterEach(async () => {
  if (mgr) await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installHooksForSession integration (Tier 2)', () => {
  it('calls installHooksForSession after session creation', async () => {
    const installCalls: string[] = [];

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string) => {
        const cfg = kiro.spawnConfig();
        return spawnACPClient(cfg.command, cfg.args, {
          ...cfg.env,
          AGENT_ROUTER_SESSION_ID: sessionId,
        });
      },
      log,
      installHooksForSession: async (sessionId: string) => {
        installCalls.push(sessionId);
      },
    });

    const handle = await mgr.createSession('test prompt');

    // Give any async callbacks a moment to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(installCalls).toContain(handle.sessionId);
  }, 15_000);

  it('session creation succeeds even when installHooksForSession rejects', async () => {
    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string) => {
        const cfg = kiro.spawnConfig();
        return spawnACPClient(cfg.command, cfg.args, {
          ...cfg.env,
          AGENT_ROUTER_SESSION_ID: sessionId,
        });
      },
      log,
      installHooksForSession: async (_sessionId: string) => {
        throw new Error('hook install failed intentionally');
      },
    });

    // Should NOT throw despite installHooksForSession throwing
    const handle = await mgr.createSession('test prompt');
    expect(handle.sessionId).toBeTruthy();

    // Session is still in the registry
    expect(mgr.getActiveSession(handle.sessionId)).not.toBeNull();
  }, 15_000);

  it('does not call installHooksForSession when not provided', async () => {
    // This is a sanity test — ensure no crash when the dep is absent.
    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string) => {
        const cfg = kiro.spawnConfig();
        return spawnACPClient(cfg.command, cfg.args, {
          ...cfg.env,
          AGENT_ROUTER_SESSION_ID: sessionId,
        });
      },
      log,
      // installHooksForSession intentionally omitted
    });

    const handle = await mgr.createSession('test prompt');
    expect(handle.sessionId).toBeTruthy();
  }, 15_000);

  it('KiroAdapter.installHooks writes structurally correct hook file', async () => {
    // Use a real KiroAdapter (with spawnImpl to avoid needing the kiro binary)
    // pointing at a temp homeDir, and wire it through the session manager.
    const homeDir = rootDir; // Use rootDir as stand-in for ~
    const kiroSpawnCfg = kiro.spawnConfig();

    const adapter = createKiroAdapter({
      kiroPath: kiroSpawnCfg.command,
      log,
      homeDir,
      spawnImpl: (bin, args, env) =>
        spawnACPClient(kiroSpawnCfg.command, kiroSpawnCfg.args, { ...kiroSpawnCfg.env, ...env }),
    });

    const daemonUrl = 'http://127.0.0.1:3000';

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string) => {
        return adapter.spawn({ sessionId });
      },
      log,
      installHooksForSession: async (sessionId: string) => {
        const caps = adapter.capabilities();
        if (caps.events.includes('tool.post') || caps.events.includes('session.end')) {
          await adapter.installHooks({ sessionId, daemonUrl, bearerToken: 'test-token' });
        }
      },
    });

    const handle = await mgr.createSession('test prompt');

    // Wait for the async installHooks to complete
    await new Promise((r) => setTimeout(r, 100));

    const configPath = path.join(homeDir, '.kiro', 'agents', 'agent-router.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AgentConfig;

    // Must have hooks
    expect(cfg.hooks).toBeDefined();

    // postToolUse entry for this session
    const ptu = cfg.hooks!.postToolUse ?? [];
    const ptuEntry = ptu.find((e) => e.name.includes(handle.sessionId));
    expect(ptuEntry).toBeDefined();
    expect(ptuEntry!.match?.toolName).toBe('@agent-router/merge_pr');
    expect(ptuEntry!.command).toContain(daemonUrl + '/hooks/event');
    expect(ptuEntry!.command).toContain('tool.post');

    // agentStop entry for this session
    const as = cfg.hooks!.agentStop ?? [];
    const asEntry = as.find((e) => e.name.includes(handle.sessionId));
    expect(asEntry).toBeDefined();
    expect(asEntry!.command).toContain(daemonUrl + '/hooks/event');
    expect(asEntry!.command).toContain('turn.end');

    // The bearer token value should NOT appear in the file (uses cat path instead)
    const rawContent = fs.readFileSync(configPath, 'utf-8');
    expect(rawContent).not.toContain('test-token');
  }, 15_000);
});

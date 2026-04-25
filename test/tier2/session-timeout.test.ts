/**
 * Tier 2 tests: Session timeout behavior — inactivity and max-lifetime timers.
 *
 * Uses short timeout values (seconds) to keep tests fast.
 * The fake-kiro subprocess emits notifications on configurable schedules
 * to exercise the activity-reset and timeout-kill paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles, type SessionMeta } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PERIODIC_UPDATES = path.resolve(__dirname, '../scenarios/periodic-updates.json');
const SINGLE_UPDATE_THEN_SILENT = path.resolve(__dirname, '../scenarios/single-update-then-silent.json');

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;

function makeManager(opts: {
  inactivityMinutes: number;
  maxLifetimeMinutes: number;
}): SessionManager {
  return createSessionManager({
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
    sessionTimeout: {
      inactivityMinutes: opts.inactivityMinutes,
      maxLifetimeMinutes: opts.maxLifetimeMinutes,
    },
  });
}

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-timeout-tier2-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
});

afterEach(async () => {
  if (mgr) {
    await mgr.shutdown();
  }
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function readStreamEntries(sessionPath: string): Array<Record<string, unknown>> {
  const content = fs.readFileSync(path.join(sessionPath, 'stream.log'), 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('inactivity timeout', () => {
  it('kills a silent session after the inactivity window', async () => {
    await kiro.loadScenario(SINGLE_UPDATE_THEN_SILENT);

    // Use a very short inactivity timeout: ~2 seconds
    // The scenario emits one notification then goes silent, so the session
    // should be killed after ~2s of inactivity.
    mgr = makeManager({
      inactivityMinutes: 2 / 60, // 2 seconds
      maxLifetimeMinutes: 60,
    });

    const handle = await mgr.createSession('Do something');

    // Wait for the inactivity timer to fire (2s + buffer)
    await new Promise((r) => setTimeout(r, 4000));

    // Session should no longer be active
    expect(mgr.getActiveSession(handle.sessionId)).toBeNull();

    // meta.json should show failed with timeout_inactivity reason
    const meta = sf.readMeta(handle.sessionId) as SessionMeta & { termination_reason?: string };
    expect(meta.status).toBe('failed');
    expect(meta.termination_reason).toBe('timeout_inactivity');

    // stream.log should contain session_ended with reason timeout_inactivity
    const entries = readStreamEntries(handle.paths.dir);
    const endEntry = entries.find((e) => e['type'] === 'session_ended');
    expect(endEntry).toBeDefined();
    expect(endEntry!['reason']).toBe('timeout_inactivity');
  }, 15_000);
});

describe('activity keeps session alive', () => {
  it('session with periodic updates survives past the inactivity window', async () => {
    await kiro.loadScenario(PERIODIC_UPDATES);

    // Inactivity timeout: ~2 seconds. The scenario emits updates every 500ms
    // for 20 iterations (10 seconds total), so the session should stay alive
    // well past the 2-second inactivity window.
    mgr = makeManager({
      inactivityMinutes: 2 / 60, // 2 seconds
      maxLifetimeMinutes: 60,
    });

    const handle = await mgr.createSession('Build the project');

    // Wait 5 seconds — past the inactivity window but within the periodic emission window
    await new Promise((r) => setTimeout(r, 5000));

    // Session should still be active because notifications keep resetting the timer
    const active = mgr.getActiveSession(handle.sessionId);
    expect(active).not.toBeNull();

    // Wait for the scenario to finish (it exits after 20 * 500ms = 10s from start)
    await new Promise((r) => setTimeout(r, 8000));

    // After the subprocess exits, session should be gone
    // (either completed or failed depending on exit handling)
    expect(mgr.getActiveSession(handle.sessionId)).toBeNull();
  }, 25_000);
});

describe('max lifetime timeout', () => {
  it('kills a session that exceeds max lifetime regardless of activity', async () => {
    await kiro.loadScenario(PERIODIC_UPDATES);

    // Max lifetime: ~3 seconds. The scenario emits updates every 500ms,
    // so the session is active, but the absolute cap should kill it.
    mgr = makeManager({
      inactivityMinutes: 60, // very long — won't fire
      maxLifetimeMinutes: 3 / 60, // 3 seconds
    });

    const handle = await mgr.createSession('Long running task');

    // Wait for the max lifetime to fire (3s + buffer)
    await new Promise((r) => setTimeout(r, 5000));

    // Session should be gone
    expect(mgr.getActiveSession(handle.sessionId)).toBeNull();

    // meta.json should show failed with timeout_max_lifetime reason
    const meta = sf.readMeta(handle.sessionId) as SessionMeta & { termination_reason?: string };
    expect(meta.status).toBe('failed');
    expect(meta.termination_reason).toBe('timeout_max_lifetime');

    // stream.log should contain session_ended with reason timeout_max_lifetime
    const entries = readStreamEntries(handle.paths.dir);
    const endEntry = entries.find((e) => e['type'] === 'session_ended');
    expect(endEntry).toBeDefined();
    expect(endEntry!['reason']).toBe('timeout_max_lifetime');
  }, 15_000);
});

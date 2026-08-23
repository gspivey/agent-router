/**
 * Tier 2 test: hanging verify() does not leak a session.
 *
 * Uses a FakeKiroBackend scenario that emits one notification then goes silent,
 * combined with a verify function that never resolves. The session MUST still be
 * terminated by the inactivity handler within (inactivityMs + verifyDeadlineMs + buffer).
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
import type { VerifySessionFn, VerifyResult } from '../../src/verify-session.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SINGLE_UPDATE_THEN_SILENT = path.resolve(__dirname, '../scenarios/single-update-then-silent.json');

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-deadline-tier2-'));
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

describe('verify deadline with FakeKiroBackend', () => {
  it('hanging verify does not cause session to leak indefinitely', async () => {
    await kiro.loadScenario(SINGLE_UPDATE_THEN_SILENT);

    // A verify that never resolves — simulates GitHub API hang
    const hangingVerify: VerifySessionFn = () => new Promise<VerifyResult>(() => {
      // Intentionally never resolves
    });

    // Short inactivity (2s) + short verify deadline (1s) = session should terminate
    // within ~3s + buffer
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
      sessionTimeout: {
        inactivityMinutes: 2 / 60, // 2 seconds
        maxLifetimeMinutes: 60,
        gracePeriodAfterMergeSeconds: 60,
      },
      verify: hangingVerify,
      verifyDeadlineMs: 1000, // 1 second deadline for the verify call
    });

    const handle = await mgr.createSession('Do something');

    // Wait for inactivity (2s) + verify deadline (1s) + buffer (3s) = 6s total
    await new Promise((r) => setTimeout(r, 6000));

    // Session must NOT be leaked — it should have been terminated
    expect(mgr.getActiveSession(handle.sessionId)).toBeNull();

    // meta.json should show failed with timeout_inactivity reason
    const meta = sf.readMeta(handle.sessionId) as SessionMeta & { termination_reason?: string };
    expect(meta.status).toBe('failed');
    expect(meta.termination_reason).toBe('timeout_inactivity');

    // stream.log should contain session_ended with reason timeout_inactivity
    const streamPath = path.join(handle.paths.dir, 'stream.log');
    const content = fs.readFileSync(streamPath, 'utf-8').trim();
    const entries = content.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
    const endEntry = entries.find((e) => e['type'] === 'session_ended');
    expect(endEntry).toBeDefined();
    expect(endEntry!['reason']).toBe('timeout_inactivity');
  }, 15_000);

  it('verify that resolves before deadline allows normal termination flow', async () => {
    await kiro.loadScenario(SINGLE_UPDATE_THEN_SILENT);

    // A verify that resolves normally (no PRs)
    const normalVerify: VerifySessionFn = () =>
      Promise.resolve({ verified: false, reason: 'no_prs' as const });

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
      sessionTimeout: {
        inactivityMinutes: 2 / 60, // 2 seconds
        maxLifetimeMinutes: 60,
        gracePeriodAfterMergeSeconds: 60,
      },
      verify: normalVerify,
      verifyDeadlineMs: 5000, // generous deadline — won't fire
    });

    const handle = await mgr.createSession('Do something');

    // Wait for inactivity timer + verify (fast) + buffer
    await new Promise((r) => setTimeout(r, 5000));

    expect(mgr.getActiveSession(handle.sessionId)).toBeNull();

    const meta = sf.readMeta(handle.sessionId) as SessionMeta & { termination_reason?: string };
    expect(meta.status).toBe('failed');
    expect(meta.termination_reason).toBe('timeout_inactivity');
  }, 15_000);
});

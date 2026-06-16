/**
 * Tier 2 tests: Session resumption across daemon restart.
 * Spec: .kiro/specs/operator-controls/ · tasks 3.2
 *
 * Tests the resume-or-terminate behavior on startup:
 * - Active sessions with kiro_session_id are resumed via session/load
 * - Active sessions where session/load fails are marked terminated_by_restart
 * - Active sessions without kiro_session_id are marked terminated_by_restart
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
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');
const LOAD_SUCCESS_SCENARIO = path.resolve(__dirname, '../scenarios/load-session-success.json');
const FAKE_KIRO_CRASH_ON_LOAD = path.resolve(__dirname, '../harness/fake-kiro-crash-on-load.ts');

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-tier2-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
});

afterEach(async () => {
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/**
 * Simulate a daemon that had an active session and crashed.
 * Creates the session on disk with status 'active' and a kiro_session_id.
 */
function plantActiveSession(sessionId: string, opts?: { kiroSessionId?: string; repo?: string }): void {
  const paths = sf.createSession(sessionId, 'Test prompt');
  const meta: SessionMeta = {
    session_id: sessionId,
    original_prompt: 'Test prompt',
    status: 'active',
    created_at: Math.floor(Date.now() / 1000) - 60,
    completed_at: null,
    prs: [],
    ...(opts?.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts?.kiroSessionId !== undefined ? { kiro_session_id: opts.kiroSessionId } : {}),
  };
  // Overwrite meta.json directly to simulate pre-crash state
  fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + '\n');
}

function createMgrWithScenario(scenarioPath: string): SessionManager {
  const kiro = new FakeKiroBackend();
  // loadScenario is async but we need sync setup — write env directly
  const cfg = {
    command: process.execPath,
    args: ['--import', 'tsx/esm', path.resolve(__dirname, '../harness/fake-kiro-process.ts')],
    env: { FAKE_KIRO_SCENARIO: scenarioPath },
  };

  return createSessionManager({
    db,
    sessionFiles: sf,
    acpSpawner: (sessionId: string, repo?: string) => {
      return spawnACPClient(cfg.command, cfg.args, {
        ...cfg.env,
        AGENT_ROUTER_SESSION_ID: sessionId,
      });
    },
    log,
  });
}

describe('session resumption on startup (Task 3.2)', () => {
  it('resumes an active session when session/load succeeds', async () => {
    plantActiveSession('sess-resume-ok', { kiroSessionId: 'fake-session-001' });

    const mgr = createMgrWithScenario(LOAD_SUCCESS_SCENARIO);
    try {
      const result = await mgr.resumeSessions();
      expect(result.resumed).toBe(1);
      expect(result.terminated).toBe(0);

      // Session should be in the active registry
      const handle = mgr.getActiveSession('sess-resume-ok');
      expect(handle).not.toBeNull();
      expect(handle!.sessionId).toBe('sess-resume-ok');

      // Meta should still be active
      const meta = sf.readMeta('sess-resume-ok');
      expect(meta.status).toBe('active');
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);

  it('marks session terminated_by_restart when session/load fails', async () => {
    plantActiveSession('sess-resume-fail', { kiroSessionId: 'fake-session-001' });

    // Use a fake kiro that crashes on session/load (exits without responding)
    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string) => {
        return spawnACPClient(process.execPath, ['--import', 'tsx/esm', FAKE_KIRO_CRASH_ON_LOAD], {
          AGENT_ROUTER_SESSION_ID: sessionId,
        });
      },
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result.resumed).toBe(0);
      expect(result.terminated).toBe(1);

      // Session should NOT be in the active registry
      const handle = mgr.getActiveSession('sess-resume-fail');
      expect(handle).toBeNull();

      // Meta should be abandoned with terminated_by_restart
      const meta = sf.readMeta('sess-resume-fail');
      expect(meta.status).toBe('abandoned');
      expect(meta.termination_reason).toBe('terminated_by_restart');
      expect(meta.completed_at).not.toBeNull();

      // stream.log should have session_ended entry
      const streamPath = sf.getSessionPaths('sess-resume-fail').stream;
      const streamContent = fs.readFileSync(streamPath, 'utf-8').trim();
      const lines = streamContent.split('\n').filter((l) => l.length > 0);
      const endEntry = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e['type'] === 'session_ended');
      expect(endEntry).toBeDefined();
      expect(endEntry!['reason']).toBe('terminated_by_restart');
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);

  it('marks session terminated_by_restart when no kiro_session_id', async () => {
    // Plant a session WITHOUT kiro_session_id
    plantActiveSession('sess-no-kiro-id');

    const mgr = createMgrWithScenario(LOAD_SUCCESS_SCENARIO);
    try {
      const result = await mgr.resumeSessions();
      expect(result.resumed).toBe(0);
      expect(result.terminated).toBe(1);

      const meta = sf.readMeta('sess-no-kiro-id');
      expect(meta.status).toBe('abandoned');
      expect(meta.termination_reason).toBe('terminated_by_restart');
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);

  it('does not attempt to resume terminal sessions', async () => {
    // Plant a completed session — should be ignored
    sf.createSession('sess-completed', 'Done');
    sf.updateMeta('sess-completed', {
      status: 'completed',
      completed_at: Math.floor(Date.now() / 1000),
      termination_reason: 'completed',
    });

    const mgr = createMgrWithScenario(LOAD_SUCCESS_SCENARIO);
    try {
      const result = await mgr.resumeSessions();
      expect(result.resumed).toBe(0);
      expect(result.terminated).toBe(0);
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);

  it('handles mixed sessions: some resume, some fail', async () => {
    // Plant one session that will succeed and one without kiro_session_id
    plantActiveSession('sess-good', { kiroSessionId: 'fake-session-001' });
    plantActiveSession('sess-bad');

    const mgr = createMgrWithScenario(LOAD_SUCCESS_SCENARIO);
    try {
      const result = await mgr.resumeSessions();
      // sess-bad terminates (no kiro_session_id), sess-good resumes
      expect(result.terminated).toBe(1);
      expect(result.resumed).toBe(1);

      expect(mgr.getActiveSession('sess-good')).not.toBeNull();
      expect(mgr.getActiveSession('sess-bad')).toBeNull();
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);
});

describe('kiro_session_id persistence via createSession (Task 3.1)', () => {
  it('persists kiro_session_id after ACP session creation', async () => {
    const kiro = new FakeKiroBackend();
    await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);

    const mgr = createSessionManager({
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
    });

    try {
      const handle = await mgr.createSession('Test prompt');
      const meta = sf.readMeta(handle.sessionId);
      // The fake kiro returns 'fake-session-001' as the session ID
      expect(meta.kiro_session_id).toBe('fake-session-001');
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);
});

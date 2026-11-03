/**
 * Tier 1 tests: `computeSessionsByRepo` pure function and the
 * `active_sessions_by_repo` field in `GET /overview`.
 *
 * Tests for the pure helper directly (no daemon, no disk I/O) and for the
 * field's presence/absence in the overview response.
 *
 * See BACKLOG.md § P2.45 (original), BACKLOG.md § P2.48 (last_started_at).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  computeSessionsByRepo,
  createWebRoutes,
  type OverviewResponse,
  type OverviewSessionsByRepo,
} from '../../../src/web-routes.js';
import { createSessionFiles, type SessionFiles } from '../../../src/session-files.js';
import { createSSEBroker, type SSEBroker } from '../../../src/sse-broker.js';
import { createLogger, type Logger } from '../../../src/log.js';
import type { SessionManager } from '../../../src/session-mgr.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => makeLogger() };
}

function stubSessionMgr(): SessionManager {
  return {
    getActiveSession: () => undefined,
    hasActiveSessionForRepo: () => false,
    listActiveSessions: () => [],
    injectPrompt: async () => {},
    terminateSession: async () => {},
    createSession: async () => ({ sessionId: '', sessionDir: '' }),
    registerPR: () => {},
    shutdown: async () => {},
    completeSession: async () => {},
  } as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestCtx {
  rootDir: string;
  sessionFiles: SessionFiles;
  sseBroker: SSEBroker;
  log: Logger;
}

function makeCtx(): TestCtx {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-sbr-t1-'));
  const log = makeLogger();
  const sessionFiles = createSessionFiles(rootDir);
  const sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
  return { rootDir, sessionFiles, sseBroker, log };
}

function cleanup(ctx: TestCtx): void {
  ctx.sseBroker.shutdown();
  fs.rmSync(ctx.rootDir, { recursive: true, force: true });
}

/** A minimal session object compatible with computeSessionsByRepo's input type. */
function sess(
  repo: string | undefined,
  status: string,
  completed_at: number | null,
  created_at = 1_000_000,
) {
  return repo !== undefined
    ? { repo, status, completed_at, created_at }
    : { status, completed_at, created_at };
}

// ---------------------------------------------------------------------------
// Unit tests for the pure computeSessionsByRepo function
// ---------------------------------------------------------------------------

describe('computeSessionsByRepo — pure unit tests', () => {
  it('returns [] when the sessions array is empty', () => {
    expect(computeSessionsByRepo([], 1000000)).toEqual([]);
  });

  it('returns [] when all sessions have null/undefined repo', () => {
    const sessions = [
      sess(undefined, 'active', null),
      sess(undefined, 'completed', 999999),
    ];
    expect(computeSessionsByRepo(sessions, 1000000)).toEqual([]);
  });

  it('returns [] when all sessions have an empty-string repo', () => {
    const sessions = [sess('', 'active', null)];
    expect(computeSessionsByRepo(sessions, 1000000)).toEqual([]);
  });

  it('counts active sessions per repo', () => {
    const sessions = [
      sess('org/a', 'active', null),
      sess('org/a', 'active', null),
      sess('org/b', 'active', null),
    ];
    const result = computeSessionsByRepo(sessions, 1000000);
    const a = result.find((r) => r.repo === 'org/a');
    const b = result.find((r) => r.repo === 'org/b');
    expect(a?.active).toBe(2);
    expect(b?.active).toBe(1);
  });

  it('counts completed_24h only for sessions with completed_at >= nowS - 86400', () => {
    const nowS = 1000000;
    const cutoffS = nowS - 86400; // 913600
    const sessions = [
      // within 24h
      sess('org/a', 'completed', cutoffS + 1),
      sess('org/a', 'failed', nowS),
      // exactly at boundary: should be included (>=)
      sess('org/a', 'abandoned', cutoffS),
      // older than 24h: should NOT count
      sess('org/a', 'completed', cutoffS - 1),
      // null completed_at: should NOT count
      sess('org/a', 'completed', null),
    ];
    const result = computeSessionsByRepo(sessions, nowS);
    const a = result.find((r) => r.repo === 'org/a');
    // 3 within 24h (cutoffS+1, nowS, cutoffS)
    expect(a?.completed_24h).toBe(3);
  });

  it('does not count active sessions in completed_24h even if completed_at is set', () => {
    const nowS = 1000000;
    const sessions = [
      // active session with a completed_at that would be within 24h — should only count active
      sess('org/a', 'active', nowS - 100),
    ];
    const result = computeSessionsByRepo(sessions, nowS);
    const a = result.find((r) => r.repo === 'org/a');
    expect(a?.active).toBe(1);
    expect(a?.completed_24h).toBe(0);
  });

  it('sorts by active descending, then completed_24h descending', () => {
    const nowS = 1000000;
    const sessions = [
      // repo/c: 0 active, 1 completed_24h
      sess('org/c', 'completed', nowS - 100),
      // repo/a: 2 active, 0 completed_24h
      sess('org/a', 'active', null),
      sess('org/a', 'active', null),
      // repo/b: 1 active, 2 completed_24h
      sess('org/b', 'active', null),
      sess('org/b', 'completed', nowS - 200),
      sess('org/b', 'completed', nowS - 300),
    ];
    const result = computeSessionsByRepo(sessions, nowS);
    expect(result[0]?.repo).toBe('org/a');  // 2 active
    expect(result[1]?.repo).toBe('org/b');  // 1 active
    expect(result[2]?.repo).toBe('org/c');  // 0 active, but 1 completed_24h
  });

  it('sorts equal-active repos by completed_24h descending', () => {
    const nowS = 1000000;
    const sessions = [
      // repo/a: 0 active, 1 completed_24h
      sess('org/a', 'completed', nowS - 100),
      // repo/b: 0 active, 3 completed_24h
      sess('org/b', 'completed', nowS - 100),
      sess('org/b', 'completed', nowS - 200),
      sess('org/b', 'completed', nowS - 300),
    ];
    const result = computeSessionsByRepo(sessions, nowS);
    expect(result[0]?.repo).toBe('org/b');  // 3 completed_24h
    expect(result[1]?.repo).toBe('org/a');  // 1 completed_24h
  });

  it('caps at maxRows (default 10)', () => {
    const sessions: ReturnType<typeof sess>[] = [];
    for (let i = 0; i < 15; i++) {
      sessions.push(sess(`org/repo-${i}`, 'active', null));
    }
    const result = computeSessionsByRepo(sessions, 1000000);
    expect(result).toHaveLength(10);
  });

  it('respects custom maxRows', () => {
    const sessions: ReturnType<typeof sess>[] = [];
    for (let i = 0; i < 5; i++) {
      sessions.push(sess(`org/repo-${i}`, 'active', null));
    }
    const result = computeSessionsByRepo(sessions, 1000000, 3);
    expect(result).toHaveLength(3);
  });

  it('includes each repo in the output exactly once', () => {
    const sessions = [
      sess('org/x', 'active', null),
      sess('org/x', 'completed', 999999),
      sess('org/x', 'failed', 999998),
    ];
    const result = computeSessionsByRepo(sessions, 1000000);
    expect(result.filter((r) => r.repo === 'org/x')).toHaveLength(1);
  });

  it('returns rows with the correct OverviewSessionsByRepo shape', () => {
    const nowS = 1000000;
    const sessions = [
      sess('org/typed', 'active', null, nowS - 500),
      sess('org/typed', 'completed', nowS - 100, nowS - 200),
    ];
    const result = computeSessionsByRepo(sessions, nowS);
    expect(result).toHaveLength(1);
    const row = result[0] as OverviewSessionsByRepo;
    expect(typeof row.repo).toBe('string');
    expect(typeof row.active).toBe('number');
    expect(typeof row.completed_24h).toBe('number');
    // last_started_at is number | null
    expect(row.last_started_at === null || typeof row.last_started_at === 'number').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for last_started_at (BACKLOG.md § P2.48)
// ---------------------------------------------------------------------------

describe('computeSessionsByRepo — last_started_at (BACKLOG.md § P2.48)', () => {
  it('returns last_started_at as the created_at of the only session', () => {
    const sessions = [sess('org/a', 'active', null, 1_234_567)];
    const result = computeSessionsByRepo(sessions, 2_000_000);
    expect(result[0]?.last_started_at).toBe(1_234_567);
  });

  it('returns last_started_at as the maximum created_at across multiple sessions', () => {
    const sessions = [
      sess('org/a', 'completed', null, 1_000_000),
      sess('org/a', 'active',    null, 1_500_000), // newest
      sess('org/a', 'failed',    null, 1_200_000),
    ];
    const result = computeSessionsByRepo(sessions, 2_000_000);
    expect(result[0]?.last_started_at).toBe(1_500_000);
  });

  it('returns last_started_at per repo independently', () => {
    const sessions = [
      sess('org/a', 'active', null, 1_100_000),
      sess('org/a', 'active', null, 1_300_000),  // newest for org/a
      sess('org/b', 'active', null, 1_200_000),
      sess('org/b', 'active', null, 1_000_000),  // oldest for org/b
    ];
    const result = computeSessionsByRepo(sessions, 2_000_000);
    const a = result.find((r) => r.repo === 'org/a');
    const b = result.find((r) => r.repo === 'org/b');
    expect(a?.last_started_at).toBe(1_300_000);
    expect(b?.last_started_at).toBe(1_200_000);
  });

  it('sessions with null/undefined repo do not affect any repo last_started_at', () => {
    const sessions = [
      sess('org/a', 'active', null, 1_000_000),
      // null-repo session with a newer created_at — must not bleed into org/a
      { status: 'active', completed_at: null, created_at: 9_000_000 },
    ];
    const result = computeSessionsByRepo(sessions, 2_000_000);
    const a = result.find((r) => r.repo === 'org/a');
    expect(a?.last_started_at).toBe(1_000_000);
  });

  it('all-statuses are considered for last_started_at (active, completed, failed, abandoned)', () => {
    const nowS = 2_000_000;
    const sessions = [
      sess('org/a', 'abandoned',  nowS - 500, 1_000_000),
      sess('org/a', 'failed',     nowS - 400, 1_200_000),
      sess('org/a', 'completed',  nowS - 300, 1_100_000),
      sess('org/a', 'active',     null,        999_000), // active but oldest created_at
    ];
    const result = computeSessionsByRepo(sessions, nowS);
    // The failed session has the highest created_at (1_200_000)
    expect(result[0]?.last_started_at).toBe(1_200_000);
  });

  it('last_started_at is present on every row returned (never undefined)', () => {
    const sessions = [
      sess('org/a', 'active', null, 1_000_000),
      sess('org/b', 'active', null, 1_100_000),
    ];
    const result = computeSessionsByRepo(sessions, 2_000_000);
    for (const row of result) {
      // The property must exist and be a number (not undefined)
      expect('last_started_at' in row).toBe(true);
      expect(row.last_started_at).not.toBeUndefined();
      expect(typeof row.last_started_at).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: the field appears in GET /overview
// ---------------------------------------------------------------------------

describe('GET /overview active_sessions_by_repo field (BACKLOG.md § P2.45)', () => {
  it('returns active_sessions_by_repo as [] when no sessions exist', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(Array.isArray(body.active_sessions_by_repo)).toBe(true);
      expect(body.active_sessions_by_repo).toHaveLength(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns active_sessions_by_repo with per-repo rows when sessions exist', async () => {
    const ctx = makeCtx();
    try {
      // Create two sessions for different repos using the proper API
      ctx.sessionFiles.createSession('sess-a1', 'test a');
      ctx.sessionFiles.updateMeta('sess-a1', { repo: 'org/repo-a' });

      ctx.sessionFiles.createSession('sess-b1', 'test b');
      ctx.sessionFiles.updateMeta('sess-b1', { repo: 'org/repo-b' });

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(Array.isArray(body.active_sessions_by_repo)).toBe(true);
      expect(body.active_sessions_by_repo.length).toBeGreaterThanOrEqual(2);
      const repos = body.active_sessions_by_repo.map((r) => r.repo);
      expect(repos).toContain('org/repo-a');
      expect(repos).toContain('org/repo-b');
      for (const row of body.active_sessions_by_repo) {
        expect(row.active).toBe(1);
        expect(row.completed_24h).toBe(0);
        // last_started_at must be a number (unix seconds) for each row
        expect(typeof row.last_started_at).toBe('number');
        expect((row.last_started_at as number)).toBeGreaterThan(0);
      }
    } finally {
      cleanup(ctx);
    }
  });

  it('active_sessions_by_repo is always present in the response (never undefined)', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
      });
      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      // Must be an array, not undefined or null
      expect(body.active_sessions_by_repo).toBeDefined();
      expect(Array.isArray(body.active_sessions_by_repo)).toBe(true);
    } finally {
      cleanup(ctx);
    }
  });
});

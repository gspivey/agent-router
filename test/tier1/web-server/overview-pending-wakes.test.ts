/**
 * Tier 1 tests: `pending_wakes_count` field in `GET /overview`.
 *
 * Verifies that the `GET /overview` endpoint:
 *   - includes `pending_wakes_count` with the correct count when the
 *     `pending_wakes` table has rows (BACKLOG.md § P2.34), and
 *   - returns `pending_wakes_count: 0` when the table is empty or the DB is
 *     absent.
 *
 * Uses `createWebRoutes` directly with a real (in-memory) SQLite DB injected
 * via the `db` dep — no network, no session files on disk.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createWebRoutes, type OverviewResponse } from '../../../src/web-routes.js';
import { createSessionFiles, type SessionFiles } from '../../../src/session-files.js';
import { createSSEBroker, type SSEBroker } from '../../../src/sse-broker.js';
import { createLogger, type Logger } from '../../../src/log.js';
import { initDatabase, type Database } from '../../../src/db.js';
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
  dbPath: string;
  db: Database;
  sessionFiles: SessionFiles;
  sseBroker: SSEBroker;
  log: Logger;
}

function makeCtx(): TestCtx {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-pw-t1-'));
  const dbPath = path.join(rootDir, 'agent-router.db');
  const db = initDatabase(dbPath);
  const log = makeLogger();
  const sessionFiles = createSessionFiles(rootDir);
  const sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
  return { rootDir, dbPath, db, sessionFiles, sseBroker, log };
}

function cleanup(ctx: TestCtx): void {
  ctx.sseBroker.shutdown();
  void ctx.db.shutdown();
  fs.rmSync(ctx.rootDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /overview pending_wakes_count field (BACKLOG.md § P2.34)', () => {
  it('returns pending_wakes_count: 0 when the table is empty', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        db: ctx.db,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.pending_wakes_count).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns pending_wakes_count: 0 when db dep is absent', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        // db intentionally omitted
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.pending_wakes_count).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns pending_wakes_count: 1 after inserting one deferred wake', async () => {
    const ctx = makeCtx();
    try {
      // Insert a pending wake directly into the DB.
      const nowS = Math.floor(Date.now() / 1000);
      // We need an event_id; insert a dummy event first.
      const eventId = ctx.db.insertEvent({
        repo: 'org/repo',
        prNumber: 7,
        eventType: 'check_run',
        payload: '{}',
        receivedAt: nowS,
      });
      ctx.db.upsertPendingWake('org/repo', 7, eventId, nowS + 60);

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        db: ctx.db,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.pending_wakes_count).toBe(1);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns pending_wakes_count: 2 after inserting two deferred wakes for different PRs', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const eventId1 = ctx.db.insertEvent({
        repo: 'org/repo',
        prNumber: 1,
        eventType: 'check_run',
        payload: '{}',
        receivedAt: nowS,
      });
      const eventId2 = ctx.db.insertEvent({
        repo: 'org/repo',
        prNumber: 2,
        eventType: 'check_run',
        payload: '{}',
        receivedAt: nowS,
      });
      ctx.db.upsertPendingWake('org/repo', 1, eventId1, nowS + 60);
      ctx.db.upsertPendingWake('org/repo', 2, eventId2, nowS + 60);

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        db: ctx.db,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.pending_wakes_count).toBe(2);
    } finally {
      cleanup(ctx);
    }
  });

  it('coalesces upserted wakes: count stays 1 when two events upsert the same (repo, pr)', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const eventId1 = ctx.db.insertEvent({
        repo: 'org/repo',
        prNumber: 5,
        eventType: 'check_run',
        payload: '{}',
        receivedAt: nowS,
      });
      const eventId2 = ctx.db.insertEvent({
        repo: 'org/repo',
        prNumber: 5,
        eventType: 'check_run',
        payload: '{}',
        receivedAt: nowS + 1,
      });
      ctx.db.upsertPendingWake('org/repo', 5, eventId1, nowS + 60);
      // Upsert the same (repo, pr) again — replaces, does not add.
      ctx.db.upsertPendingWake('org/repo', 5, eventId2, nowS + 90);

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        db: ctx.db,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      // UPSERT means one row per (repo, pr), not two.
      expect(body.pending_wakes_count).toBe(1);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns HTTP 200 regardless of pending_wakes_count value', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const eventId = ctx.db.insertEvent({
        repo: 'org/repo',
        prNumber: 99,
        eventType: 'check_run',
        payload: '{}',
        receivedAt: nowS,
      });
      ctx.db.upsertPendingWake('org/repo', 99, eventId, nowS + 60);

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        db: ctx.db,
      });

      const res = await app.request('/overview', { method: 'GET' });
      // GET /overview always returns 200, never 503
      expect(res.status).toBe(200);
    } finally {
      cleanup(ctx);
    }
  });
});

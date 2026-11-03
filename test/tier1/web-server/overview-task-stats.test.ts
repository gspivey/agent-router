/**
 * Tier 1 tests: `tasks_succeeded_24h` and `tasks_failed_24h` fields in
 * `GET /overview`.
 *
 * Verifies that the `GET /overview` endpoint:
 *   - includes `tasks_succeeded_24h` and `tasks_failed_24h` with the correct
 *     counts when the `tasks` table has rows in those states with
 *     `updated_at >= (nowS - 86400) * 1000` (BACKLOG.md § P2.42), and
 *   - returns `0` for both fields when the table is empty, when the DB is
 *     absent, or when all tasks were updated more than 24 hours ago.
 *
 * Uses `createWebRoutes` directly with a real (in-memory) SQLite DB injected
 * via the `db` dep — no network, no session files on disk.
 *
 * NOTE: The `tasks` table is created by `initTaskDatabase()` which runs on
 * top of the main `initDatabase()` connection. In production, both are
 * called on the same DB file. In tests, we call both on the same in-memory DB
 * so the overview handler can see the tasks table.
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
import { initTaskDatabase } from '../../../src/task-db.js';
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-ts24-t1-'));
  const dbPath = path.join(rootDir, 'agent-router.db');
  const db = initDatabase(dbPath);
  // Initialize the task DB schema on the same connection so the `tasks` table
  // is visible to the overview handler.
  initTaskDatabase(db.raw());
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

/**
 * Insert a task row with a specific `state` and `updated_at` timestamp
 * directly into the DB.
 */
function insertTaskWithState(
  db: Database,
  state: 'succeeded' | 'failed' | 'queued' | 'running',
  updatedAt: number, // unix milliseconds
): void {
  db.raw()
    .prepare(
      `INSERT INTO tasks (id, repo, source, title, spec, agent, budget, state, created_at, updated_at)
       VALUES (@id, @repo, 'api', 'Test task', '', 'kiro', '{}', @state, @created_at, @updated_at)`,
    )
    .run({
      id: `task-${Math.random().toString(36).slice(2)}`,
      repo: 'org/repo',
      state,
      created_at: updatedAt,
      updated_at: updatedAt,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /overview tasks_succeeded_24h and tasks_failed_24h fields (BACKLOG.md § P2.42)', () => {
  it('returns both fields as 0 when the tasks table is empty', async () => {
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
      expect(body.tasks_succeeded_24h).toBe(0);
      expect(body.tasks_failed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns both fields as 0 when db dep is absent', async () => {
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
      expect(body.tasks_succeeded_24h).toBe(0);
      expect(body.tasks_failed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns tasks_succeeded_24h: 0 when all succeeded tasks are older than 24h', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const oldMs = (nowS - 90000) * 1000; // 25 hours ago in ms
      insertTaskWithState(ctx.db, 'succeeded', oldMs);

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
      expect(body.tasks_succeeded_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns tasks_failed_24h: 0 when all failed tasks are older than 24h', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const oldMs = (nowS - 90000) * 1000; // 25 hours ago in ms
      insertTaskWithState(ctx.db, 'failed', oldMs);

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
      expect(body.tasks_failed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns tasks_succeeded_24h: 1 after inserting one recent succeeded task', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const recentMs = (nowS - 60) * 1000; // 1 minute ago in ms
      insertTaskWithState(ctx.db, 'succeeded', recentMs);

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
      expect(body.tasks_succeeded_24h).toBe(1);
      expect(body.tasks_failed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns tasks_failed_24h: 1 after inserting one recent failed task', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const recentMs = (nowS - 60) * 1000; // 1 minute ago in ms
      insertTaskWithState(ctx.db, 'failed', recentMs);

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
      expect(body.tasks_succeeded_24h).toBe(0);
      expect(body.tasks_failed_24h).toBe(1);
    } finally {
      cleanup(ctx);
    }
  });

  it('counts succeeded and failed tasks independently', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const recentMs = (nowS - 3600) * 1000; // 1 hour ago in ms
      insertTaskWithState(ctx.db, 'succeeded', recentMs);
      insertTaskWithState(ctx.db, 'succeeded', recentMs);
      insertTaskWithState(ctx.db, 'failed', recentMs);

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
      expect(body.tasks_succeeded_24h).toBe(2);
      expect(body.tasks_failed_24h).toBe(1);
    } finally {
      cleanup(ctx);
    }
  });

  it('excludes queued and running tasks from both counts', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const recentMs = (nowS - 60) * 1000; // 1 minute ago in ms
      insertTaskWithState(ctx.db, 'queued', recentMs);
      insertTaskWithState(ctx.db, 'running', recentMs);

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
      expect(body.tasks_succeeded_24h).toBe(0);
      expect(body.tasks_failed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('excludes old succeeded/failed tasks when mixed with recent ones', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const recentMs = (nowS - 60) * 1000;   // 1 minute ago
      const oldMs    = (nowS - 90000) * 1000; // 25 hours ago

      insertTaskWithState(ctx.db, 'succeeded', recentMs);
      insertTaskWithState(ctx.db, 'succeeded', oldMs); // excluded
      insertTaskWithState(ctx.db, 'failed', oldMs);    // excluded

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
      expect(body.tasks_succeeded_24h).toBe(1);
      expect(body.tasks_failed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });
});

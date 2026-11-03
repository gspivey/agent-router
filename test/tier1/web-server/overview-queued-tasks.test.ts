/**
 * Tier 1 tests: `queued_tasks` field in `GET /overview`.
 *
 * Verifies that the `GET /overview` endpoint:
 *   - includes `queued_tasks: []` when no tasks are in the `queued` state,
 *   - includes `queued_tasks: []` when the `db` dep is absent,
 *   - returns a row per queued task, ordered oldest-first, capped at 10, and
 *   - each row carries `id_prefix` (first 8 chars of ULID), `repo`, `title`,
 *     and `created_at` in unix seconds.
 *
 * Uses `createWebRoutes` directly with a real (in-memory) SQLite DB injected
 * via the `db` dep — no network, no session files on disk.
 *
 * NOTE: The `tasks` table is created by `initTaskDatabase()` which runs on
 * top of the main `initDatabase()` connection. In tests, we call both on the
 * same in-memory DB so the overview handler can see the tasks table.
 *
 * See BACKLOG.md § P2.60.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createWebRoutes, type OverviewResponse, type OverviewQueuedTask, collectQueuedTasks } from '../../../src/web-routes.js';
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-qt-t1-'));
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
 * Insert a task row with a specific `state` and `created_at`/`updated_at`
 * timestamp directly into the DB.
 */
function insertTask(
  db: Database,
  opts: {
    id?: string;
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    repo?: string;
    title?: string;
    createdAt?: number; // unix milliseconds
  },
): string {
  const id = opts.id ?? `task-${Math.random().toString(36).slice(2, 10).padEnd(26, '0')}`;
  const createdAt = opts.createdAt ?? Date.now();
  db.raw()
    .prepare(
      `INSERT INTO tasks (id, repo, source, title, spec, agent, budget, state, created_at, updated_at)
       VALUES (@id, @repo, 'api', @title, '', 'kiro', '{}', @state, @created_at, @updated_at)`,
    )
    .run({
      id,
      repo: opts.repo ?? 'org/repo',
      title: opts.title ?? 'Test task',
      state: opts.state,
      created_at: createdAt,
      updated_at: createdAt,
    });
  return id;
}

// ---------------------------------------------------------------------------
// Unit tests for collectQueuedTasks pure function
// ---------------------------------------------------------------------------

describe('collectQueuedTasks pure function (BACKLOG.md § P2.60)', () => {
  it('returns [] when db is undefined', () => {
    const result = collectQueuedTasks(undefined);
    expect(result).toEqual([]);
  });

  it('returns [] when the tasks table is empty', () => {
    const ctx = makeCtx();
    try {
      const result = collectQueuedTasks(ctx.db);
      expect(result).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns [] when no tasks are in queued state', () => {
    const ctx = makeCtx();
    try {
      insertTask(ctx.db, { state: 'running' });
      insertTask(ctx.db, { state: 'succeeded' });
      const result = collectQueuedTasks(ctx.db);
      expect(result).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns a row with correct shape for one queued task', () => {
    const ctx = makeCtx();
    try {
      const id = insertTask(ctx.db, {
        state: 'queued',
        repo: 'myorg/myrepo',
        title: 'Implement feature X',
        createdAt: 1699000000000, // fixed ms timestamp
      });
      const result = collectQueuedTasks(ctx.db);
      expect(result).toHaveLength(1);
      const row = result[0] as OverviewQueuedTask;
      expect(row.id_prefix).toBe(id.slice(0, 8));
      expect(row.repo).toBe('myorg/myrepo');
      expect(row.title).toBe('Implement feature X');
      expect(row.created_at).toBe(1699000000); // ms → seconds
    } finally {
      cleanup(ctx);
    }
  });

  it('orders tasks by created_at ascending (oldest first)', () => {
    const ctx = makeCtx();
    try {
      const baseMs = 1699000000000;
      const id1 = insertTask(ctx.db, { state: 'queued', title: 'First',  createdAt: baseMs });
      const id2 = insertTask(ctx.db, { state: 'queued', title: 'Second', createdAt: baseMs + 10000 });
      const id3 = insertTask(ctx.db, { state: 'queued', title: 'Third',  createdAt: baseMs + 20000 });
      const result = collectQueuedTasks(ctx.db);
      expect(result).toHaveLength(3);
      expect(result[0]?.id_prefix).toBe(id1.slice(0, 8));
      expect(result[1]?.id_prefix).toBe(id2.slice(0, 8));
      expect(result[2]?.id_prefix).toBe(id3.slice(0, 8));
    } finally {
      cleanup(ctx);
    }
  });

  it('excludes non-queued tasks (running, succeeded, failed, cancelled)', () => {
    const ctx = makeCtx();
    try {
      insertTask(ctx.db, { state: 'running' });
      insertTask(ctx.db, { state: 'succeeded' });
      insertTask(ctx.db, { state: 'failed' });
      insertTask(ctx.db, { state: 'cancelled' });
      const queuedId = insertTask(ctx.db, { state: 'queued', title: 'Queued only' });
      const result = collectQueuedTasks(ctx.db);
      expect(result).toHaveLength(1);
      expect(result[0]?.id_prefix).toBe(queuedId.slice(0, 8));
    } finally {
      cleanup(ctx);
    }
  });

  it('caps result at 10 rows by default', () => {
    const ctx = makeCtx();
    try {
      for (let i = 0; i < 15; i++) {
        insertTask(ctx.db, { state: 'queued', title: `Task ${i}`, createdAt: 1699000000000 + i * 1000 });
      }
      const result = collectQueuedTasks(ctx.db);
      expect(result).toHaveLength(10);
    } finally {
      cleanup(ctx);
    }
  });

  it('respects a custom limit parameter', () => {
    const ctx = makeCtx();
    try {
      for (let i = 0; i < 5; i++) {
        insertTask(ctx.db, { state: 'queued', title: `Task ${i}`, createdAt: 1699000000000 + i * 1000 });
      }
      const result = collectQueuedTasks(ctx.db, 3);
      expect(result).toHaveLength(3);
    } finally {
      cleanup(ctx);
    }
  });

  it('id_prefix is always 8 characters', () => {
    const ctx = makeCtx();
    try {
      insertTask(ctx.db, { state: 'queued' });
      const result = collectQueuedTasks(ctx.db);
      expect(result[0]?.id_prefix).toHaveLength(8);
    } finally {
      cleanup(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests via GET /overview
// ---------------------------------------------------------------------------

describe('GET /overview queued_tasks field (BACKLOG.md § P2.60)', () => {
  it('returns queued_tasks: [] when the tasks table is empty', async () => {
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
      expect(body.queued_tasks).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns queued_tasks: [] when db dep is absent', async () => {
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
      expect(body.queued_tasks).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns queued_tasks: [] when only non-queued tasks exist', async () => {
    const ctx = makeCtx();
    try {
      insertTask(ctx.db, { state: 'running' });
      insertTask(ctx.db, { state: 'succeeded' });

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
      expect(body.queued_tasks).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns one row per queued task with correct fields', async () => {
    const ctx = makeCtx();
    try {
      const id = insertTask(ctx.db, {
        state: 'queued',
        repo: 'myorg/myrepo',
        title: 'Add feature X',
        createdAt: 1699000000000,
      });

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
      expect(body.queued_tasks).toHaveLength(1);
      const row = body.queued_tasks[0] as OverviewQueuedTask;
      expect(row.id_prefix).toBe(id.slice(0, 8));
      expect(row.repo).toBe('myorg/myrepo');
      expect(row.title).toBe('Add feature X');
      expect(row.created_at).toBe(1699000000); // ms → s
    } finally {
      cleanup(ctx);
    }
  });

  it('returns queued tasks ordered oldest-first', async () => {
    const ctx = makeCtx();
    try {
      const baseMs = 1699000000000;
      const id1 = insertTask(ctx.db, { state: 'queued', title: 'First',  createdAt: baseMs });
      const id2 = insertTask(ctx.db, { state: 'queued', title: 'Second', createdAt: baseMs + 5000 });

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
      expect(body.queued_tasks).toHaveLength(2);
      expect(body.queued_tasks[0]?.id_prefix).toBe(id1.slice(0, 8));
      expect(body.queued_tasks[1]?.id_prefix).toBe(id2.slice(0, 8));
    } finally {
      cleanup(ctx);
    }
  });
});

/**
 * Tier 1 tests: `recent_events` field in `GET /overview`.
 *
 * Verifies that the `GET /overview` endpoint:
 *   - includes `recent_events: []` when the `events` table is empty,
 *   - includes `recent_events: []` when the DB is absent,
 *   - includes `recent_events: []` when no events have been processed yet,
 *   - returns the most recent processed events ordered by `received_at DESC`,
 *   - caps the result at 10 rows,
 *   - maps `pr_number IS NULL` to `null` in each row,
 *   - maps `wake_triggered = 1` to `true` and `0` to `false`.
 *
 * Uses `createWebRoutes` directly with a real (in-memory) SQLite DB injected
 * via the `db` dep — no network, no session files on disk.
 * See BACKLOG.md § P2.47.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createWebRoutes, type OverviewResponse, type OverviewRecentEvent } from '../../../src/web-routes.js';
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-re-t1-'));
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

/**
 * Insert an event with specific fields using db.raw() directly, since
 * insertEvent does not expose received_at or event_type as parameters.
 */
function insertEventRaw(
  db: Database,
  opts: {
    repo: string;
    prNumber: number | null;
    eventType: string;
    receivedAt: number;
  },
): number {
  const stmt = db.raw().prepare<{
    repo: string;
    pr_number: number | null;
    event_type: string;
    received_at: number;
  }>(
    `INSERT INTO events (repo, pr_number, event_type, payload, received_at)
     VALUES (@repo, @pr_number, @event_type, '{}', @received_at)`,
  );
  const result = stmt.run({
    repo: opts.repo,
    pr_number: opts.prNumber,
    event_type: opts.eventType,
    received_at: opts.receivedAt,
  });
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /overview recent_events field (BACKLOG.md § P2.47)', () => {
  it('returns recent_events: [] when the events table is empty', async () => {
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
      expect(body.recent_events).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns recent_events: [] when the db dep is absent', async () => {
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
      expect(body.recent_events).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns recent_events: [] when events exist but none are processed', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      // Insert event but do NOT call updateEventProcessed
      insertEventRaw(ctx.db, {
        repo: 'org/repo',
        prNumber: 1,
        eventType: 'check_run',
        receivedAt: nowS,
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
      expect(body.recent_events).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns the processed event with correct fields', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const id = insertEventRaw(ctx.db, {
        repo: 'org/my-repo',
        prNumber: 42,
        eventType: 'check_run',
        receivedAt: nowS,
      });
      ctx.db.updateEventProcessed(id, true);

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
      expect(body.recent_events).toHaveLength(1);
      const ev = body.recent_events[0] as OverviewRecentEvent;
      expect(ev.event_type).toBe('check_run');
      expect(ev.repo).toBe('org/my-repo');
      expect(ev.pr_number).toBe(42);
      expect(ev.wake_triggered).toBe(true);
      expect(ev.received_at).toBe(nowS);
    } finally {
      cleanup(ctx);
    }
  });

  it('maps wake_triggered = 0 to false', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const id = insertEventRaw(ctx.db, {
        repo: 'org/repo',
        prNumber: 7,
        eventType: 'issue_comment',
        receivedAt: nowS,
      });
      ctx.db.updateEventProcessed(id, false); // no wake

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
      const body = (await res.json()) as OverviewResponse;
      expect(body.recent_events[0]?.wake_triggered).toBe(false);
    } finally {
      cleanup(ctx);
    }
  });

  it('maps pr_number IS NULL to null in the response', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const id = insertEventRaw(ctx.db, {
        repo: 'org/repo',
        prNumber: null, // not PR-scoped
        eventType: 'push',
        receivedAt: nowS,
      });
      ctx.db.updateEventProcessed(id, false);

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
      const body = (await res.json()) as OverviewResponse;
      expect(body.recent_events[0]?.pr_number).toBeNull();
    } finally {
      cleanup(ctx);
    }
  });

  it('returns events ordered by received_at DESC (most recent first)', async () => {
    const ctx = makeCtx();
    try {
      const base = Math.floor(Date.now() / 1000);
      // Insert three events: oldest, middle, newest
      const id1 = insertEventRaw(ctx.db, { repo: 'org/repo', prNumber: 1, eventType: 'check_run', receivedAt: base - 200 });
      ctx.db.updateEventProcessed(id1, false);
      const id2 = insertEventRaw(ctx.db, { repo: 'org/repo', prNumber: 2, eventType: 'issue_comment', receivedAt: base - 100 });
      ctx.db.updateEventProcessed(id2, false);
      const id3 = insertEventRaw(ctx.db, { repo: 'org/repo', prNumber: 3, eventType: 'pull_request_review_comment', receivedAt: base });
      ctx.db.updateEventProcessed(id3, true);

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
      const body = (await res.json()) as OverviewResponse;
      expect(body.recent_events).toHaveLength(3);
      // Most recent first
      expect(body.recent_events[0]?.received_at).toBe(base);
      expect(body.recent_events[1]?.received_at).toBe(base - 100);
      expect(body.recent_events[2]?.received_at).toBe(base - 200);
    } finally {
      cleanup(ctx);
    }
  });

  it('caps the result at 10 rows when more than 10 events are processed', async () => {
    const ctx = makeCtx();
    try {
      const base = Math.floor(Date.now() / 1000);
      // Insert 12 processed events
      for (let i = 0; i < 12; i++) {
        const id = insertEventRaw(ctx.db, {
          repo: 'org/repo',
          prNumber: i + 1,
          eventType: 'check_run',
          receivedAt: base + i,
        });
        ctx.db.updateEventProcessed(id, false);
      }

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
      const body = (await res.json()) as OverviewResponse;
      // Cap at 10
      expect(body.recent_events).toHaveLength(10);
      // Should be the 10 most recent (highest received_at)
      const received = body.recent_events.map((e) => e.received_at);
      const maxReceived = base + 11; // most recent
      expect(received[0]).toBe(maxReceived);
    } finally {
      cleanup(ctx);
    }
  });

  it('excludes unprocessed events even when more processed events exist', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      // One processed event
      const id1 = insertEventRaw(ctx.db, { repo: 'org/repo', prNumber: 1, eventType: 'check_run', receivedAt: nowS });
      ctx.db.updateEventProcessed(id1, true);
      // One unprocessed event (should not appear)
      insertEventRaw(ctx.db, { repo: 'org/repo', prNumber: 2, eventType: 'issue_comment', receivedAt: nowS + 1 });

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
      const body = (await res.json()) as OverviewResponse;
      // Only the processed event appears
      expect(body.recent_events).toHaveLength(1);
      expect(body.recent_events[0]?.event_type).toBe('check_run');
    } finally {
      cleanup(ctx);
    }
  });

  it('always returns an array (never undefined)', async () => {
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
      const body = (await res.json()) as OverviewResponse;
      expect(Array.isArray(body.recent_events)).toBe(true);
    } finally {
      cleanup(ctx);
    }
  });
});

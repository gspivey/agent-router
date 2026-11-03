/**
 * Tier 1 tests: `events_processed_24h` field in `GET /overview`.
 *
 * Verifies that the `GET /overview` endpoint:
 *   - includes `events_processed_24h` with the correct count when the
 *     `events` table has processed rows with received_at >= now-86400
 *     (BACKLOG.md § P2.37), and
 *   - returns `events_processed_24h: 0` when the table is empty, when the DB
 *     is absent, or when all events are older than 24 hours.
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-ep24-t1-'));
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
 * Insert an event with a specific received_at timestamp by using db.raw()
 * directly, since the `insertEvent` helper sets received_at = now internally.
 */
function insertEventWithReceivedAt(
  db: Database,
  repo: string,
  prNumber: number,
  receivedAt: number,
): number {
  const stmt = db
    .raw()
    .prepare<{ repo: string; pr_number: number; received_at: number }>(
      `INSERT INTO events (repo, pr_number, event_type, payload, received_at)
       VALUES (@repo, @pr_number, 'check_run', '{}', @received_at)`,
    );
  const result = stmt.run({ repo, pr_number: prNumber, received_at: receivedAt });
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /overview events_processed_24h field (BACKLOG.md § P2.37)', () => {
  it('returns events_processed_24h: 0 when the events table is empty', async () => {
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
      expect(body.events_processed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns events_processed_24h: 0 when db dep is absent', async () => {
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
      expect(body.events_processed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns events_processed_24h: 0 when all events are older than 24h', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const oldReceivedAt = nowS - 86401; // more than 24h ago
      const eventId = insertEventWithReceivedAt(ctx.db, 'org/repo', 1, oldReceivedAt);
      ctx.db.updateEventProcessed(eventId, false);

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
      expect(body.events_processed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns events_processed_24h: 0 when events are recent but unprocessed', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      // Insert an event but do NOT call updateEventProcessed (processed_at remains NULL)
      insertEventWithReceivedAt(ctx.db, 'org/repo', 1, nowS);

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
      expect(body.events_processed_24h).toBe(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns events_processed_24h: 1 after inserting and processing one recent event', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const eventId = insertEventWithReceivedAt(ctx.db, 'org/repo', 7, nowS);
      ctx.db.updateEventProcessed(eventId, true);

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
      expect(body.events_processed_24h).toBe(1);
    } finally {
      cleanup(ctx);
    }
  });

  it('counts all processed events in the 24h window, not just wake-triggering ones', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      // Insert three events: two processed (one wake-triggering, one not), one unprocessed
      const id1 = insertEventWithReceivedAt(ctx.db, 'org/repo', 1, nowS);
      ctx.db.updateEventProcessed(id1, true); // wake-triggering

      const id2 = insertEventWithReceivedAt(ctx.db, 'org/repo', 2, nowS);
      ctx.db.updateEventProcessed(id2, false); // processed but no wake

      insertEventWithReceivedAt(ctx.db, 'org/repo', 3, nowS);
      // id3 NOT processed — processed_at remains NULL

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
      // Only 2 events are processed (regardless of wake_triggered value)
      expect(body.events_processed_24h).toBe(2);
    } finally {
      cleanup(ctx);
    }
  });

  it('excludes events older than 24h from the count', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      // One recent processed event (100 seconds ago — within window)
      const recentId = insertEventWithReceivedAt(ctx.db, 'org/repo', 1, nowS - 100);
      ctx.db.updateEventProcessed(recentId, false);

      // One old processed event (older than 24h — outside window)
      const oldId = insertEventWithReceivedAt(ctx.db, 'org/repo', 2, nowS - 90000);
      ctx.db.updateEventProcessed(oldId, false);

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
      // Only the recent event falls within the 24h window
      expect(body.events_processed_24h).toBe(1);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns HTTP 200 regardless of events_processed_24h value', async () => {
    const ctx = makeCtx();
    try {
      const nowS = Math.floor(Date.now() / 1000);
      const eventId = insertEventWithReceivedAt(ctx.db, 'org/repo', 99, nowS);
      ctx.db.updateEventProcessed(eventId, false);

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

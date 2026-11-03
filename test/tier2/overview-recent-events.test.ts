/**
 * Tier 2 tests: `recent_events` field in `GET /overview`.
 *
 * Verifies that `GET /overview` correctly surfaces recent processed webhook
 * events (BACKLOG.md § P2.47) through the full web-server stack:
 *
 * - When the `events` table is empty, `recent_events` is `[]`.
 * - When an event is inserted and processed, `recent_events` contains it.
 * - Unprocessed events (processed_at IS NULL) are excluded.
 * - Events are ordered by `received_at DESC`.
 * - `pr_number` is `null` when the DB row has `pr_number IS NULL`.
 * - `wake_triggered` reflects the DB value accurately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionFiles } from '../../src/session-files.js';
import type { SessionFiles } from '../../src/session-files.js';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';
import { createDaemonTokenStore } from '../../src/daemon-token.js';
import type { DaemonTokenStore } from '../../src/daemon-token.js';
import { createSSEBroker } from '../../src/sse-broker.js';
import type { SSEBroker } from '../../src/sse-broker.js';
import { createWebApp, startWebServer } from '../../src/web-server.js';
import { initDatabase } from '../../src/db.js';
import type { Database } from '../../src/db.js';
import type { SessionManager } from '../../src/session-mgr.js';
import type { AgentRouterConfig } from '../../src/config.js';
import type { OverviewResponse, OverviewRecentEvent } from '../../src/web-routes.js';
import type { ServerType } from '@hono/node-server';

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

function makeBaseConfig(controlPort: number): AgentRouterConfig {
  return {
    port: 3000,
    controlPort,
    webhookSecret: 'test-secret',
    kiroPath: process.execPath,
    repos: [{ owner: 'org', name: 'repo' }],
    cron: [],
  } as unknown as AgentRouterConfig;
}

/**
 * Insert an event with specific fields directly into the DB, bypassing the
 * `insertEvent` helper which sets received_at = now internally.
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

describe('Tier 2: GET /overview recent_events field (BACKLOG.md § P2.47)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let db: Database;
  let webServer: ServerType;
  let baseUrl: string;
  let bearerToken: string;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-re-tier2-'));
    const dbPath = path.join(rootDir, 'agent-router.db');
    db = initDatabase(dbPath);
    log = createLogger({ level: 'error' });
    sessionFiles = createSessionFiles(rootDir);
    tokenStore = createDaemonTokenStore({ rootDir, log });
    sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
    bearerToken = tokenStore.read();
  });

  afterEach(async () => {
    if (webServer) {
      await new Promise<void>((resolve) => webServer.close(() => resolve()));
    }
    sseBroker.shutdown();
    await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  async function startServer(port: number): Promise<void> {
    const config = makeBaseConfig(port);
    const app = createWebApp({
      sessionMgr: stubSessionMgr(),
      sessionFiles,
      sseBroker,
      tokenStore,
      log,
      rootDir,
      config,
      shuttingDown: () => false,
      db,
    });
    webServer = startWebServer(app, config, log);
    baseUrl = `http://127.0.0.1:${port}`;
    await new Promise((r) => setTimeout(r, 20));
  }

  async function getFreePort(): Promise<number> {
    const { createServer } = await import('node:net');
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  it('GET /overview returns recent_events: [] when the events table is empty', async () => {
    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.recent_events).toEqual([]);
  });

  it('GET /overview returns the processed event with correct fields', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const id = insertEventRaw(db, {
      repo: 'org/my-repo',
      prNumber: 42,
      eventType: 'check_run',
      receivedAt: nowS,
    });
    db.updateEventProcessed(id, true);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.recent_events).toHaveLength(1);
    const ev = body.recent_events[0] as OverviewRecentEvent;
    expect(ev.event_type).toBe('check_run');
    expect(ev.repo).toBe('org/my-repo');
    expect(ev.pr_number).toBe(42);
    expect(ev.wake_triggered).toBe(true);
    expect(ev.received_at).toBe(nowS);
  });

  it('GET /overview excludes unprocessed events from recent_events', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    // Insert event but do NOT process it
    insertEventRaw(db, { repo: 'org/repo', prNumber: 1, eventType: 'check_run', receivedAt: nowS });

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.recent_events).toEqual([]);
  });

  it('GET /overview returns recent_events ordered by received_at DESC', async () => {
    const base = Math.floor(Date.now() / 1000);
    const id1 = insertEventRaw(db, { repo: 'org/repo', prNumber: 1, eventType: 'check_run', receivedAt: base - 200 });
    db.updateEventProcessed(id1, false);
    const id2 = insertEventRaw(db, { repo: 'org/repo', prNumber: 2, eventType: 'issue_comment', receivedAt: base });
    db.updateEventProcessed(id2, true);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.recent_events).toHaveLength(2);
    // Most recent first
    expect(body.recent_events[0]?.received_at).toBe(base);
    expect(body.recent_events[1]?.received_at).toBe(base - 200);
  });

  it('GET /overview maps pr_number IS NULL to null', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const id = insertEventRaw(db, { repo: 'org/repo', prNumber: null, eventType: 'push', receivedAt: nowS });
    db.updateEventProcessed(id, false);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.recent_events[0]?.pr_number).toBeNull();
  });

  it('GET /overview maps wake_triggered=0 to false in recent_events', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const id = insertEventRaw(db, { repo: 'org/repo', prNumber: 5, eventType: 'issue_comment', receivedAt: nowS });
    db.updateEventProcessed(id, false); // no wake

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.recent_events[0]?.wake_triggered).toBe(false);
  });
});

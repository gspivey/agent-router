/**
 * Tier 2 tests: `events_processed_24h` field in `GET /overview`.
 *
 * Verifies that `GET /overview` correctly surfaces the count of events
 * processed in the last 24 hours (BACKLOG.md § P2.37) through the full
 * web-server stack:
 *
 * - When the `events` table is empty, `events_processed_24h` is 0.
 * - When an event is inserted and processed, `events_processed_24h` is 1.
 * - Events with received_at older than 24h are excluded from the count.
 * - Unprocessed events (processed_at IS NULL) are excluded from the count.
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
import type { OverviewResponse } from '../../src/web-routes.js';
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
 * Insert an event with a specific received_at timestamp directly into the DB,
 * since `db.insertEvent` sets received_at = now internally.
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

describe('Tier 2: GET /overview events_processed_24h field (BACKLOG.md § P2.37)', () => {
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
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-ep24-tier2-'));
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

  it('GET /overview returns events_processed_24h: 0 when the events table is empty', async () => {
    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.events_processed_24h).toBe(0);
  });

  it('GET /overview returns events_processed_24h: 1 after inserting and processing one recent event', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const eventId = insertEventWithReceivedAt(db, 'org/repo', 42, nowS);
    db.updateEventProcessed(eventId, true);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.events_processed_24h).toBe(1);
  });

  it('GET /overview excludes unprocessed events (processed_at IS NULL)', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    insertEventWithReceivedAt(db, 'org/repo', 1, nowS);
    // Event NOT processed — processed_at remains NULL

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.events_processed_24h).toBe(0);
  });

  it('GET /overview excludes events older than 24h', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    // Old processed event (25 hours ago)
    const oldId = insertEventWithReceivedAt(db, 'org/repo', 1, nowS - 90000);
    db.updateEventProcessed(oldId, false);

    // Recent processed event
    const recentId = insertEventWithReceivedAt(db, 'org/repo', 2, nowS - 60);
    db.updateEventProcessed(recentId, false);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.events_processed_24h).toBe(1);
  });

  it('GET /overview counts both wake-triggering and non-wake-triggering processed events', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const id1 = insertEventWithReceivedAt(db, 'org/repo', 1, nowS);
    db.updateEventProcessed(id1, true); // wake_triggered = 1

    const id2 = insertEventWithReceivedAt(db, 'org/repo', 2, nowS);
    db.updateEventProcessed(id2, false); // wake_triggered = 0

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.events_processed_24h).toBe(2);
  });
});

/**
 * Tier 2 tests: `pending_wakes_count` field in `GET /overview`.
 *
 * Verifies that `GET /overview` correctly surfaces the count of rows in the
 * `pending_wakes` table (BACKLOG.md § P2.34) through the full web-server stack:
 *
 * - When the `pending_wakes` table is empty, `pending_wakes_count` is 0.
 * - When a pending wake is inserted into the DB, `pending_wakes_count` is 1.
 * - Upserts to the same `(repo, pr)` do not inflate the count beyond 1.
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

describe('Tier 2: GET /overview pending_wakes_count field (BACKLOG.md § P2.34)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let db: Database;
  let webServer: ServerType;
  let controlPort: number;
  let baseUrl: string;
  let bearerToken: string;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-pw-tier2-'));
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
    controlPort = port;
    baseUrl = `http://127.0.0.1:${controlPort}`;
    // Small pause for server to bind
    await new Promise((r) => setTimeout(r, 20));
  }

  /** Find a free port by binding to :0 then closing. */
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

  it('GET /overview returns pending_wakes_count: 0 when table is empty', async () => {
    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.pending_wakes_count).toBe(0);
  });

  it('GET /overview returns pending_wakes_count: 1 after inserting one pending wake', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const eventId = db.insertEvent({
      repo: 'org/repo',
      prNumber: 42,
      eventType: 'check_run',
      payload: '{}',
      receivedAt: nowS,
    });
    db.upsertPendingWake('org/repo', 42, eventId, nowS + 60);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.pending_wakes_count).toBe(1);
  });

  it('GET /overview pending_wakes_count stays 1 when the same (repo, pr) is upserted twice', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const ev1 = db.insertEvent({
      repo: 'org/repo',
      prNumber: 7,
      eventType: 'check_run',
      payload: '{}',
      receivedAt: nowS,
    });
    const ev2 = db.insertEvent({
      repo: 'org/repo',
      prNumber: 7,
      eventType: 'check_run',
      payload: '{}',
      receivedAt: nowS + 1,
    });
    db.upsertPendingWake('org/repo', 7, ev1, nowS + 60);
    // Upsert the same (repo, pr) — coalesces, not additive.
    db.upsertPendingWake('org/repo', 7, ev2, nowS + 90);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.pending_wakes_count).toBe(1);
  });

  it('GET /overview returns pending_wakes_count: 2 for two different PRs', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const ev1 = db.insertEvent({
      repo: 'org/repo',
      prNumber: 1,
      eventType: 'check_run',
      payload: '{}',
      receivedAt: nowS,
    });
    const ev2 = db.insertEvent({
      repo: 'org/repo',
      prNumber: 2,
      eventType: 'check_run',
      payload: '{}',
      receivedAt: nowS,
    });
    db.upsertPendingWake('org/repo', 1, ev1, nowS + 60);
    db.upsertPendingWake('org/repo', 2, ev2, nowS + 60);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.pending_wakes_count).toBe(2);
  });
});

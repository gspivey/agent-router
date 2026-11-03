/**
 * Tier 2 tests: `tasks_succeeded_24h` and `tasks_failed_24h` fields in
 * `GET /overview`.
 *
 * Verifies that `GET /overview` correctly surfaces the 24-hour task outcome
 * counts (BACKLOG.md § P2.42) through the full web-server stack:
 *
 * - When the tasks table is empty, both counts are 0.
 * - When a succeeded task is inserted with a recent updated_at, tasks_succeeded_24h is 1.
 * - When a failed task is inserted with a recent updated_at, tasks_failed_24h is 1.
 * - Tasks with updated_at older than 24h are excluded from both counts.
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
import { initTaskDatabase } from '../../src/task-db.js';
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
 * Insert a task row with a specific `state` and `updated_at` timestamp.
 * Tasks use unix-ms timestamps.
 */
function insertTaskWithState(
  db: Database,
  state: 'succeeded' | 'failed' | 'queued' | 'running',
  updatedAtMs: number,
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
      created_at: updatedAtMs,
      updated_at: updatedAtMs,
    });
}

describe('Tier 2: GET /overview tasks_succeeded_24h and tasks_failed_24h fields (BACKLOG.md § P2.42)', () => {
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
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-ts24-tier2-'));
    const dbPath = path.join(rootDir, 'agent-router.db');
    db = initDatabase(dbPath);
    // Initialize the task DB schema on the same connection.
    initTaskDatabase(db.raw());
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

  it('GET /overview returns both task counts as 0 when the tasks table is empty', async () => {
    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.tasks_succeeded_24h).toBe(0);
    expect(body.tasks_failed_24h).toBe(0);
  });

  it('GET /overview returns tasks_succeeded_24h: 1 after inserting one recent succeeded task', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const recentMs = (nowS - 60) * 1000; // 1 minute ago
    insertTaskWithState(db, 'succeeded', recentMs);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.tasks_succeeded_24h).toBe(1);
    expect(body.tasks_failed_24h).toBe(0);
  });

  it('GET /overview returns tasks_failed_24h: 1 after inserting one recent failed task', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const recentMs = (nowS - 3600) * 1000; // 1 hour ago
    insertTaskWithState(db, 'failed', recentMs);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.tasks_succeeded_24h).toBe(0);
    expect(body.tasks_failed_24h).toBe(1);
  });

  it('GET /overview excludes tasks with updated_at older than 24h', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const recentMs = (nowS - 60) * 1000;    // 1 minute ago (included)
    const oldMs    = (nowS - 90000) * 1000; // 25 hours ago (excluded)

    insertTaskWithState(db, 'succeeded', recentMs);
    insertTaskWithState(db, 'succeeded', oldMs); // should be excluded
    insertTaskWithState(db, 'failed', oldMs);    // should be excluded

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.tasks_succeeded_24h).toBe(1);
    expect(body.tasks_failed_24h).toBe(0);
  });

  it('GET /overview counts succeeded and failed independently', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const recentMs = (nowS - 3600) * 1000; // 1 hour ago

    insertTaskWithState(db, 'succeeded', recentMs);
    insertTaskWithState(db, 'succeeded', recentMs);
    insertTaskWithState(db, 'failed', recentMs);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.tasks_succeeded_24h).toBe(2);
    expect(body.tasks_failed_24h).toBe(1);
  });
});

/**
 * Tier 2 tests: `last_fired_at` in `GET /overview` cron_summary (BACKLOG.md § P2.53).
 *
 * Verifies that `GET /overview` correctly surfaces `last_fired_at` in
 * `cron_summary` through the full web-server stack:
 *
 * - When a cron has never fired, `last_fired_at` is null.
 * - After `db.setLastFiredAt` is called, `GET /overview` returns the
 *   ISO timestamp in the matching cron_summary row.
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
    cron: [
      {
        name: 'nightly-tasks',
        schedule: '0 9 * * *',
        repo: 'org/repo',
        promptFile: '/etc/prompt.md',
      },
    ],
  } as unknown as AgentRouterConfig;
}

describe('Tier 2: GET /overview cron_summary last_fired_at (BACKLOG.md § P2.53)', () => {
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
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-cron-lfa-tier2-'));
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

  it('GET /overview returns last_fired_at: null when the cron has never fired', async () => {
    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.cron_summary).toHaveLength(1);
    expect(body.cron_summary[0]!.name).toBe('nightly-tasks');
    expect(body.cron_summary[0]!.last_fired_at).toBeNull();
  });

  it('GET /overview returns the ISO timestamp after db.setLastFiredAt is called', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    db.setLastFiredAt('nightly-tasks', nowS);

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.cron_summary).toHaveLength(1);
    const cronRow = body.cron_summary[0]!;
    expect(cronRow.name).toBe('nightly-tasks');
    expect(cronRow.last_fired_at).not.toBeNull();
    // The ISO string should round-trip: parse it and compare to the stored unix second.
    const parsed = new Date(cronRow.last_fired_at!).getTime() / 1000;
    expect(parsed).toBe(nowS);
  });

  it('GET /overview reflects updated last_fired_at on subsequent fires', async () => {
    const firstFireS = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    db.setLastFiredAt('nightly-tasks', firstFireS);

    await startServer(await getFreePort());

    // First fetch — see the first fire time
    const res1 = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    const body1 = (await res1.json()) as OverviewResponse;
    expect(body1.cron_summary[0]!.last_fired_at).toBe(new Date(firstFireS * 1000).toISOString());

    // Simulate a second fire
    const secondFireS = Math.floor(Date.now() / 1000);
    db.setLastFiredAt('nightly-tasks', secondFireS);

    // Second fetch — should see updated time
    const res2 = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    const body2 = (await res2.json()) as OverviewResponse;
    expect(body2.cron_summary[0]!.last_fired_at).toBe(new Date(secondFireS * 1000).toISOString());
  });
});

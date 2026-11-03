/**
 * Tier 2 tests: `active_sessions_by_repo` field in `GET /overview`.
 *
 * Verifies that `GET /overview` correctly surfaces the per-repo session
 * activity breakdown (BACKLOG.md § P2.45) through the full web-server stack:
 *
 * - When no sessions exist, `active_sessions_by_repo` is an empty array.
 * - Active sessions contribute to the `active` count for their repo.
 * - Terminal sessions with `completed_at` in the last 24h contribute to
 *   `completed_24h` for their repo.
 * - Sessions with no `repo` field are excluded from the breakdown.
 * - Results are sorted by `active` descending, then `completed_24h` descending.
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
    repos: [{ owner: 'org', name: 'repo-a' }, { owner: 'org', name: 'repo-b' }],
    cron: [],
  } as unknown as AgentRouterConfig;
}

describe('Tier 2: GET /overview active_sessions_by_repo field (BACKLOG.md § P2.45)', () => {
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
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-sbr-tier2-'));
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

  it('returns active_sessions_by_repo: [] when no sessions exist', async () => {
    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(Array.isArray(body.active_sessions_by_repo)).toBe(true);
    expect(body.active_sessions_by_repo).toHaveLength(0);
  });

  it('counts active sessions per repo', async () => {
    // Two active sessions for org/repo-a, one for org/repo-b
    sessionFiles.createSession('sess-a1', 'p1');
    sessionFiles.updateMeta('sess-a1', { repo: 'org/repo-a' });

    sessionFiles.createSession('sess-a2', 'p2');
    sessionFiles.updateMeta('sess-a2', { repo: 'org/repo-a' });

    sessionFiles.createSession('sess-b1', 'p3');
    sessionFiles.updateMeta('sess-b1', { repo: 'org/repo-b' });

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    const rows = body.active_sessions_by_repo;
    const a = rows.find((r) => r.repo === 'org/repo-a');
    const b = rows.find((r) => r.repo === 'org/repo-b');
    expect(a?.active).toBe(2);
    expect(b?.active).toBe(1);
  });

  it('counts completed_24h for terminal sessions with recent completed_at', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    // One completed session within 24h for org/repo-a
    sessionFiles.createSession('sess-c1', 'done');
    sessionFiles.updateMeta('sess-c1', { repo: 'org/repo-a' });
    // Terminal update: must set completed_at at the same time as status
    sessionFiles.updateMeta('sess-c1', { status: 'completed', completed_at: nowS - 300 });

    // One old completed session (> 24h ago) — should NOT be counted in completed_24h
    sessionFiles.createSession('sess-c2', 'old');
    sessionFiles.updateMeta('sess-c2', { repo: 'org/repo-a' });
    sessionFiles.updateMeta('sess-c2', { status: 'completed', completed_at: nowS - 90000 });

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    const a = body.active_sessions_by_repo.find((r) => r.repo === 'org/repo-a');
    expect(a?.completed_24h).toBe(1);
    expect(a?.active).toBe(0);
  });

  it('excludes sessions with no repo from the breakdown', async () => {
    // Session with no repo field — just create, don't updateMeta with repo
    sessionFiles.createSession('sess-nr1', 'no repo');

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    // The session without a repo should not appear in the breakdown
    expect(body.active_sessions_by_repo).toHaveLength(0);
  });

  it('sorts rows by active descending, then completed_24h descending', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    // repo-a: 1 active, 0 completed_24h
    sessionFiles.createSession('a1', 'pa');
    sessionFiles.updateMeta('a1', { repo: 'org/repo-a' });

    // repo-b: 2 active, 1 completed_24h  ← should be first (2 active)
    sessionFiles.createSession('b1', 'pb1');
    sessionFiles.updateMeta('b1', { repo: 'org/repo-b' });
    sessionFiles.createSession('b2', 'pb2');
    sessionFiles.updateMeta('b2', { repo: 'org/repo-b' });
    sessionFiles.createSession('b3', 'pb3');
    sessionFiles.updateMeta('b3', { repo: 'org/repo-b' });
    sessionFiles.updateMeta('b3', { status: 'completed', completed_at: nowS - 300 });

    // repo-c: 0 active, 2 completed_24h
    sessionFiles.createSession('c1', 'pc1');
    sessionFiles.updateMeta('c1', { repo: 'org/repo-c' });
    sessionFiles.updateMeta('c1', { status: 'completed', completed_at: nowS - 400 });
    sessionFiles.createSession('c2', 'pc2');
    sessionFiles.updateMeta('c2', { repo: 'org/repo-c' });
    sessionFiles.updateMeta('c2', { status: 'completed', completed_at: nowS - 500 });

    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    const rows = body.active_sessions_by_repo;

    // repo-b (2 active) should be first
    expect(rows[0]?.repo).toBe('org/repo-b');
    // repo-a (1 active) should be second
    expect(rows[1]?.repo).toBe('org/repo-a');
    // repo-c (0 active, 2 completed_24h) should be third
    expect(rows[2]?.repo).toBe('org/repo-c');
  });

  it('active_sessions_by_repo is always present (never undefined)', async () => {
    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.active_sessions_by_repo).toBeDefined();
    expect(Array.isArray(body.active_sessions_by_repo)).toBe(true);
  });
});

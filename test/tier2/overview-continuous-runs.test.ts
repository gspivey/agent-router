/**
 * Tier 2 tests: `continuous_runs` field in `GET /overview`.
 *
 * Verifies that `GET /overview` correctly surfaces the list of continuous runs
 * (BACKLOG.md § P2.35) through the full web-server stack:
 *
 * - When no `continuousRuns` getter is supplied, `continuous_runs` is absent.
 * - When the getter returns an empty array, `continuous_runs` is [].
 * - When the getter returns one running DTO, the field is surfaced correctly.
 * - When the getter is updated between requests, the second request reflects
 *   the new state (no snapshotting).
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
import type { SessionManager } from '../../src/session-mgr.js';
import type { AgentRouterConfig } from '../../src/config.js';
import type { OverviewResponse } from '../../src/web-routes.js';
import type { ContinuousRunDTO } from '../../src/continuous-runner.js';
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

function makeRunningDTO(repo: string): ContinuousRunDTO {
  return {
    repo,
    status: 'running',
    items_completed: 2,
    current_session_id: 'sess-xyz',
    started_at: Math.floor(Date.now() / 1000) - 60,
  };
}

describe('Tier 2: GET /overview continuous_runs field (BACKLOG.md § P2.35)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let baseUrl: string;
  let bearerToken: string;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-cr-tier2-'));
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
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  async function startServer(
    port: number,
    continuousRuns?: () => ContinuousRunDTO[],
  ): Promise<void> {
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
      ...(continuousRuns !== undefined ? { continuousRuns } : {}),
    });
    webServer = startWebServer(app, config, log);
    baseUrl = `http://127.0.0.1:${port}`;
    // Small pause for server to bind
    await new Promise((r) => setTimeout(r, 20));
  }

  it('GET /overview omits continuous_runs when getter is not provided', async () => {
    await startServer(await getFreePort());
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.continuous_runs).toBeUndefined();
  });

  it('GET /overview returns continuous_runs: [] when getter returns empty array', async () => {
    await startServer(await getFreePort(), () => []);
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.continuous_runs).toEqual([]);
  });

  it('GET /overview includes running DTO with correct fields', async () => {
    const dto = makeRunningDTO('org/my-repo');
    await startServer(await getFreePort(), () => [dto]);
    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.continuous_runs).toHaveLength(1);
    const run = body.continuous_runs?.[0];
    expect(run?.repo).toBe('org/my-repo');
    expect(run?.status).toBe('running');
    expect(run?.items_completed).toBe(2);
    expect(run?.current_session_id).toBe('sess-xyz');
  });

  it('GET /overview reflects live getter state on each request', async () => {
    const runs: ContinuousRunDTO[] = [makeRunningDTO('org/live-repo')];
    await startServer(await getFreePort(), () => [...runs]);

    // First request: one running run.
    const res1 = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as OverviewResponse;
    expect(body1.continuous_runs).toHaveLength(1);

    // Mutate the array — simulates the run finishing.
    runs.length = 0;

    // Second request: no runs.
    const res2 = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as OverviewResponse;
    expect(body2.continuous_runs).toHaveLength(0);
  });
});

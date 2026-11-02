/**
 * Tier 2 tests: `restart_required` field in `GET /overview`.
 *
 * Verifies that `GET /overview` correctly surfaces the restart-required
 * condition (BACKLOG.md § P2.30) through the full web-server stack:
 *
 * - When `restartRequired` getter returns null, the field is absent from the
 *   response.
 * - When `restartRequired` getter returns a condition (simulating a config
 *   reload that changed a restart-required field), the field is present and
 *   contains the correct data.
 * - Authenticated requests succeed; unauthenticated requests get 401.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
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
import { createRestartRequiredState } from '../../src/restart-required.js';
import type { OverviewResponse } from '../../src/web-routes.js';
import type { ServerType } from '@hono/node-server';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = (addr as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
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

function makeBaseConfig(overrides?: Partial<AgentRouterConfig>): AgentRouterConfig {
  return {
    port: 3000,
    controlPort: 3100,
    webhookSecret: 'test-secret',
    kiroPath: process.execPath,
    repos: [{ owner: 'org', name: 'repo' }],
    cron: [],
    ...overrides,
  } as AgentRouterConfig;
}

describe('Tier 2: GET /overview restart_required field (BACKLOG.md § P2.30)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;
  let baseUrl: string;
  let bearerToken: string;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-rr-tier2-'));
    sessionFiles = createSessionFiles(rootDir);
    log = createLogger({ level: 'error', output: () => {} });
    tokenStore = createDaemonTokenStore({ rootDir, log });
    sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
    controlPort = await getFreePort();
    bearerToken = tokenStore.read();
  });

  afterEach(async () => {
    if (webServer) {
      await new Promise<void>((resolve) => webServer.close(() => resolve()));
    }
    sseBroker.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  async function startWithRestartRequired(
    restartRequired: () => ReturnType<ReturnType<typeof createRestartRequiredState>['get']>,
  ): Promise<void> {
    const config = makeBaseConfig({ controlPort });
    const app = createWebApp({
      sessionMgr: stubSessionMgr(),
      sessionFiles,
      sseBroker,
      tokenStore,
      log,
      rootDir,
      config,
      shuttingDown: () => false,
      restartRequired,
    });
    webServer = startWebServer(app, config, log);
    // Small pause for server to bind
    await new Promise((r) => setTimeout(r, 20));
    baseUrl = `http://127.0.0.1:${controlPort}`;
  }

  it('GET /overview omits restart_required when condition is null', async () => {
    const rrState = createRestartRequiredState();
    await startWithRestartRequired(() => rrState.get()); // starts null

    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body).not.toHaveProperty('restart_required');
  });

  it('GET /overview includes restart_required when condition is set', async () => {
    const rrState = createRestartRequiredState();

    // Simulate a config reload that changed kiroPath
    const startupConfig = makeBaseConfig();
    const reloadedConfig = makeBaseConfig({ kiroPath: '/different/path/to/kiro' });
    rrState.update(startupConfig, reloadedConfig);

    await startWithRestartRequired(() => rrState.get());

    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.restart_required).toBeDefined();
    expect(body.restart_required?.fields).toContain('kiroPath');
    // since must be a valid ISO 8601 string
    expect(typeof body.restart_required?.since).toBe('string');
    const sinceDate = new Date(body.restart_required?.since ?? '');
    expect(Number.isNaN(sinceDate.getTime())).toBe(false);
  });

  it('GET /overview returns 401 without auth', async () => {
    const rrState = createRestartRequiredState();
    await startWithRestartRequired(() => rrState.get());

    const res = await fetch(`${baseUrl}/overview`);
    expect(res.status).toBe(401);
  });

  it('restart_required condition persists across multiple requests', async () => {
    const rrState = createRestartRequiredState();
    const startupConfig = makeBaseConfig();
    const reloadedConfig = makeBaseConfig({ controlPort: 9999 });
    rrState.update(startupConfig, reloadedConfig);

    await startWithRestartRequired(() => rrState.get());

    // Make two requests — condition should be present in both
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${baseUrl}/overview`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.restart_required?.fields).toContain('controlPort');
    }
  });

  it('restart_required omitted after condition is cleared', async () => {
    const rrState = createRestartRequiredState();
    const startupConfig = makeBaseConfig();

    // Set the condition
    rrState.update(startupConfig, makeBaseConfig({ kiroPath: '/different/kiro' }));

    await startWithRestartRequired(() => rrState.get());

    // Confirm it's initially present
    let res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    let body = (await res.json()) as OverviewResponse;
    expect(body.restart_required).toBeDefined();

    // Simulate config reverting to startup values (clears condition)
    rrState.update(startupConfig, startupConfig);

    // Condition should now be absent
    res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    body = (await res.json()) as OverviewResponse;
    expect(body).not.toHaveProperty('restart_required');
  });
});

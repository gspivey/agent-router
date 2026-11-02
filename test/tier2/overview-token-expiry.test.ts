/**
 * Tier 2 tests: `token_expiry` field in `GET /overview`.
 *
 * Verifies that `GET /overview` correctly surfaces the token expiry condition
 * (BACKLOG.md § P2.33) through the full web-server stack:
 *
 * - When `tokenExpiry` getter returns null (expiry is ok or not configured),
 *   the field is absent from the response.
 * - When `tokenExpiry` getter returns a warn/error condition (PAT approaching
 *   expiry), the field is present and contains `days_remaining`, `severity`,
 *   and `expires_at`.
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

/** Token expiry condition shape returned by the getter. */
interface TokenExpiryCondition {
  days_remaining: number;
  severity: 'warn' | 'error';
  expires_at: string;
}

describe('Tier 2: GET /overview token_expiry field (BACKLOG.md § P2.33)', () => {
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
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-te-tier2-'));
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

  async function startWithTokenExpiry(
    tokenExpiry: () => TokenExpiryCondition | null,
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
      tokenExpiry,
    });
    webServer = startWebServer(app, config, log);
    // Small pause for server to bind
    await new Promise((r) => setTimeout(r, 20));
    baseUrl = `http://127.0.0.1:${controlPort}`;
  }

  it('GET /overview omits token_expiry when getter returns null (ok severity)', async () => {
    await startWithTokenExpiry(() => null);

    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body).not.toHaveProperty('token_expiry');
  });

  it('GET /overview includes token_expiry with warn severity when PAT is near expiry', async () => {
    const expiresAt = '2027-06-01T00:00:00.000Z';
    await startWithTokenExpiry(() => ({
      days_remaining: 10,
      severity: 'warn',
      expires_at: expiresAt,
    }));

    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.token_expiry).toBeDefined();
    expect(body.token_expiry?.days_remaining).toBe(10);
    expect(body.token_expiry?.severity).toBe('warn');
    expect(body.token_expiry?.expires_at).toBe(expiresAt);
  });

  it('GET /overview includes token_expiry with error severity when PAT is imminent', async () => {
    const expiresAt = '2027-05-25T00:00:00.000Z';
    await startWithTokenExpiry(() => ({
      days_remaining: 1,
      severity: 'error',
      expires_at: expiresAt,
    }));

    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.token_expiry).toBeDefined();
    expect(body.token_expiry?.days_remaining).toBe(1);
    expect(body.token_expiry?.severity).toBe('error');
  });

  it('GET /overview includes token_expiry with negative days_remaining for expired token', async () => {
    const expiresAt = '2026-01-01T00:00:00.000Z';
    await startWithTokenExpiry(() => ({
      days_remaining: -30,
      severity: 'error',
      expires_at: expiresAt,
    }));

    const res = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.token_expiry).toBeDefined();
    expect(body.token_expiry?.days_remaining).toBe(-30);
    expect(body.token_expiry?.severity).toBe('error');
  });

  it('GET /overview returns 401 without auth (even with token_expiry condition set)', async () => {
    await startWithTokenExpiry(() => ({
      days_remaining: 5,
      severity: 'error',
      expires_at: new Date().toISOString(),
    }));

    const res = await fetch(`${baseUrl}/overview`);
    expect(res.status).toBe(401);
  });

  it('token_expiry condition is evaluated per-request (supports runtime clock changes)', async () => {
    let callCount = 0;
    await startWithTokenExpiry(() => {
      callCount += 1;
      return callCount === 1
        ? { days_remaining: 5, severity: 'error', expires_at: '2027-01-01T00:00:00.000Z' }
        : null;
    });

    // First request: condition present
    const res1 = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    const body1 = (await res1.json()) as OverviewResponse;
    expect(body1.token_expiry).toBeDefined();

    // Second request: getter returns null (simulates far-future expiry)
    const res2 = await fetch(`${baseUrl}/overview`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    const body2 = (await res2.json()) as OverviewResponse;
    expect(body2).not.toHaveProperty('token_expiry');
  });
});

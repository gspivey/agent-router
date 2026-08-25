/**
 * Auth token browser tests.
 * Verifies token is accessible via window.__DAEMON_TOKEN when bindPublic: false,
 * and absent when bindPublic: true.
 * Spec: .kiro/specs/browser-test-harness-v2/ · tasks 10.1, 10.2
 */
import { test as base, expect } from './fixtures.js';
import { test as playwrightBase } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as url from 'node:url';
import { createSessionFiles } from '../../src/session-files.js';
import { initDatabase } from '../../src/db.js';
import { createLogger } from '../../src/log.js';
import { createDaemonTokenStore } from '../../src/daemon-token.js';
import { createSSEBroker } from '../../src/sse-broker.js';
import { createWebApp, startWebServer } from '../../src/web-server.js';
import { createSessionManager } from '../../src/session-mgr.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import type { AgentRouterConfig } from '../../src/config.js';

base('token present when bindPublic is false (default)', async ({ page, baseUrl, token }) => {
  await page.goto(baseUrl);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pageToken = await page.evaluate('window.__DAEMON_TOKEN');
  expect(pageToken).toBe(token);
});

// For bindPublic: true, we need a custom fixture with different server config
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SLOW_MULTI_PROMPT = path.resolve(__dirname, '../scenarios/slow-multi-prompt.json');

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForTCP(port: number, host: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt(): void {
      if (Date.now() > deadline) {
        reject(new Error(`Server startup timeout: port ${port} not accepting after ${timeoutMs}ms`));
        return;
      }
      const sock = net.connect({ port, host });
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => { sock.destroy(); setTimeout(attempt, 50); });
    }
    attempt();
  });
}

playwrightBase('token absent when bindPublic is true', async ({ page }) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-test-public-'));
  const db = initDatabase(path.join(rootDir, 'agent-router.db'));
  const log = createLogger({ level: 'error', output: () => {} });
  const sessionFiles = createSessionFiles(rootDir);
  const tokenStore = createDaemonTokenStore({ rootDir, log });
  const token = tokenStore.read();
  const sseBroker = createSSEBroker({ sessionFiles, rootDir, log, pollIntervalMs: 50 });
  const kiro = new FakeKiroBackend();
  await kiro.loadScenario(SLOW_MULTI_PROMPT);
  const sessionManager = createSessionManager({
    db,
    sessionFiles,
    acpSpawner: () => {
      const cfg = kiro.spawnConfig();
      return spawnACPClient(cfg.command, cfg.args, cfg.env);
    },
    log,
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
  });

  const controlPort = await getFreePort();
  const config = { port: 9999, controlPort, bindPublic: true } as AgentRouterConfig;
  const app = createWebApp({
    sessionMgr: sessionManager,
    sessionFiles,
    sseBroker,
    tokenStore,
    log,
    rootDir,
    config,
    shuttingDown: () => false,
  });
  const server = startWebServer(app, config, log);
  await waitForTCP(controlPort, '127.0.0.1');

  try {
    // With bindPublic: true, need to inject auth header for API requests
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
    await page.goto(`http://127.0.0.1:${controlPort}`);

    const pageToken = await page.evaluate('window.__DAEMON_TOKEN');
    expect(pageToken).toBeUndefined();
  } finally {
    server.close();
    sseBroker.shutdown();
    await sessionManager.shutdown();
    await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

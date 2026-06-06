/**
 * Tier 2 test: Token-embedding security (task 14.7)
 *
 * Properties tested:
 * - GET / embeds daemon token in HTML when bound to loopback (Req 7.2)
 * - GET / does NOT embed daemon token when bindPublic: true (Req 7.3)
 * - GET /ui follows same embedding rules as GET /
 * - Token is not present in HTML when proxy proof header is sent (Req 7.3)
 *
 * Validates: Requirements 7.2, 7.3
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

describe('Token-embedding security (task 14.7)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-token-embed-tier2-'));
    sessionFiles = createSessionFiles(rootDir);
    log = createLogger({ level: 'error', output: () => {} });
    tokenStore = createDaemonTokenStore({ rootDir, log });
    sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
    controlPort = await getFreePort();
  });

  afterEach(() => {
    if (webServer) {
      webServer.close();
    }
    sseBroker.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function startApp(configOverrides: Partial<AgentRouterConfig> = {}): void {
    const config = {
      port: 9999,
      controlPort,
      bindPublic: false,
      ...configOverrides,
    } as AgentRouterConfig;

    const app = createWebApp({
      sessionMgr: stubSessionMgr(),
      sessionFiles,
      sseBroker,
      tokenStore,
      log,
      rootDir,
      config,
      shuttingDown: () => false,
    });
    webServer = startWebServer(app, config, log);
  }

  describe('loopback bind (default)', () => {
    it('GET / contains daemon token in HTML', async () => {
      startApp({ bindPublic: false });
      const token = tokenStore.read();

      const res = await fetch(`http://127.0.0.1:${controlPort}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`window.__DAEMON_TOKEN = '${token}'`);
    });

    it('GET /ui contains daemon token in HTML', async () => {
      startApp({ bindPublic: false });
      const token = tokenStore.read();

      const res = await fetch(`http://127.0.0.1:${controlPort}/ui`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`window.__DAEMON_TOKEN = '${token}'`);
    });
  });

  describe('public bind (bindPublic: true)', () => {
    it('GET / does NOT contain daemon token in HTML', async () => {
      startApp({ bindPublic: true });
      const token = tokenStore.read();

      const res = await fetch(`http://127.0.0.1:${controlPort}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain(token);
      expect(html).not.toContain('__DAEMON_TOKEN');
    });

    it('GET /ui does NOT contain daemon token in HTML', async () => {
      startApp({ bindPublic: true });
      const token = tokenStore.read();

      const res = await fetch(`http://127.0.0.1:${controlPort}/ui`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain(token);
      expect(html).not.toContain('__DAEMON_TOKEN');
    });
  });

  describe('proxy proof suppresses token embedding', () => {
    it('GET / omits token when proxy proof header is present', async () => {
      const proofSecret = path.join(rootDir, 'proxy-secret');
      fs.writeFileSync(proofSecret, 'test-proof-secret', { mode: 0o600 });

      const config = {
        port: 9999,
        controlPort,
        bindPublic: false,
        trustedProxy: {
          identityHeader: 'X-User-Email',
          proofHeader: 'X-Proxy-Proof',
          proofSecret,
        },
      } as AgentRouterConfig;

      const app = createWebApp({
        sessionMgr: stubSessionMgr(),
        sessionFiles,
        sseBroker,
        tokenStore,
        log,
        rootDir,
        config,
        shuttingDown: () => false,
      });
      webServer = startWebServer(app, config, log);

      const token = tokenStore.read();

      // Request WITH the proxy proof header — token should be omitted
      const res = await fetch(`http://127.0.0.1:${controlPort}/`, {
        headers: { 'X-Proxy-Proof': 'test-proof-secret' },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain(token);
      expect(html).not.toContain('__DAEMON_TOKEN');
    });

    it('GET / still embeds token when proxy is configured but proof header absent', async () => {
      const proofSecret = path.join(rootDir, 'proxy-secret');
      fs.writeFileSync(proofSecret, 'test-proof-secret', { mode: 0o600 });

      const config = {
        port: 9999,
        controlPort,
        bindPublic: false,
        trustedProxy: {
          identityHeader: 'X-User-Email',
          proofHeader: 'X-Proxy-Proof',
          proofSecret,
        },
      } as AgentRouterConfig;

      const app = createWebApp({
        sessionMgr: stubSessionMgr(),
        sessionFiles,
        sseBroker,
        tokenStore,
        log,
        rootDir,
        config,
        shuttingDown: () => false,
      });
      webServer = startWebServer(app, config, log);

      const token = tokenStore.read();

      // Request WITHOUT the proxy proof header — token should be embedded (direct local access)
      const res = await fetch(`http://127.0.0.1:${controlPort}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`window.__DAEMON_TOKEN = '${token}'`);
    });
  });
});

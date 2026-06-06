/**
 * Tier 2 test: Bind-address verification (task 14.8)
 *
 * Properties tested:
 * - P1: Loopback-Default Invariant — server binds to 127.0.0.1 with default config
 * - bindPublic: true → server binds to 0.0.0.0
 *
 * Validates: Requirements 1.1, 1.2
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

describe('Bind-address verification (task 14.8)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-bind-addr-tier2-'));
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

  function waitForListening(server: ServerType): Promise<net.AddressInfo> {
    return new Promise((resolve, reject) => {
      if (server.listening) {
        resolve(server.address() as net.AddressInfo);
        return;
      }
      server.on('listening', () => resolve(server.address() as net.AddressInfo));
      server.on('error', reject);
    });
  }

  it('binds to 127.0.0.1 with default config (P1 loopback-default)', async () => {
    const config = {
      port: 9999,
      controlPort,
      bindPublic: false,
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

    const addr = await waitForListening(webServer);
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBe(controlPort);
  });

  it('binds to 0.0.0.0 when bindPublic is true (Req 1.2)', async () => {
    const config = {
      port: 9999,
      controlPort,
      bindPublic: true,
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

    const addr = await waitForListening(webServer);
    expect(addr.address).toBe('0.0.0.0');
    expect(addr.port).toBe(controlPort);
  });
});

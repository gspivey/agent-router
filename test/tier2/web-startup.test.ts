/**
 * Tier 2 test: Web server starts alongside daemon components.
 * Validates task 11.1 — createWebApp and startWebServer wired into daemon startup.
 *
 * Properties tested:
 * - Web control plane responds on controlPort
 * - Unauthenticated GET / returns 200 (SPA shell after the spa-overhaul cutover)
 * - Authenticated GET /sessions returns 200
 * - Daemon token works for bearer auth
 * - --bind-public config wires to 0.0.0.0
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

describe('Web server startup wiring (task 11.1)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-startup-tier2-'));
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

  it('web server responds to GET / without auth (serves the SPA shell after cutover)', async () => {
    // After the spa-overhaul cutover (ROADMAP 78), GET / serves the Svelte SPA
    // shell (client/dist/index.html) instead of the deleted renderWebUI monolith.
    // Seed a shell fixture and point createWebApp at it so the test is
    // deterministic without requiring a real `npm run build:client`.
    const clientDist = path.join(rootDir, 'client-dist');
    fs.mkdirSync(clientDist, { recursive: true });
    fs.writeFileSync(
      path.join(clientDist, 'index.html'),
      '<!doctype html><html><head><!--__DAEMON_TOKEN__--></head><body><div id="app"></div></body></html>',
    );

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
      clientDist,
    });
    webServer = startWebServer(app, config, log);

    const res = await fetch(`http://127.0.0.1:${controlPort}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // The SPA shell mount point is present and the sentinel was replaced.
    expect(html).toContain('<div id="app"></div>');
    expect(html).not.toContain('<!--__DAEMON_TOKEN__-->');
    // A direct loopback bind (bindPublic:false, no proxy proof) embeds the token.
    expect(html).toContain(`window.__DAEMON_TOKEN=${JSON.stringify(tokenStore.read())}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('web server serves the SPA shell at GET /ui after cutover', async () => {
    const clientDist = path.join(rootDir, 'client-dist-ui');
    fs.mkdirSync(clientDist, { recursive: true });
    fs.writeFileSync(
      path.join(clientDist, 'index.html'),
      '<!doctype html><html><head><!--__DAEMON_TOKEN__--></head><body><div id="app"></div></body></html>',
    );

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
      clientDist,
    });
    webServer = startWebServer(app, config, log);

    const res = await fetch(`http://127.0.0.1:${controlPort}/ui`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="app"></div>');
  });

  it('web server responds to GET /sessions with valid bearer token', async () => {
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

    const token = tokenStore.read();
    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('sessions');
    expect(Array.isArray(body['sessions'])).toBe(true);
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('offset');
    expect(body).toHaveProperty('limit');
  });

  it('web server rejects GET /sessions without auth', async () => {
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

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions`);
    expect(res.status).toBe(401);
  });

  it('web server embeds daemon token in HTML when bound to loopback', async () => {
    // Seed a shell fixture so the test is deterministic without a real
    // `npm run build:client` (same pattern as the GET / and GET /ui tests above).
    const clientDist = path.join(rootDir, 'client-dist-token');
    fs.mkdirSync(clientDist, { recursive: true });
    fs.writeFileSync(
      path.join(clientDist, 'index.html'),
      '<!doctype html><html><head><!--__DAEMON_TOKEN__--></head><body><div id="app"></div></body></html>',
    );

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
      clientDist,
    });
    webServer = startWebServer(app, config, log);

    const token = tokenStore.read();
    const res = await fetch(`http://127.0.0.1:${controlPort}/`);
    const html = await res.text();
    expect(html).toContain(token);
  });

  it('web server does NOT embed daemon token when bindPublic is true', async () => {
    // Seed a shell fixture so the test is deterministic without a real build.
    const clientDist = path.join(rootDir, 'client-dist-noembed');
    fs.mkdirSync(clientDist, { recursive: true });
    fs.writeFileSync(
      path.join(clientDist, 'index.html'),
      '<!doctype html><html><head><!--__DAEMON_TOKEN__--></head><body><div id="app"></div></body></html>',
    );

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
      clientDist,
    });
    webServer = startWebServer(app, config, log);

    const token = tokenStore.read();
    const res = await fetch(`http://127.0.0.1:${controlPort}/`);
    const html = await res.text();
    expect(html).not.toContain(token);
  });

  it('startWebServer throws FatalError on port conflict', () => {
    const config = {
      port: 3000,
      controlPort: 3000,
      bindPublic: false,
    } as AgentRouterConfig;

    const app = createWebApp({
      sessionMgr: stubSessionMgr(),
      sessionFiles,
      sseBroker,
      tokenStore,
      log,
      rootDir,
      config: { ...config, controlPort } as AgentRouterConfig,
      shuttingDown: () => false,
    });

    expect(() => startWebServer(app, config, log)).toThrow(/conflicts with webhook server port/);
  });
});

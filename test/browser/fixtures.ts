/**
 * Playwright fixtures for browser tests.
 *
 * Provides per-test server lifecycle: tmpdir → session files → db → logger →
 * token store → SSE broker → FakeKiroBackend → session manager → web app →
 * startWebServer on an ephemeral port.
 *
 * Includes TCP readiness check (50ms interval, 5s timeout), teardown,
 * ConsoleCollector, and seedSession helper with live:false / live:true modes.
 *
 * The page fixture does NOT auto-navigate — tests call page.goto(baseUrl).
 */
import { test as base, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as url from 'node:url';
import { createSessionFiles, type SessionFiles, type SessionMeta } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { createDaemonTokenStore, type DaemonTokenStore } from '../../src/daemon-token.js';
import { createSSEBroker, type SSEBroker } from '../../src/sse-broker.js';
import { createWebApp, startWebServer } from '../../src/web-server.js';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import type { AgentRouterConfig } from '../../src/config.js';
import type { ServerType } from '@hono/node-server';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SLOW_MULTI_PROMPT = path.resolve(__dirname, '../scenarios/slow-multi-prompt.json');

// ---------------------------------------------------------------------------
// ConsoleCollector
// ---------------------------------------------------------------------------

export interface ConsoleCollector {
  errors: string[];
  warnings: string[];
  dialogs: string[];
  pageErrors: string[];
  assertNoErrors(): void;
}

function createConsoleCollector(): ConsoleCollector {
  return {
    errors: [],
    warnings: [],
    dialogs: [],
    pageErrors: [],
    assertNoErrors() {
      const allErrors = [...this.errors, ...this.pageErrors];
      if (allErrors.length > 0) {
        throw new Error(`Unexpected browser errors:\n${allErrors.join('\n')}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// TCP readiness check & ephemeral port helper
// ---------------------------------------------------------------------------

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
  const intervalMs = 50;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    function attempt(): void {
      if (Date.now() > deadline) {
        reject(new Error(`Server startup timeout: port ${port} not accepting connections after ${timeoutMs}ms`));
        return;
      }
      const sock = net.connect({ port, host });
      sock.on('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        setTimeout(attempt, intervalMs);
      });
    }
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Fixture interfaces
// ---------------------------------------------------------------------------

export interface ServerFixture {
  baseUrl: string;
  sessionFiles: SessionFiles;
  sseBroker: SSEBroker;
  sessionManager: SessionManager;
  db: Database;
  tokenStore: DaemonTokenStore;
  rootDir: string;
  token: string;
}

export interface SeedSessionOptions {
  live?: boolean;
  status?: SessionMeta['status'];
  repo?: string;
  streamEntries?: Array<Record<string, unknown>>;
}

export interface SeedSessionResult {
  sessionId: string;
}

export interface BrowserFixture {
  console: ConsoleCollector;
  seedSession: (opts?: SeedSessionOptions) => Promise<SeedSessionResult>;
}

// ---------------------------------------------------------------------------
// Exported test with fixtures
// ---------------------------------------------------------------------------

export const test = base.extend<ServerFixture & BrowserFixture>({
  // --- Server fixture ---
  rootDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-test-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  db: async ({ rootDir }, use) => {
    const database = initDatabase(path.join(rootDir, 'agent-router.db'));
    await use(database);
    await database.shutdown();
  },

  sessionFiles: async ({ rootDir }, use) => {
    const sf = createSessionFiles(rootDir);
    await use(sf);
  },

  tokenStore: async ({ rootDir }, use) => {
    const log = createLogger({ level: 'error', output: () => {} });
    const store = createDaemonTokenStore({ rootDir, log });
    await use(store);
  },

  token: async ({ tokenStore }, use) => {
    await use(tokenStore.read());
  },

  sseBroker: async ({ sessionFiles, rootDir }, use) => {
    const log = createLogger({ level: 'error', output: () => {} });
    const broker = createSSEBroker({ sessionFiles, rootDir, log, pollIntervalMs: 50 });
    await use(broker);
    broker.shutdown();
  },

  sessionManager: async ({ db, sessionFiles }, use) => {
    const log = createLogger({ level: 'error', output: () => {} });
    const kiro = new FakeKiroBackend();
    await kiro.loadScenario(SLOW_MULTI_PROMPT);

    const mgr = createSessionManager({
      db,
      sessionFiles,
      acpSpawner: () => {
        const cfg = kiro.spawnConfig();
        return spawnACPClient(cfg.command, cfg.args, cfg.env);
      },
      log,
      sessionTimeout: {
        inactivityMinutes: 5,
        maxLifetimeMinutes: 120,
        gracePeriodAfterMergeSeconds: 60,
      },
    });

    await use(mgr);
    await mgr.shutdown();
  },

  baseUrl: async ({ rootDir, sessionManager, sessionFiles, sseBroker, tokenStore }, use) => {
    const log = createLogger({ level: 'error', output: () => {} });
    const controlPort = await getFreePort();
    const config = {
      port: 9999,
      controlPort,
      bindPublic: false,
    } as AgentRouterConfig;

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

    const url = `http://127.0.0.1:${controlPort}`;
    await use(url);
    server.close();
  },

  // --- Browser fixture: ConsoleCollector ---
  console: async ({ page }, use) => {
    const collector = createConsoleCollector();

    page.on('console', (msg) => {
      if (msg.type() === 'error') collector.errors.push(msg.text());
      if (msg.type() === 'warning') collector.warnings.push(msg.text());
    });

    page.on('pageerror', (error) => {
      collector.pageErrors.push(error.message);
    });

    page.on('dialog', async (dialog) => {
      collector.dialogs.push(dialog.message());
      await dialog.accept();
    });

    await use(collector);
  },

  // --- seedSession helper ---
  seedSession: async ({ sessionFiles, sessionManager }, use) => {
    async function seed(opts?: SeedSessionOptions): Promise<SeedSessionResult> {
      const { live = false, status = 'active', repo = 'test-org/test-repo', streamEntries } = opts ?? {};

      if (live) {
        // Use sessionManager to create a real session with FakeKiroBackend
        const handle = await sessionManager.createSession('Browser test session', repo);
        // Wait briefly for the ACP process to start and emit initial entries
        await new Promise((r) => setTimeout(r, 300));
        return { sessionId: handle.sessionId };
      }

      // Filesystem-only seed
      const crypto = await import('node:crypto');
      const sessionId = crypto.randomUUID();
      sessionFiles.createSession(sessionId, 'Browser test session');
      sessionFiles.updateMeta(sessionId, { repo, status });

      if (status !== 'active') {
        sessionFiles.updateMeta(sessionId, {
          completed_at: Date.now(),
          termination_reason: status === 'completed' ? 'completed' : 'terminated_cli',
        });
      }

      if (streamEntries) {
        for (const entry of streamEntries) {
          sessionFiles.appendStream(sessionId, {
            ts: new Date().toISOString(),
            source: 'router',
            type: 'message',
            ...entry,
          });
        }
      }

      return { sessionId };
    }

    await use(seed);
  },
});

export { expect } from '@playwright/test';

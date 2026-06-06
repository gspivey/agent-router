/**
 * Tier 2 test: Property 27 — Every Terminal Transition Emits session_ended.
 *
 * Tests each termination path:
 *   - completion (via completeSession)
 *   - failure (subprocess exit without completion flag)
 *   - timeout_inactivity
 *   - timeout_max_lifetime
 *   - killed via web (terminated_web)
 *   - killed via CLI (terminated_cli)
 *   - shutdown
 *
 * Verifies exactly one session_ended entry exists per terminated session.
 *
 * Validates: Requirements 6.8, 15.3
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as url from 'node:url';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { createDaemonTokenStore, type DaemonTokenStore } from '../../src/daemon-token.js';
import { createSSEBroker, type SSEBroker } from '../../src/sse-broker.js';
import { createWebApp, startWebServer } from '../../src/web-server.js';
import type { AgentRouterConfig } from '../../src/config.js';
import type { ServerType } from '@hono/node-server';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SLOW_MULTI_PROMPT = path.resolve(__dirname, '../scenarios/slow-multi-prompt.json');
const SINGLE_PROMPT_ECHO = path.resolve(__dirname, '../scenarios/single-prompt-echo.json');
const SINGLE_UPDATE_THEN_SILENT = path.resolve(__dirname, '../scenarios/single-update-then-silent.json');
const PERIODIC_UPDATES = path.resolve(__dirname, '../scenarios/periodic-updates.json');

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function waitForStreamEntry(
  rootDir: string,
  sessionId: string,
  type: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const streamPath = path.join(rootDir, 'sessions', sessionId, 'stream.log');
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for stream entry type="${type}"`));
        return;
      }
      try {
        const content = fs.readFileSync(streamPath, 'utf-8');
        const lines = content.split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry['type'] === type) {
              resolve(entry);
              return;
            }
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // file may not exist yet
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function waitForTerminal(
  sf: SessionFiles,
  sessionId: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for terminal state on session ${sessionId}`));
        return;
      }
      try {
        const meta = sf.readMeta(sessionId);
        if (meta.status !== 'active') {
          resolve();
          return;
        }
      } catch {
        // meta may not exist yet
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function getSessionEndedEntries(
  rootDir: string,
  sessionId: string,
): Array<Record<string, unknown>> {
  const streamPath = path.join(rootDir, 'sessions', sessionId, 'stream.log');
  try {
    const content = fs.readFileSync(streamPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    const entries: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry['type'] === 'session_ended') {
          entries.push(entry);
        }
      } catch {
        // skip
      }
    }
    return entries;
  } catch {
    return [];
  }
}

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let tokenStore: DaemonTokenStore;
let sseBroker: SSEBroker;
let webServer: ServerType | undefined;
let controlPort: number;
let token: string;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ended-inv-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  tokenStore = createDaemonTokenStore({ rootDir, log });
  sseBroker = createSSEBroker({ sessionFiles: sf, rootDir, log });
  kiro = new FakeKiroBackend();
  controlPort = await getFreePort();
  token = tokenStore.read();
  webServer = undefined;
});

afterEach(async () => {
  if (webServer) webServer.close();
  sseBroker.shutdown();
  if (mgr) await mgr.shutdown();
  if (db) await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function setupManager(opts?: {
  inactivityMinutes?: number;
  maxLifetimeMinutes?: number;
  shutdownDrainSeconds?: number;
}): void {
  mgr = createSessionManager({
    db,
    sessionFiles: sf,
    acpSpawner: () => {
      const cfg = kiro.spawnConfig();
      return spawnACPClient(cfg.command, cfg.args, cfg.env);
    },
    log,
    sessionTimeout: {
      inactivityMinutes: opts?.inactivityMinutes ?? 5,
      maxLifetimeMinutes: opts?.maxLifetimeMinutes ?? 120,
      gracePeriodAfterMergeSeconds: 60,
    },
    shutdownDrainSeconds: opts?.shutdownDrainSeconds ?? 5,
  });
}

function setupWebServer(): void {
  const config = {
    port: 9999,
    controlPort,
    bindPublic: false,
  } as AgentRouterConfig;

  const app = createWebApp({
    sessionMgr: mgr,
    sessionFiles: sf,
    sseBroker,
    tokenStore,
    log,
    rootDir,
    config,
    shuttingDown: () => false,
  });
  webServer = startWebServer(app, config, log);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

describe('Property 27: Every Terminal Transition Emits session_ended', () => {
  it('completion path: exactly one session_ended with reason "completed"', async () => {
    await kiro.loadScenario(SLOW_MULTI_PROMPT);
    setupManager();

    const handle = await mgr.createSession('Test completion');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Trigger completion via completeSession (simulates MCP complete_session tool)
    await mgr.completeSession(handle.sessionId, 'completed');

    // Wait for terminal state
    await waitForTerminal(sf, handle.sessionId);

    const entries = getSessionEndedEntries(rootDir, handle.sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['reason']).toBe('completed');
  }, 15_000);

  it('failure path: exactly one session_ended with reason "failed"', async () => {
    // single-prompt-echo exits after first prompt without completion flag
    await kiro.loadScenario(SINGLE_PROMPT_ECHO);
    setupManager();

    const handle = await mgr.createSession('Test failure');

    // Wait for the session to reach terminal state (subprocess exits)
    await waitForTerminal(sf, handle.sessionId);

    const entries = getSessionEndedEntries(rootDir, handle.sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['reason']).toBe('failed');
  }, 15_000);

  it('timeout_inactivity path: exactly one session_ended with reason "timeout_inactivity"', async () => {
    await kiro.loadScenario(SINGLE_UPDATE_THEN_SILENT);
    // Very short inactivity timeout
    setupManager({ inactivityMinutes: 2 / 60 });

    const handle = await mgr.createSession('Test inactivity timeout');

    // Wait for the inactivity timer to fire
    await waitForTerminal(sf, handle.sessionId, 15000);

    const entries = getSessionEndedEntries(rootDir, handle.sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['reason']).toBe('timeout_inactivity');
  }, 20_000);

  it('timeout_max_lifetime path: exactly one session_ended with reason "timeout_max_lifetime"', async () => {
    await kiro.loadScenario(PERIODIC_UPDATES);
    // Very short max lifetime, long inactivity so it doesn't fire first
    setupManager({ inactivityMinutes: 60, maxLifetimeMinutes: 3 / 60 });

    const handle = await mgr.createSession('Test max lifetime timeout');

    // Wait for the max lifetime timer to fire
    await waitForTerminal(sf, handle.sessionId, 15000);

    const entries = getSessionEndedEntries(rootDir, handle.sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['reason']).toBe('timeout_max_lifetime');
  }, 20_000);

  it('killed via web (terminated_web): exactly one session_ended with reason "terminated_web"', async () => {
    await kiro.loadScenario(SLOW_MULTI_PROMPT);
    setupManager();
    setupWebServer();

    const handle = await mgr.createSession('Test web kill');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/kill`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const entries = getSessionEndedEntries(rootDir, handle.sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['reason']).toBe('terminated_web');
    expect(entries[0]!['actor']).toBe('local');
  }, 15_000);

  it('killed via CLI (terminated_cli): exactly one session_ended with reason "terminated_cli"', async () => {
    await kiro.loadScenario(SLOW_MULTI_PROMPT);
    setupManager();

    const handle = await mgr.createSession('Test CLI kill');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    await mgr.terminateSession(handle.sessionId, 'terminated_cli', 'local');

    const entries = getSessionEndedEntries(rootDir, handle.sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!['reason']).toBe('terminated_cli');
    expect(entries[0]!['actor']).toBe('local');
  }, 15_000);

  it('shutdown path: exactly one session_ended with reason "shutdown" per session', async () => {
    await kiro.loadScenario(SLOW_MULTI_PROMPT);
    setupManager({ shutdownDrainSeconds: 2 });

    const handle1 = await mgr.createSession('Shutdown test 1');
    const handle2 = await mgr.createSession('Shutdown test 2');
    await waitForStreamEntry(rootDir, handle1.sessionId, 'prompt_injected');
    await waitForStreamEntry(rootDir, handle2.sessionId, 'prompt_injected');

    await mgr.shutdown();

    for (const sessionId of [handle1.sessionId, handle2.sessionId]) {
      const entries = getSessionEndedEntries(rootDir, sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!['reason']).toBe('shutdown');
    }
  }, 15_000);

  it('no session_ended is emitted for still-active sessions', async () => {
    await kiro.loadScenario(SLOW_MULTI_PROMPT);
    setupManager();

    const handle = await mgr.createSession('Still active');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Session is still active — no session_ended should exist
    const entries = getSessionEndedEntries(rootDir, handle.sessionId);
    expect(entries).toHaveLength(0);
  }, 15_000);
});

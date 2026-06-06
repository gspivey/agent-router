/**
 * Tier 2 test: Web graceful shutdown.
 * Properties tested:
 * - Property 20: Graceful Shutdown Leaves No Active Sessions
 * - Property 21: Drain Phase Request Routing
 *
 * Validates: Requirements 15.1, 15.3, 15.5
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

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let tokenStore: DaemonTokenStore;
let sseBroker: SSEBroker;
let webServer: ServerType;
let controlPort: number;
let token: string;
let shuttingDownFlag: { value: boolean };

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-shutdown-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  tokenStore = createDaemonTokenStore({ rootDir, log });
  sseBroker = createSSEBroker({ sessionFiles: sf, rootDir, log });
  kiro = new FakeKiroBackend();
  controlPort = await getFreePort();
  token = tokenStore.read();
  shuttingDownFlag = { value: false };
});

afterEach(async () => {
  if (webServer) webServer.close();
  sseBroker.shutdown();
  if (mgr) await mgr.shutdown();
  if (db) await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function setupDaemon(scenario: string): void {
  kiro.loadScenario(scenario);
  mgr = createSessionManager({
    db,
    sessionFiles: sf,
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
    shutdownDrainSeconds: 5,
  });

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
    shuttingDown: () => shuttingDownFlag.value,
  });
  webServer = startWebServer(app, config, log);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function readAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('Property 20: Graceful Shutdown Leaves No Active Sessions', () => {
  it('after shutdown, no session meta.json has status active', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);

    // Create two sessions
    const handle1 = await mgr.createSession('Task one');
    const handle2 = await mgr.createSession('Task two');

    // Wait for both to be active (prompt injected)
    await waitForStreamEntry(rootDir, handle1.sessionId, 'prompt_injected');
    await waitForStreamEntry(rootDir, handle2.sessionId, 'prompt_injected');

    // Trigger shutdown
    await mgr.shutdown();

    // Verify: no session on disk has status 'active'
    const sessionsDir = path.join(rootDir, 'sessions');
    const sessionDirs = fs.readdirSync(sessionsDir);
    for (const dir of sessionDirs) {
      const metaPath = path.join(sessionsDir, dir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { status: string };
      expect(meta.status).not.toBe('active');
    }
  }, 15_000);

  it('shutdown writes termination_reason for all terminated sessions', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);

    const handle = await mgr.createSession('Task one');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    await mgr.shutdown();

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.status).not.toBe('active');
    expect(meta.termination_reason).not.toBeNull();
    expect(meta.completed_at).not.toBeNull();
  }, 15_000);

  it('shutdown emits session_ended in stream.log for every terminated session', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);

    const handle1 = await mgr.createSession('Task one');
    const handle2 = await mgr.createSession('Task two');
    await waitForStreamEntry(rootDir, handle1.sessionId, 'prompt_injected');
    await waitForStreamEntry(rootDir, handle2.sessionId, 'prompt_injected');

    await mgr.shutdown();

    // Both sessions must have session_ended entries
    for (const sessionId of [handle1.sessionId, handle2.sessionId]) {
      const streamPath = path.join(rootDir, 'sessions', sessionId, 'stream.log');
      const content = fs.readFileSync(streamPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      const endedEntries = lines
        .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
        .filter((e): e is Record<string, unknown> => e !== null && e['type'] === 'session_ended');
      expect(endedEntries.length).toBeGreaterThanOrEqual(1);
      expect(endedEntries[endedEntries.length - 1]!['reason']).toBe('shutdown');
    }
  }, 15_000);
});

describe('Property 21: Drain Phase Request Routing', () => {
  it('GET /sessions returns 200 during drain phase', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);

    // Set shuttingDown flag to simulate drain
    shuttingDownFlag.value = true;

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions`, {
      headers: readAuthHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it('GET /sessions/:id returns 200 during drain phase for existing session', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Task one');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Set shuttingDown flag
    shuttingDownFlag.value = true;

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}`, {
      headers: readAuthHeaders(),
    });
    expect(res.status).toBe(200);
  }, 15_000);

  it('POST /sessions/:id/inject returns 503 during drain phase', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Task one');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Set shuttingDown flag
    shuttingDownFlag.value = true;

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/inject`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('shutting_down');
  }, 15_000);

  it('POST /sessions/:id/interrupt returns 503 during drain phase', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Task one');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Set shuttingDown flag
    shuttingDownFlag.value = true;

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/interrupt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('shutting_down');
  }, 15_000);

  it('POST /sessions/:id/kill returns 503 during drain phase', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Task one');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Set shuttingDown flag
    shuttingDownFlag.value = true;

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/kill`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('shutting_down');
  }, 15_000);
});

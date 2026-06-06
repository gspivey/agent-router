/**
 * Tier 2 test: Auth-before-resource ordering (Property 26).
 * Properties tested:
 * - Property 26: Authentication Precedes Resource Resolution
 * Verify unauthenticated requests always get 401, never 404/409.
 *
 * Validates: Requirements 16.4
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

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-auth-ord-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  tokenStore = createDaemonTokenStore({ rootDir, log });
  sseBroker = createSSEBroker({ sessionFiles: sf, rootDir, log });
  kiro = new FakeKiroBackend();
  controlPort = await getFreePort();
});

afterEach(async () => {
  if (webServer) webServer.close();
  sseBroker.shutdown();
  if (mgr) await mgr.shutdown();
  if (db) await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function setupDaemon(): void {
  kiro.loadScenario(SLOW_MULTI_PROMPT);
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
    shuttingDown: () => false,
  });
  webServer = startWebServer(app, config, log);
}

const NON_EXISTENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TERMINATED_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('Property 26: Authentication Precedes Resource Resolution', () => {
  it('unauthenticated GET /sessions/:id returns 401, not 404, for non-existent session', async () => {
    setupDaemon();

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${NON_EXISTENT_ID}`, {
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  it('unauthenticated GET /sessions/:id returns 401, not 200, for existing session', async () => {
    setupDaemon();
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}`, {
      headers: {},
    });
    expect(res.status).toBe(401);
  }, 15_000);

  it('unauthenticated POST /sessions/:id/inject returns 401, not 404, for non-existent session', async () => {
    setupDaemon();

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${NON_EXISTENT_ID}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(res.status).toBe(401);
  });

  it('unauthenticated POST /sessions/:id/inject returns 401, not 409, for terminated session', async () => {
    setupDaemon();

    // Create a terminated session on disk
    const sessionDir = path.join(rootDir, 'sessions', TERMINATED_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({
      session_id: TERMINATED_ID,
      original_prompt: 'test',
      status: 'completed',
      created_at: Math.floor(Date.now() / 1000),
      completed_at: Math.floor(Date.now() / 1000),
      termination_reason: 'completed',
      prs: [],
    }));
    fs.writeFileSync(path.join(sessionDir, 'stream.log'), '');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${TERMINATED_ID}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(res.status).toBe(401);
  });

  it('unauthenticated POST /sessions/:id/interrupt returns 401, not 404', async () => {
    setupDaemon();

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${NON_EXISTENT_ID}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('unauthenticated POST /sessions/:id/kill returns 401, not 404', async () => {
    setupDaemon();

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${NON_EXISTENT_ID}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('unauthenticated GET /sessions/:id/stream returns 401, not 404', async () => {
    setupDaemon();

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${NON_EXISTENT_ID}/stream`, {
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  it('unauthenticated GET /sessions returns 401', async () => {
    setupDaemon();

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions`, {
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  it('invalid bearer token returns 401 regardless of session existence', async () => {
    setupDaemon();
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Existing session with wrong token
    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}`, {
      headers: { Authorization: 'Bearer wrong-token-value' },
    });
    expect(res.status).toBe(401);
  }, 15_000);

  it('missing Authorization header returns 401 for write to active session', async () => {
    setupDaemon();
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Active session that would return 202 with valid auth
    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    expect(res.status).toBe(401);
  }, 15_000);
});

/**
 * Tier 2 test: Web kill and interrupt lifecycle.
 * Properties tested:
 * - Property 6: Terminal Sessions Are Immutable
 * - Property 18: Kill Produces Correct Terminal State
 * - Property 19: Interrupt Preserves Active Status
 * - Property 25: Non-Resident Active Session Returns 409
 * - Also: logging_failed → 500 when stream.log write fails (Req 12.5)
 *
 * Validates: Requirements 9.2, 10.2, 10.3, 10.6, 10.7, 12.5
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

function getStreamEntries(
  rootDir: string,
  sessionId: string,
  type: string,
): Array<Record<string, unknown>> {
  const streamPath = path.join(rootDir, 'sessions', sessionId, 'stream.log');
  try {
    const content = fs.readFileSync(streamPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    const entries: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry['type'] === type) {
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
let webServer: ServerType;
let controlPort: number;
let token: string;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-kill-int-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  tokenStore = createDaemonTokenStore({ rootDir, log });
  sseBroker = createSSEBroker({ sessionFiles: sf, rootDir, log });
  kiro = new FakeKiroBackend();
  controlPort = await getFreePort();
  token = tokenStore.read();
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

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function readAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('Property 6: Terminal Sessions Are Immutable', () => {
  it('kill returns 409 for a terminated session', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Terminate via session manager directly
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/kill`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_active');
  }, 15_000);

  it('interrupt returns 409 for a terminated session', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    await mgr.terminateSession(handle.sessionId, 'terminated_cli');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/interrupt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_active');
  }, 15_000);
});

describe('Property 18: Kill Produces Correct Terminal State', () => {
  it('kill returns 200 and writes terminated_web to meta.json', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/kill`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify meta.json terminal state
    const meta = sf.readMeta(handle.sessionId);
    expect(meta.status).toBe('abandoned');
    expect(meta.termination_reason).toBe('terminated_web');
    expect(meta.completed_at).not.toBeNull();
  }, 15_000);

  it('kill produces session_ended stream entry with actor and reason', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/kill`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });

    const endedEntries = getStreamEntries(rootDir, handle.sessionId, 'session_ended');
    expect(endedEntries.length).toBeGreaterThanOrEqual(1);
    const ended = endedEntries[endedEntries.length - 1]!;
    expect(ended['reason']).toBe('terminated_web');
    expect(ended['actor']).toBe('local');
  }, 15_000);

  it('kill produces web_kill audit entry in stream.log', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/kill`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });

    const killEntries = getStreamEntries(rootDir, handle.sessionId, 'web_kill');
    expect(killEntries.length).toBe(1);
    expect(killEntries[0]!['actor']).toBe('local');
    expect(killEntries[0]!['source']).toBe('router');
  }, 15_000);
});

describe('Property 19: Interrupt Preserves Active Status', () => {
  it('interrupt returns 200 and session remains active', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/interrupt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Session remains active
    const meta = sf.readMeta(handle.sessionId);
    expect(meta.status).toBe('active');
  }, 15_000);

  it('interrupt produces web_interrupt stream entry with actor', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/interrupt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });

    const entries = getStreamEntries(rootDir, handle.sessionId, 'web_interrupt');
    expect(entries.length).toBe(1);
    expect(entries[0]!['actor']).toBe('local');
    expect(entries[0]!['source']).toBe('router');
  }, 15_000);

  it('interrupt on idle session returns 200 (cancel is a no-op)', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    // Wait for initial prompt to finish — session is now idle
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');
    // Small delay to ensure turn completes fully
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/interrupt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    // Session still active
    const meta = sf.readMeta(handle.sessionId);
    expect(meta.status).toBe('active');
  }, 15_000);
});

describe('Property 25: Non-Resident Active Session Returns 409', () => {
  it('kill returns 409 session_not_resident for active-on-disk but no handle', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);

    // Manually create a session directory with active meta but no live handle
    const fakeId = '11111111-1111-4111-8111-111111111111';
    const sessionDir = path.join(rootDir, 'sessions', fakeId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const meta = {
      session_id: fakeId,
      original_prompt: 'test',
      status: 'active',
      created_at: Math.floor(Date.now() / 1000),
      completed_at: null,
      prs: [],
    };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(sessionDir, 'stream.log'), '');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${fakeId}/kill`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_resident');
  });

  it('interrupt returns 409 session_not_resident for active-on-disk but no handle', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);

    const fakeId = '22222222-2222-4222-8222-222222222222';
    const sessionDir = path.join(rootDir, 'sessions', fakeId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const meta = {
      session_id: fakeId,
      original_prompt: 'test',
      status: 'active',
      created_at: Math.floor(Date.now() / 1000),
      completed_at: null,
      prs: [],
    };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(sessionDir, 'stream.log'), '');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${fakeId}/interrupt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_resident');
  });
});

describe('logging_failed → 500 when stream.log write fails (Req 12.5)', () => {
  it('kill returns 500 when stream.log is not writable', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Make stream.log read-only to force appendStream to throw
    const streamPath = path.join(rootDir, 'sessions', handle.sessionId, 'stream.log');
    fs.chmodSync(streamPath, 0o444);

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/kill`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('logging_failed');

    // Restore permissions for cleanup
    fs.chmodSync(streamPath, 0o644);
  }, 15_000);

  it('interrupt returns 500 when stream.log is not writable', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const streamPath = path.join(rootDir, 'sessions', handle.sessionId, 'stream.log');
    fs.chmodSync(streamPath, 0o444);

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/interrupt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('logging_failed');

    fs.chmodSync(streamPath, 0o644);
  }, 15_000);
});

/**
 * Tier 2 test: SSE hardening for Cloudflare / mobile.
 * Properties tested:
 * - SSE response carries anti-buffering headers (Cache-Control, X-Accel-Buffering)
 * - SSE response emits initial flush comment (:ok) + retry hint
 * - Content-Type is text/event-stream
 * - Events carry id: fields with integer values
 *
 * Validates: Spec .kiro/specs/web-client/ tasks 4.1a, 4.1b
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as url from 'node:url';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { createDaemonTokenStore, type DaemonTokenStore } from '../../src/daemon-token.js';
import { createSSEBroker, type SSEBroker } from '../../src/sse-broker.js';
import { createWebApp, startWebServer } from '../../src/web-server.js';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { spawnACPClient } from '../../src/acp.js';
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
): Promise<void> {
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
            if (entry['type'] === type) { resolve(); return; }
          } catch { /* skip */ }
        }
      } catch { /* file may not exist yet */ }
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

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-harden-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  tokenStore = createDaemonTokenStore({ rootDir, log });
  sseBroker = createSSEBroker({ sessionFiles: sf, rootDir, log, pollIntervalMs: 50 });
  kiro = new FakeKiroBackend();
  controlPort = await getFreePort();
  token = tokenStore.read();

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
});

afterEach(async () => {
  if (webServer) webServer.close();
  sseBroker.shutdown();
  if (mgr) await mgr.shutdown();
  if (db) await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('SSE hardening headers and initial flush', () => {
  it('carries all anti-buffering headers required by task 4.1b', async () => {
    const handle = await mgr.createSession('task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    // All five anti-buffering requirements from spec task 4.1b:
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('connection')).toBe('keep-alive');
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');
  }, 15_000);

  it('response has Cache-Control: no-cache, no-transform', async () => {
    const handle = await mgr.createSession('task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    // Abort to clean up
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');
  }, 15_000);

  it('response has X-Accel-Buffering: no', async () => {
    const handle = await mgr.createSession('task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');
  }, 15_000);

  it('response has Content-Type: text/event-stream', async () => {
    const handle = await mgr.createSession('task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');
  }, 15_000);

  it('emits initial flush comment and retry hint before data events', async () => {
    const handle = await mgr.createSession('task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');
    await waitForStreamEntry(rootDir, handle.sessionId, 'session_ended');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (result.done) break;
      if (result.value) raw += decoder.decode(result.value, { stream: true });
    }
    reader.releaseLock();

    // The very first bytes should be the initial flush comment + retry hint
    expect(raw.startsWith(':ok\nretry: 1000\n\n')).toBe(true);

    // After the initial flush, there should be actual SSE events with id: fields
    const afterFlush = raw.slice(':ok\nretry: 1000\n\n'.length);
    expect(afterFlush).toContain('id: ');
    expect(afterFlush).toContain('event: ');
    expect(afterFlush).toContain('data: ');
  }, 15_000);

  it('events carry id: fields with integer values', async () => {
    const handle = await mgr.createSession('task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');
    await waitForStreamEntry(rootDir, handle.sessionId, 'session_ended');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (result.done) break;
      if (result.value) raw += decoder.decode(result.value, { stream: true });
    }
    reader.releaseLock();

    // Parse id: lines
    const idMatches = raw.match(/^id: (\d+)$/gm);
    expect(idMatches).not.toBeNull();
    expect(idMatches!.length).toBeGreaterThan(0);

    // All should be valid positive integers
    for (const match of idMatches!) {
      const num = parseInt(match.slice(4), 10);
      expect(num).toBeGreaterThan(0);
    }
  }, 15_000);
});

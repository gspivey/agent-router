/**
 * Tier 2 test: SSE full lifecycle.
 * Properties tested:
 * - Property 11: SSE Event IDs Are Monotonic
 * - Property 12: SSE Last-Event-ID Resumption
 * - Property 13: SSE Session-Ended Closes Connection
 *
 * Validates: Requirements 6.2, 6.8, 6.10
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

interface SSEEvent {
  event: string;
  id: number;
  data: string;
}

/**
 * Parse raw SSE text into structured events.
 * Handles standard SSE format: event:, id:, data: fields separated by blank lines.
 */
function parseSSEEvents(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = raw.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    if (block.startsWith(':')) continue; // heartbeat comment
    let event = '';
    let id = -1;
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice(7);
      } else if (line.startsWith('id: ')) {
        id = parseInt(line.slice(4), 10);
      } else if (line.startsWith('data: ')) {
        data = line.slice(6);
      }
    }
    if (event && id >= 0 && data) {
      events.push({ event, id, data });
    }
  }
  return events;
}

/**
 * Collect SSE events from a fetch response until the stream closes or timeout.
 */
async function collectSSEEvents(
  response: Response,
  timeoutMs = 5000,
): Promise<{ events: SSEEvent[]; raw: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (result.done) break;
      raw += decoder.decode(result.value, { stream: true });
    }
  } catch {
    // stream closed
  } finally {
    reader.releaseLock();
  }
  return { events: parseSSEEvents(raw), raw };
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
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-sse-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  tokenStore = createDaemonTokenStore({ rootDir, log });
  sseBroker = createSSEBroker({ sessionFiles: sf, rootDir, log, pollIntervalMs: 50 });
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
  return { Authorization: `Bearer ${token}` };
}

describe('Property 11: SSE Event IDs Are Monotonic', () => {
  it('emits strictly increasing integer IDs corresponding to line numbers', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Inject a second prompt to generate more stream entries
    await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/inject`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Second prompt' }),
    });
    // Wait for delivery
    await new Promise((r) => setTimeout(r, 500));

    // Kill to generate session_ended
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');

    // Now connect to SSE and collect all events (session is terminal, so full replay + close)
    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const { events } = await collectSSEEvents(res, 3000);
    expect(events.length).toBeGreaterThan(1);

    // Verify IDs are strictly increasing starting from 1
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.id).toBe(i + 1);
      if (i > 0) {
        expect(events[i]!.id).toBeGreaterThan(events[i - 1]!.id);
      }
    }
  }, 15_000);

  it('IDs have no gaps in a continuous stream', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Terminate to get a complete stream
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    const { events } = await collectSSEEvents(res, 3000);
    expect(events.length).toBeGreaterThan(0);

    // Verify no gaps: each ID is exactly previous + 1
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.id - events[i - 1]!.id).toBe(1);
    }
  }, 15_000);
});

describe('Property 12: SSE Last-Event-ID Resumption', () => {
  it('resumes from the line after the specified Last-Event-ID', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Terminate to get full stream available
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');

    // First: get full stream to know what's there
    const fullRes = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    const { events: fullEvents } = await collectSSEEvents(fullRes, 3000);
    expect(fullEvents.length).toBeGreaterThan(2);

    // Now reconnect with Last-Event-ID set to the second event's ID
    const resumeFromId = fullEvents[1]!.id;
    const resumeRes = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: { ...authHeaders(), 'Last-Event-ID': String(resumeFromId) },
    });
    const { events: resumedEvents } = await collectSSEEvents(resumeRes, 3000);

    // Should start from the line AFTER resumeFromId
    expect(resumedEvents.length).toBe(fullEvents.length - 2);
    expect(resumedEvents[0]!.id).toBe(resumeFromId + 1);

    // All resumed events should match the tail of the full stream
    for (let i = 0; i < resumedEvents.length; i++) {
      expect(resumedEvents[i]!.id).toBe(fullEvents[i + 2]!.id);
      expect(resumedEvents[i]!.data).toBe(fullEvents[i + 2]!.data);
    }
  }, 15_000);

  it('does not duplicate events on resumption', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');

    // Get full stream
    const fullRes = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    const { events: fullEvents } = await collectSSEEvents(fullRes, 3000);

    // Resume from the last event ID — should only get events after it (none if it was the last)
    const lastId = fullEvents[fullEvents.length - 1]!.id;
    const resumeRes = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: { ...authHeaders(), 'Last-Event-ID': String(lastId) },
    });
    const { events: resumedEvents } = await collectSSEEvents(resumeRes, 2000);

    // No events should be emitted since we already have the last one
    expect(resumedEvents.length).toBe(0);
  }, 15_000);
});

describe('Property 13: SSE Session-Ended Closes Connection', () => {
  it('emits session_ended event and closes when session terminates', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');

    // Connect to SSE before killing
    const abortController = new AbortController();
    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
      signal: abortController.signal,
    });
    expect(res.status).toBe(200);

    // Kill the session — this should cause a session_ended event and stream close
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');

    // Collect all events — stream should close after session_ended
    const { events } = await collectSSEEvents(res, 5000);
    expect(events.length).toBeGreaterThan(0);

    // The last event should be session_ended
    const lastEvent = events[events.length - 1]!;
    expect(lastEvent.event).toBe('session_ended');

    // Verify the data is valid JSON with type session_ended
    const parsed = JSON.parse(lastEvent.data) as Record<string, unknown>;
    expect(parsed['type']).toBe('session_ended');
  }, 15_000);

  it('immediately closes for already-terminal sessions after full replay', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');

    // Wait for session_ended to be written
    await waitForStreamEntry(rootDir, handle.sessionId, 'session_ended');

    // Connect to an already-terminal session
    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    // Should get all events replayed, ending with session_ended, then stream closes
    const { events } = await collectSSEEvents(res, 3000);
    expect(events.length).toBeGreaterThan(0);

    // Last event must be session_ended
    const lastEvent = events[events.length - 1]!;
    expect(lastEvent.event).toBe('session_ended');

    // Events should still have monotonic IDs
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.id).toBeGreaterThan(events[i - 1]!.id);
    }
  }, 15_000);

  it('all events before session_ended have event type "log"', async () => {
    setupDaemon(SLOW_MULTI_PROMPT);
    const handle = await mgr.createSession('Initial task');
    await waitForStreamEntry(rootDir, handle.sessionId, 'prompt_injected');
    await mgr.terminateSession(handle.sessionId, 'terminated_cli');
    await waitForStreamEntry(rootDir, handle.sessionId, 'session_ended');

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${handle.sessionId}/stream`, {
      headers: authHeaders(),
    });
    const { events } = await collectSSEEvents(res, 3000);
    expect(events.length).toBeGreaterThan(1);

    // All but last should be 'log', last should be 'session_ended'
    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i]!.event).toBe('log');
    }
    expect(events[events.length - 1]!.event).toBe('session_ended');
  }, 15_000);
});

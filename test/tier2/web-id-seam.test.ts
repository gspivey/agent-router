/**
 * Tier 2 cross-check test: history/SSE id seam (ROADMAP item 71 / spa-overhaul task 1.8).
 *
 * Validates Requirement 10 (first_event_id / last_event_id on GET /sessions/:id).
 *
 * HIGH-B redesign note: the real SSE broker (src/sse-broker.ts) assigns
 * `id = raw 1-indexed line number` to EVERY line it emits — valid AND malformed.
 * It does NOT drop malformed lines before id assignment (verified against source).
 * This contradicts the spec's original assumption that malformed lines are dropped
 * and valid-entry ids are contiguous. Per the HIGH-B gate ("if the broker does not
 * drop malformed lines before id assignment ... the id-derivation approach shall be
 * redesigned"), the seam is derived against the real broker:
 *   first_event_id = raw 1-indexed line number of the FIRST valid entry in the slice
 *   last_event_id  = raw 1-indexed line number of the LAST  valid entry in the slice
 * These equal the SSE ids the broker emits for those entries, so
 * `Last-Event-ID: last_event_id` resumes replay exactly after the slice.
 *
 * This is a genuine CROSS-CHECK (not an algebraic tautology): it seeds a known
 * stream.log, reads first/last_event_id from the detail endpoint, then opens SSE
 * replay and asserts that the broker frame carrying each valid entry's id has a
 * `data` payload whose `ts` matches that entry. A broken id derivation would make
 * the claimed id line up with the wrong (or a malformed) broker frame and fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
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

interface SSEFrame {
  event: string;
  id: number;
  data: string;
}

/**
 * Parse raw SSE text into frames. Unlike the stricter parser in web-sse.test.ts,
 * this keeps EVERY `event:/id:/data:` frame (including malformed-JSON data lines)
 * so the test can prove the broker emits malformed lines too and that valid-entry
 * ids still land on the right frames.
 */
function parseAllSSEFrames(raw: string): SSEFrame[] {
  const frames: SSEFrame[] = [];
  const blocks = raw.split('\n\n');
  for (const block of blocks) {
    if (block.length === 0) continue;
    if (block.startsWith(':')) continue; // :ok / :heartbeat comments
    let event = '';
    let id = -1;
    let data: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('id: ')) id = parseInt(line.slice(4), 10);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event && id >= 0 && data !== null) {
      frames.push({ event, id, data });
    }
  }
  return frames;
}

async function collectSSE(response: Response, timeoutMs = 5000): Promise<SSEFrame[]> {
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
  return parseAllSSEFrames(raw);
}

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let mgr: SessionManager;
let tokenStore: DaemonTokenStore;
let sseBroker: SSEBroker;
let webServer: ServerType;
let controlPort: number;
let token: string;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-id-seam-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  tokenStore = createDaemonTokenStore({ rootDir, log });
  sseBroker = createSSEBroker({ sessionFiles: sf, rootDir, log, pollIntervalMs: 50 });
  controlPort = await getFreePort();
  token = tokenStore.read();

  mgr = createSessionManager({
    db,
    sessionFiles: sf,
    acpSpawner: () => spawnACPClient('true', [], {}),
    log,
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
  });

  const config = { port: 9999, controlPort, bindPublic: false } as AgentRouterConfig;
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

describe('history/SSE id seam cross-check', () => {
  it('first/last_event_id line up with broker SSE replay when malformed lines sit inside the window', async () => {
    const sessionId = crypto.randomUUID();
    sf.createSession(sessionId, 'seed');

    // Seed stream.log with exactly 250 lines; 5 malformed lines scattered INSIDE
    // the last 200 positions (lines 100, 130, 170, 200, 240 — all > 50, so within
    // the lines=200 window which covers raw lines 51..250).
    const malformed = new Set([100, 130, 170, 200, 240]);
    const lines: string[] = [];
    for (let n = 1; n <= 250; n++) {
      if (malformed.has(n)) {
        lines.push(`!!! malformed line ${n} not json`);
      } else {
        // Encode the line number into ts so each valid entry is identifiable.
        lines.push(JSON.stringify({ ts: `line-${n}`, source: 'router', type: 'seed', n }));
      }
    }
    const streamPath = path.join(rootDir, 'sessions', sessionId, 'stream.log');
    fs.writeFileSync(streamPath, lines.join('\n') + '\n');

    // Mark the session terminal so the SSE stream replays the full backlog and closes.
    sf.updateMeta(sessionId, { status: 'completed', completed_at: Math.floor(Date.now() / 1000) });

    // (1) history load
    const detailRes = await fetch(`http://127.0.0.1:${controlPort}/sessions/${sessionId}?lines=200`, {
      headers: authHeaders(),
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      entries: Array<{ ts: string; n: number }>;
      skipped_lines: number;
      first_event_id: number | null;
      last_event_id: number | null;
    };

    // (2) assertions on the detail shape
    // Window = raw lines 51..250 (200 lines), 5 malformed inside → 195 valid entries.
    expect(detail.entries.length).toBe(195);
    expect(detail.skipped_lines).toBe(5);
    // Last valid entry is raw line 250 (250 is not malformed) → last_event_id = 250.
    expect(detail.last_event_id).toBe(250);
    // First valid entry in the window is raw line 51 → first_event_id = 51.
    expect(detail.first_event_id).toBe(51);
    // Broker counts malformed lines in id-space, so the span is the full window
    // (250 - 51 = 199), NOT entries.length - 1 (= 194). This is the HIGH-B redesign.
    expect(detail.last_event_id! - detail.first_event_id!).toBe(199);

    // (3) open SSE replay from just before the first entry's id.
    const sseRes = await fetch(`http://127.0.0.1:${controlPort}/sessions/${sessionId}/stream`, {
      headers: { ...authHeaders(), 'Last-Event-ID': String(detail.first_event_id! - 1) },
    });
    expect(sseRes.status).toBe(200);
    const frames = await collectSSE(sseRes, 4000);

    // The broker replays every raw line from first_event_id..250 (valid + malformed).
    // Build an id → frame map for the valid-entry cross-check.
    const frameById = new Map<number, SSEFrame>();
    for (const f of frames) frameById.set(f.id, f);

    // (4) for every valid history entry, assert the broker frame with that entry's
    // derived id (first_event_id + rawOffset) carries matching data (ts). We derive
    // each entry's raw id from its own `n`, which equals its raw line number.
    for (const entry of detail.entries) {
      const expectedId = entry.n; // raw line number == broker id
      const frame = frameById.get(expectedId);
      expect(frame, `missing SSE frame for id ${expectedId}`).toBeDefined();
      const parsed = JSON.parse(frame!.data) as { ts: string; n: number };
      expect(parsed.ts).toBe(entry.ts);
      expect(parsed.n).toBe(entry.n);
    }

    // The malformed line ids are also replayed by the broker but are NOT valid
    // entries; prove they exist as frames yet carry non-JSON data (so the client
    // would parse them as `unknown`, never as a duplicate of a valid entry).
    for (const m of malformed) {
      if (m < detail.first_event_id!) continue;
      const frame = frameById.get(m);
      expect(frame, `expected broker to replay malformed line ${m}`).toBeDefined();
      expect(() => JSON.parse(frame!.data)).toThrow();
    }
  }, 20_000);

  it('returns null ids for a session with no entries', async () => {
    const sessionId = crypto.randomUUID();
    sf.createSession(sessionId, 'seed');
    sf.updateMeta(sessionId, { status: 'completed', completed_at: Math.floor(Date.now() / 1000) });

    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions/${sessionId}?lines=200`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      entries: unknown[];
      first_event_id: number | null;
      last_event_id: number | null;
    };
    expect(detail.entries.length).toBe(0);
    expect(detail.first_event_id).toBeNull();
    expect(detail.last_event_id).toBeNull();
  }, 15_000);
});

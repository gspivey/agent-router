/**
 * Tier 2 tests: POST /hooks/event endpoint.
 *
 * Exercises the Hono route end-to-end (real fetch against a real server
 * instance), with verifySession stubbed so we can observe whether it was
 * called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { createApp } from '../../src/server.js';
import { createDaemonTokenStore, type DaemonTokenStore } from '../../src/daemon-token.js';
import { createLogger, type Logger } from '../../src/log.js';
import { initDatabase, type Database } from '../../src/db.js';
import type { VerifySessionFn, VerifyResult } from '../../src/verify-session.js';

let rootDir: string;
let log: Logger;
let db: Database;
let tokenStore: DaemonTokenStore;
let server: ServerType;
let baseUrl: string;
let verifyCalls: string[];
let verifyDelay: number;
let verifyResult: VerifyResult;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-endpoint-tier2-'));
  log = createLogger({ level: 'error', output: () => {} });
  db = initDatabase(path.join(rootDir, 'db.sqlite'));
  tokenStore = createDaemonTokenStore({ rootDir, log });
  verifyCalls = [];
  verifyDelay = 0;
  verifyResult = { verified: false, reason: 'no_prs' };

  const verifySession: VerifySessionFn = async (sessionId) => {
    verifyCalls.push(sessionId);
    if (verifyDelay > 0) {
      await new Promise((r) => setTimeout(r, verifyDelay));
    }
    return verifyResult;
  };

  const app = createApp({
    webhookSecret: 'test-secret',
    db,
    enqueue: () => {},
    log,
    tokenStore,
    verifySession,
  });

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

async function postEvent(body: unknown, opts?: { token?: string | null }): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.token === null) {
    // intentionally no auth header
  } else {
    headers['Authorization'] = `Bearer ${opts?.token ?? tokenStore.read()}`;
  }
  return fetch(`${baseUrl}/hooks/event`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /hooks/event', () => {
  describe('authentication', () => {
    it('202 + dispatches verifySession with correct token', async () => {
      const res = await postEvent({ event_type: 'tool.post', session_id: 'sess-1' });
      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['accepted']).toBe(true);

      // Verify the call landed (give the void verifySession promise time to resolve)
      await new Promise((r) => setTimeout(r, 20));
      expect(verifyCalls).toEqual(['sess-1']);
    });

    it('401 + does not call verifySession when Authorization header is missing', async () => {
      const res = await postEvent({ event_type: 'tool.post', session_id: 'sess-1' }, { token: null });
      expect(res.status).toBe(401);
      await new Promise((r) => setTimeout(r, 20));
      expect(verifyCalls).toEqual([]);
    });

    it('401 + does not call verifySession when token is wrong', async () => {
      const res = await postEvent({ event_type: 'tool.post', session_id: 'sess-1' }, { token: 'definitely-wrong' });
      expect(res.status).toBe(401);
      await new Promise((r) => setTimeout(r, 20));
      expect(verifyCalls).toEqual([]);
    });

    it('401 + does not call verifySession when header is malformed (no Bearer prefix)', async () => {
      const res = await fetch(`${baseUrl}/hooks/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: tokenStore.read() },
        body: JSON.stringify({ session_id: 'sess-1' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('body validation', () => {
    it('400 on malformed JSON', async () => {
      const res = await postEvent('not really json at all');
      expect(res.status).toBe(400);
      expect(verifyCalls).toEqual([]);
    });

    it('400 when session_id is missing', async () => {
      const res = await postEvent({ event_type: 'turn.end' });
      expect(res.status).toBe(400);
      expect(verifyCalls).toEqual([]);
    });

    it('400 when session_id is a non-string', async () => {
      const res = await postEvent({ event_type: 'turn.end', session_id: 42 });
      expect(res.status).toBe(400);
      expect(verifyCalls).toEqual([]);
    });

    it('accepts unknown event_type values (forward-compat)', async () => {
      const res = await postEvent({ event_type: 'session.future_event', session_id: 'sess-1' });
      expect(res.status).toBe(202);
    });

    it('accepts request with no event_type at all', async () => {
      const res = await postEvent({ session_id: 'sess-1' });
      expect(res.status).toBe(202);
    });
  });

  describe('async dispatch', () => {
    it('responds quickly even when verifySession is slow', async () => {
      verifyDelay = 500; // half a second
      const t0 = Date.now();
      const res = await postEvent({ event_type: 'tool.post', session_id: 'sess-1' });
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(202);
      // Should respond well under 200ms — the verifySession is fire-and-forget
      expect(elapsed).toBeLessThan(200);
    });

    it('logs verifySession errors without crashing the endpoint', async () => {
      verifyResult = { verified: false, reason: 'github_error', error: 'whatever' };
      // Even if verifier reports error, endpoint returns 202 (it's fire-and-forget)
      const res = await postEvent({ event_type: 'tool.post', session_id: 'sess-1' });
      expect(res.status).toBe(202);
    });
  });

  describe('method handling', () => {
    it('405 on GET /hooks/event', async () => {
      const res = await fetch(`${baseUrl}/hooks/event`);
      expect(res.status).toBe(405);
    });
  });

  describe('without tokenStore (endpoint disabled)', () => {
    it('returns 404 when the daemon was started without hook-endpoint wiring', async () => {
      // Tear down the running server and start a new one without tokenStore.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const noHookApp = createApp({
        webhookSecret: 'test-secret',
        db,
        enqueue: () => {},
        log,
        // tokenStore and verifySession intentionally omitted
      });
      await new Promise<void>((resolve) => {
        server = serve({ fetch: noHookApp.fetch, port: 0 }, (info) => {
          baseUrl = `http://127.0.0.1:${info.port}`;
          resolve();
        });
      });

      const res = await fetch(`${baseUrl}/hooks/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
        body: JSON.stringify({ session_id: 'x' }),
      });
      expect(res.status).toBe(404);
    });
  });
});

/**
 * Tier 1 tests: `token_expiry` field in `GET /overview`.
 *
 * Verifies that the `GET /overview` endpoint:
 *   - includes `token_expiry` with `days_remaining`, `severity`, and
 *     `expires_at` when the `tokenExpiry` getter returns a non-null condition
 *     (BACKLOG.md § P2.33), and
 *   - omits the field entirely when the getter returns null or is absent.
 *
 * Uses `createWebRoutes` directly with minimal stubs — no network, no DB,
 * no session files on disk.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWebRoutes, type OverviewResponse } from '../../../src/web-routes.js';
import { createSessionFiles, type SessionFiles } from '../../../src/session-files.js';
import { createSSEBroker, type SSEBroker } from '../../../src/sse-broker.js';
import { createLogger, type Logger } from '../../../src/log.js';
import type { SessionManager } from '../../../src/session-mgr.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => makeLogger() };
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestCtx {
  rootDir: string;
  sessionFiles: SessionFiles;
  sseBroker: SSEBroker;
  log: Logger;
}

function makeCtx(): TestCtx {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-te-t1-'));
  const log = makeLogger();
  const sessionFiles = createSessionFiles(rootDir);
  const sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
  return { rootDir, sessionFiles, sseBroker, log };
}

function cleanup(ctx: TestCtx): void {
  ctx.sseBroker.shutdown();
  fs.rmSync(ctx.rootDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /overview token_expiry field (BACKLOG.md § P2.33)', () => {
  it('omits token_expiry when tokenExpiry getter is absent', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        // tokenExpiry intentionally omitted
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body).not.toHaveProperty('token_expiry');
    } finally {
      cleanup(ctx);
    }
  });

  it('omits token_expiry when getter returns null', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        tokenExpiry: () => null,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body).not.toHaveProperty('token_expiry');
    } finally {
      cleanup(ctx);
    }
  });

  it('includes token_expiry with warn severity when getter returns a warn condition', async () => {
    const ctx = makeCtx();
    try {
      const expiresAt = '2027-01-10T00:00:00.000Z';

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        tokenExpiry: () => ({
          days_remaining: 8,
          severity: 'warn',
          expires_at: expiresAt,
        }),
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.token_expiry).toBeDefined();
      expect(body.token_expiry?.days_remaining).toBe(8);
      expect(body.token_expiry?.severity).toBe('warn');
      expect(body.token_expiry?.expires_at).toBe(expiresAt);
    } finally {
      cleanup(ctx);
    }
  });

  it('includes token_expiry with error severity when getter returns an error condition', async () => {
    const ctx = makeCtx();
    try {
      const expiresAt = '2027-01-03T00:00:00.000Z';

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        tokenExpiry: () => ({
          days_remaining: 1,
          severity: 'error',
          expires_at: expiresAt,
        }),
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.token_expiry).toBeDefined();
      expect(body.token_expiry?.days_remaining).toBe(1);
      expect(body.token_expiry?.severity).toBe('error');
      expect(body.token_expiry?.expires_at).toBe(expiresAt);
    } finally {
      cleanup(ctx);
    }
  });

  it('includes token_expiry with negative days_remaining for already-expired token', async () => {
    const ctx = makeCtx();
    try {
      const expiresAt = '2026-10-01T00:00:00.000Z';

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        tokenExpiry: () => ({
          days_remaining: -5,
          severity: 'error',
          expires_at: expiresAt,
        }),
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.token_expiry).toBeDefined();
      expect(body.token_expiry?.days_remaining).toBe(-5);
      expect(body.token_expiry?.severity).toBe('error');
    } finally {
      cleanup(ctx);
    }
  });

  it('response always has HTTP 200 regardless of token_expiry condition', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        tokenExpiry: () => ({
          days_remaining: 0,
          severity: 'error',
          expires_at: new Date().toISOString(),
        }),
      });

      const res = await app.request('/overview', { method: 'GET' });
      // GET /overview always returns 200 (never 503 like /health)
      expect(res.status).toBe(200);
    } finally {
      cleanup(ctx);
    }
  });
});

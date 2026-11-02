/**
 * Tier 1 tests: `restart_required` field in `GET /overview`.
 *
 * Verifies that the `GET /overview` endpoint:
 *   - includes `restart_required` when the `restartRequired` getter returns a
 *     non-null condition (BACKLOG.md § P2.30), and
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
import type { RestartRequiredCondition } from '../../../src/restart-required.js';

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-rr-t1-'));
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

describe('GET /overview restart_required field (BACKLOG.md § P2.30)', () => {
  it('omits restart_required when restartRequired getter is absent', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        // restartRequired intentionally omitted
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body).not.toHaveProperty('restart_required');
    } finally {
      cleanup(ctx);
    }
  });

  it('omits restart_required when getter returns null', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        restartRequired: () => null,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body).not.toHaveProperty('restart_required');
    } finally {
      cleanup(ctx);
    }
  });

  it('includes restart_required with fields and ISO since when condition is set', async () => {
    const ctx = makeCtx();
    try {
      const sinceMs = 1_700_000_000_000;
      const condition: RestartRequiredCondition = {
        fields: ['kiroPath'],
        since: sinceMs,
      };

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        restartRequired: () => condition,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.restart_required).toBeDefined();
      expect(body.restart_required?.fields).toEqual(['kiroPath']);
      // since must be a valid ISO 8601 string matching the input ms
      const sinceParsed = new Date(body.restart_required?.since ?? '').getTime();
      expect(sinceParsed).toBe(sinceMs);
    } finally {
      cleanup(ctx);
    }
  });

  it('includes multiple fields when multiple restart-required fields changed', async () => {
    const ctx = makeCtx();
    try {
      const condition: RestartRequiredCondition = {
        fields: ['port', 'controlPort'],
        since: Date.now(),
      };

      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        restartRequired: () => condition,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.restart_required?.fields).toEqual(['port', 'controlPort']);
    } finally {
      cleanup(ctx);
    }
  });

  it('response always has HTTP 200 regardless of restart_required condition', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        restartRequired: () => ({ fields: ['kiroPath'], since: Date.now() }),
      });

      const res = await app.request('/overview', { method: 'GET' });
      // GET /overview always returns 200 (never 503 like /health)
      expect(res.status).toBe(200);
    } finally {
      cleanup(ctx);
    }
  });
});

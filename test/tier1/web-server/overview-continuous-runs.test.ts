/**
 * Tier 1 tests: `continuous_runs` field in `GET /overview`.
 *
 * Verifies that the `GET /overview` endpoint:
 *   - omits `continuous_runs` when the `continuousRuns` getter is absent
 *     (backwards-compat for callers that don't supply the continuous runner),
 *   - includes `continuous_runs` as an empty array when the getter returns [],
 *   - includes `continuous_runs` with the DTO array returned by the getter, and
 *   - reflects live getter state on each request (not a snapshot).
 *
 * Uses `createWebRoutes` directly with injected stubs — no network, no disk I/O.
 *
 * See BACKLOG.md § P2.35.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createWebRoutes, type OverviewResponse } from '../../../src/web-routes.js';
import { createSessionFiles, type SessionFiles } from '../../../src/session-files.js';
import { createSSEBroker, type SSEBroker } from '../../../src/sse-broker.js';
import { createLogger, type Logger } from '../../../src/log.js';
import type { SessionManager } from '../../../src/session-mgr.js';
import type { ContinuousRunDTO } from '../../../src/continuous-runner.js';

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-cr-t1-'));
  const log = makeLogger();
  const sessionFiles = createSessionFiles(rootDir);
  const sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
  return { rootDir, sessionFiles, sseBroker, log };
}

function cleanup(ctx: TestCtx): void {
  ctx.sseBroker.shutdown();
  fs.rmSync(ctx.rootDir, { recursive: true, force: true });
}

function makeRunningDTO(repo: string): ContinuousRunDTO {
  return {
    repo,
    status: 'running',
    items_completed: 3,
    current_session_id: 'sess-abc',
    started_at: Math.floor(Date.now() / 1000) - 120,
  };
}

function makeStoppedDTO(repo: string): ContinuousRunDTO {
  return {
    repo,
    status: 'stopped',
    stop_reason: 'queue_empty',
    items_completed: 5,
    current_session_id: null,
    started_at: Math.floor(Date.now() / 1000) - 300,
    stopped_at: Math.floor(Date.now() / 1000) - 10,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /overview continuous_runs field (BACKLOG.md § P2.35)', () => {
  it('omits continuous_runs when the getter is not provided', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        // continuousRuns intentionally omitted
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.continuous_runs).toBeUndefined();
    } finally {
      cleanup(ctx);
    }
  });

  it('includes continuous_runs as [] when the getter returns an empty array', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        continuousRuns: () => [],
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.continuous_runs).toEqual([]);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns a running DTO with the correct fields', async () => {
    const ctx = makeCtx();
    try {
      const dto = makeRunningDTO('org/myrepo');
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        continuousRuns: () => [dto],
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.continuous_runs).toHaveLength(1);
      const run = body.continuous_runs?.[0];
      expect(run?.repo).toBe('org/myrepo');
      expect(run?.status).toBe('running');
      expect(run?.items_completed).toBe(3);
      expect(run?.current_session_id).toBe('sess-abc');
      expect(run?.stop_reason).toBeUndefined();
    } finally {
      cleanup(ctx);
    }
  });

  it('returns a stopped DTO with stop_reason and stopped_at', async () => {
    const ctx = makeCtx();
    try {
      const dto = makeStoppedDTO('org/stopped-repo');
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        continuousRuns: () => [dto],
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.continuous_runs).toHaveLength(1);
      const run = body.continuous_runs?.[0];
      expect(run?.status).toBe('stopped');
      expect(run?.stop_reason).toBe('queue_empty');
      expect(run?.current_session_id).toBeNull();
      expect(typeof run?.stopped_at).toBe('number');
    } finally {
      cleanup(ctx);
    }
  });

  it('returns multiple DTOs for different repos', async () => {
    const ctx = makeCtx();
    try {
      const dtos: ContinuousRunDTO[] = [
        makeRunningDTO('org/repo-a'),
        makeStoppedDTO('org/repo-b'),
      ];
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        continuousRuns: () => dtos,
      });

      const res = await app.request('/overview', { method: 'GET' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OverviewResponse;
      expect(body.continuous_runs).toHaveLength(2);
      const repos = body.continuous_runs?.map((r) => r.repo) ?? [];
      expect(repos).toContain('org/repo-a');
      expect(repos).toContain('org/repo-b');
    } finally {
      cleanup(ctx);
    }
  });

  it('reflects live getter state — second request sees updated run list', async () => {
    const ctx = makeCtx();
    try {
      // Start with one running DTO.
      const runs: ContinuousRunDTO[] = [makeRunningDTO('org/live-repo')];
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        // Getter reads from `runs` by reference — mutations are visible.
        continuousRuns: () => [...runs],
      });

      const res1 = await app.request('/overview', { method: 'GET' });
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as OverviewResponse;
      expect(body1.continuous_runs).toHaveLength(1);

      // Simulate run completing — clear the array.
      runs.length = 0;

      const res2 = await app.request('/overview', { method: 'GET' });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as OverviewResponse;
      expect(body2.continuous_runs).toHaveLength(0);
    } finally {
      cleanup(ctx);
    }
  });

  it('returns HTTP 200 regardless of continuous_runs content', async () => {
    const ctx = makeCtx();
    try {
      const app = createWebRoutes({
        sessionMgr: stubSessionMgr(),
        sessionFiles: ctx.sessionFiles,
        sseBroker: ctx.sseBroker,
        rootDir: ctx.rootDir,
        log: ctx.log,
        shuttingDown: () => false,
        continuousRuns: () => [makeRunningDTO('org/repo'), makeStoppedDTO('org/repo2')],
      });

      const res = await app.request('/overview', { method: 'GET' });
      // GET /overview always returns 200
      expect(res.status).toBe(200);
    } finally {
      cleanup(ctx);
    }
  });
});

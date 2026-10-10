/**
 * Tier 2 tests: the `/v1` REST API against the real task layer (task 10.4).
 *
 * Wires `initTaskDatabase` (real SQLite tmpdir) + `TaskService` + `RepoScheduler`
 * + `TaskEventBroker` + `AttemptRunner` into `createWebApp`, starts the server on
 * an ephemeral port, and exercises the public HTTP surface: submit idempotency,
 * list/get filters, retry/cancel 409 rules, attempt listing, repo status +
 * breaker reset with two-segment repo paths, the `blocked` field in attempt
 * detail, and the 400/404 envelopes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import BetterSqlite3 from 'better-sqlite3';
import { createSessionFiles } from '../../src/session-files.js';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';
import { createDaemonTokenStore } from '../../src/daemon-token.js';
import { createSSEBroker } from '../../src/sse-broker.js';
import { createWebApp, startWebServer } from '../../src/web-server.js';
import type { SessionManager } from '../../src/session-mgr.js';
import type { AgentRouterConfig } from '../../src/config.js';
import { initTaskDatabase } from '../../src/task-db.js';
import type { TaskDatabase } from '../../src/task-db.js';
import { TaskService } from '../../src/task-service.js';
import { RepoScheduler } from '../../src/repo-scheduler.js';
import { TaskEventBroker } from '../../src/task-event-broker.js';
import { AttemptRunner } from '../../src/attempt-runner.js';
import type { WorktreeOps, ProcessOps } from '../../src/attempt-runner.js';
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

function stubSessionMgr(): SessionManager {
  return {
    getActiveSession: () => null,
    hasActiveSessionForRepo: () => false,
    listActiveSessions: () => [],
    injectPrompt: async () => {},
    terminateSession: async () => {},
    createSession: async () => ({ sessionId: '', sessionDir: '' }),
    registerPR: () => {},
    shutdown: async () => {},
    completeSession: async () => {},
    resumeSessions: async () => ({ resumed: 0, terminated: 0 }),
  } as unknown as SessionManager;
}

const noopWorktree: WorktreeOps = {
  add: async () => {},
  remove: async () => {},
  headSha: async () => 'deadbeef',
  hasDiff: async () => false,
  remoteBranchMatchesHead: async () => false,
  clearOutcomeFile: async () => {},
  readOutcomeFile: async () => null,
};

const noopProcess: ProcessOps = {
  killProcessGroup: async () => {},
};

const REPO = 'o/r';

interface Harness {
  rootDir: string;
  controlPort: number;
  token: string;
  db: TaskDatabase;
  scheduler: RepoScheduler;
  attemptRunner: AttemptRunner;
  webServer: ServerType;
  handle: BetterSqlite3.Database;
}

let harness: Harness | null = null;

async function setup(): Promise<Harness> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-api-'));
  const log: Logger = createLogger({ level: 'error', output: () => {} });
  const sessionFiles = createSessionFiles(rootDir);
  const daemonTokenStore = createDaemonTokenStore({ rootDir, log });
  const sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
  const controlPort = await getFreePort();
  const token = daemonTokenStore.read();

  const handle = new BetterSqlite3(path.join(rootDir, 'tasks.db'));
  handle.pragma('journal_mode = WAL');
  const db = initTaskDatabase(handle);

  const configuredRepos = new Set([REPO]);

  // A scheduler whose starter does nothing (no real attempt start) — tasks stay
  // queued, so cancel/retry conflict rules can be exercised deterministically.
  const scheduler = new RepoScheduler({
    db,
    log,
    startAttempt: async () => false,
  });
  const eventBroker = new TaskEventBroker({ db, heartbeatMs: 0 });
  const attemptRunner = new AttemptRunner({
    db,
    scheduler,
    log,
    worktree: noopWorktree,
    process: noopProcess,
  });
  const taskService = new TaskService({ db, scheduler, configuredRepos });

  const config = {
    port: 9999,
    controlPort,
    bindPublic: false,
    webhookSecret: 'test-secret',
    kiroPath: '/usr/bin/true',
    rateLimit: { perPRSeconds: 60 },
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    repos: [{ owner: 'o', name: 'r' }],
    cron: [],
    credentialMode: 'env' as const,
    reaper: { enabled: false, gracePeriodMinutes: 60, retentionDays: 30, agentRunsDir: rootDir, sweepIntervalMinutes: 15 },
    shutdownDrainSeconds: 60,
    idleTimeoutSeconds: 900,
    setupTimeoutSeconds: 120,
    taskTranscript: { archiveGraceMinutes: 60, retentionDays: 90, sweepIntervalMinutes: 30 },
    roadmap: { scanIntervalMinutes: 15 },
  } as unknown as AgentRouterConfig;

  const app = createWebApp({
    sessionMgr: stubSessionMgr(),
    sessionFiles,
    sseBroker,
    tokenStore: daemonTokenStore,
    log,
    rootDir,
    config,
    shuttingDown: () => false,
    v1: {
      taskService,
      scheduler,
      eventBroker,
      db,
      attemptRunner,
      configuredRepos,
      transcript: { graceMs: 60 * 60_000, ttlMs: 90 * 24 * 60 * 60_000 },
    },
  });

  const webServer = startWebServer(app, config, log);
  return { rootDir, controlPort, token, db, scheduler, attemptRunner, webServer, handle };
}

function url(h: Harness, p: string): string {
  return `http://127.0.0.1:${h.controlPort}${p}`;
}

function authed(h: Harness, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${h.token}`,
      'Content-Type': 'application/json',
    },
  };
}

beforeEach(async () => {
  harness = await setup();
});

afterEach(() => {
  if (harness) {
    harness.webServer.close();
    harness.handle.close();
    fs.rmSync(harness.rootDir, { recursive: true, force: true });
    harness = null;
  }
});

async function submit(h: Harness, body: Record<string, unknown>): Promise<Response> {
  return fetch(url(h, '/v1/tasks'), authed(h, { method: 'POST', body: JSON.stringify(body) }));
}

describe('/v1 auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const h = harness!;
    const resp = await fetch(url(h, '/v1/tasks'));
    expect(resp.status).toBe(401);
  });
});

describe('POST /v1/tasks', () => {
  it('creates a task with 201 and v:1', async () => {
    const h = harness!;
    const resp = await submit(h, { repo: REPO, title: 'T', spec: 'do it' });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { v: number; task: { id: string; state: string } };
    expect(body.v).toBe(1);
    expect(body.task.state).toBe('queued');
    expect(typeof body.task.id).toBe('string');
  });

  it('is idempotent on external_id (200 on duplicate)', async () => {
    const h = harness!;
    const first = await submit(h, { repo: REPO, title: 'T', spec: 's', external_id: 'ext-1' });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { task: { id: string } }).task.id;

    const second = await submit(h, { repo: REPO, title: 'T2', spec: 's2', external_id: 'ext-1' });
    expect(second.status).toBe(200);
    const secondId = ((await second.json()) as { task: { id: string } }).task.id;
    expect(secondId).toBe(firstId);
  });

  it('rejects a missing required field with 400 invalid_body', async () => {
    const h = harness!;
    const resp = await submit(h, { repo: REPO, spec: 's' });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });

  it('rejects an unconfigured repo with 400 invalid_repo', async () => {
    const h = harness!;
    const resp = await submit(h, { repo: 'x/y', title: 'T', spec: 's' });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe('invalid_repo');
  });

  it('rejects an invalid agent with 400 invalid_agent', async () => {
    const h = harness!;
    const resp = await submit(h, { repo: REPO, title: 'T', spec: 's', agent: 'bogus' });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe('invalid_agent');
  });
});

describe('GET /v1/tasks and /v1/tasks/:id', () => {
  it('lists tasks and filters by repo + state', async () => {
    const h = harness!;
    await submit(h, { repo: REPO, title: 'A', spec: 's' });
    await submit(h, { repo: REPO, title: 'B', spec: 's' });

    const all = await fetch(url(h, '/v1/tasks'), authed(h));
    const allBody = (await all.json()) as { v: number; tasks: unknown[] };
    expect(allBody.v).toBe(1);
    expect(allBody.tasks.length).toBe(2);

    const queued = await fetch(url(h, '/v1/tasks?state=queued'), authed(h));
    expect(((await queued.json()) as { tasks: unknown[] }).tasks.length).toBe(2);

    const byRepo = await fetch(url(h, `/v1/tasks?repo=${encodeURIComponent(REPO)}&state=queued`), authed(h));
    expect(((await byRepo.json()) as { tasks: unknown[] }).tasks.length).toBe(2);

    const none = await fetch(url(h, '/v1/tasks?state=succeeded'), authed(h));
    expect(((await none.json()) as { tasks: unknown[] }).tasks.length).toBe(0);
  });

  it('rejects an invalid state filter with 400 invalid_param', async () => {
    const h = harness!;
    const resp = await fetch(url(h, '/v1/tasks?state=nope'), authed(h));
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe('invalid_param');
  });

  it('returns a task with its latest_attempt (null when none)', async () => {
    const h = harness!;
    const created = await submit(h, { repo: REPO, title: 'T', spec: 's' });
    const id = ((await created.json()) as { task: { id: string } }).task.id;
    const resp = await fetch(url(h, `/v1/tasks/${id}`), authed(h));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { v: number; task: { id: string }; latest_attempt: unknown };
    expect(body.task.id).toBe(id);
    expect(body.latest_attempt).toBeNull();
  });

  it('returns 404 not_found for an unknown task', async () => {
    const h = harness!;
    const resp = await fetch(url(h, '/v1/tasks/nope'), authed(h));
    expect(resp.status).toBe(404);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('retry and cancel', () => {
  it('retry returns 409 on a queued task', async () => {
    const h = harness!;
    const created = await submit(h, { repo: REPO, title: 'T', spec: 's' });
    const id = ((await created.json()) as { task: { id: string } }).task.id;
    const resp = await fetch(url(h, `/v1/tasks/${id}/attempts`), authed(h, { method: 'POST', body: '{}' }));
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('retry re-queues a failed task with 202', async () => {
    const h = harness!;
    const created = await submit(h, { repo: REPO, title: 'T', spec: 's' });
    const id = ((await created.json()) as { task: { id: string } }).task.id;
    // Force the task to failed directly in the DB.
    h.db.setTaskState(id, 'failed', Date.now());
    const resp = await fetch(url(h, `/v1/tasks/${id}/attempts`), authed(h, { method: 'POST', body: '{}' }));
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { task: { state: string } };
    expect(body.task.state).toBe('queued');
  });

  it('cancel transitions a queued task to cancelled (no attempt.ended)', async () => {
    const h = harness!;
    const created = await submit(h, { repo: REPO, title: 'T', spec: 's' });
    const id = ((await created.json()) as { task: { id: string } }).task.id;
    const resp = await fetch(url(h, `/v1/tasks/${id}/cancel`), authed(h, { method: 'POST', body: '{}' }));
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { task: { state: string } }).task.state).toBe('cancelled');
  });

  it('cancel returns 409 on an already-cancelled task', async () => {
    const h = harness!;
    const created = await submit(h, { repo: REPO, title: 'T', spec: 's' });
    const id = ((await created.json()) as { task: { id: string } }).task.id;
    await fetch(url(h, `/v1/tasks/${id}/cancel`), authed(h, { method: 'POST', body: '{}' }));
    const second = await fetch(url(h, `/v1/tasks/${id}/cancel`), authed(h, { method: 'POST', body: '{}' }));
    expect(second.status).toBe(409);
  });
});

describe('attempts and repos', () => {
  it('lists attempts for a task (empty array) and 404 for unknown task', async () => {
    const h = harness!;
    const created = await submit(h, { repo: REPO, title: 'T', spec: 's' });
    const id = ((await created.json()) as { task: { id: string } }).task.id;
    const resp = await fetch(url(h, `/v1/tasks/${id}/attempts`), authed(h));
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { attempts: unknown[] }).attempts).toEqual([]);

    const missing = await fetch(url(h, '/v1/tasks/nope/attempts'), authed(h));
    expect(missing.status).toBe(404);
  });

  it('GET /v1/attempts/:id surfaces the blocked field', async () => {
    const h = harness!;
    // Insert a blocked attempt directly via the DB helpers.
    const created = await submit(h, { repo: REPO, title: 'T', spec: 's' });
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;
    const attemptId = 'att-blocked-1';
    const started = h.db.startAttemptWithEvent(
      {
        id: attemptId,
        taskId,
        attemptNo: 1,
        sessionId: 'sess-x',
        worktreeBranch: `agent/${attemptId}`,
        worktreePath: `/tmp/agent-runs/${attemptId}`,
        state: 'running',
        leaseExpiresAt: null,
        artifacts: null,
        promptHash: 'h',
        startedAt: Date.now(),
      },
      'running',
      { id: 'ev1', ts: Date.now(), type: 'attempt.started', repo: REPO, taskId, attemptId, data: {} }
    );
    expect(started).not.toBeNull();
    h.db.endAttemptWithEvent(
      attemptId,
      {
        outcome: 'blocked',
        failureClass: null,
        reasonCode: 'agent_blocked',
        reason: 'need a decision',
        blocked: { question: 'which approach?', needs: 'decision' },
        artifacts: null,
        usage: null,
        agentVersion: null,
        model: null,
        endedAt: Date.now(),
      },
      'blocked',
      { id: 'ev2', ts: Date.now(), type: 'attempt.ended', repo: REPO, taskId, attemptId, data: {} }
    );

    const resp = await fetch(url(h, `/v1/attempts/${attemptId}`), authed(h));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { attempt: { blocked: { question: string; needs: string } | null } };
    expect(body.attempt.blocked).toEqual({ question: 'which approach?', needs: 'decision' });
  });

  it('GET /v1/attempts/:id returns 404 for unknown attempt', async () => {
    const h = harness!;
    const resp = await fetch(url(h, '/v1/attempts/nope'), authed(h));
    expect(resp.status).toBe(404);
  });

  it('lists repos with the flat status shape', async () => {
    const h = harness!;
    const resp = await fetch(url(h, '/v1/repos'), authed(h));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      v: number;
      repos: Array<{ repo: string; circuit_breaker_state: string; slots_total: number }>;
    };
    expect(body.v).toBe(1);
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]!.repo).toBe(REPO);
    expect(body.repos[0]!.circuit_breaker_state).toBe('closed');
    expect(body.repos[0]!.slots_total).toBe(1);
  });

  it('returns repo status via two-segment path and resets the breaker', async () => {
    const h = harness!;
    const status = await fetch(url(h, '/v1/repos/o/r/status'), authed(h));
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { v: number; repo: string; circuit_breaker_state: string };
    expect(statusBody.v).toBe(1);
    expect(statusBody.repo).toBe(REPO);

    const reset = await fetch(
      url(h, '/v1/repos/o/r/circuit-breaker/reset'),
      authed(h, { method: 'POST', body: '{}' })
    );
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { circuit_breaker_state: string }).circuit_breaker_state).toBe('closed');
  });

  it('returns 404 for an unconfigured repo status', async () => {
    const h = harness!;
    const resp = await fetch(url(h, '/v1/repos/x/y/status'), authed(h));
    expect(resp.status).toBe(404);
  });
});

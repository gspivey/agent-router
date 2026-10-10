/**
 * Tier 2 tests: the `/v1/events` SSE stream with replay (task 10.5).
 *
 * Submits tasks (each emits a `task.queued` event into `task_events`), then
 * subscribes to `/v1/events` with `?since` and `Last-Event-ID` and asserts the
 * replay resumes with no gaps or duplicates, and that when both are present the
 * larger cursor wins.
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
  headSha: async () => 'x',
  hasDiff: async () => false,
  remoteBranchMatchesHead: async () => false,
  clearOutcomeFile: async () => {},
  readOutcomeFile: async () => null,
};
const noopProcess: ProcessOps = { killProcessGroup: async () => {} };

const REPO = 'o/r';

interface Harness {
  rootDir: string;
  controlPort: number;
  token: string;
  db: TaskDatabase;
  broker: TaskEventBroker;
  webServer: ServerType;
  handle: BetterSqlite3.Database;
}

let harness: Harness | null = null;

async function setup(): Promise<Harness> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-events-'));
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

  const scheduler = new RepoScheduler({ db, log, startAttempt: async () => false });
  const broker = new TaskEventBroker({ db, heartbeatMs: 0 });
  const attemptRunner = new AttemptRunner({ db, scheduler, log, worktree: noopWorktree, process: noopProcess });
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
      eventBroker: broker,
      db,
      attemptRunner,
      configuredRepos,
      transcript: { graceMs: 60 * 60_000, ttlMs: 90 * 24 * 60 * 60_000 },
    },
  });

  const webServer = startWebServer(app, config, log);
  return { rootDir, controlPort, token, db, broker, webServer, handle };
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

interface SseEvent {
  seq: number;
  type: string;
}

/** Submit N tasks, each producing one task.queued event. */
async function submitTasks(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const resp = await fetch(`http://127.0.0.1:${h.controlPort}/v1/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: REPO, title: `T${i}`, spec: 's' }),
    });
    expect(resp.status).toBe(201);
  }
}

/**
 * Connect to /v1/events with the given headers, read for a short window, and
 * return the parsed data events (replay burst). Closes the connection after the
 * read window.
 */
async function readEvents(
  h: Harness,
  opts: { since?: number; lastEventId?: number; windowMs?: number }
): Promise<SseEvent[]> {
  const headers: Record<string, string> = { Authorization: `Bearer ${h.token}` };
  if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = String(opts.lastEventId);
  const query = opts.since !== undefined ? `?since=${opts.since}` : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.windowMs ?? 300);

  const events: SseEvent[] = [];
  try {
    const resp = await fetch(`http://127.0.0.1:${h.controlPort}/v1/events${query}`, {
      headers,
      signal: controller.signal,
    });
    if (resp.status !== 200 || resp.body === null) {
      return events;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine === undefined) continue;
        try {
          const env = JSON.parse(dataLine.slice(6)) as { seq: number; type: string };
          events.push({ seq: env.seq, type: env.type });
        } catch {
          /* comment / non-JSON frame */
        }
      }
    }
  } catch {
    /* aborted after the read window */
  } finally {
    clearTimeout(timer);
  }
  return events;
}

describe('GET /v1/events replay', () => {
  it('rejects a non-integer since with 400 invalid_param', async () => {
    const h = harness!;
    const resp = await fetch(`http://127.0.0.1:${h.controlPort}/v1/events?since=abc`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe('invalid_param');
  });

  it('replays all events from the beginning in strictly increasing seq order', async () => {
    const h = harness!;
    await submitTasks(h, 3);
    const events = await readEvents(h, { since: 0 });
    expect(events.length).toBe(3);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect(events.every((e) => e.type === 'task.queued')).toBe(true);
  });

  it('resumes after a cursor via ?since with no gaps or duplicates', async () => {
    const h = harness!;
    await submitTasks(h, 4);
    const all = await readEvents(h, { since: 0 });
    expect(all.length).toBe(4);
    const cursor = all[1]!.seq; // resume after the 2nd event

    const resumed = await readEvents(h, { since: cursor });
    expect(resumed.length).toBe(2);
    expect(resumed.every((e) => e.seq > cursor)).toBe(true);
    const resumedSeqs = resumed.map((e) => e.seq);
    expect(new Set(resumedSeqs).size).toBe(resumedSeqs.length);
  });

  it('resumes via the Last-Event-ID header', async () => {
    const h = harness!;
    await submitTasks(h, 3);
    const all = await readEvents(h, { since: 0 });
    const cursor = all[0]!.seq;

    const resumed = await readEvents(h, { lastEventId: cursor });
    expect(resumed.every((e) => e.seq > cursor)).toBe(true);
    expect(resumed.length).toBe(2);
  });

  it('uses the larger of ?since and Last-Event-ID when both are present', async () => {
    const h = harness!;
    await submitTasks(h, 4);
    const all = await readEvents(h, { since: 0 });
    const smaller = all[0]!.seq;
    const larger = all[2]!.seq;

    // since=smaller, Last-Event-ID=larger → the larger wins (only events > larger).
    const resumed = await readEvents(h, { since: smaller, lastEventId: larger });
    expect(resumed.every((e) => e.seq > larger)).toBe(true);
    expect(resumed.length).toBe(1);
  });
});

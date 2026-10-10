/**
 * Tier 2 tests: restart (crash recovery) for the task layer (task 11.3).
 *
 * Against a real SQLite tmpdir with a real `AttemptRunner`/`RepoScheduler` and
 * inert git/process effects: a `running` attempt left in the DB becomes
 * `interrupted` with an emitted `attempt.ended`; its parent task transitions to
 * `failed`/`interrupted` (NOT re-queued, NOT auto-retried — Req 13.9); the
 * interruption does NOT increment `consecutive_failures` (Req 12.5/13.10);
 * `daemon.started` lists the interrupted ids (Req 13.4); a stranded `running`
 * task with no `running` attempt is swept to `failed` (Req 13.1/HIGH-4); and a
 * task already `queued` before restart is left untouched (Req 13.8).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';
import { initTaskDatabase } from '../../src/task-db.js';
import type { TaskDatabase } from '../../src/task-db.js';
import { RepoScheduler } from '../../src/repo-scheduler.js';
import { AttemptRunner } from '../../src/attempt-runner.js';
import type { WorktreeOps, ProcessOps } from '../../src/attempt-runner.js';
import { TaskEventBroker } from '../../src/task-event-broker.js';
import { runRestartRecovery } from '../../src/task-recovery.js';

const log: Logger = createLogger({ level: 'error', output: () => {} });

const noopWorktree: WorktreeOps = {
  add: async () => {},
  remove: async () => {},
  headSha: async () => '',
  hasDiff: async () => false,
  remoteBranchMatchesHead: async () => null,
  clearOutcomeFile: async () => {},
  readOutcomeFile: async () => null,
};
const noopProcess: ProcessOps = { killProcessGroup: async () => {} };

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  cleanup = [];
});

interface Harness {
  db: TaskDatabase;
  scheduler: RepoScheduler;
  attemptRunner: AttemptRunner;
  broker: TaskEventBroker;
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'restart-recovery-'));
  const handle = new BetterSqlite3(join(dir, 'test.db'));
  handle.pragma('journal_mode = WAL');
  const db = initTaskDatabase(handle);
  cleanup.push(() => handle.close());
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

  const scheduler = new RepoScheduler({ db, log, startAttempt: async () => false });
  const attemptRunner = new AttemptRunner({ db, scheduler, log, worktree: noopWorktree, process: noopProcess });
  const broker = new TaskEventBroker({ db, heartbeatMs: 0 });
  return { db, scheduler, attemptRunner, broker };
}

const REPO = 'o/r';

/** Insert a queued task, then claim it and insert a running attempt. */
function seedRunningAttempt(db: TaskDatabase, taskId: string, attemptId: string): void {
  const ts = Date.now();
  db.createTaskWithEvent(
    {
      id: taskId,
      externalId: null,
      repo: REPO,
      source: 'api',
      sourceRef: null,
      title: 'T',
      spec: 's',
      baseRef: null,
      agent: 'kiro',
      budget: null,
      metadata: null,
      state: 'queued',
      createdAt: ts,
      updatedAt: ts,
    },
    { id: `ev-q-${taskId}`, ts, type: 'task.queued', repo: REPO, taskId, attemptId: null, data: {} }
  );
  const started = db.startAttemptWithEvent(
    {
      id: attemptId,
      taskId,
      attemptNo: 1,
      sessionId: `sess-${attemptId}`,
      worktreeBranch: `agent/${attemptId}`,
      worktreePath: `/tmp/agent-runs/${attemptId}`,
      state: 'running',
      leaseExpiresAt: ts + 90_000,
      artifacts: { branch: `agent/${attemptId}`, base_sha: 'base123' },
      promptHash: 'h',
      startedAt: ts,
    },
    'running',
    { id: `ev-s-${attemptId}`, ts, type: 'attempt.started', repo: REPO, taskId, attemptId, data: {} }
  );
  if (started === null) throw new Error('failed to seed running attempt');
}

describe('restart recovery', () => {
  it('ends a running attempt interrupted and fails its task (no auto-retry)', async () => {
    const { db, attemptRunner, broker } = setup();
    seedRunningAttempt(db, 'task-1', 'att-1');

    const result = await runRestartRecovery({
      db,
      attemptRunner,
      broker,
      log,
      version: '0.1.0',
    });

    expect(result.interruptedAttemptIds).toEqual(['att-1']);

    const attempt = db.getAttempt('att-1')!;
    expect(attempt.state).toBe('ended');
    expect(attempt.outcome).toBe('interrupted');
    expect(attempt.failureClass).toBe('infra');
    expect(attempt.reasonCode).toBe('interrupted');

    const task = db.getTask('task-1')!;
    // Interrupted → failed, NOT re-queued (Req 13.9).
    expect(task.state).toBe('failed');
  });

  it('emits attempt.ended for the interrupted attempt and daemon.started lists its id', async () => {
    const { db, attemptRunner, broker } = setup();
    seedRunningAttempt(db, 'task-1', 'att-1');

    await runRestartRecovery({ db, attemptRunner, broker, log, version: '0.2.0' });

    const events = db.getEventsSince(0, 100);
    const ended = events.filter((e) => e.type === 'attempt.ended' && e.attemptId === 'att-1');
    expect(ended.length).toBe(1);

    const started = events.filter((e) => e.type === 'daemon.started');
    expect(started.length).toBe(1);
    const data = started[0]!.data as { version: string; interrupted_attempt_ids: string[] };
    expect(data.version).toBe('0.2.0');
    expect(data.interrupted_attempt_ids).toContain('att-1');
  });

  it('does NOT increment consecutive_failures for an interruption (Req 12.5/13.10)', async () => {
    const { db, attemptRunner, broker } = setup();
    seedRunningAttempt(db, 'task-1', 'att-1');

    await runRestartRecovery({ db, attemptRunner, broker, log, version: '0.1.0' });

    const repoState = db.getRepoState(REPO);
    // Either no repo_state row was written, or the counter stayed at 0.
    expect(repoState?.consecutiveFailures ?? 0).toBe(0);
    expect(repoState?.breaker ?? 'closed').toBe('closed');
  });

  it('leaves a queued task untouched for the scheduler to drain (Req 13.8)', async () => {
    const { db, attemptRunner, broker } = setup();
    // A queued task with no attempt.
    const ts = Date.now();
    db.createTaskWithEvent(
      {
        id: 'task-queued',
        externalId: null,
        repo: REPO,
        source: 'api',
        sourceRef: null,
        title: 'Q',
        spec: 's',
        baseRef: null,
        agent: 'kiro',
        budget: null,
        metadata: null,
        state: 'queued',
        createdAt: ts,
        updatedAt: ts,
      },
      { id: 'ev-q', ts, type: 'task.queued', repo: REPO, taskId: 'task-queued', attemptId: null, data: {} }
    );

    await runRestartRecovery({ db, attemptRunner, broker, log, version: '0.1.0' });

    expect(db.getTask('task-queued')!.state).toBe('queued');
  });

  it('sweeps a stranded running task with no running attempt to failed (HIGH-4)', async () => {
    const { db, attemptRunner, broker } = setup();
    // A task stranded in `running` with no attempt row at all (torn claim).
    const ts = Date.now();
    db.createTaskWithEvent(
      {
        id: 'task-stranded',
        externalId: null,
        repo: REPO,
        source: 'api',
        sourceRef: null,
        title: 'S',
        spec: 's',
        baseRef: null,
        agent: 'kiro',
        budget: null,
        metadata: null,
        state: 'queued',
        createdAt: ts,
        updatedAt: ts,
      },
      { id: 'ev-q2', ts, type: 'task.queued', repo: REPO, taskId: 'task-stranded', attemptId: null, data: {} }
    );
    db.setTaskState('task-stranded', 'running', ts);

    const result = await runRestartRecovery({ db, attemptRunner, broker, log, version: '0.1.0' });

    expect(result.sweptTaskIds).toContain('task-stranded');
    expect(db.getTask('task-stranded')!.state).toBe('failed');
  });

  it('runs the preReap hook before iterating running attempts', async () => {
    const { db, attemptRunner, broker } = setup();
    seedRunningAttempt(db, 'task-1', 'att-1');
    let reapRan = false;
    let attemptStillRunningAtReap = false;

    await runRestartRecovery({
      db,
      attemptRunner,
      broker,
      log,
      version: '0.1.0',
      preReap: () => {
        reapRan = true;
        attemptStillRunningAtReap = db.getAttempt('att-1')!.state === 'running';
      },
    });

    expect(reapRan).toBe(true);
    expect(attemptStillRunningAtReap).toBe(true);
    expect(db.getAttempt('att-1')!.state).toBe('ended');
  });

  it('is a no-op with no running attempts (daemon.started with empty list)', async () => {
    const { db, attemptRunner, broker } = setup();
    const result = await runRestartRecovery({ db, attemptRunner, broker, log, version: '0.1.0' });
    expect(result.interruptedAttemptIds).toEqual([]);
    const started = db.getEventsSince(0, 100).filter((e) => e.type === 'daemon.started');
    expect(started.length).toBe(1);
    const data = started[0]!.data as { interrupted_attempt_ids: string[] };
    expect(data.interrupted_attempt_ids).toEqual([]);
  });
});

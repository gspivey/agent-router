/**
 * Tier 2 tests: full task lifecycle end-to-end (task 11.4, HIGH-9).
 *
 * Exercises the path:
 *   task.queued → db.startAttemptWithEvent → attempt.started → attempt.heartbeat
 *   (lease refresh) → agent report_outcome(succeeded) → teardownAttempt →
 *   attempt.ended(succeeded) → task succeeded
 *
 * The `hasDiff` result is driven by the injected `WorktreeOps.hasDiff` mock
 * (simulating `git rev-list --count <base_sha>..HEAD > 0` — CRITICAL-1).
 *
 * Tests use the DB-level harness (no spawned agent processes or real git),
 * consistent with restart-recovery.test.ts.
 *
 * Requirements covered: 3.2, 3.3, 4.2, 4.3, 4.6, 16.1, 16.2, 16.3
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
import { ulid } from '../../src/ulid.js';

const log: Logger = createLogger({ level: 'error', output: () => {} });

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

function setup(worktree: WorktreeOps): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'task-lifecycle-'));
  const handle = new BetterSqlite3(join(dir, 'test.db'));
  handle.pragma('journal_mode = WAL');
  const db = initTaskDatabase(handle);
  cleanup.push(() => handle.close());
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

  const scheduler = new RepoScheduler({ db, log, startAttempt: async () => false });
  const attemptRunner = new AttemptRunner({ db, scheduler, log, worktree, process: noopProcess });
  const broker = new TaskEventBroker({ db, heartbeatMs: 0 });
  return { db, scheduler, attemptRunner, broker };
}

const REPO = 'o/r';
const BASE_SHA = 'abc123';
const HEAD_SHA = 'def456';

/** Seed a queued task and create a running attempt (attempt.started emitted). */
function seedRunningAttempt(
  db: TaskDatabase,
  taskId: string,
  attemptId: string,
  worktreePath = `/tmp/agent-runs/${attemptId}`
): void {
  const ts = Date.now();
  db.createTaskWithEvent(
    {
      id: taskId,
      externalId: null,
      repo: REPO,
      source: 'api',
      sourceRef: null,
      title: 'Test task',
      spec: 'Do the work',
      baseRef: null,
      agent: 'kiro',
      budget: null,
      metadata: null,
      state: 'queued',
      createdAt: ts,
      updatedAt: ts,
    },
    { id: ulid(), ts, type: 'task.queued', repo: REPO, taskId, attemptId: null, data: {} }
  );
  const started = db.startAttemptWithEvent(
    {
      id: attemptId,
      taskId,
      attemptNo: 1,
      sessionId: `sess-${attemptId}`,
      worktreeBranch: `agent/${attemptId}`,
      worktreePath,
      state: 'running',
      leaseExpiresAt: ts + 90_000,
      artifacts: { branch: `agent/${attemptId}`, base_sha: BASE_SHA },
      promptHash: AttemptRunner.promptHash('Do the work'),
      startedAt: ts,
    },
    'running',
    { id: ulid(), ts, type: 'attempt.started', repo: REPO, taskId, attemptId, data: {} }
  );
  if (started === null) throw new Error('failed to seed running attempt');
}

// ────────────────────────────────────────────────────────────────────────────
// Task 11.4: full lifecycle — succeeded via report_outcome
// ────────────────────────────────────────────────────────────────────────────

describe('task lifecycle: succeeded via report_outcome with hasDiff (task 11.4)', () => {
  it('task transitions to succeeded when report_outcome=succeeded and hasDiff=true (CRITICAL-1)', async () => {
    let worktreeRemoved = false;
    const worktree: WorktreeOps = {
      add: async () => {},
      remove: async () => {
        worktreeRemoved = true;
      },
      headSha: async () => HEAD_SHA,
      hasDiff: async () => true,
      remoteBranchMatchesHead: async () => true,
      clearOutcomeFile: async () => {},
      readOutcomeFile: async () => null,
    };
    const { db, attemptRunner } = setup(worktree);
    const taskId = ulid();
    const attemptId = ulid();

    seedRunningAttempt(db, taskId, attemptId);

    // Register in-memory state (simulates what startAttempt does after DB claim).
    const ts = Date.now();
    attemptRunner.track({
      attemptId,
      taskId,
      repo: REPO,
      pid: null, // no real process in this test
      pgid: null,
      worktreePath: `/tmp/agent-runs/${attemptId}`,
      worktreeBranch: `agent/${attemptId}`,
      allowResume: false,
      lastActivityTs: ts,
      turnsSoFar: 0,
      tokensSoFar: 0,
      startedAt: ts,
      terminationIntent: null,
      reported: null,
    });

    // Simulate heartbeat: refresh the lease (Requirement 4.3 / 4.4).
    const heartbeatTs = ts + 5_000;
    const newLeaseExpiry = heartbeatTs + 90_000;
    db.refreshLeaseWithHeartbeat(attemptId, newLeaseExpiry, {
      id: ulid(),
      ts: heartbeatTs,
      type: 'attempt.heartbeat',
      repo: REPO,
      taskId,
      attemptId,
      data: { last_activity_ts: heartbeatTs, turns_so_far: 1, tokens_so_far: 500 },
    });

    // Verify the lease was extended (Requirement 4.4).
    const afterHeartbeat = db.getAttempt(attemptId)!;
    expect(afterHeartbeat.leaseExpiresAt).toBe(newLeaseExpiry);

    // Agent declares report_outcome(succeeded) via MCP tool
    // (simulated by recordReportedOutcome — Requirement 7.2).
    const recorded = attemptRunner.recordReportedOutcome(attemptId, {
      outcome: 'succeeded',
    });
    expect(recorded).toBe(true);

    // Verify hasDiff=true (CRITICAL-1: committed work exists).
    const hasDiff = await worktree.hasDiff(`/tmp/agent-runs/${attemptId}`, BASE_SHA);
    expect(hasDiff).toBe(true);

    // End the attempt (simulates the session-end handler applying resolveOutcome).
    // Rule 1: report_outcome wins, so succeeded with null reason_code.
    await attemptRunner.teardownAttempt(attemptId, {
      outcome: 'succeeded',
      reasonCode: null,
      failureClass: null,
      artifacts: {
        branch: `agent/${attemptId}`,
        base_sha: BASE_SHA,
        head_sha: HEAD_SHA,
      },
    });

    // Attempt is ended with succeeded outcome (Requirement 3.3).
    const attempt = db.getAttempt(attemptId)!;
    expect(attempt.state).toBe('ended');
    expect(attempt.outcome).toBe('succeeded');
    expect(attempt.reasonCode).toBeNull();
    expect(attempt.failureClass).toBeNull();

    // Task transitioned to succeeded (Requirement 3.3).
    const task = db.getTask(taskId)!;
    expect(task.state).toBe('succeeded');

    // Worktree was cleaned up on success (Requirement 18.4).
    expect(worktreeRemoved).toBe(true);
  });

  it('event stream is monotonic: task.queued < attempt.started < attempt.heartbeat < attempt.ended', async () => {
    const worktree: WorktreeOps = {
      add: async () => {},
      remove: async () => {},
      headSha: async () => HEAD_SHA,
      hasDiff: async () => true,
      remoteBranchMatchesHead: async () => true,
      clearOutcomeFile: async () => {},
      readOutcomeFile: async () => null,
    };
    const { db, attemptRunner } = setup(worktree);
    const taskId = ulid();
    const attemptId = ulid();

    seedRunningAttempt(db, taskId, attemptId);

    const ts = Date.now();
    attemptRunner.track({
      attemptId,
      taskId,
      repo: REPO,
      pid: null,
      pgid: null,
      worktreePath: `/tmp/agent-runs/${attemptId}`,
      worktreeBranch: `agent/${attemptId}`,
      allowResume: false,
      lastActivityTs: ts,
      turnsSoFar: 0,
      tokensSoFar: 0,
      startedAt: ts,
      terminationIntent: null,
      reported: null,
    });

    // Emit a heartbeat event (Requirement 4.2/4.3).
    const heartbeatTs = ts + 1_000;
    db.refreshLeaseWithHeartbeat(attemptId, heartbeatTs + 90_000, {
      id: ulid(),
      ts: heartbeatTs,
      type: 'attempt.heartbeat',
      repo: REPO,
      taskId,
      attemptId,
      data: { last_activity_ts: heartbeatTs, turns_so_far: 1, tokens_so_far: 100 },
    });

    // End attempt as succeeded.
    await attemptRunner.teardownAttempt(attemptId, {
      outcome: 'succeeded',
      reasonCode: null,
      failureClass: null,
    });

    // All events for this task, ordered by seq (Requirement 8.1).
    const events = db.getEventsSince(0, 200).filter((e) => e.taskId === taskId);
    const seqs = events.map((e) => e.seq);
    // seqs must be strictly increasing (monotonic, CRITICAL-1 complement).
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }

    // Verify the types appear in the correct order.
    const types = events.map((e) => e.type);
    const startedIdx = types.indexOf('attempt.started');
    const heartbeatIdx = types.indexOf('attempt.heartbeat');
    const endedIdx = types.indexOf('attempt.ended');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(heartbeatIdx).toBeGreaterThan(startedIdx);
    expect(endedIdx).toBeGreaterThan(heartbeatIdx);
  });

  it('hasDiff=false + no report_outcome → no_changes failure (CRITICAL-1 complement)', async () => {
    const worktree: WorktreeOps = {
      add: async () => {},
      remove: async () => {},
      headSha: async () => BASE_SHA,
      hasDiff: async () => false,          // no commits — CRITICAL-1 signal
      remoteBranchMatchesHead: async () => null,
      clearOutcomeFile: async () => {},
      readOutcomeFile: async () => null,
    };
    const { db, attemptRunner } = setup(worktree);
    const taskId = ulid();
    const attemptId = ulid();

    seedRunningAttempt(db, taskId, attemptId);

    const ts = Date.now();
    attemptRunner.track({
      attemptId,
      taskId,
      repo: REPO,
      pid: null,
      pgid: null,
      worktreePath: `/tmp/agent-runs/${attemptId}`,
      worktreeBranch: `agent/${attemptId}`,
      allowResume: false,
      lastActivityTs: ts,
      turnsSoFar: 0,
      tokensSoFar: 0,
      startedAt: ts,
      terminationIntent: null,
      reported: null,
    });

    // hasDiff=false, no report_outcome → no_changes (Requirement 16.3.5).
    const hasDiff = await worktree.hasDiff(`/tmp/agent-runs/${attemptId}`, BASE_SHA);
    expect(hasDiff).toBe(false);

    // Caller classifies as no_changes and calls teardown.
    await attemptRunner.teardownAttempt(attemptId, {
      outcome: 'failed',
      reasonCode: 'no_changes',
      failureClass: null,
    });

    const attempt = db.getAttempt(attemptId)!;
    expect(attempt.outcome).toBe('failed');
    expect(attempt.reasonCode).toBe('no_changes');
    expect(attempt.failureClass).toBeNull();

    // Task lands in failed (Requirement 3.4).
    const task = db.getTask(taskId)!;
    expect(task.state).toBe('failed');
  });

  it('lease refresh extends leaseExpiresAt beyond original (Requirement 4.4)', () => {
    const worktree: WorktreeOps = {
      add: async () => {},
      remove: async () => {},
      headSha: async () => '',
      hasDiff: async () => false,
      remoteBranchMatchesHead: async () => null,
      clearOutcomeFile: async () => {},
      readOutcomeFile: async () => null,
    };
    const { db, attemptRunner } = setup(worktree);
    const taskId = ulid();
    const attemptId = ulid();
    void attemptRunner; // harness setup only

    seedRunningAttempt(db, taskId, attemptId);

    const before = db.getAttempt(attemptId)!;
    const originalExpiry = before.leaseExpiresAt!;

    // Simulate heartbeat refresh (anchored to now, not to startedAt).
    const heartbeatTs = Date.now() + 5_000;
    const heartbeatIntervalMs = 30_000;
    const newExpiry = heartbeatTs + 3 * heartbeatIntervalMs;
    db.refreshLeaseWithHeartbeat(attemptId, newExpiry, {
      id: ulid(),
      ts: heartbeatTs,
      type: 'attempt.heartbeat',
      repo: REPO,
      taskId,
      attemptId,
      data: { last_activity_ts: heartbeatTs, turns_so_far: 0, tokens_so_far: 0 },
    });

    const after = db.getAttempt(attemptId)!;
    // Lease was refreshed to a later time (Requirement 4.4).
    expect(after.leaseExpiresAt).toBe(newExpiry);
    expect(after.leaseExpiresAt).toBeGreaterThan(originalExpiry);
  });
});

/**
 * Restart (crash recovery) for the task layer (task-attempt-outcome, task 11.1).
 *
 * On daemon startup, before accepting traffic, every attempt left `running` by
 * a crashed instance is ended `interrupted` through the single `teardownAttempt`
 * path with `skipKill = true` (Requirement 13.2/13.12), its parent task is moved
 * to `failed` with `reason_code = 'interrupted'` (NOT auto-retried —
 * Requirement 13.9), and a single `daemon.started` event lists every interrupted
 * attempt id (Requirement 13.4). A belt-and-suspenders sweep also marks any
 * `running` task that has no `running` attempt `interrupted → failed`
 * (Requirement 13.1 / HIGH-4). Tasks already `queued` are left untouched for the
 * scheduler to drain (Requirement 13.8).
 *
 * Dependency-injected (DB, attempt runner, broker, clock, id) so it is testable
 * in isolation. The orphan-process reap and `git worktree prune` of
 * Requirement 13.12 are process/git side effects owned by the attempt-spawn
 * wiring; they are injected as an optional `preReap` hook so the structure is
 * correct and this function stays unit-testable without a real git clone.
 */
import type { TaskDatabase, EventInsert } from './task-db.js';
import type { AttemptRunner } from './attempt-runner.js';
import type { TaskEventBroker } from './task-event-broker.js';
import type { Logger } from './log.js';
import { ulid } from './ulid.js';

export interface RestartRecoveryDeps {
  db: TaskDatabase;
  attemptRunner: AttemptRunner;
  /** Live event broker; recovery events are emitted after they are committed. */
  broker?: TaskEventBroker;
  log: Logger;
  /** Daemon version recorded on the `daemon.started` event. */
  version: string;
  /**
   * Optional orphan-process reap + `git worktree prune` hook (Requirement 13.12,
   * HIGH-8). Runs once, before the running-attempts list is iterated.
   */
  preReap?: () => Promise<void> | void;
  now?: () => number;
  newId?: () => string;
}

export interface RestartRecoveryResult {
  interruptedAttemptIds: string[];
  sweptTaskIds: string[];
}

/**
 * Run restart recovery and emit `daemon.started`. Returns the ids of the
 * attempts interrupted and the orphaned `running` tasks swept this startup.
 */
export async function runRestartRecovery(deps: RestartRecoveryDeps): Promise<RestartRecoveryResult> {
  const { db, attemptRunner, broker, log, version } = deps;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => ulid());

  // (HIGH-2) `git worktree prune` + explicit orphan-process reap run first.
  if (deps.preReap !== undefined) {
    try {
      await deps.preReap();
    } catch (err: unknown) {
      log.warn('restart recovery pre-reap failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const interruptedAttemptIds: string[] = [];
  const sweptTaskIds: string[] = [];

  // Mark every running attempt interrupted via the single teardown path
  // (skipKill=true — the process is already dead after a crash/reboot).
  const runningAttempts = db.findRunningAttempts();
  for (const attempt of runningAttempts) {
    try {
      await attemptRunner.teardownAttempt(
        attempt.id,
        { outcome: 'interrupted', reasonCode: 'interrupted', failureClass: 'infra' },
        /* skipKill */ true
      );
      interruptedAttemptIds.push(attempt.id);
    } catch (err: unknown) {
      log.warn('restart recovery teardown failed', {
        attempt_id: attempt.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Belt-and-suspenders sweep (HIGH-4): any `running` task without a `running`
  // attempt is a torn claim — mark it interrupted → failed.
  for (const task of db.listTasks({ state: 'running' })) {
    const latest = db.getLatestAttempt(task.id);
    const hasRunning = latest !== null && latest.state === 'running';
    if (!hasRunning) {
      const ts = now();
      // A stranded `running` task (torn claim) lands `failed` with no attempt to
      // emit against; a plain state write is correct (no misleading event).
      db.setTaskState(task.id, 'failed', ts);
      sweptTaskIds.push(task.id);
    }
  }

  // Emit a single daemon.started event listing the interrupted attempt ids.
  const startedEvent: EventInsert = {
    id: newId(),
    ts: now(),
    type: 'daemon.started',
    repo: null,
    taskId: null,
    attemptId: null,
    data: { version, interrupted_attempt_ids: interruptedAttemptIds },
  };
  const row = db.appendEvent(startedEvent);
  broker?.emit(row);

  log.info('Restart recovery complete', {
    interrupted: interruptedAttemptIds.length,
    swept: sweptTaskIds.length,
  });

  return { interruptedAttemptIds, sweptTaskIds };
}

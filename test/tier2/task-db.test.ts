/**
 * Tier 2 tests: task database layer against a real SQLite tmpdir
 * (task-attempt-outcome, task 2.5).
 */
import { describe, it, expect, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTaskDatabase } from '../../src/task-db.js';
import type {
  TaskDatabase,
  TaskInsert,
  AttemptInsert,
  AttemptEndPatch,
  EventInsert,
} from '../../src/task-db.js';

let cleanupFns: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  cleanupFns = [];
});

function setup(): { db: TaskDatabase; handle: BetterSqlite3.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'task-db-test-'));
  const handle = new BetterSqlite3(join(dir, 'test.db'));
  handle.pragma('journal_mode = WAL');
  const db = initTaskDatabase(handle);
  cleanupFns.push(() => handle.close());
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return { db, handle };
}

let idCounter = 0;
function nextId(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString().padStart(6, '0')}`;
}

function makeTask(overrides: Partial<TaskInsert> = {}): TaskInsert {
  const now = Date.now();
  return {
    id: nextId('task'),
    externalId: null,
    repo: 'owner/repo',
    source: 'api',
    sourceRef: null,
    title: 'A task',
    spec: 'spec text',
    baseRef: null,
    agent: 'kiro',
    budget: null,
    metadata: null,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queuedEvent(taskId: string): EventInsert {
  return {
    id: nextId('evt'),
    ts: Date.now(),
    type: 'task.queued',
    repo: 'owner/repo',
    taskId,
    attemptId: null,
    data: { source: 'api', title: 'A task' },
  };
}

function makeAttempt(taskId: string, attemptNo: number, overrides: Partial<AttemptInsert> = {}): AttemptInsert {
  return {
    id: nextId('attempt'),
    taskId,
    attemptNo,
    sessionId: null,
    worktreeBranch: `agent/${taskId}-${attemptNo}`,
    worktreePath: `/tmp/agent-runs/${taskId}-${attemptNo}`,
    state: 'running',
    leaseExpiresAt: Date.now() + 90_000,
    artifacts: { branch: `agent/${taskId}-${attemptNo}`, base_sha: 'abc123' },
    promptHash: 'deadbeef',
    startedAt: Date.now(),
    ...overrides,
  };
}

function startedEvent(taskId: string, attemptId: string): EventInsert {
  return {
    id: nextId('evt'),
    ts: Date.now(),
    type: 'attempt.started',
    repo: 'owner/repo',
    taskId,
    attemptId,
    data: { attempt_no: 1, agent: 'kiro', model: null, agent_version: null },
  };
}

function endedEvent(taskId: string, attemptId: string): EventInsert {
  return {
    id: nextId('evt'),
    ts: Date.now(),
    type: 'attempt.ended',
    repo: 'owner/repo',
    taskId,
    attemptId,
    data: { outcome: 'succeeded' },
  };
}

function endPatch(overrides: Partial<AttemptEndPatch> = {}): AttemptEndPatch {
  return {
    outcome: 'succeeded',
    failureClass: null,
    reasonCode: null,
    reason: null,
    blocked: null,
    artifacts: null,
    usage: { wall_ms: 1234 },
    agentVersion: null,
    model: null,
    endedAt: Date.now(),
    ...overrides,
  };
}

describe('createTaskWithEvent', () => {
  it('inserts a task and its task.queued event', () => {
    const { db } = setup();
    const task = makeTask();
    const result = db.createTaskWithEvent(task, queuedEvent(task.id));
    expect(result.created).toBe(true);
    expect(result.task.id).toBe(task.id);
    expect(result.task.state).toBe('queued');
    expect(db.maxEventSeq()).toBe(1);
  });

  it('is idempotent on external_id: duplicate returns existing with no second event', () => {
    const { db } = setup();
    const task = makeTask({ externalId: 'ext-1' });
    const first = db.createTaskWithEvent(task, queuedEvent(task.id));
    expect(first.created).toBe(true);
    expect(db.maxEventSeq()).toBe(1);

    const dup = makeTask({ externalId: 'ext-1', title: 'different title' });
    const second = db.createTaskWithEvent(dup, queuedEvent(dup.id));
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(task.id); // the original, not the duplicate
    expect(second.task.title).toBe('A task');
    expect(db.maxEventSeq()).toBe(1); // no second event emitted
  });

  it('round-trips budget and metadata as JSON', () => {
    const { db } = setup();
    const task = makeTask({
      budget: { max_wall_s: 60, allow_resume: true },
      metadata: { team: 'core', nested: { a: 1 } },
    });
    db.createTaskWithEvent(task, queuedEvent(task.id));
    const got = db.getTask(task.id);
    expect(got?.budget).toEqual({ max_wall_s: 60, allow_resume: true });
    expect(got?.metadata).toEqual({ team: 'core', nested: { a: 1 } });
  });
});

describe('listTasks', () => {
  it('filters by repo and state (logical AND)', () => {
    const { db } = setup();
    const a = makeTask({ repo: 'owner/repo', state: 'queued' });
    const b = makeTask({ repo: 'owner/repo', state: 'running' });
    const c = makeTask({ repo: 'owner/other', state: 'queued' });
    db.createTaskWithEvent(a, queuedEvent(a.id));
    db.createTaskWithEvent(b, queuedEvent(b.id));
    db.createTaskWithEvent(c, queuedEvent(c.id));

    expect(db.listTasks({}).length).toBe(3);
    expect(db.listTasks({ repo: 'owner/repo' }).length).toBe(2);
    expect(db.listTasks({ state: 'queued' }).length).toBe(2);
    const both = db.listTasks({ repo: 'owner/repo', state: 'queued' });
    expect(both.length).toBe(1);
    expect(both[0]!.id).toBe(a.id);
  });
});

describe('startAttemptWithEvent (atomic claim + create)', () => {
  it('claims a queued task, inserts the attempt, moves the task to running', () => {
    const { db } = setup();
    const task = makeTask();
    db.createTaskWithEvent(task, queuedEvent(task.id));

    const attempt = makeAttempt(task.id, 1);
    const created = db.startAttemptWithEvent(attempt, 'running', startedEvent(task.id, attempt.id));
    expect(created).not.toBeNull();
    expect(db.getTask(task.id)?.state).toBe('running');
    expect(db.maxAttemptNo(task.id)).toBe(1);
  });

  it('returns null when the task is not queued (already claimed)', () => {
    const { db } = setup();
    const task = makeTask();
    db.createTaskWithEvent(task, queuedEvent(task.id));

    const first = db.startAttemptWithEvent(makeAttempt(task.id, 1), 'running', startedEvent(task.id, 'a1'));
    expect(first).not.toBeNull();

    // Second claim attempt: task is already 'running', not 'queued'.
    const second = db.startAttemptWithEvent(makeAttempt(task.id, 2), 'running', startedEvent(task.id, 'a2'));
    expect(second).toBeNull();
    expect(db.maxAttemptNo(task.id)).toBe(1); // no second attempt row
  });

  it('enforces UNIQUE(task_id, attempt_no)', () => {
    const { db } = setup();
    const task = makeTask();
    db.createTaskWithEvent(task, queuedEvent(task.id));
    db.startAttemptWithEvent(makeAttempt(task.id, 1), 'running', startedEvent(task.id, 'a1'));
    // Re-queue, then try to insert attempt_no 1 again.
    db.setTaskState(task.id, 'queued', Date.now());
    expect(() =>
      db.startAttemptWithEvent(makeAttempt(task.id, 1), 'running', startedEvent(task.id, 'a2'))
    ).toThrow();
  });
});

describe('endAttemptWithEvent (conditional UPDATE)', () => {
  it('ends exactly once under a double call', () => {
    const { db } = setup();
    const task = makeTask();
    db.createTaskWithEvent(task, queuedEvent(task.id));
    const attempt = makeAttempt(task.id, 1);
    db.startAttemptWithEvent(attempt, 'running', startedEvent(task.id, attempt.id));

    const first = db.endAttemptWithEvent(
      attempt.id,
      endPatch(),
      'succeeded',
      endedEvent(task.id, attempt.id)
    );
    expect(first).toBe(true);
    expect(db.getTask(task.id)?.state).toBe('succeeded');

    const second = db.endAttemptWithEvent(
      attempt.id,
      endPatch({ outcome: 'failed', reasonCode: 'agent_error' }),
      'failed',
      endedEvent(task.id, attempt.id)
    );
    expect(second).toBe(false); // already ended
    expect(db.getTask(task.id)?.state).toBe('succeeded'); // unchanged
    const got = db.getAttempt(attempt.id);
    expect(got?.outcome).toBe('succeeded');
  });

  it('merges endState.artifacts over existing start-time artifacts', () => {
    const { db } = setup();
    const task = makeTask();
    db.createTaskWithEvent(task, queuedEvent(task.id));
    const attempt = makeAttempt(task.id, 1);
    db.startAttemptWithEvent(attempt, 'running', startedEvent(task.id, attempt.id));

    db.endAttemptWithEvent(
      attempt.id,
      endPatch({ artifacts: { head_sha: 'xyz789', pr_url: 'https://pr/1' } }),
      'succeeded',
      endedEvent(task.id, attempt.id)
    );
    const got = db.getAttempt(attempt.id);
    // start-time branch/base_sha preserved, end-time head_sha/pr_url merged on top.
    expect(got?.artifacts).toEqual({
      branch: `agent/${task.id}-1`,
      base_sha: 'abc123',
      head_sha: 'xyz789',
      pr_url: 'https://pr/1',
    });
  });

  it('persists the blocked JSON only when supplied', () => {
    const { db } = setup();
    const task = makeTask();
    db.createTaskWithEvent(task, queuedEvent(task.id));
    const attempt = makeAttempt(task.id, 1);
    db.startAttemptWithEvent(attempt, 'running', startedEvent(task.id, attempt.id));

    db.endAttemptWithEvent(
      attempt.id,
      endPatch({ outcome: 'blocked', reasonCode: 'agent_blocked', blocked: { question: 'creds?', needs: 'credential' } }),
      'blocked',
      endedEvent(task.id, attempt.id)
    );
    const got = db.getAttempt(attempt.id);
    expect(got?.blocked).toEqual({ question: 'creds?', needs: 'credential' });
  });
});

describe('failure_class CHECK constraint', () => {
  it('rejects a contradictory row (infra on a succeeded outcome)', () => {
    const { db, handle } = setup();
    const task = makeTask();
    db.createTaskWithEvent(task, queuedEvent(task.id));
    const attempt = makeAttempt(task.id, 1);
    db.startAttemptWithEvent(attempt, 'running', startedEvent(task.id, attempt.id));

    // Attempt a raw contradictory UPDATE: outcome='succeeded' with failure_class='infra'.
    expect(() =>
      handle
        .prepare(
          `UPDATE attempts SET outcome = 'succeeded', failure_class = 'infra' WHERE id = @id`
        )
        .run({ id: attempt.id })
    ).toThrow();
  });

  it('allows infra on failed and interrupted outcomes', () => {
    const { db } = setup();
    const task = makeTask();
    db.createTaskWithEvent(task, queuedEvent(task.id));
    const attempt = makeAttempt(task.id, 1);
    db.startAttemptWithEvent(attempt, 'running', startedEvent(task.id, attempt.id));
    const ok = db.endAttemptWithEvent(
      attempt.id,
      endPatch({ outcome: 'interrupted', failureClass: 'infra', reasonCode: 'interrupted' }),
      'failed',
      endedEvent(task.id, attempt.id)
    );
    expect(ok).toBe(true);
    expect(db.getAttempt(attempt.id)?.failureClass).toBe('infra');
  });
});

describe('findRunningAttempts', () => {
  it('selects only running attempts', () => {
    const { db } = setup();
    const t1 = makeTask();
    const t2 = makeTask();
    db.createTaskWithEvent(t1, queuedEvent(t1.id));
    db.createTaskWithEvent(t2, queuedEvent(t2.id));
    const a1 = makeAttempt(t1.id, 1);
    const a2 = makeAttempt(t2.id, 1);
    db.startAttemptWithEvent(a1, 'running', startedEvent(t1.id, a1.id));
    db.startAttemptWithEvent(a2, 'running', startedEvent(t2.id, a2.id));
    db.endAttemptWithEvent(a1.id, endPatch(), 'succeeded', endedEvent(t1.id, a1.id));

    const running = db.findRunningAttempts();
    expect(running.length).toBe(1);
    expect(running[0]!.id).toBe(a2.id);
  });
});

describe('transactional all-or-nothing', () => {
  it('rolls back the task insert when the event insert fails', () => {
    const { db } = setup();
    const task = makeTask();
    // A null event type violates NOT NULL, forcing the transaction to roll back.
    const badEvent = { ...queuedEvent(task.id), type: null as unknown as string };
    expect(() => db.createTaskWithEvent(task, badEvent)).toThrow();
    expect(db.getTask(task.id)).toBeNull(); // no partial row
    expect(db.maxEventSeq()).toBe(0); // no orphan event
  });
});

describe('event helpers', () => {
  it('appends standalone events and replays by seq', () => {
    const { db } = setup();
    const e1 = db.appendEvent({
      id: nextId('evt'),
      ts: Date.now(),
      type: 'daemon.started',
      repo: null,
      taskId: null,
      attemptId: null,
      data: { version: '1.0', interrupted_attempt_ids: [] },
    });
    const e2 = db.appendEvent({
      id: nextId('evt'),
      ts: Date.now(),
      type: 'repo.paused',
      repo: 'owner/repo',
      taskId: null,
      attemptId: null,
      data: { reason: 'threshold', consecutive_failures: 3 },
    });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    const since = db.getEventsSince(e1.seq, 10);
    expect(since.length).toBe(1);
    expect(since[0]!.type).toBe('repo.paused');
    expect(since[0]!.data).toEqual({ reason: 'threshold', consecutive_failures: 3 });
  });
});

describe('repo_state round-trip', () => {
  it('persists and reloads circuit-breaker state with its event', () => {
    const { db } = setup();
    db.setRepoStateWithEvent(
      'owner/repo',
      { consecutiveFailures: 3, breaker: 'open', pausedAt: 1000, pausedUntil: null, updatedAt: 2000 },
      {
        id: nextId('evt'),
        ts: 2000,
        type: 'repo.paused',
        repo: 'owner/repo',
        taskId: null,
        attemptId: null,
        data: { reason: 'threshold', consecutive_failures: 3 },
      }
    );
    const state = db.getRepoState('owner/repo');
    expect(state).toEqual({
      repo: 'owner/repo',
      consecutiveFailures: 3,
      breaker: 'open',
      pausedAt: 1000,
      pausedUntil: null,
      updatedAt: 2000,
    });
    expect(db.listRepoStates().length).toBe(1);

    // Partial update keeps unspecified fields.
    db.setRepoStateWithEvent('owner/repo', { breaker: 'closed', consecutiveFailures: 0, pausedAt: null, updatedAt: 3000 });
    const reset = db.getRepoState('owner/repo');
    expect(reset?.breaker).toBe('closed');
    expect(reset?.consecutiveFailures).toBe(0);
    expect(reset?.pausedAt).toBeNull();
  });
});

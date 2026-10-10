import type BetterSqlite3 from 'better-sqlite3';
import {
  type AgentKind,
  type Artifacts,
  type AttemptRecord,
  type AttemptState,
  type AttemptOutcome,
  type Blocked,
  type BreakerState,
  type Budget,
  type FailureClass,
  type ReasonCode,
  type RepoStateRecord,
  type TaskEventRecord,
  type TaskRecord,
  type TaskSource,
  type TaskState,
  type Usage,
} from './task-types.js';

/**
 * Database layer for the task-attempt-outcome model (task-attempt-outcome,
 * tasks 2.1–2.4).
 *
 * Follows the `src/db.ts` pattern exactly: DDL as module-scope template
 * strings, `initTaskDatabase(db)` prepares statements over the already-open
 * `better-sqlite3` handle (WAL mode is set by `initDatabase`) and returns a
 * `TaskDatabase` closing over them. All timestamps are unix ms.
 *
 * Every state change and the event it produces are written in the same
 * `db.transaction(...)` so the event stream can never disagree with persisted
 * state (Requirement 15.1/15.2).
 */

// ---------------------------------------------------------------------------
// Insert/patch shapes
// ---------------------------------------------------------------------------

/** Fields for inserting a task (id/timestamps/state supplied here). */
export interface TaskInsert {
  id: string;
  externalId: string | null;
  repo: string;
  source: TaskSource;
  sourceRef: string | null;
  title: string;
  spec: string;
  baseRef: string | null;
  agent: AgentKind;
  budget: Budget | null;
  metadata: unknown;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
}

/** Fields for inserting an attempt. */
export interface AttemptInsert {
  id: string;
  taskId: string;
  attemptNo: number;
  sessionId: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  state: AttemptState;
  leaseExpiresAt: number | null;
  artifacts: Artifacts | null;
  promptHash: string | null;
  startedAt: number;
}

/** The DB-write projection of an attempt end (Requirement 16.10). */
export interface AttemptEndPatch {
  outcome: AttemptOutcome;
  failureClass: FailureClass | null;
  reasonCode: ReasonCode | null;
  reason: string | null;
  blocked: Blocked | null;
  /** Shallow-merged over the attempt's existing artifacts (HIGH-C). */
  artifacts: Artifacts | null;
  usage: Usage | null;
  agentVersion: string | null;
  model: string | null;
  endedAt: number;
}

/** A standalone or transactional event insert. */
export interface EventInsert {
  id: string;
  ts: number;
  type: string;
  repo: string | null;
  taskId: string | null;
  attemptId: string | null;
  data: unknown;
}

/** A partial update to a repo's circuit-breaker state. */
export interface RepoStatePatch {
  consecutiveFailures?: number;
  breaker?: BreakerState;
  pausedAt?: number | null;
  pausedUntil?: number | null;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TaskDatabase {
  // tasks
  createTaskWithEvent(task: TaskInsert, event: EventInsert): { task: TaskRecord; created: boolean };
  getTask(id: string): TaskRecord | null;
  getTaskByExternalId(externalId: string): TaskRecord | null;
  listTasks(filter: { repo?: string; state?: TaskState }): TaskRecord[];
  setTaskState(id: string, state: TaskState, updatedAt: number, event?: EventInsert): void;
  setResumeSessionId(id: string, resumeSessionId: string | null): void;

  // attempts
  startAttemptWithEvent(
    attempt: AttemptInsert,
    taskState: TaskState,
    event: EventInsert
  ): AttemptRecord | null;
  endAttemptWithEvent(
    id: string,
    patch: AttemptEndPatch,
    taskState: TaskState,
    event: EventInsert
  ): boolean;
  refreshLeaseWithHeartbeat(id: string, leaseExpiresAt: number, event: EventInsert): void;
  getAttempt(id: string): AttemptRecord | null;
  getLatestAttempt(taskId: string): AttemptRecord | null;
  getAttemptsForTask(taskId: string): AttemptRecord[];
  maxAttemptNo(taskId: string): number;
  findRunningAttempts(): AttemptRecord[];

  // repo circuit-breaker state
  getRepoState(repo: string): RepoStateRecord | null;
  listRepoStates(): RepoStateRecord[];
  setRepoStateWithEvent(repo: string, patch: RepoStatePatch, event?: EventInsert): void;

  // events
  appendEvent(event: EventInsert): TaskEventRecord;
  getEventsSince(seq: number, limit: number): TaskEventRecord[];
  maxEventSeq(): number;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const TASKS_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  repo        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('api','roadmap')),
  source_ref  TEXT,
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,
  base_ref    TEXT,
  agent       TEXT NOT NULL CHECK (agent IN ('kiro','claude')),
  budget      TEXT,
  metadata    TEXT,
  state       TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','blocked','cancelled')),
  resume_session_id TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

const TASKS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_tasks_repo_state ON tasks(repo, state);
`;

const ATTEMPTS_DDL = `
CREATE TABLE IF NOT EXISTS attempts (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  attempt_no       INTEGER NOT NULL,
  session_id       TEXT,
  state            TEXT NOT NULL CHECK (state IN ('running','ended')),
  lease_expires_at INTEGER,
  outcome          TEXT CHECK (outcome IN
                     ('succeeded','failed','blocked','cancelled','timed_out','budget_exceeded','interrupted')),
  failure_class    TEXT CHECK (failure_class IN ('infra') OR failure_class IS NULL),
  reason_code      TEXT,
  reason           TEXT,
  blocked          TEXT DEFAULT NULL,
  artifacts        TEXT,
  usage            TEXT,
  agent_version    TEXT,
  model            TEXT,
  prompt_hash      TEXT,
  worktree_branch     TEXT,
  worktree_path       TEXT,
  pid                 INTEGER,
  pgid                INTEGER,
  process_start_time  INTEGER,
  process_cmdline     TEXT,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  UNIQUE(task_id, attempt_no),
  CHECK (
    (failure_class = 'infra' AND outcome IN ('failed','interrupted'))
    OR failure_class IS NULL
  )
);
`;

const ATTEMPTS_INDEX_TASK = `
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
`;

const ATTEMPTS_INDEX_RUNNING = `
CREATE INDEX IF NOT EXISTS idx_attempts_running ON attempts(state) WHERE state = 'running';
`;

const TASK_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS task_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  repo       TEXT,
  task_id    TEXT,
  attempt_id TEXT,
  data       TEXT NOT NULL
);
`;

const TASK_EVENTS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
`;

const REPO_STATE_DDL = `
CREATE TABLE IF NOT EXISTS repo_state (
  repo                 TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  breaker              TEXT NOT NULL DEFAULT 'closed' CHECK (breaker IN ('closed','open','half-open')),
  paused_at            INTEGER,
  paused_until         INTEGER,
  updated_at           INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  external_id: string | null;
  repo: string;
  source: string;
  source_ref: string | null;
  title: string;
  spec: string;
  base_ref: string | null;
  agent: string;
  budget: string | null;
  metadata: string | null;
  state: string;
  resume_session_id: string | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    externalId: row.external_id,
    repo: row.repo,
    source: row.source as TaskSource,
    sourceRef: row.source_ref,
    title: row.title,
    spec: row.spec,
    baseRef: row.base_ref,
    agent: row.agent as AgentKind,
    budget: parseJson<Budget>(row.budget),
    metadata: row.metadata === null ? null : JSON.parse(row.metadata),
    state: row.state as TaskState,
    resumeSessionId: row.resume_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface AttemptRow {
  id: string;
  task_id: string;
  attempt_no: number;
  session_id: string | null;
  state: string;
  lease_expires_at: number | null;
  outcome: string | null;
  failure_class: string | null;
  reason_code: string | null;
  reason: string | null;
  blocked: string | null;
  artifacts: string | null;
  usage: string | null;
  agent_version: string | null;
  model: string | null;
  prompt_hash: string | null;
  worktree_branch: string | null;
  worktree_path: string | null;
  pid: number | null;
  pgid: number | null;
  process_start_time: number | null;
  process_cmdline: string | null;
  started_at: number;
  ended_at: number | null;
}

function mapAttempt(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    sessionId: row.session_id,
    worktreeBranch: row.worktree_branch,
    worktreePath: row.worktree_path,
    state: row.state as AttemptState,
    leaseExpiresAt: row.lease_expires_at,
    outcome: row.outcome as AttemptOutcome | null,
    failureClass: row.failure_class as FailureClass | null,
    reasonCode: row.reason_code as ReasonCode | null,
    reason: row.reason,
    blocked: parseJson<Blocked>(row.blocked),
    artifacts: parseJson<Artifacts>(row.artifacts),
    usage: parseJson<Usage>(row.usage),
    agentVersion: row.agent_version,
    model: row.model,
    promptHash: row.prompt_hash,
    pid: row.pid,
    pgid: row.pgid,
    processStartTime: row.process_start_time,
    processCmdline: row.process_cmdline,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

interface EventRow {
  seq: number;
  id: string;
  ts: number;
  type: string;
  repo: string | null;
  task_id: string | null;
  attempt_id: string | null;
  data: string;
}

function mapEvent(row: EventRow): TaskEventRecord {
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    type: row.type,
    repo: row.repo,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    data: JSON.parse(row.data),
  };
}

interface RepoStateRow {
  repo: string;
  consecutive_failures: number;
  breaker: string;
  paused_at: number | null;
  paused_until: number | null;
  updated_at: number;
}

function mapRepoState(row: RepoStateRow): RepoStateRecord {
  return {
    repo: row.repo,
    consecutiveFailures: row.consecutive_failures,
    breaker: row.breaker as BreakerState,
    pausedAt: row.paused_at,
    pausedUntil: row.paused_until,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function initTaskDatabase(db: BetterSqlite3.Database): TaskDatabase {
  db.exec(TASKS_DDL);
  db.exec(TASKS_INDEX);
  db.exec(ATTEMPTS_DDL);
  db.exec(ATTEMPTS_INDEX_TASK);
  db.exec(ATTEMPTS_INDEX_RUNNING);
  db.exec(TASK_EVENTS_DDL);
  db.exec(TASK_EVENTS_INDEX);
  db.exec(REPO_STATE_DDL);

  // --- task statements -----------------------------------------------------
  const insertTaskStmt = db.prepare(
    `INSERT INTO tasks (id, external_id, repo, source, source_ref, title, spec, base_ref,
                        agent, budget, metadata, state, resume_session_id, created_at, updated_at)
     VALUES (@id, @external_id, @repo, @source, @source_ref, @title, @spec, @base_ref,
             @agent, @budget, @metadata, @state, @resume_session_id, @created_at, @updated_at)`
  );
  const getTaskStmt = db.prepare(`SELECT * FROM tasks WHERE id = @id`);
  const getTaskByExternalIdStmt = db.prepare(`SELECT * FROM tasks WHERE external_id = @external_id`);
  const listTasksStmt = db.prepare(`SELECT * FROM tasks`);
  const listTasksByRepoStmt = db.prepare(`SELECT * FROM tasks WHERE repo = @repo`);
  const listTasksByStateStmt = db.prepare(`SELECT * FROM tasks WHERE state = @state`);
  const listTasksByRepoStateStmt = db.prepare(
    `SELECT * FROM tasks WHERE repo = @repo AND state = @state`
  );
  const setTaskStateStmt = db.prepare(
    `UPDATE tasks SET state = @state, updated_at = @updated_at WHERE id = @id`
  );
  const setResumeSessionIdStmt = db.prepare(
    `UPDATE tasks SET resume_session_id = @resume_session_id WHERE id = @id`
  );

  // --- attempt statements --------------------------------------------------
  const claimTaskStmt = db.prepare(
    `UPDATE tasks SET state = @state, updated_at = @updated_at
     WHERE id = @id AND state = 'queued'`
  );
  const insertAttemptStmt = db.prepare(
    `INSERT INTO attempts (id, task_id, attempt_no, session_id, state, lease_expires_at,
                           artifacts, prompt_hash, worktree_branch, worktree_path, started_at)
     VALUES (@id, @task_id, @attempt_no, @session_id, @state, @lease_expires_at,
             @artifacts, @prompt_hash, @worktree_branch, @worktree_path, @started_at)`
  );
  const endAttemptStmt = db.prepare(
    `UPDATE attempts
       SET state = 'ended', outcome = @outcome, failure_class = @failure_class,
           reason_code = @reason_code, reason = @reason, blocked = @blocked,
           artifacts = @artifacts, usage = @usage, agent_version = @agent_version,
           model = @model, ended_at = @ended_at
     WHERE id = @id AND state = 'running'`
  );
  const refreshLeaseStmt = db.prepare(
    `UPDATE attempts SET lease_expires_at = @lease_expires_at WHERE id = @id`
  );
  const getAttemptStmt = db.prepare(`SELECT * FROM attempts WHERE id = @id`);
  const getLatestAttemptStmt = db.prepare(
    `SELECT * FROM attempts WHERE task_id = @task_id ORDER BY attempt_no DESC LIMIT 1`
  );
  const getAttemptsForTaskStmt = db.prepare(
    `SELECT * FROM attempts WHERE task_id = @task_id ORDER BY attempt_no ASC`
  );
  const maxAttemptNoStmt = db.prepare(
    `SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE task_id = @task_id`
  );
  const findRunningAttemptsStmt = db.prepare(`SELECT * FROM attempts WHERE state = 'running'`);

  // --- event statements ----------------------------------------------------
  const insertEventStmt = db.prepare(
    `INSERT INTO task_events (id, ts, type, repo, task_id, attempt_id, data)
     VALUES (@id, @ts, @type, @repo, @task_id, @attempt_id, @data)`
  );
  const getEventStmt = db.prepare(`SELECT * FROM task_events WHERE seq = @seq`);
  const getEventsSinceStmt = db.prepare(
    `SELECT * FROM task_events WHERE seq > @seq ORDER BY seq ASC LIMIT @limit`
  );
  const maxEventSeqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM task_events`);

  // --- repo-state statements ----------------------------------------------
  const getRepoStateStmt = db.prepare(`SELECT * FROM repo_state WHERE repo = @repo`);
  const listRepoStatesStmt = db.prepare(`SELECT * FROM repo_state`);
  const upsertRepoStateStmt = db.prepare(
    `INSERT INTO repo_state (repo, consecutive_failures, breaker, paused_at, paused_until, updated_at)
     VALUES (@repo, @consecutive_failures, @breaker, @paused_at, @paused_until, @updated_at)
     ON CONFLICT(repo) DO UPDATE SET
       consecutive_failures = @consecutive_failures,
       breaker = @breaker,
       paused_at = @paused_at,
       paused_until = @paused_until,
       updated_at = @updated_at`
  );

  function eventParams(event: EventInsert) {
    return {
      id: event.id,
      ts: event.ts,
      type: event.type,
      repo: event.repo,
      task_id: event.taskId,
      attempt_id: event.attemptId,
      data: JSON.stringify(event.data ?? null),
    };
  }

  function insertEventRow(event: EventInsert): TaskEventRecord {
    const result = insertEventStmt.run(eventParams(event));
    const row = getEventStmt.get({ seq: Number(result.lastInsertRowid) }) as EventRow;
    return mapEvent(row);
  }

  function taskParams(task: TaskInsert) {
    return {
      id: task.id,
      external_id: task.externalId,
      repo: task.repo,
      source: task.source,
      source_ref: task.sourceRef,
      title: task.title,
      spec: task.spec,
      base_ref: task.baseRef,
      agent: task.agent,
      budget: task.budget === null ? null : JSON.stringify(task.budget),
      metadata: task.metadata === undefined ? null : JSON.stringify(task.metadata ?? null),
      state: task.state,
      resume_session_id: null,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    };
  }

  // --- transactional helpers ----------------------------------------------

  const createTaskTxn = db.transaction((task: TaskInsert, event: EventInsert): {
    task: TaskRecord;
    created: boolean;
  } => {
    if (task.externalId !== null) {
      const existing = getTaskByExternalIdStmt.get({ external_id: task.externalId }) as
        | TaskRow
        | undefined;
      if (existing !== undefined) {
        return { task: mapTask(existing), created: false };
      }
    }
    insertTaskStmt.run(taskParams(task));
    insertEventRow(event);
    const row = getTaskStmt.get({ id: task.id }) as TaskRow;
    return { task: mapTask(row), created: true };
  });

  const setTaskStateTxn = db.transaction(
    (id: string, state: TaskState, updatedAt: number, event?: EventInsert): void => {
      setTaskStateStmt.run({ id, state, updated_at: updatedAt });
      if (event !== undefined) insertEventRow(event);
    }
  );

  const startAttemptTxn = db.transaction(
    (attempt: AttemptInsert, taskState: TaskState, event: EventInsert): AttemptRecord | null => {
      const claim = claimTaskStmt.run({
        id: attempt.taskId,
        state: taskState,
        updated_at: attempt.startedAt,
      });
      if (claim.changes === 0) {
        // Task was already claimed or is not queued — caller must skip.
        return null;
      }
      insertAttemptStmt.run({
        id: attempt.id,
        task_id: attempt.taskId,
        attempt_no: attempt.attemptNo,
        session_id: attempt.sessionId,
        state: attempt.state,
        lease_expires_at: attempt.leaseExpiresAt,
        artifacts: attempt.artifacts === null ? null : JSON.stringify(attempt.artifacts),
        prompt_hash: attempt.promptHash,
        worktree_branch: attempt.worktreeBranch,
        worktree_path: attempt.worktreePath,
        started_at: attempt.startedAt,
      });
      insertEventRow(event);
      const row = getAttemptStmt.get({ id: attempt.id }) as AttemptRow;
      return mapAttempt(row);
    }
  );

  const endAttemptTxn = db.transaction(
    (id: string, patch: AttemptEndPatch, taskState: TaskState, event: EventInsert): boolean => {
      // Merge endState.artifacts over the attempt's existing stored artifacts (HIGH-C)
      // so start-time artifacts (branch, base_sha, transcript_ref) survive an enforcer
      // end that supplies no artifacts.
      const current = getAttemptStmt.get({ id }) as AttemptRow | undefined;
      let mergedArtifacts: string | null;
      if (patch.artifacts === null) {
        mergedArtifacts = current?.artifacts ?? null;
      } else {
        const existing = (current?.artifacts !== undefined && current?.artifacts !== null
          ? JSON.parse(current.artifacts)
          : {}) as Record<string, unknown>;
        mergedArtifacts = JSON.stringify({ ...existing, ...patch.artifacts });
      }

      const result = endAttemptStmt.run({
        id,
        outcome: patch.outcome,
        failure_class: patch.failureClass,
        reason_code: patch.reasonCode,
        reason: patch.reason,
        blocked: patch.blocked === null ? null : JSON.stringify(patch.blocked),
        artifacts: mergedArtifacts,
        usage: patch.usage === null ? null : JSON.stringify(patch.usage),
        agent_version: patch.agentVersion,
        model: patch.model,
        ended_at: patch.endedAt,
      });
      if (result.changes === 0) {
        // Already ended by another concurrent path — skip the task-state write and event.
        return false;
      }
      const attemptRow = getAttemptStmt.get({ id }) as AttemptRow;
      setTaskStateStmt.run({ id: attemptRow.task_id, state: taskState, updated_at: patch.endedAt });
      insertEventRow(event);
      return true;
    }
  );

  const refreshLeaseTxn = db.transaction(
    (id: string, leaseExpiresAt: number, event: EventInsert): void => {
      refreshLeaseStmt.run({ id, lease_expires_at: leaseExpiresAt });
      insertEventRow(event);
    }
  );

  const setRepoStateTxn = db.transaction(
    (repo: string, patch: RepoStatePatch, event?: EventInsert): void => {
      const existing = getRepoStateStmt.get({ repo }) as RepoStateRow | undefined;
      const next = {
        repo,
        consecutive_failures: patch.consecutiveFailures ?? existing?.consecutive_failures ?? 0,
        breaker: patch.breaker ?? existing?.breaker ?? 'closed',
        paused_at: patch.pausedAt !== undefined ? patch.pausedAt : (existing?.paused_at ?? null),
        paused_until:
          patch.pausedUntil !== undefined ? patch.pausedUntil : (existing?.paused_until ?? null),
        updated_at: patch.updatedAt,
      };
      upsertRepoStateStmt.run(next);
      if (event !== undefined) insertEventRow(event);
    }
  );

  return {
    createTaskWithEvent(task, event) {
      return createTaskTxn(task, event);
    },

    getTask(id) {
      const row = getTaskStmt.get({ id }) as TaskRow | undefined;
      return row === undefined ? null : mapTask(row);
    },

    getTaskByExternalId(externalId) {
      const row = getTaskByExternalIdStmt.get({ external_id: externalId }) as TaskRow | undefined;
      return row === undefined ? null : mapTask(row);
    },

    listTasks(filter) {
      let rows: TaskRow[];
      if (filter.repo !== undefined && filter.state !== undefined) {
        rows = listTasksByRepoStateStmt.all({ repo: filter.repo, state: filter.state }) as TaskRow[];
      } else if (filter.repo !== undefined) {
        rows = listTasksByRepoStmt.all({ repo: filter.repo }) as TaskRow[];
      } else if (filter.state !== undefined) {
        rows = listTasksByStateStmt.all({ state: filter.state }) as TaskRow[];
      } else {
        rows = listTasksStmt.all() as TaskRow[];
      }
      return rows.map(mapTask);
    },

    setTaskState(id, state, updatedAt, event) {
      setTaskStateTxn(id, state, updatedAt, event);
    },

    setResumeSessionId(id, resumeSessionId) {
      setResumeSessionIdStmt.run({ id, resume_session_id: resumeSessionId });
    },

    startAttemptWithEvent(attempt, taskState, event) {
      return startAttemptTxn(attempt, taskState, event);
    },

    endAttemptWithEvent(id, patch, taskState, event) {
      return endAttemptTxn(id, patch, taskState, event);
    },

    refreshLeaseWithHeartbeat(id, leaseExpiresAt, event) {
      refreshLeaseTxn(id, leaseExpiresAt, event);
    },

    getAttempt(id) {
      const row = getAttemptStmt.get({ id }) as AttemptRow | undefined;
      return row === undefined ? null : mapAttempt(row);
    },

    getLatestAttempt(taskId) {
      const row = getLatestAttemptStmt.get({ task_id: taskId }) as AttemptRow | undefined;
      return row === undefined ? null : mapAttempt(row);
    },

    getAttemptsForTask(taskId) {
      const rows = getAttemptsForTaskStmt.all({ task_id: taskId }) as AttemptRow[];
      return rows.map(mapAttempt);
    },

    maxAttemptNo(taskId) {
      const row = maxAttemptNoStmt.get({ task_id: taskId }) as { n: number };
      return row.n;
    },

    findRunningAttempts() {
      const rows = findRunningAttemptsStmt.all() as AttemptRow[];
      return rows.map(mapAttempt);
    },

    getRepoState(repo) {
      const row = getRepoStateStmt.get({ repo }) as RepoStateRow | undefined;
      return row === undefined ? null : mapRepoState(row);
    },

    listRepoStates() {
      const rows = listRepoStatesStmt.all() as RepoStateRow[];
      return rows.map(mapRepoState);
    },

    setRepoStateWithEvent(repo, patch, event) {
      setRepoStateTxn(repo, patch, event);
    },

    appendEvent(event) {
      return insertEventRow(event);
    },

    getEventsSince(seq, limit) {
      const rows = getEventsSinceStmt.all({ seq, limit }) as EventRow[];
      return rows.map(mapEvent);
    },

    maxEventSeq() {
      const row = maxEventSeqStmt.get() as { n: number };
      return row.n;
    },
  };
}

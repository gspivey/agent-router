/**
 * Closed unions and record/JSON types for the task-attempt-outcome model
 * (task-attempt-outcome, task 1.3).
 *
 * Every status-like field is a closed TypeScript union mirrored by a SQLite
 * `CHECK` constraint in `src/task-db.ts`. Timestamps are stored as unix ms
 * (INTEGER) and serialized as ISO 8601 strings at the API boundary.
 */

/** Task lifecycle states (Requirement 3.1). */
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

/** Attempt lifecycle states. */
export type AttemptState = 'running' | 'ended';

/** Closed attempt outcome enum (Requirement 6.1). */
export type AttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'timed_out'
  | 'budget_exceeded'
  | 'interrupted';

/**
 * Only ever `'infra'`, and only when `outcome` is `'failed'` (with an infra
 * cause) or `'interrupted'`; `null` for every other outcome (Requirement 6.2/6.3).
 */
export type FailureClass = 'infra';

/** Closed, versioned reason-code enum (Requirement 6.4). */
export type ReasonCode =
  | 'spawn_failed'
  | 'auth_failed'
  | 'rate_limited'
  | 'git_push_failed'
  | 'adapter_crash'
  | 'no_changes'
  | 'agent_reported_failure'
  | 'agent_error'
  | 'agent_blocked'
  | 'budget_exceeded'
  | 'timed_out'
  | 'interrupted'
  | 'cancelled_by_api'
  | 'cancelled_by_breaker';

/**
 * The real ACP protocol stop-reason enum consumed by the ordered outcome
 * classification (not invented values).
 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/** What a `blocked` attempt needs from a human (Requirement 6.7). */
export type BlockedNeeds = 'credential' | 'decision' | 'access' | 'other';

/** How a task entered the daemon. */
export type TaskSource = 'api' | 'roadmap';

/** Supported agent kinds (Requirement 1.7). */
export type AgentKind = 'kiro' | 'claude';

/** Per-repo circuit-breaker state (Requirement 19.1). */
export type BreakerState = 'closed' | 'open' | 'half-open';

/** Task budget/metadata (Requirement 1.10). */
export interface Budget {
  max_wall_s?: number;
  max_tokens?: number;
  max_turns?: number;
  /** Heartbeat interval in seconds; defaults to 30. */
  heartbeat_interval_s?: number;
  /** Whether an interrupted session may be resumed; defaults to false. */
  allow_resume?: boolean;
}

/** Attempt artifacts (Requirement 6.6). */
export interface Artifacts {
  branch?: string;
  base_sha?: string;
  head_sha?: string;
  pr_url?: string;
  diff_stats?: { files: number; insertions: number; deletions: number };
  /** Path to the active `stream.log` or the archived `.zst`. */
  transcript_ref?: string;
}

/** Attempt usage (Requirement 6.6). */
export interface Usage {
  wall_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

/** The `{ question, needs }` payload for a `blocked` attempt (Requirement 6.7). */
export interface Blocked {
  question: string;
  needs: BlockedNeeds;
}

/**
 * Enforcer-set termination intent (Requirement 16.9). In-memory only; never a
 * column on `attempts`. Carries the full triple so a circuit-breaker cancel can
 * express `reason_code` + `failure_class`, which a bare `AttemptOutcome` string
 * could not.
 */
export interface TerminationIntent {
  outcome: AttemptOutcome;
  reasonCode: ReasonCode;
  failureClass: FailureClass | null;
}

/**
 * Full end state passed to `teardownAttempt()` (Requirement 16.10). A superset
 * of `TerminationIntent`: enforcer/cancel/breaker/lease paths supply only the
 * triple (`blocked`/`artifacts`/`usage` omitted), while a natural end supplies
 * the full state including the agent-reported `pr_url`, `artifacts`, and `usage`.
 * A `TerminationIntent` is therefore assignable to `AttemptEndState` unchanged.
 */
export interface AttemptEndState {
  outcome: AttemptOutcome;
  /** `null` only for a natural `succeeded` end (Requirement 6.8). */
  reasonCode: ReasonCode | null;
  failureClass: FailureClass | null;
  /**
   * Whether this end increments the repo's `consecutive_failures` (circuit
   * breaker). Optional; defaults to `true` when omitted. Set `false` only for
   * the Requirement 22.8 carve-out — a `git_push_failed` end whose remote-ref
   * check failed because `git ls-remote` itself errored (`remoteBranchExists`
   * is `null`, a transient network fault that must not trip the breaker).
   */
  countsTowardBreaker?: boolean;
  /** Free-text human reason (distinct from the closed `reasonCode`). */
  reason?: string;
  blocked?: Blocked;
  artifacts?: Artifacts;
  usage?: Usage;
}

/** A row in the `tasks` table. */
export interface TaskRecord {
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
  /** Set when an allow_resume session is interrupted; cleared after one resume. */
  resumeSessionId: string | null;
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
}

/** A row in the `attempts` table. */
export interface AttemptRecord {
  id: string;
  taskId: string;
  attemptNo: number;
  sessionId: string | null;
  /** `agent/<attempt_id>` (fresh) or `agent/<original_attempt_id>` (resume). */
  worktreeBranch: string | null;
  /** `/tmp/agent-runs/<attempt_id>`; a resume reuses the interrupted attempt's path. */
  worktreePath: string | null;
  state: AttemptState;
  leaseExpiresAt: number | null;
  outcome: AttemptOutcome | null;
  failureClass: FailureClass | null;
  reasonCode: ReasonCode | null;
  reason: string | null;
  blocked: Blocked | null;
  artifacts: Artifacts | null;
  usage: Usage | null;
  agentVersion: string | null;
  model: string | null;
  promptHash: string | null;
  pid: number | null;
  pgid: number | null;
  processStartTime: number | null;
  processCmdline: string | null;
  startedAt: number; // unix ms
  endedAt: number | null; // unix ms
}

/** A row in the `task_events` table. */
export interface TaskEventRecord {
  seq: number;
  id: string;
  ts: number; // unix ms
  type: string;
  repo: string | null;
  taskId: string | null;
  attemptId: string | null;
  data: unknown;
}

/** A row in the `repo_state` table (Requirement 19.1). */
export interface RepoStateRecord {
  repo: string;
  consecutiveFailures: number;
  breaker: BreakerState;
  pausedAt: number | null; // unix ms when the breaker last opened
  pausedUntil: number | null; // unix ms optional cooldown deadline
  updatedAt: number; // unix ms
}

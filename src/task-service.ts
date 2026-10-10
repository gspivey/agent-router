import { ulid } from './ulid.js';
import { TaskError } from './task-errors.js';
import type { TaskDatabase, EventInsert } from './task-db.js';
import {
  type AgentKind,
  type AttemptOutcome,
  type Budget,
  type TaskRecord,
  type TaskSource,
  type TaskState,
} from './task-types.js';

/**
 * Task service and state machine (task-attempt-outcome, tasks 3.1–3.2).
 *
 * Owns the task state machine (Requirement 3) and submission validation
 * (Requirement 1). Pure functions are exported individually for Tier 1 testing;
 * `TaskService` composes them with the DB helpers and a scheduler hook.
 */

// ---------------------------------------------------------------------------
// Pure validation and state-machine functions
// ---------------------------------------------------------------------------

const AGENT_KINDS: ReadonlySet<string> = new Set<AgentKind>(['kiro', 'claude']);
const TASK_STATES: ReadonlySet<string> = new Set<TaskState>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
]);

/** Known budget fields and their expected runtime types. */
const BUDGET_NUMBER_FIELDS = ['max_wall_s', 'max_tokens', 'max_turns', 'heartbeat_interval_s'] as const;

/** The normalized, validated result of a `POST /v1/tasks` body. */
export interface NormalizedSubmit {
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
}

export type ValidateSubmitResult =
  | { valid: true; value: NormalizedSubmit }
  | { valid: false; code: string; message: string };

export type ParseBudgetResult =
  | { valid: true; value: Budget }
  | { valid: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate and normalize a budget object (Requirement 1.10). Known numeric
 * fields must be non-negative finite numbers; `allow_resume` must be boolean.
 * Unknown fields are rejected to keep the contract closed.
 */
export function parseBudget(raw: unknown): ParseBudgetResult {
  if (!isPlainObject(raw)) {
    return { valid: false, message: 'budget must be a JSON object' };
  }
  const budget: Budget = {};
  for (const key of Object.keys(raw)) {
    if ((BUDGET_NUMBER_FIELDS as readonly string[]).includes(key)) {
      const value = raw[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return { valid: false, message: `budget.${key} must be a non-negative number` };
      }
      (budget as Record<string, unknown>)[key] = value;
    } else if (key === 'allow_resume') {
      const value = raw[key];
      if (typeof value !== 'boolean') {
        return { valid: false, message: 'budget.allow_resume must be a boolean' };
      }
      budget.allow_resume = value;
    } else {
      return { valid: false, message: `budget has unknown field "${key}"` };
    }
  }
  return { valid: true, value: budget };
}

/**
 * Validate a `POST /v1/tasks` body against the set of configured repos.
 * Returns a normalized submission or a `{ code, message }` describing the
 * first failure (Requirement 1.5–1.10).
 */
export function validateSubmitBody(
  body: unknown,
  configuredRepos: ReadonlySet<string>
): ValidateSubmitResult {
  if (!isPlainObject(body)) {
    return { valid: false, code: 'invalid_body', message: 'request body must be a JSON object' };
  }

  // Required string fields.
  for (const field of ['repo', 'title', 'spec'] as const) {
    const value = body[field];
    if (typeof value !== 'string' || value.length === 0) {
      return {
        valid: false,
        code: 'invalid_body',
        message: `missing or invalid required field "${field}"`,
      };
    }
  }

  const repo = body['repo'] as string;
  if (!configuredRepos.has(repo)) {
    return { valid: false, code: 'invalid_repo', message: `repo "${repo}" is not configured` };
  }

  // agent: default 'kiro'; must be a known kind when present (Requirement 1.7).
  let agent: AgentKind = 'kiro';
  if (body['agent'] !== undefined) {
    const raw = body['agent'];
    if (typeof raw !== 'string' || !AGENT_KINDS.has(raw)) {
      return { valid: false, code: 'invalid_agent', message: `agent "${String(raw)}" is not valid` };
    }
    agent = raw as AgentKind;
  }

  // source: default 'api' for API submissions (Requirement 1.8).
  let source: TaskSource = 'api';
  if (body['source'] !== undefined) {
    const raw = body['source'];
    if (raw !== 'api' && raw !== 'roadmap') {
      return { valid: false, code: 'invalid_body', message: `source "${String(raw)}" is not valid` };
    }
    source = raw;
  }

  // external_id: optional string; null when omitted (Requirement 1.2).
  let externalId: string | null = null;
  if (body['external_id'] !== undefined && body['external_id'] !== null) {
    const raw = body['external_id'];
    if (typeof raw !== 'string' || raw.length === 0) {
      return { valid: false, code: 'invalid_body', message: 'external_id must be a non-empty string' };
    }
    externalId = raw;
  }

  // source_ref: optional string.
  let sourceRef: string | null = null;
  if (body['source_ref'] !== undefined && body['source_ref'] !== null) {
    const raw = body['source_ref'];
    if (typeof raw !== 'string') {
      return { valid: false, code: 'invalid_body', message: 'source_ref must be a string' };
    }
    sourceRef = raw;
  }

  // base_ref: optional; null means the repo default branch (Requirement 1.9).
  let baseRef: string | null = null;
  if (body['base_ref'] !== undefined && body['base_ref'] !== null) {
    const raw = body['base_ref'];
    if (typeof raw !== 'string' || raw.length === 0) {
      return { valid: false, code: 'invalid_body', message: 'base_ref must be a non-empty string' };
    }
    baseRef = raw;
  }

  // budget: optional object (Requirement 1.10).
  let budget: Budget | null = null;
  if (body['budget'] !== undefined && body['budget'] !== null) {
    const parsed = parseBudget(body['budget']);
    if (!parsed.valid) {
      return { valid: false, code: 'invalid_budget', message: parsed.message };
    }
    budget = parsed.value;
  }

  // metadata: persisted verbatim (Requirement 1.11); defaults to null.
  const metadata = body['metadata'] !== undefined ? body['metadata'] : null;

  return {
    valid: true,
    value: {
      externalId,
      repo,
      source,
      sourceRef,
      title: body['title'] as string,
      spec: body['spec'] as string,
      baseRef,
      agent,
      budget,
      metadata,
    },
  };
}

/** True when `state` is a valid task state (for `?state=` query validation). */
export function validateTaskState(state: string): state is TaskState {
  return TASK_STATES.has(state);
}

/**
 * Map an attempt outcome to the next task state (Requirement 3.3–3.6).
 * `interrupted` maps to `failed` (reason_code `interrupted`), NOT `queued` — an
 * interruption is infrastructural but is never auto-retried.
 */
export function nextTaskStateForOutcome(outcome: AttemptOutcome): TaskState {
  switch (outcome) {
    case 'succeeded':
      return 'succeeded';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'timed_out':
    case 'budget_exceeded':
    case 'interrupted':
      return 'failed';
  }
}

/** A task may be retried only from `failed` or `blocked` (Requirement 5.1/5.2). */
export function canRetry(state: TaskState): boolean {
  return state === 'failed' || state === 'blocked';
}

/** A task may be cancelled unless it is already terminal (Requirement 5.6/3.8). */
export function canCancel(state: TaskState): boolean {
  return state !== 'succeeded' && state !== 'cancelled';
}

// ---------------------------------------------------------------------------
// TaskService
// ---------------------------------------------------------------------------

/**
 * The scheduler hook the service hands queued/retried tasks to. The concrete
 * `RepoScheduler` is implemented by a later roadmap item; this foundation item
 * depends only on the `enqueue` contract so it can be unit-tested in isolation.
 */
export interface TaskScheduler {
  enqueue(task: TaskRecord): void;
}

export interface TaskServiceDeps {
  db: TaskDatabase;
  scheduler: TaskScheduler;
  configuredRepos: ReadonlySet<string>;
  now?: () => number;
  newId?: () => string;
}

/** The result of a submission (Requirement 1.1/1.3). */
export interface SubmitResult {
  task: TaskRecord;
  created: boolean;
}

export type RetryResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; code: 'conflict'; message: string };

export type CancelResult =
  | { ok: true; task: TaskRecord; killedAttempt: boolean }
  | { ok: false; code: 'conflict'; message: string };

export class TaskService {
  private readonly db: TaskDatabase;
  private readonly scheduler: TaskScheduler;
  private readonly configuredRepos: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: TaskServiceDeps) {
    this.db = deps.db;
    this.scheduler = deps.scheduler;
    this.configuredRepos = deps.configuredRepos;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => ulid());
  }

  /**
   * Submit a task. Idempotent on `external_id`: a duplicate returns the existing
   * record with `created = false` and emits no event (Requirement 1.1–1.3/1.12).
   */
  submitTask(normalized: NormalizedSubmit): SubmitResult {
    if (!this.configuredRepos.has(normalized.repo)) {
      throw new TaskError(`repo "${normalized.repo}" is not configured`);
    }
    const ts = this.now();
    const id = this.newId();
    const event: EventInsert = {
      id: this.newId(),
      ts,
      type: 'task.queued',
      repo: normalized.repo,
      taskId: id,
      attemptId: null,
      data: { source: normalized.source, title: normalized.title },
    };
    const { task, created } = this.db.createTaskWithEvent(
      {
        id,
        externalId: normalized.externalId,
        repo: normalized.repo,
        source: normalized.source,
        sourceRef: normalized.sourceRef,
        title: normalized.title,
        spec: normalized.spec,
        baseRef: normalized.baseRef,
        agent: normalized.agent,
        budget: normalized.budget,
        metadata: normalized.metadata,
        state: 'queued',
        createdAt: ts,
        updatedAt: ts,
      },
      event
    );
    if (created) {
      this.scheduler.enqueue(task);
    }
    return { task, created };
  }

  /** Fetch a task plus a summary of its latest attempt (Requirement 2.1/2.2). */
  getTask(id: string): { task: TaskRecord; latestAttempt: ReturnType<TaskDatabase['getLatestAttempt']> } | null {
    const task = this.db.getTask(id);
    if (task === null) return null;
    return { task, latestAttempt: this.db.getLatestAttempt(id) };
  }

  /** List tasks filtered by repo and/or state (Requirement 2.3–2.6). */
  listTasks(filter: { repo?: string; state?: TaskState }): TaskRecord[] {
    return this.db.listTasks(filter);
  }

  /**
   * Re-queue a `failed`/`blocked` task for retry (Requirement 5.1–5.3). Emits
   * `task.requeued` (`reason='retry'`) in the same transaction as the state
   * write and hands the task to the scheduler; it never creates an attempt row
   * directly — the scheduler does that when it claims the task.
   */
  retryTask(id: string): RetryResult {
    const task = this.db.getTask(id);
    if (task === null) {
      return { ok: false, code: 'conflict', message: `task "${id}" not found` };
    }
    if (!canRetry(task.state)) {
      return {
        ok: false,
        code: 'conflict',
        message: `task "${id}" cannot be retried from state "${task.state}"`,
      };
    }
    const ts = this.now();
    const event: EventInsert = {
      id: this.newId(),
      ts,
      type: 'task.requeued',
      repo: task.repo,
      taskId: id,
      attemptId: null,
      data: { reason: 'retry' },
    };
    this.db.setTaskState(id, 'queued', ts, event);
    const requeued = this.db.getTask(id) as TaskRecord;
    this.scheduler.enqueue(requeued);
    return { ok: true, task: requeued };
  }

  /**
   * Cancel a task (Requirement 5.4–5.7). This foundation item handles the
   * no-running-attempt case: it transitions the task to `cancelled` and emits
   * `task.cancelled` without an `attempt.ended`. The running-attempt teardown
   * (Rule 1 of Requirement 4.1a) is wired by the attempt-runner item; here we
   * surface whether a running attempt exists so the caller can route it.
   */
  cancelTask(id: string): CancelResult {
    const task = this.db.getTask(id);
    if (task === null) {
      return { ok: false, code: 'conflict', message: `task "${id}" not found` };
    }
    if (!canCancel(task.state)) {
      return {
        ok: false,
        code: 'conflict',
        message: `task "${id}" is already in terminal state "${task.state}"`,
      };
    }

    const latest = this.db.getLatestAttempt(id);
    const hasRunningAttempt = latest !== null && latest.state === 'running';

    const ts = this.now();
    const event: EventInsert = {
      id: this.newId(),
      ts,
      type: 'task.cancelled',
      repo: task.repo,
      taskId: id,
      attemptId: hasRunningAttempt ? latest.id : null,
      data: { by: 'api', reason: 'cancelled by api' },
    };
    this.db.setTaskState(id, 'cancelled', ts, event);
    const cancelled = this.db.getTask(id) as TaskRecord;
    return { ok: true, task: cancelled, killedAttempt: hasRunningAttempt };
  }
}

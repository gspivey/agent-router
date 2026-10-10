/**
 * Attempt runner (task-attempt-outcome, tasks 5.1–5.5).
 *
 * Owns the lifecycle of a single attempt: it drives the existing session
 * machinery, resolves the structured outcome, and ends the attempt through the
 * single `teardownAttempt` path. Pure outcome-resolution functions
 * (`resolveOutcome`, `classifyPreSessionInfra`, `buildPromptPreamble`) are
 * exported for Tier 1 testing; the `AttemptRunner` class composes them with the
 * DB helpers, the scheduler, and injected git/process/session effects so the
 * orchestration is testable in isolation and wired by a later roadmap item.
 */
import { createHash } from 'node:crypto';
import type { TaskDatabase, EventInsert, AttemptEndPatch } from './task-db.js';
import type { RepoScheduler } from './repo-scheduler.js';
import { INFRA_REASON_CODES } from './repo-scheduler.js';
import type { Logger } from './log.js';
import { ulid } from './ulid.js';
import { nextTaskStateForOutcome } from './task-service.js';
import {
  type AttemptEndState,
  type AttemptOutcome,
  type AttemptRecord,
  type Blocked,
  type BlockedNeeds,
  type FailureClass,
  type ReasonCode,
  type StopReason,
  type TaskRecord,
  type TerminationIntent,
} from './task-types.js';

// ---------------------------------------------------------------------------
// Agent self-report payload (report_outcome tool / outcome.json)
// ---------------------------------------------------------------------------

/** The three outcomes an agent may declare (Requirement 7.1a). */
export type AgentDeclarableOutcome = 'succeeded' | 'failed' | 'blocked';

const AGENT_DECLARABLE: ReadonlySet<string> = new Set<AgentDeclarableOutcome>([
  'succeeded',
  'failed',
  'blocked',
]);

const BLOCKED_NEEDS: ReadonlySet<string> = new Set<BlockedNeeds>([
  'credential',
  'decision',
  'access',
  'other',
]);

/** Decoded `report_outcome` / `outcome.json` payload carried end-to-end (HIGH-5). */
export interface ReportOutcomePayload {
  outcome: AgentDeclarableOutcome;
  reason_code?: ReasonCode;
  reason?: string;
  blocked?: Blocked;
  pr_url?: string;
}

/**
 * Validate an agent-supplied self-report (tool args or parsed outcome.json)
 * against the agent-declarable enum (Requirement 7.1a/7.7). Returns a decoded
 * payload or `null` when the value is out of scope so the caller falls through
 * to mechanical classification.
 */
export function parseReportOutcome(raw: unknown): ReportOutcomePayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const outcome = obj['outcome'];
  if (typeof outcome !== 'string' || !AGENT_DECLARABLE.has(outcome)) return null;
  const payload: ReportOutcomePayload = { outcome: outcome as AgentDeclarableOutcome };

  if (obj['reason_code'] !== undefined && obj['reason_code'] !== null) {
    if (typeof obj['reason_code'] !== 'string') return null;
    payload.reason_code = obj['reason_code'] as ReasonCode;
  }
  if (obj['reason'] !== undefined && obj['reason'] !== null) {
    if (typeof obj['reason'] !== 'string') return null;
    payload.reason = obj['reason'];
  }
  if (obj['pr_url'] !== undefined && obj['pr_url'] !== null) {
    if (typeof obj['pr_url'] !== 'string') return null;
    payload.pr_url = obj['pr_url'];
  }
  if (outcome === 'blocked') {
    const blocked = obj['blocked'];
    if (typeof blocked !== 'object' || blocked === null || Array.isArray(blocked)) return null;
    const b = blocked as Record<string, unknown>;
    if (typeof b['question'] !== 'string') return null;
    if (typeof b['needs'] !== 'string' || !BLOCKED_NEEDS.has(b['needs'])) return null;
    payload.blocked = { question: b['question'], needs: b['needs'] as BlockedNeeds };
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Pre-session infra classification (task 5.1a / Requirement 22)
// ---------------------------------------------------------------------------

/** The closed set of pre-session / adapter infra reason codes (Requirement 22.1). */
export type PreSessionInfraReasonCode =
  | 'spawn_failed'
  | 'auth_failed'
  | 'rate_limited'
  | 'adapter_crash';

/** The result of running a session up to and through the agent process. */
export interface SessionResult {
  /** fork/exec error (ENOENT/EACCES/EPERM) when the agent CLI could not start. */
  spawnError?: NodeJS.ErrnoException;
  exitCode: number | null;
  /** Tail of agent stderr for auth-message detection. */
  stderrTail?: string;
  /** Number of ACP events received before exit (0 ⇒ adapter never connected). */
  acpEventCount: number;
  /** HTTP status of the setup `GET /repos/:owner/:repo` call (401/403/429). */
  setupHttpStatus?: number | null;
}

const AUTH_ERROR_PATTERN = /\b(401|403|unauthorized|forbidden|bad credentials|authentication failed)\b/i;

/**
 * Detect pre-session / adapter infra failures (Requirement 22.1–22.7). Runs
 * after the agent session has exited and BEFORE the self-report / mechanical
 * classification. First match wins. Does NOT produce `git_push_failed` — that
 * is a separate post-exit remote-ref check.
 */
export function classifyPreSessionInfra(r: SessionResult): PreSessionInfraReasonCode | null {
  // spawn_failed: fork/exec threw ENOENT/EACCES/EPERM (Requirement 22.2).
  if (r.spawnError !== undefined) {
    const code = r.spawnError.code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return 'spawn_failed';
    return 'spawn_failed';
  }
  // auth_failed: setup GET /repos returned 401/403, or stderr matches an auth
  // pattern (Requirement 22.3).
  if (r.setupHttpStatus === 401 || r.setupHttpStatus === 403) return 'auth_failed';
  // rate_limited: setup call returned 429 (Requirement 22.4).
  if (r.setupHttpStatus === 429) return 'rate_limited';
  // auth stderr fallback (Requirement 22.3).
  if (r.stderrTail !== undefined && AUTH_ERROR_PATTERN.test(r.stderrTail)) return 'auth_failed';
  // adapter_crash: zero ACP events with non-zero exit (Requirement 22.6).
  if (r.acpEventCount === 0 && r.exitCode !== null && r.exitCode !== 0) return 'adapter_crash';
  return null;
}

// ---------------------------------------------------------------------------
// Outcome resolution (task 5.1 / Requirement 16)
// ---------------------------------------------------------------------------

/** Inputs to `resolveOutcome`, mirroring the ordered classification list. */
export interface ResolveOutcomeInputs {
  /** Enforcer-set intent; when present, wins over everything (Requirement 16.8). */
  terminationIntent?: TerminationIntent | null;
  /** Agent `report_outcome` self-report (succeeded|failed|blocked only). */
  reported?: ReportOutcomePayload | null;
  /** Parsed `.agent-router/outcome.json` (succeeded|failed|blocked only). */
  outcomeFile?: ReportOutcomePayload | null;
  /** Pre-session infra reason code (Requirement 22), consulted before self-report. */
  preSessionInfra?: PreSessionInfraReasonCode | null;
  /** Real ACP stop reason (null until a stop reason fires). */
  stopReason?: StopReason | null;
  /** Process exit code (null until process exit — ACP may end first). */
  exitCode: number | null;
  /** `git rev-list --count <base_sha>..HEAD > 0`. */
  hasDiff: boolean;
  /**
   * Post-exit `git ls-remote` vs HEAD (HIGH-7): `true` = ref present AND
   * SHA === HEAD → succeeded; `false` = absent or SHA ≠ HEAD → git_push_failed
   * (counts); `null` = ls-remote itself failed → git_push_failed (does NOT count).
   */
  remoteBranchExists?: boolean | null;
}

/** The structured result of `resolveOutcome`. */
export interface ResolvedOutcome {
  outcome: AttemptOutcome;
  failureClass: FailureClass | null;
  reasonCode: ReasonCode | null;
  reason: string;
  blocked?: Blocked;
  /** Only set `false` for the Requirement 22.8 ls-remote-null carve-out. */
  countsTowardBreaker?: boolean;
}

/** Reason code for a declared outcome (Requirement 16.3 rules 1–2). */
function reasonCodeForDeclared(outcome: AgentDeclarableOutcome): ReasonCode | null {
  switch (outcome) {
    case 'succeeded':
      return null;
    case 'failed':
      return 'agent_reported_failure';
    case 'blocked':
      return 'agent_blocked';
  }
}

/** `failure_class` is `'infra'` for the infra reason set + `interrupted`. */
function failureClassFor(outcome: AttemptOutcome, reasonCode: ReasonCode | null): FailureClass | null {
  if (outcome === 'interrupted') return 'infra';
  if (
    outcome === 'failed' &&
    reasonCode !== null &&
    (INFRA_REASON_CODES.has(reasonCode) || reasonCode === 'cancelled_by_breaker')
  ) {
    return 'infra';
  }
  return null;
}

function fromDeclared(declared: ReportOutcomePayload): ResolvedOutcome {
  const reasonCode = declared.reason_code ?? reasonCodeForDeclared(declared.outcome);
  const outcome: AttemptOutcome = declared.outcome;
  const result: ResolvedOutcome = {
    outcome,
    reasonCode,
    failureClass: failureClassFor(outcome, reasonCode),
    reason: declared.reason ?? '',
  };
  if (declared.outcome === 'blocked' && declared.blocked !== undefined) {
    result.blocked = declared.blocked;
  }
  return result;
}

/**
 * Resolve an attempt's structured outcome as an ordered first-match list
 * (Requirement 16.3 / 22.9). Pure — side-effect-free and fully unit-testable.
 */
export function resolveOutcome(inputs: ResolveOutcomeInputs): ResolvedOutcome {
  // (0) Enforcer-set termination intent wins over everything (Requirement 16.8).
  if (inputs.terminationIntent !== undefined && inputs.terminationIntent !== null) {
    const ti = inputs.terminationIntent;
    return { outcome: ti.outcome, reasonCode: ti.reasonCode, failureClass: ti.failureClass, reason: '' };
  }

  // (1–2) Pre-session infra overrides a self-report (it ran before one was possible).
  if (inputs.preSessionInfra !== undefined && inputs.preSessionInfra !== null) {
    return {
      outcome: 'failed',
      reasonCode: inputs.preSessionInfra,
      failureClass: 'infra',
      reason: `pre-session infra failure: ${inputs.preSessionInfra}`,
    };
  }

  // (3) Agent self-report via report_outcome tool.
  if (inputs.reported !== undefined && inputs.reported !== null) {
    return fromDeclared(inputs.reported);
  }
  // (3) Agent self-report via outcome.json.
  if (inputs.outcomeFile !== undefined && inputs.outcomeFile !== null) {
    return fromDeclared(inputs.outcomeFile);
  }

  // (4) ACP stop reason with no declaration.
  const stopReason = inputs.stopReason ?? null;
  if (stopReason !== null) {
    switch (stopReason) {
      case 'max_tokens':
      case 'max_turn_requests':
        return { outcome: 'budget_exceeded', reasonCode: 'budget_exceeded', failureClass: null, reason: 'budget overrun' };
      case 'refusal':
        return { outcome: 'failed', reasonCode: 'agent_reported_failure', failureClass: null, reason: 'agent refused' };
      case 'cancelled':
        // No termination_intent (checked at step 0) ⇒ the agent cannot self-cancel.
        return { outcome: 'failed', reasonCode: 'agent_error', failureClass: null, reason: 'cancelled without intent' };
      case 'end_turn':
        break; // fall through to the commit check
      default:
        return { outcome: 'failed', reasonCode: 'agent_error', failureClass: null, reason: 'unexpected stop reason' };
    }
  }

  // (5) hasDiff → post-exit remote-ref check (Requirement 22.5 / HIGH-7).
  if (inputs.hasDiff) {
    const remote = inputs.remoteBranchExists;
    if (remote === true) {
      return { outcome: 'succeeded', reasonCode: null, failureClass: null, reason: 'committed and pushed' };
    }
    if (remote === null) {
      // ls-remote itself failed — git_push_failed but does NOT count (Req 22.8).
      return {
        outcome: 'failed',
        reasonCode: 'git_push_failed',
        failureClass: 'infra',
        reason: 'git ls-remote failed (transient)',
        countsTowardBreaker: false,
      };
    }
    // remote === false or undefined: absent or SHA mismatch.
    return {
      outcome: 'failed',
      reasonCode: 'git_push_failed',
      failureClass: 'infra',
      reason: 'remote branch absent or SHA mismatch',
    };
  }

  // (6) cleanEnd + no commits → no_changes.
  const cleanEnd = stopReason === 'end_turn' || inputs.exitCode === 0;
  if (cleanEnd) {
    return { outcome: 'failed', reasonCode: 'no_changes', failureClass: null, reason: 'no commits produced' };
  }

  // (7) non-zero exit → agent_error.
  if (inputs.exitCode !== null && inputs.exitCode !== 0) {
    return { outcome: 'failed', reasonCode: 'agent_error', failureClass: null, reason: `exit code ${inputs.exitCode}` };
  }

  // (8) catch-all: exitCode null and no stop reason — ACP never connected.
  return { outcome: 'failed', reasonCode: 'agent_error', failureClass: null, reason: 'agent error (no stop reason, no exit)' };
}

// ---------------------------------------------------------------------------
// Prompt preamble (task 5.2a / Requirement 23)
// ---------------------------------------------------------------------------

/**
 * Build the standard preamble prepended to the agent's initial prompt
 * (Requirement 23). Pure and independently testable. `branchName` is the
 * attempt's actual push branch — `agent/<attempt_id>` fresh or
 * `agent/<original_attempt_id>` resume — so the exact push command is correct
 * for both cases (HIGH-4/HIGH-7). Never mutates `task.spec`.
 */
export function buildPromptPreamble(task: TaskRecord, attemptId: string, branchName: string): string {
  void task;
  void attemptId;
  return [
    'You are running inside agent-router as a task attempt. Before this session ends you',
    'MUST report your structured outcome through ONE of these two channels:',
    '',
    '1. Call the `report_outcome` tool with one of exactly three outcomes:',
    '   - `succeeded` — you completed the work, committed, pushed, and (if applicable) opened a PR.',
    '   - `failed` — you could not complete the work.',
    '   - `blocked` — you need a human decision/credential/access to proceed',
    '     (include a `blocked` object `{ question, needs }` where `needs` is one of',
    '     credential | decision | access | other).',
    '   The tool also accepts an optional `pr_url` string — include it if you opened a pull request.',
    '',
    '2. OR write a file `.agent-router/outcome.json` in the worktree root with the schema',
    '   `{ outcome, reason_code?, reason?, blocked?, pr_url? }`, using the same three',
    '   `outcome` values (`succeeded` | `failed` | `blocked`). Include `pr_url` if you opened a PR.',
    '',
    'You are responsible for committing your work, pushing the branch, and opening the pull request.',
    `Push your branch with exactly this command: \`git push origin ${branchName}\``,
    '',
    '--- TASK ---',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// AttemptRunner — effects interfaces (injected for testability)
// ---------------------------------------------------------------------------

/** Git/worktree effects used by the runner. Injected so Tier 2 can fake them. */
export interface WorktreeOps {
  /** `git worktree add <path> -b <branch> <baseRef>`. */
  add(path: string, branch: string, baseRef: string): Promise<void>;
  /** `git worktree remove --force <path>`. */
  remove(path: string): Promise<void>;
  /** `git rev-parse HEAD` in the worktree. */
  headSha(path: string): Promise<string>;
  /** `git rev-list --count <baseSha>..HEAD > 0` in the worktree. */
  hasDiff(path: string, baseSha: string): Promise<boolean>;
  /**
   * Post-exit remote-ref check: compare `git ls-remote origin refs/heads/<branch>`
   * to the worktree HEAD. Returns `true` (match), `false` (absent/mismatch), or
   * `null` (ls-remote itself failed).
   */
  remoteBranchMatchesHead(path: string, branch: string): Promise<boolean | null>;
  /** Delete a pre-existing `.agent-router/outcome.json` to prevent spoofing. */
  clearOutcomeFile(path: string): Promise<void>;
  /** Read + schema-validate `.agent-router/outcome.json`; null when absent/invalid. */
  readOutcomeFile(path: string): Promise<ReportOutcomePayload | null>;
}

/** Agent process effects used by the runner. */
export interface ProcessOps {
  /** Close the ACP connection, SIGTERM the pgid, 5s grace, then SIGKILL (Req 16.7). */
  killProcessGroup(pid: number, pgid: number): Promise<void>;
}

/** Clock + id injection. */
export interface RunnerClock {
  now(): number;
  newId(): string;
}

export interface AttemptRunnerDeps {
  db: TaskDatabase;
  scheduler: RepoScheduler;
  log: Logger;
  worktree: WorktreeOps;
  process: ProcessOps;
  clock?: Partial<RunnerClock>;
}

/** In-memory state for a running attempt (Requirement 16.9 — not persisted). */
export interface RunningAttemptState {
  attemptId: string;
  taskId: string;
  repo: string;
  pid: number | null;
  pgid: number | null;
  worktreePath: string;
  worktreeBranch: string;
  allowResume: boolean;
  lastActivityTs: number;
  turnsSoFar: number;
  tokensSoFar: number;
  startedAt: number;
  terminationIntent: TerminationIntent | null;
  reported: ReportOutcomePayload | null;
}

export const DEFAULT_HEARTBEAT_INTERVAL_S = 30;

/**
 * Drives attempt lifecycle. The orchestration methods (`start`, heartbeat loop,
 * lease/idle checks) are wired by a later roadmap item; the critical
 * `teardownAttempt` path and the enforcer/cancel/breaker intent handling are
 * implemented here and used by the scheduler and the cancel path.
 */
export class AttemptRunner {
  private readonly db: TaskDatabase;
  private readonly scheduler: RepoScheduler;
  private readonly log: Logger;
  private readonly worktree: WorktreeOps;
  private readonly process: ProcessOps;
  private readonly now: () => number;
  private readonly newId: () => string;

  /** Running attempts keyed by attempt id. */
  private readonly running = new Map<string, RunningAttemptState>();

  constructor(deps: AttemptRunnerDeps) {
    this.db = deps.db;
    this.scheduler = deps.scheduler;
    this.log = deps.log;
    this.worktree = deps.worktree;
    this.process = deps.process;
    this.now = deps.clock?.now ?? (() => Date.now());
    this.newId = deps.clock?.newId ?? (() => ulid());
  }

  /** Expose running state for the cli-server report_outcome sink and tests. */
  getRunningBySession(sessionId: string): RunningAttemptState | undefined {
    for (const s of this.running.values()) {
      if (s.attemptId === sessionId || s.taskId === sessionId) return s;
    }
    return undefined;
  }

  /** Register a running attempt's in-memory state (used by start + tests). */
  track(state: RunningAttemptState): void {
    this.running.set(state.attemptId, state);
  }

  /** Look up tracked state. */
  getRunning(attemptId: string): RunningAttemptState | undefined {
    return this.running.get(attemptId);
  }

  /**
   * Record a `report_outcome` self-report on the attempt's in-memory state
   * (Requirement 7.2a). Validated against the agent-declarable enum; an invalid
   * value is ignored (falls through to mechanical classification).
   */
  recordReportedOutcome(attemptId: string, raw: unknown): boolean {
    const state = this.running.get(attemptId);
    if (state === undefined) return false;
    const parsed = parseReportOutcome(raw);
    if (parsed === null) return false;
    state.reported = parsed;
    state.lastActivityTs = this.now();
    return true;
  }

  /**
   * Record a self-report by the attempt's session id (the daemon identifies an
   * attempt by its session). Returns true when accepted.
   */
  recordReportedOutcomeBySession(sessionId: string, raw: unknown): boolean {
    const state = this.getRunningBySession(sessionId);
    if (state === undefined) return false;
    return this.recordReportedOutcome(state.attemptId, raw);
  }

  /**
   * Atomically set the termination intent (compare-and-set, first-writer-wins —
   * Requirement 4.1a Rule 4). Returns true when this call set it.
   */
  setTerminationIntent(attemptId: string, intent: TerminationIntent): boolean {
    const state = this.running.get(attemptId);
    if (state === undefined) return false;
    if (state.terminationIntent !== null) return false;
    state.terminationIntent = intent;
    return true;
  }

  /**
   * Rule 1 caller (Requirement 4.1a / 5.4 / 12.9): set the intent FIRST, then
   * read `pid`. If a pid exists, tear the attempt down immediately; otherwise
   * return (the spawner's Rule 3 re-check consumes the intent once the pid
   * exists). Used by both the API cancel and the breaker cancel.
   */
  async requestTermination(attemptId: string, intent: TerminationIntent): Promise<void> {
    this.setTerminationIntent(attemptId, intent);
    const state = this.running.get(attemptId);
    const pid = state?.pid ?? this.db.getAttempt(attemptId)?.pid ?? null;
    if (pid !== null) {
      const effective = state?.terminationIntent ?? intent;
      await this.teardownAttempt(attemptId, effective, false);
    }
    // pid === null: setup window still open — defer to Rule 3.
  }

  /**
   * Evaluate the task budget against the attempt's observed usage. When a limit
   * is exceeded, set the termination intent and tear the attempt down
   * (Requirement 17.1–17.3). Called on heartbeat ticks and ACP activity.
   */
  async enforceBudget(attemptId: string, task: TaskRecord, wallMs: number): Promise<boolean> {
    const state = this.running.get(attemptId);
    if (state === undefined) return false;
    const budget = task.budget;
    if (budget === null) return false;

    if (budget.max_wall_s !== undefined && wallMs > budget.max_wall_s * 1000) {
      const intent: TerminationIntent = { outcome: 'timed_out', reasonCode: 'timed_out', failureClass: null };
      if (this.setTerminationIntent(attemptId, intent)) {
        await this.teardownAttempt(attemptId, intent, false);
        return true;
      }
    }
    if (
      (budget.max_tokens !== undefined && state.tokensSoFar > budget.max_tokens) ||
      (budget.max_turns !== undefined && state.turnsSoFar > budget.max_turns)
    ) {
      const intent: TerminationIntent = {
        outcome: 'budget_exceeded',
        reasonCode: 'budget_exceeded',
        failureClass: null,
      };
      if (this.setTerminationIntent(attemptId, intent)) {
        await this.teardownAttempt(attemptId, intent, false);
        return true;
      }
    }
    return false;
  }

  /**
   * Idle-timeout check (Requirement 17.6). For a running attempt whose last
   * activity is older than `idleTimeoutMs`, set the `timed_out` intent and tear
   * it down. For a pidless setup-window attempt, apply Rule 2 (skip while the
   * window is open, else tear down with `skipKill=false`).
   */
  async checkIdle(attemptId: string, idleTimeoutMs: number, setupTimeoutMs: number): Promise<boolean> {
    const state = this.running.get(attemptId);
    if (state === undefined) return false;
    const now = this.now();

    if (state.pid === null) {
      // Rule 2: setup window.
      if (now < state.startedAt + setupTimeoutMs) return false;
      const intent: TerminationIntent = { outcome: 'failed', reasonCode: 'spawn_failed', failureClass: 'infra' };
      const end = state.terminationIntent ?? intent;
      await this.teardownAttempt(attemptId, end, false);
      return true;
    }

    if (now - state.lastActivityTs > idleTimeoutMs) {
      const intent: TerminationIntent = { outcome: 'timed_out', reasonCode: 'timed_out', failureClass: null };
      if (this.setTerminationIntent(attemptId, intent)) {
        await this.teardownAttempt(attemptId, intent, false);
        return true;
      }
    }
    return false;
  }

  /**
   * Lease checker (Requirement 4.5). A pidless setup-window attempt is handled
   * by Rule 2; a running attempt whose lease has expired is ended `interrupted`.
   */
  async checkLease(attempt: AttemptRecord, setupTimeoutMs: number): Promise<boolean> {
    if (attempt.state !== 'running') return false;
    const now = this.now();
    if (attempt.pid === null) {
      if (now < attempt.startedAt + setupTimeoutMs) return false;
      const state = this.running.get(attempt.id);
      const intent: TerminationIntent = { outcome: 'failed', reasonCode: 'spawn_failed', failureClass: 'infra' };
      const end = state?.terminationIntent ?? intent;
      await this.teardownAttempt(attempt.id, end, false);
      return true;
    }
    if (attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt < now) {
      await this.teardownAttempt(
        attempt.id,
        { outcome: 'interrupted', reasonCode: 'interrupted', failureClass: 'infra' },
        false
      );
      return true;
    }
    return false;
  }

  /**
   * The single running→ended transition (Requirement 16.10). Idempotent and
   * race-safe via the conditional end-claim UPDATE. NEVER inspects
   * `termination_intent` and never branches on `pid` to decide whether to run —
   * callers make the setup-window deferral decision (Rules 1–2).
   */
  async teardownAttempt(attemptId: string, endState: AttemptEndState, skipKill = false): Promise<void> {
    const attempt = this.db.getAttempt(attemptId);
    if (attempt === null) return;
    const state = this.running.get(attemptId);

    const now = this.now();
    const patch: AttemptEndPatch = {
      outcome: endState.outcome,
      failureClass: endState.failureClass,
      reasonCode: endState.reasonCode,
      reason: endState.reason ?? null,
      blocked: endState.blocked ?? null,
      artifacts: endState.artifacts ?? null,
      usage: endState.usage ?? null,
      agentVersion: attempt.agentVersion,
      model: attempt.model,
      endedAt: now,
    };

    const endEvent: EventInsert = {
      id: this.newId(),
      ts: now,
      type: 'attempt.ended',
      repo: this.repoFor(attempt.taskId),
      taskId: attempt.taskId,
      attemptId,
      data: {
        outcome: endState.outcome,
        reason_code: endState.reasonCode,
        failure_class: endState.failureClass,
        blocked: endState.blocked ?? null,
        artifacts: endState.artifacts ?? null,
        usage: endState.usage ?? null,
      },
    };

    // Step 0 — conditional end-claim (the ONLY running→ended transition).
    const claimed = this.db.endAttemptWithEvent(
      attemptId,
      patch,
      nextTaskStateForOutcome(endState.outcome),
      endEvent
    );
    if (!claimed) {
      // Already ended by a concurrent path — no kill, no worktree, no event.
      this.running.delete(attemptId);
      return;
    }

    // Step 1 — kill the process (skippable).
    const pid = attempt.pid;
    const pgid = attempt.pgid;
    if (!skipKill && pid !== null && pgid !== null) {
      try {
        await this.process.killProcessGroup(pid, pgid);
      } catch (err: unknown) {
        this.log.warn('process kill failed during teardown', {
          attempt_id: attemptId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Step 2 — worktree cleanup, EXCEPT the Requirement 18.4 retention cases.
    const retain =
      endState.reasonCode === 'git_push_failed' ||
      (endState.outcome === 'interrupted' && (state?.allowResume ?? false));
    const worktreePath = state?.worktreePath ?? attempt.worktreePath;
    if (!retain && worktreePath !== null) {
      try {
        await this.worktree.remove(worktreePath);
      } catch (err: unknown) {
        this.log.warn('worktree remove failed during teardown', {
          attempt_id: attemptId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Step 4 — notify the scheduler (frees the slot + drives the breaker).
    const repo = this.repoFor(attempt.taskId);
    if (repo !== null) {
      this.scheduler.onAttemptEnded(repo, endState);
    }

    this.running.delete(attemptId);
  }

  private repoFor(taskId: string): string | null {
    const task = this.db.getTask(taskId);
    return task === null ? null : task.repo;
  }

  /**
   * Compute `prompt_hash = sha256(task.spec)` (Requirement 4.1). Exported as a
   * method so start + tests share one implementation.
   */
  static promptHash(spec: string): string {
    return createHash('sha256').update(spec, 'utf8').digest('hex');
  }
}

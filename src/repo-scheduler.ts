/**
 * Repo scheduler and circuit breaker (task-attempt-outcome, tasks 4.1–4.3).
 *
 * Owns per-repo concurrency slots, queue draining, the atomic task claim, and
 * the circuit-breaker state machine. Breaker state is persisted in `repo_state`
 * (reloaded on startup so a paused repo stays paused across restarts); slot
 * occupancy is in-memory and rebuilt from `running` attempts.
 *
 * Pure functions (`breakerTransition`, `statusSnapshot`) are exported for Tier
 * 1 testing; the `RepoScheduler` class composes them with the DB helpers and a
 * caller-supplied attempt starter.
 */
import type { TaskDatabase, EventInsert } from './task-db.js';
import type { Logger } from './log.js';
import { ulid } from './ulid.js';
import {
  type AttemptEndState,
  type BreakerState,
  type ReasonCode,
  type RepoStateRecord,
  type TaskRecord,
} from './task-types.js';

/**
 * The infra reason-code set that feeds the circuit breaker (Requirement 12.5).
 * An attempt ending with one of these reason codes increments the repo's
 * `consecutive_failures` counter — EXCEPT the Requirement 22.8 carve-out where
 * `countsTowardBreaker === false` (a `git_push_failed` whose `ls-remote` itself
 * failed, a transient fault that must not trip the breaker).
 */
export const INFRA_REASON_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'spawn_failed',
  'auth_failed',
  'rate_limited',
  'git_push_failed',
  'adapter_crash',
]);

/** The canonical flat repo-status shape (Requirement 21.2 / HIGH-10). */
export interface RepoStatusSnapshot {
  repo: string;
  circuit_breaker_state: BreakerState;
  consecutive_failures: number;
  paused_until: number | null;
  slots_total: number;
  slots_in_use: number;
}

/** The in-memory + persisted breaker/slot state for a single repo. */
export interface RepoSlotState {
  repo: string;
  inUse: number;
  limit: number;
  breaker: BreakerState;
  consecutiveFailures: number;
  /** When the breaker last opened (unix ms); drives the half-open probe window. */
  pausedAt: number | null;
  /** Optional explicit cooldown deadline (unix ms). */
  pausedUntil: number | null;
  /** Whether a half-open probe is currently in flight (concurrent_probe_limit = 1). */
  probeInFlight: boolean;
}

/** The outcome of a pure `breakerTransition` evaluation. */
export interface BreakerTransitionResult {
  consecutiveFailures: number;
  breaker: BreakerState;
  pausedAt: number | null;
  /** Which (if any) repo lifecycle event this transition should emit. */
  emit: 'paused' | 'resumed' | null;
  /** For a `resumed` emission, who reset the breaker. */
  resetBy: 'api' | 'auto' | null;
}

/**
 * Pure circuit-breaker state transition (Requirement 12.4–12.11, HIGH-11).
 *
 * Given the current breaker state and the ending attempt, compute the next
 * breaker state and whether a `repo.paused`/`repo.resumed` event is warranted.
 * The counter increments ONLY when the end's `reasonCode` is in the infra set
 * AND `countsTowardBreaker !== false` (the Requirement 22.8 ls-remote-null
 * carve-out). A `succeeded` end resets the counter and closes an open/half-open
 * breaker.
 */
export function breakerTransition(
  state: Pick<RepoSlotState, 'breaker' | 'consecutiveFailures' | 'pausedAt'>,
  attemptEnd: AttemptEndState,
  threshold: number,
  now: number
): BreakerTransitionResult {
  // Success resets the counter and closes an open/half-open breaker (Req 12.10).
  if (attemptEnd.outcome === 'succeeded') {
    const wasOpen = state.breaker === 'open' || state.breaker === 'half-open';
    return {
      consecutiveFailures: 0,
      breaker: 'closed',
      pausedAt: null,
      emit: wasOpen ? 'resumed' : null,
      resetBy: wasOpen ? 'auto' : null,
    };
  }

  // Does this end count toward the breaker? Infra reason code AND not the
  // ls-remote-null carve-out (Req 12.5 / 22.8 / H4).
  const counts =
    attemptEnd.reasonCode !== null &&
    INFRA_REASON_CODES.has(attemptEnd.reasonCode) &&
    attemptEnd.countsTowardBreaker !== false;

  if (!counts) {
    // Non-counting outcome: leave the breaker and counter unchanged.
    return {
      consecutiveFailures: state.consecutiveFailures,
      breaker: state.breaker,
      pausedAt: state.pausedAt,
      emit: null,
      resetBy: null,
    };
  }

  const nextFailures = state.consecutiveFailures + 1;

  if (state.breaker === 'half-open') {
    // A failed probe returns the breaker to open and resets pausedAt (Req 12.11).
    return {
      consecutiveFailures: nextFailures,
      breaker: 'open',
      pausedAt: now,
      emit: null,
      resetBy: null,
    };
  }

  if (state.breaker === 'open') {
    // Already open — idempotent; just track the counter.
    return {
      consecutiveFailures: nextFailures,
      breaker: 'open',
      pausedAt: state.pausedAt,
      emit: null,
      resetBy: null,
    };
  }

  // Closed: open the breaker when the counter reaches the threshold (Req 12.4).
  if (nextFailures >= threshold) {
    return {
      consecutiveFailures: nextFailures,
      breaker: 'open',
      pausedAt: now,
      emit: 'paused',
      resetBy: null,
    };
  }

  return {
    consecutiveFailures: nextFailures,
    breaker: 'closed',
    pausedAt: state.pausedAt,
    emit: null,
    resetBy: null,
  };
}

/** Pure projection of a repo's slot/breaker state to the flat status shape. */
export function statusSnapshot(state: RepoSlotState): RepoStatusSnapshot {
  return {
    repo: state.repo,
    circuit_breaker_state: state.breaker,
    consecutive_failures: state.consecutiveFailures,
    paused_until: state.pausedUntil,
    slots_total: state.limit,
    slots_in_use: state.inUse,
  };
}

// ---------------------------------------------------------------------------
// RepoScheduler
// ---------------------------------------------------------------------------

/** Per-repo config knobs resolved from `RepoConfig` (Requirement 12.1/12.4/12.11). */
export interface RepoSchedulerConfig {
  /** Concurrent running attempts per repo (default 1). */
  concurrency?: number;
  /** Consecutive infra failures that open the breaker (default 3). */
  failureThreshold?: number;
  /** Seconds before an open breaker may half-open for a probe (default 3600). */
  timeoutSeconds?: number;
}

/**
 * Starts an attempt for a claimed task. Supplied by the attempt-runner wiring;
 * the scheduler calls it once it decides a task may run. The starter is
 * responsible for the atomic claim + attempt-row creation (via
 * `startAttemptWithEvent`); it returns `true` if an attempt was started, or
 * `false` if the claim did not land (so the scheduler releases the slot).
 */
export type AttemptStarter = (task: TaskRecord) => Promise<boolean>;

export interface RepoSchedulerDeps {
  db: TaskDatabase;
  log: Logger;
  startAttempt: AttemptStarter;
  /** Resolve per-repo config; defaults applied when a field is absent. */
  configFor?: (repo: string) => RepoSchedulerConfig | undefined;
  now?: () => number;
  newId?: () => string;
}

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_TIMEOUT_SECONDS = 3600;

export class RepoScheduler {
  private readonly db: TaskDatabase;
  private readonly log: Logger;
  private readonly startAttempt: AttemptStarter;
  private readonly configFor: (repo: string) => RepoSchedulerConfig | undefined;
  private readonly now: () => number;
  private readonly newId: () => string;

  /** In-memory per-repo state keyed by `owner/name`. */
  private readonly repos = new Map<string, RepoSlotState>();
  /** FIFO queue of pending tasks per repo. */
  private readonly queues = new Map<string, TaskRecord[]>();
  /** Task ids currently being dispatched (within-cycle double-dispatch guard). */
  private readonly claiming = new Set<string>();

  constructor(deps: RepoSchedulerDeps) {
    this.db = deps.db;
    this.log = deps.log;
    this.startAttempt = deps.startAttempt;
    this.configFor = deps.configFor ?? (() => undefined);
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => ulid());
    this.restoreFromDb();
  }

  /** Load persisted breaker state so a repo paused before a restart stays paused. */
  private restoreFromDb(): void {
    const states = this.db.listRepoStates();
    for (const s of states) {
      this.repos.set(s.repo, this.slotStateFromRecord(s));
    }
    // Rebuild slot occupancy from running attempts.
    for (const attempt of this.db.findRunningAttempts()) {
      const task = this.db.getTask(attempt.taskId);
      if (task === null) continue;
      const slot = this.ensureRepo(task.repo);
      slot.inUse += 1;
    }
  }

  private slotStateFromRecord(s: RepoStateRecord): RepoSlotState {
    const cfg = this.configFor(s.repo);
    return {
      repo: s.repo,
      inUse: 0,
      limit: cfg?.concurrency ?? DEFAULT_CONCURRENCY,
      breaker: s.breaker,
      consecutiveFailures: s.consecutiveFailures,
      pausedAt: s.pausedAt,
      pausedUntil: s.pausedUntil,
      probeInFlight: false,
    };
  }

  private ensureRepo(repo: string): RepoSlotState {
    let slot = this.repos.get(repo);
    if (slot === undefined) {
      const cfg = this.configFor(repo);
      slot = {
        repo,
        inUse: 0,
        limit: cfg?.concurrency ?? DEFAULT_CONCURRENCY,
        breaker: 'closed',
        consecutiveFailures: 0,
        pausedAt: null,
        pausedUntil: null,
        probeInFlight: false,
      };
      this.repos.set(repo, slot);
    }
    return slot;
  }

  private thresholdFor(repo: string): number {
    return this.configFor(repo)?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  }

  private timeoutMsFor(repo: string): number {
    return (this.configFor(repo)?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  /** Enqueue a task for its repo and attempt to drain (Requirement 12.2). */
  enqueue(task: TaskRecord): void {
    const queue = this.queues.get(task.repo) ?? [];
    queue.push(task);
    this.queues.set(task.repo, queue);
    void this.drain(task.repo);
  }

  /**
   * Try to start as many queued tasks for a repo as slots and the breaker
   * allow. A half-open breaker admits exactly one probe attempt.
   */
  async drain(repo: string): Promise<void> {
    const slot = this.ensureRepo(repo);
    const queue = this.queues.get(repo);
    if (queue === undefined || queue.length === 0) return;

    // Time-based probe: an open breaker may half-open after the timeout (Req 12.11).
    this.maybeHalfOpen(slot);

    while (queue.length > 0) {
      if (slot.breaker === 'open') break;
      if (slot.breaker === 'half-open') {
        // Admit exactly one probe while half-open.
        if (slot.probeInFlight || slot.inUse > 0) break;
      }
      if (slot.inUse >= slot.limit) break;

      const task = queue[0]!;
      if (this.claiming.has(task.id)) {
        // Already dispatching this task in another drain pass — stop to avoid
        // double-dispatch within one cycle.
        break;
      }

      // Reserve the slot optimistically; release it if the claim fails.
      queue.shift();
      this.claiming.add(task.id);
      slot.inUse += 1;
      if (slot.breaker === 'half-open') slot.probeInFlight = true;

      let started = false;
      try {
        started = await this.startAttempt(task);
      } catch (err: unknown) {
        this.log.warn('attempt starter threw', {
          repo,
          task_id: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.claiming.delete(task.id);
      }

      if (!started) {
        // Claim did not land (task not queued / cancelled): release the slot.
        slot.inUse -= 1;
        if (slot.breaker === 'half-open') slot.probeInFlight = false;
      }
    }

    if (queue.length === 0) this.queues.delete(repo);
  }

  /** Move an open breaker to half-open once the probe window has elapsed. */
  private maybeHalfOpen(slot: RepoSlotState): void {
    if (slot.breaker !== 'open' || slot.pausedAt === null) return;
    const elapsed = this.now() - slot.pausedAt;
    if (elapsed >= this.timeoutMsFor(slot.repo)) {
      slot.breaker = 'half-open';
      slot.probeInFlight = false;
    }
  }

  /**
   * Called by `teardownAttempt` when an attempt ends (Requirement 12.5/12.9).
   * Frees the repo slot, drives the breaker transition, persists breaker state,
   * and drains the queue.
   */
  onAttemptEnded(repo: string, endState: AttemptEndState): void {
    const slot = this.ensureRepo(repo);
    if (slot.inUse > 0) slot.inUse -= 1;
    if (slot.breaker === 'half-open') slot.probeInFlight = false;

    const now = this.now();
    const result = breakerTransition(
      { breaker: slot.breaker, consecutiveFailures: slot.consecutiveFailures, pausedAt: slot.pausedAt },
      endState,
      this.thresholdFor(repo),
      now
    );

    const changed =
      result.breaker !== slot.breaker ||
      result.consecutiveFailures !== slot.consecutiveFailures ||
      result.pausedAt !== slot.pausedAt;

    slot.breaker = result.breaker;
    slot.consecutiveFailures = result.consecutiveFailures;
    slot.pausedAt = result.pausedAt;
    if (result.breaker !== 'open') slot.pausedUntil = null;

    if (changed) {
      let event: EventInsert | undefined;
      if (result.emit === 'paused') {
        event = {
          id: this.newId(),
          ts: now,
          type: 'repo.paused',
          repo,
          taskId: null,
          attemptId: null,
          data: { reason: 'consecutive_failures', consecutive_failures: result.consecutiveFailures },
        };
      } else if (result.emit === 'resumed') {
        event = {
          id: this.newId(),
          ts: now,
          type: 'repo.resumed',
          repo,
          taskId: null,
          attemptId: null,
          data: { reset_by: result.resetBy ?? 'auto', reason: 'success' },
        };
      }
      this.db.setRepoStateWithEvent(
        repo,
        {
          consecutiveFailures: result.consecutiveFailures,
          breaker: result.breaker,
          pausedAt: result.pausedAt,
          pausedUntil: slot.pausedUntil,
          updatedAt: now,
        },
        event
      );
    }

    void this.drain(repo);
  }

  /**
   * Reset a repo's breaker to closed and emit `repo.resumed` (Requirement 12.7).
   * `by` is `'api'` for the reset endpoint or `'auto'` for a cooldown.
   */
  resetBreaker(repo: string, by: 'api' | 'auto'): void {
    const slot = this.ensureRepo(repo);
    const now = this.now();
    slot.breaker = 'closed';
    slot.consecutiveFailures = 0;
    slot.pausedAt = null;
    slot.pausedUntil = null;
    slot.probeInFlight = false;
    this.db.setRepoStateWithEvent(
      repo,
      { consecutiveFailures: 0, breaker: 'closed', pausedAt: null, pausedUntil: null, updatedAt: now },
      {
        id: this.newId(),
        ts: now,
        type: 'repo.resumed',
        repo,
        taskId: null,
        attemptId: null,
        data: { reset_by: by, reason: by === 'api' ? 'manual reset' : 'cooldown' },
      }
    );
    void this.drain(repo);
  }

  /** Status snapshot for `GET /v1/repos/:owner/:name/status` (Requirement 12.3). */
  status(repo: string): RepoStatusSnapshot {
    return statusSnapshot(this.ensureRepo(repo));
  }

  /** Status snapshots for every repo the scheduler knows about. */
  statusAll(): RepoStatusSnapshot[] {
    return [...this.repos.values()].map(statusSnapshot);
  }
}

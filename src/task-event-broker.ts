/**
 * Task event broker + SSE helpers (task-attempt-outcome, tasks 7.1–7.3).
 *
 * The backing store is the `task_events` table (ordered by `seq`). Pure helpers
 * (`resolveSince`, `envelopeFromRow`) are exported for Tier 1 testing; the
 * `TaskEventBroker` fans events out to SSE subscribers with replay-by-seq and a
 * strictly-increasing per-client cursor, mirroring the proven `sse-broker.ts`
 * replay model but reading from the DB rather than a file.
 */
import type { TaskDatabase } from './task-db.js';
import type { TaskEventRecord, TaskRecord } from './task-types.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The serialized `/v1/` event envelope (Requirement 8.2). */
export interface V1EventEnvelope {
  v: 1;
  seq: number;
  id: string;
  ts: string; // ISO 8601
  type: string;
  repo: string | null;
  task_id: string | null;
  attempt_id: string | null;
  external_id: string | null;
  metadata: unknown;
  data: unknown;
}

export type ResolveSinceResult = { valid: true; since: number } | { valid: false };

/**
 * Resolve the replay cursor from `?since` and the `Last-Event-ID` header, using
 * the larger of the two (Requirement 9.3). Both must be non-negative integers
 * when present; a non-integer value is rejected (Requirement 9.6). When neither
 * is present the cursor is 0 (replay from the beginning / live only).
 */
export function resolveSince(
  sinceParam: string | undefined,
  lastEventIdHeader: string | undefined
): ResolveSinceResult {
  let since = 0;
  let present = false;

  if (sinceParam !== undefined && sinceParam !== '') {
    const n = parseIntStrict(sinceParam);
    if (n === null || n < 0) return { valid: false };
    since = Math.max(since, n);
    present = true;
  }
  if (lastEventIdHeader !== undefined && lastEventIdHeader !== '') {
    const n = parseIntStrict(lastEventIdHeader);
    if (n === null || n < 0) return { valid: false };
    since = Math.max(since, n);
    present = true;
  }
  // No cursor supplied is valid (since = 0).
  void present;
  return { valid: true, since };
}

/** Parse a strictly-integer string (no floats, no trailing junk). */
function parseIntStrict(raw: string): number | null {
  if (!/^-?\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Build the serialized envelope for an event row (Requirement 8.2–8.4). The
 * task supplies `external_id` and `metadata`; both are `null` when the event
 * belongs to no task or the task has none.
 */
export function envelopeFromRow(
  row: TaskEventRecord,
  task: Pick<TaskRecord, 'externalId' | 'metadata'> | null
): V1EventEnvelope {
  return {
    v: 1,
    seq: row.seq,
    id: row.id,
    ts: new Date(row.ts).toISOString(),
    type: row.type,
    repo: row.repo,
    task_id: row.taskId,
    attempt_id: row.attemptId,
    external_id: task?.externalId ?? null,
    metadata: task?.metadata ?? null,
    data: row.data,
  };
}

// ---------------------------------------------------------------------------
// TaskEventBroker
// ---------------------------------------------------------------------------

/** A subscriber receives serialized envelopes in strictly increasing `seq`. */
export interface EventSubscriber {
  send(envelope: V1EventEnvelope): void;
  /** Optional heartbeat/comment line to keep the connection open. */
  heartbeat?(): void;
}

interface Subscription {
  subscriber: EventSubscriber;
  /** Highest `seq` delivered to this client (strictly-increasing dedup). */
  cursor: number;
}

export interface TaskEventBrokerDeps {
  db: TaskDatabase;
  /** Replay page size (default 500). */
  batchSize?: number;
  /** Heartbeat interval in ms (default 15000); 0 disables. */
  heartbeatMs?: number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export class TaskEventBroker {
  private readonly db: TaskDatabase;
  private readonly batchSize: number;
  private readonly heartbeatMs: number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  private readonly subscriptions = new Set<Subscription>();
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;

  constructor(deps: TaskEventBrokerDeps) {
    this.db = deps.db;
    this.batchSize = deps.batchSize ?? 500;
    this.heartbeatMs = deps.heartbeatMs ?? 15_000;
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h));
  }

  /** Look up a task's envelope fields for an event row. */
  private taskFor(taskId: string | null): Pick<TaskRecord, 'externalId' | 'metadata'> | null {
    if (taskId === null) return null;
    return this.db.getTask(taskId);
  }

  /**
   * Emit an event to all subscribers after it has been committed. Called by the
   * daemon's DB-write paths. Each subscriber receives it only if its `seq` is
   * strictly greater than the subscriber's cursor (dedup, Requirement 9.4).
   */
  emit(event: TaskEventRecord): void {
    const envelope = envelopeFromRow(event, this.taskFor(event.taskId));
    for (const sub of this.subscriptions) {
      if (event.seq > sub.cursor) {
        sub.subscriber.send(envelope);
        sub.cursor = event.seq;
      }
    }
  }

  /**
   * Subscribe a client, first replaying all events with `seq > since` from the
   * DB (Requirement 9.2/9.3) in pages, then switching to live delivery. Returns
   * an unsubscribe function.
   */
  subscribe(subscriber: EventSubscriber, since: number): () => void {
    const sub: Subscription = { subscriber, cursor: since };
    // Replay from the DB up to the current max, in pages.
    let cursor = since;
    for (;;) {
      const rows = this.db.getEventsSince(cursor, this.batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (row.seq > sub.cursor) {
          subscriber.send(envelopeFromRow(row, this.taskFor(row.taskId)));
          sub.cursor = row.seq;
        }
        cursor = row.seq;
      }
      if (rows.length < this.batchSize) break;
    }
    this.subscriptions.add(sub);
    this.ensureHeartbeat();
    return () => {
      this.subscriptions.delete(sub);
      if (this.subscriptions.size === 0) this.stopHeartbeat();
    };
  }

  /** Number of active subscribers (for tests/diagnostics). */
  subscriberCount(): number {
    return this.subscriptions.size;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.heartbeatHandle !== null) return;
    this.heartbeatHandle = this.setIntervalFn(() => {
      for (const sub of this.subscriptions) {
        sub.subscriber.heartbeat?.();
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.clearIntervalFn(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  /** Tear down the broker (stop the heartbeat, drop subscribers). */
  shutdown(): void {
    this.stopHeartbeat();
    this.subscriptions.clear();
  }
}

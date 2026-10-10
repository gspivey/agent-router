/**
 * Versioned `/v1/` REST + SSE API (task-attempt-outcome, tasks 10.1–10.3).
 *
 * `createV1Routes(deps)` returns a `Hono<WebEnv>` mounting every `/v1/` endpoint.
 * Pure serializers and validators are exported individually for Tier 1 testing
 * (timestamps rendered ISO 8601, every success body carries `"v": 1`). The
 * route factory composes them with the task service, scheduler, event broker,
 * attempt runner, and transcript retention — all injected so the surface is
 * testable against fake backends.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthResult } from './web-auth.js';
import type { Logger } from './log.js';
import type { TaskService } from './task-service.js';
import { validateTaskState, validateSubmitBody } from './task-service.js';
import type { RepoScheduler, RepoStatusSnapshot } from './repo-scheduler.js';
import type { TaskEventBroker, V1EventEnvelope, EventSubscriber } from './task-event-broker.js';
import { resolveSince } from './task-event-broker.js';
import type { TaskDatabase } from './task-db.js';
import type { AttemptRunner } from './attempt-runner.js';
import { classifyRetentionPhase, readTranscript } from './transcript-retention.js';
import type {
  AttemptRecord,
  TaskRecord,
  TaskState,
} from './task-types.js';
import * as path from 'node:path';

type WebEnv = { Variables: { auth: AuthResult } };

function errorEnvelope(
  code: string,
  message: string,
  details?: unknown
): { error: { code: string; message: string; details?: unknown } } {
  const error: { code: string; message: string; details?: unknown } = { code, message };
  if (details !== undefined) error.details = details;
  return { error };
}

// ---------------------------------------------------------------------------
// Pure serializers (Requirement 2.7 — all timestamps ISO 8601)
// ---------------------------------------------------------------------------

/** ISO 8601 string for a unix-ms timestamp, or null when absent. */
function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** The serialized `/v1/` task shape. */
export interface SerializedTask {
  id: string;
  external_id: string | null;
  repo: string;
  source: string;
  source_ref: string | null;
  title: string;
  spec: string;
  base_ref: string | null;
  agent: string;
  budget: unknown;
  metadata: unknown;
  state: TaskState;
  created_at: string;
  updated_at: string;
}

/** Serialize a task record (Requirement 2.1/2.7). */
export function serializeTask(task: TaskRecord): SerializedTask {
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
    budget: task.budget,
    metadata: task.metadata ?? null,
    state: task.state,
    created_at: new Date(task.createdAt).toISOString(),
    updated_at: new Date(task.updatedAt).toISOString(),
  };
}

/** The serialized `/v1/` attempt shape (Requirement 10.1). */
export interface SerializedAttempt {
  id: string;
  task_id: string;
  attempt_no: number;
  session_id: string | null;
  state: string;
  outcome: string | null;
  failure_class: string | null;
  reason_code: string | null;
  reason: string | null;
  blocked: { question: string; needs: string } | null;
  artifacts: unknown;
  usage: unknown;
  agent_version: string | null;
  model: string | null;
  /** Convenience top-level mirror of `artifacts.pr_url` (Requirement 10.1 / HIGH-4). */
  pr_url: string | null;
  worktree_branch: string | null;
  started_at: string;
  ended_at: string | null;
}

/** Serialize an attempt record (Requirement 10.1). */
export function serializeAttempt(attempt: AttemptRecord): SerializedAttempt {
  const prUrl = attempt.artifacts?.pr_url ?? null;
  return {
    id: attempt.id,
    task_id: attempt.taskId,
    attempt_no: attempt.attemptNo,
    session_id: attempt.sessionId,
    state: attempt.state,
    outcome: attempt.outcome,
    failure_class: attempt.failureClass,
    reason_code: attempt.reasonCode,
    reason: attempt.reason,
    blocked: attempt.blocked,
    artifacts: attempt.artifacts,
    usage: attempt.usage,
    agent_version: attempt.agentVersion,
    model: attempt.model,
    pr_url: prUrl,
    worktree_branch: attempt.worktreeBranch,
    started_at: new Date(attempt.startedAt).toISOString(),
    ended_at: iso(attempt.endedAt),
  };
}

/** A latest-attempt summary for `GET /v1/tasks/:id` (Requirement 2.1). */
export function serializeAttemptSummary(attempt: AttemptRecord | null): SerializedAttempt | null {
  return attempt === null ? null : serializeAttempt(attempt);
}

/** Serialize an SSE event envelope (already ISO-8601 by the broker). */
export function serializeEventEnvelope(env: V1EventEnvelope): V1EventEnvelope {
  return env;
}

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

export type TaskStateParamResult =
  | { valid: true; state: TaskState }
  | { valid: false };

/** Validate a `?state=` query param against the task-state union (Requirement 2.5). */
export function validateTaskStateParam(raw: string): TaskStateParamResult {
  if (validateTaskState(raw)) return { valid: true, state: raw };
  return { valid: false };
}

export type SinceParamResult = { valid: true; since: number } | { valid: false };

/** Validate `?since=` as a non-negative integer (Requirement 9.6). */
export function validateSinceParam(raw: string | undefined): SinceParamResult {
  if (raw === undefined || raw === '') return { valid: true, since: 0 };
  if (!/^\d+$/.test(raw.trim())) return { valid: false };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return { valid: false };
  return { valid: true, since: n };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface V1RouteDeps {
  taskService: TaskService;
  scheduler: RepoScheduler;
  eventBroker: TaskEventBroker;
  db: TaskDatabase;
  /** Attempt runner for the running-attempt cancel teardown (Rule 1 caller). */
  attemptRunner: AttemptRunner;
  configuredRepos: ReadonlySet<string>;
  log: Logger;
  /** Session root (`<root>/sessions/<id>/stream.log`) for transcript fallback. */
  rootDir: string;
  /** active→archived grace (ms) and archived→deleted TTL (ms) for retention. */
  transcript: { graceMs: number; ttlMs: number };
  shuttingDown: () => boolean;
  now?: () => number;
}

/** Resolve the transcript file for an attempt (artifacts.transcript_ref or the session stream.log). */
function transcriptRefFor(attempt: AttemptRecord, rootDir: string): string | null {
  const ref = attempt.artifacts?.transcript_ref;
  if (ref !== undefined && ref !== null) return ref;
  if (attempt.sessionId !== null) {
    return path.join(rootDir, 'sessions', attempt.sessionId, 'stream.log');
  }
  return null;
}

export function createV1Routes(deps: V1RouteDeps): Hono<WebEnv> {
  const {
    taskService,
    scheduler,
    eventBroker,
    db,
    attemptRunner,
    configuredRepos,
    log,
    rootDir,
    transcript,
    shuttingDown,
  } = deps;
  const now = deps.now ?? (() => Date.now());

  const app = new Hono<WebEnv>();

  // --- POST /v1/tasks (submit, idempotent) — Requirement 1 ---
  app.post('/tasks', async (c) => {
    if (shuttingDown()) {
      return c.json(errorEnvelope('shutting_down', 'Server is shutting down'), 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorEnvelope('invalid_body', 'request body must be valid JSON'), 400);
    }
    const validation = validateSubmitBody(body, configuredRepos);
    if (!validation.valid) {
      return c.json(errorEnvelope(validation.code, validation.message), 400);
    }
    const { task, created } = taskService.submitTask(validation.value);
    const status = created ? 201 : 200;
    return c.json({ v: 1, task: serializeTask(task) }, status);
  });

  // --- GET /v1/tasks (list) — Requirement 2.3–2.6 ---
  app.get('/tasks', (c) => {
    const repo = c.req.query('repo');
    const stateParam = c.req.query('state');
    const filter: { repo?: string; state?: TaskState } = {};
    if (repo !== undefined) filter.repo = repo;
    if (stateParam !== undefined) {
      const parsed = validateTaskStateParam(stateParam);
      if (!parsed.valid) {
        return c.json(errorEnvelope('invalid_param', `invalid state "${stateParam}"`), 400);
      }
      filter.state = parsed.state;
    }
    const tasks = taskService.listTasks(filter);
    return c.json({ v: 1, tasks: tasks.map(serializeTask) });
  });

  // --- GET /v1/tasks/:id (task + latest-attempt summary) — Requirement 2.1/2.2 ---
  app.get('/tasks/:id', (c) => {
    const id = c.req.param('id');
    const found = taskService.getTask(id);
    if (found === null) {
      return c.json(errorEnvelope('not_found', `task "${id}" not found`), 404);
    }
    return c.json({
      v: 1,
      task: serializeTask(found.task),
      latest_attempt: serializeAttemptSummary(found.latestAttempt),
    });
  });

  // --- GET /v1/tasks/:id/attempts (list attempts) — Requirement 21.1 ---
  app.get('/tasks/:id/attempts', (c) => {
    const id = c.req.param('id');
    if (db.getTask(id) === null) {
      return c.json(errorEnvelope('not_found', `task "${id}" not found`), 404);
    }
    const attempts = db.getAttemptsForTask(id);
    return c.json({ v: 1, attempts: attempts.map(serializeAttempt) });
  });

  // --- POST /v1/tasks/:id/attempts (retry) — Requirement 5.1–5.3 ---
  app.post('/tasks/:id/attempts', (c) => {
    if (shuttingDown()) {
      return c.json(errorEnvelope('shutting_down', 'Server is shutting down'), 503);
    }
    const id = c.req.param('id');
    if (db.getTask(id) === null) {
      return c.json(errorEnvelope('not_found', `task "${id}" not found`), 404);
    }
    const result = taskService.retryTask(id);
    if (!result.ok) {
      return c.json(errorEnvelope(result.code, result.message), 409);
    }
    return c.json({ v: 1, task: serializeTask(result.task) }, 202);
  });

  // --- POST /v1/tasks/:id/cancel — Requirement 5.4–5.7 ---
  app.post('/tasks/:id/cancel', async (c) => {
    if (shuttingDown()) {
      return c.json(errorEnvelope('shutting_down', 'Server is shutting down'), 503);
    }
    const id = c.req.param('id');
    const task = db.getTask(id);
    if (task === null) {
      return c.json(errorEnvelope('not_found', `task "${id}" not found`), 404);
    }
    // Running-attempt teardown (Rule 1 caller): request termination FIRST so the
    // running process is torn down before we transition the task to cancelled.
    const latest = db.getLatestAttempt(id);
    if (latest !== null && latest.state === 'running') {
      try {
        await attemptRunner.requestTermination(latest.id, {
          outcome: 'cancelled',
          reasonCode: 'cancelled_by_api',
          failureClass: null,
        });
      } catch (err: unknown) {
        log.warn('cancel teardown failed', {
          task_id: id,
          attempt_id: latest.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const result = taskService.cancelTask(id);
    if (!result.ok) {
      return c.json(errorEnvelope(result.code, result.message), 409);
    }
    return c.json({ v: 1, task: serializeTask(result.task) }, 200);
  });

  // --- GET /v1/attempts/:id (detail) — Requirement 10.1/10.2 ---
  app.get('/attempts/:id', (c) => {
    const id = c.req.param('id');
    const attempt = db.getAttempt(id);
    if (attempt === null) {
      return c.json(errorEnvelope('not_found', `attempt "${id}" not found`), 404);
    }
    return c.json({ v: 1, attempt: serializeAttempt(attempt) });
  });

  // --- GET /v1/attempts/:id/transcript — Requirement 10.3–10.5 / 21.3 ---
  app.get('/attempts/:id/transcript', (c) => {
    const id = c.req.param('id');
    const attempt = db.getAttempt(id);
    if (attempt === null) {
      return c.json(errorEnvelope('not_found', `attempt "${id}" not found`), 404);
    }

    // Deleted phase → 404 (Requirement 10.5).
    const phase = classifyRetentionPhase(now(), attempt.endedAt, transcript.graceMs, transcript.ttlMs);
    if (phase === 'deleted') {
      return c.json(errorEnvelope('not_found', 'transcript has been deleted'), 404);
    }

    const ref = transcriptRefFor(attempt, rootDir);
    if (ref === null) {
      return c.json(errorEnvelope('not_found', 'transcript not available'), 404);
    }

    const accept = c.req.header('accept') ?? '';
    const wantsSSE = accept.includes('text/event-stream');

    if (wantsSSE) {
      return streamTranscriptSSE(c, ref);
    }

    // Full transcript as text/plain (raw or zstd-decompressed) — Requirement 21.3.
    const stream = readTranscript(ref);
    if (stream === null) {
      return c.json(errorEnvelope('not_found', 'transcript not available'), 404);
    }
    return new Response(nodeStreamToWeb(stream), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  });

  // --- GET /v1/events (SSE with replay) — Requirement 9 ---
  app.get('/events', (c) => {
    const sinceParam = c.req.query('since');
    const parsed = validateSinceParam(sinceParam);
    if (!parsed.valid) {
      return c.json(errorEnvelope('invalid_param', 'since must be a non-negative integer'), 400);
    }
    const lastEventId = c.req.header('last-event-id');
    const resolved = resolveSince(sinceParam, lastEventId);
    if (!resolved.valid) {
      return c.json(errorEnvelope('invalid_param', 'invalid Last-Event-ID / since'), 400);
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Initial flush so proxies open the stream promptly.
    writer.write(encoder.encode(':ok\nretry: 1000\n\n')).catch(() => {});

    const subscriber: EventSubscriber = {
      send(env: V1EventEnvelope): void {
        const frame = `id: ${env.seq}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
        writer.write(encoder.encode(frame)).catch(() => {});
      },
      heartbeat(): void {
        writer.write(encoder.encode(':heartbeat\n\n')).catch(() => {});
      },
    };

    const unsubscribe = eventBroker.subscribe(subscriber, resolved.since);

    c.req.raw.signal.addEventListener('abort', () => {
      unsubscribe();
      writer.close().catch(() => {});
    });

    return new Response(readable as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
    });
  });

  // --- GET /v1/repos (list repos + status) — Requirement 21.2 ---
  app.get('/repos', (c) => {
    const repos: RepoStatusSnapshot[] = [];
    for (const repo of configuredRepos) {
      repos.push(scheduler.status(repo));
    }
    return c.json({ v: 1, repos });
  });

  // --- GET /v1/repos/:owner/:name/status — Requirement 12.3 ---
  app.get('/repos/:owner/:name/status', (c) => {
    const repo = `${c.req.param('owner')}/${c.req.param('name')}`;
    if (!configuredRepos.has(repo)) {
      return c.json(errorEnvelope('not_found', `repo "${repo}" is not configured`), 404);
    }
    return c.json({ v: 1, ...scheduler.status(repo) });
  });

  // --- POST /v1/repos/:owner/:name/circuit-breaker/reset — Requirement 12.7 ---
  app.post('/repos/:owner/:name/circuit-breaker/reset', (c) => {
    if (shuttingDown()) {
      return c.json(errorEnvelope('shutting_down', 'Server is shutting down'), 503);
    }
    const repo = `${c.req.param('owner')}/${c.req.param('name')}`;
    if (!configuredRepos.has(repo)) {
      return c.json(errorEnvelope('not_found', `repo "${repo}" is not configured`), 404);
    }
    scheduler.resetBreaker(repo, 'api');
    return c.json({ v: 1, ...scheduler.status(repo) }, 200);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Transcript SSE tail (Requirement 21.3)
// ---------------------------------------------------------------------------

/** Stream a transcript's full content as SSE data lines, then close. */
function streamTranscriptSSE(c: Context<WebEnv>, ref: string): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  writer.write(encoder.encode(':ok\nretry: 1000\n\n')).catch(() => {});

  const stream = readTranscript(ref);
  if (stream === null) {
    writer.write(encoder.encode('event: error\ndata: transcript not available\n\n')).catch(() => {});
    writer.close().catch(() => {});
  } else {
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        writer.write(encoder.encode(`data: ${line}\n\n`)).catch(() => {});
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) {
        writer.write(encoder.encode(`data: ${buffer}\n\n`)).catch(() => {});
      }
      writer.close().catch(() => {});
    });
    stream.on('error', () => {
      writer.close().catch(() => {});
    });
  }

  c.req.raw.signal.addEventListener('abort', () => {
    stream?.destroy();
    writer.close().catch(() => {});
  });

  return new Response(readable as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}

/** Adapt a Node Readable to a web ReadableStream for the Hono/undici Response. */
function nodeStreamToWeb(stream: import('node:stream').Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
      });
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

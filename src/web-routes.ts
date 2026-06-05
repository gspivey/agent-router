import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionManager } from './session-mgr.js';
import type { SessionFiles, SessionMeta } from './session-files.js';
import type { SSEBroker } from './sse-broker.js';
import type { Logger } from './log.js';
import type { AuthResult } from './web-auth.js';

type WebEnv = { Variables: { auth: AuthResult } };

function errorEnvelope(code: string, message: string, details?: unknown): { error: { code: string; message: string; details?: unknown } } {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

// --- Pure helpers (exported for testing) ---

const VALID_STATUSES = new Set(['active', 'completed', 'abandoned', 'failed']);

export function validateStatus(value: string): value is SessionMeta['status'] {
  return VALID_STATUSES.has(value);
}

export function validateSince(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function validateLimit(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 500) return null;
  return n;
}

export function validateLines(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 2000) return null;
  return n;
}

export function validatePrompt(body: unknown): { valid: true; prompt: string } | { valid: false; reason: string } {
  if (body === null || typeof body !== 'object') {
    return { valid: false, reason: 'Request body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;
  if (!('prompt' in obj) || typeof obj['prompt'] !== 'string') {
    return { valid: false, reason: 'Missing or invalid "prompt" field' };
  }
  const trimmed = obj['prompt'].trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'Prompt must not be empty or whitespace-only' };
  }
  if (trimmed.length > 10000) {
    return { valid: false, reason: 'Prompt exceeds maximum length of 10000 characters' };
  }
  return { valid: true, prompt: trimmed };
}

export interface SessionSummary {
  session_id: string;
  repo: string | null;
  status: SessionMeta['status'];
  created_at: number;
  completed_at: number | null;
  termination_reason: string | null;
  prs: Array<{ repo: string; pr_number: number; registered_at: number }>;
}

export function metaToSummary(meta: SessionMeta): SessionSummary {
  return {
    session_id: meta.session_id,
    repo: meta.repo ?? null,
    status: meta.status,
    created_at: meta.created_at,
    completed_at: meta.completed_at,
    termination_reason: meta.termination_reason ?? null,
    prs: meta.prs,
  };
}

export function filterSessions(
  sessions: SessionMeta[],
  status: SessionMeta['status'] | undefined,
  since: number | undefined,
  limit: number,
): SessionSummary[] {
  let filtered = sessions;
  if (status !== undefined) {
    filtered = filtered.filter(s => s.status === status);
  }
  if (since !== undefined) {
    filtered = filtered.filter(s => s.created_at >= since);
  }
  return filtered.slice(0, limit).map(metaToSummary);
}

export function tailStreamLog(
  streamPath: string,
  lines: number,
): { entries: unknown[]; skipped_lines: number } {
  let content: string;
  try {
    content = fs.readFileSync(streamPath, 'utf-8');
  } catch {
    return { entries: [], skipped_lines: 0 };
  }

  if (content.length === 0) {
    return { entries: [], skipped_lines: 0 };
  }

  const rawLines = content.split('\n').filter(l => l.length > 0);
  const tail = rawLines.slice(-lines);
  const entries: unknown[] = [];
  let skipped = 0;

  for (const line of tail) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }

  return { entries, skipped_lines: skipped };
}

// --- Route factory ---

export function createWebRoutes(deps: {
  sessionMgr: SessionManager;
  sessionFiles: SessionFiles;
  sseBroker: SSEBroker;
  rootDir: string;
  log: Logger;
  shuttingDown: () => boolean;
}): Hono<WebEnv> {
  const { sessionMgr, sessionFiles, sseBroker, rootDir, log, shuttingDown } = deps;
  const app = new Hono<WebEnv>();

  // GET /sessions
  app.get('/sessions', (c) => {
    const statusParam = c.req.query('status');
    const sinceParam = c.req.query('since');
    const limitParam = c.req.query('limit');

    let status: SessionMeta['status'] | undefined;
    if (statusParam !== undefined) {
      if (!validateStatus(statusParam)) {
        return c.json(errorEnvelope('invalid_param', 'Invalid status value', { param: 'status', constraint: 'must be one of: active, completed, abandoned, failed' }), 400);
      }
      status = statusParam;
    }

    let since: number | undefined;
    if (sinceParam !== undefined) {
      const parsed = validateSince(sinceParam);
      if (parsed === null) {
        return c.json(errorEnvelope('invalid_param', 'Invalid since value', { param: 'since', constraint: 'must be a non-negative integer' }), 400);
      }
      since = parsed;
    }

    let limit = 50;
    if (limitParam !== undefined) {
      const parsed = validateLimit(limitParam);
      if (parsed === null) {
        return c.json(errorEnvelope('invalid_param', 'Invalid limit value', { param: 'limit', constraint: 'must be an integer between 1 and 500' }), 400);
      }
      limit = parsed;
    }

    const sessions = sessionFiles.listSessions();
    const results = filterSessions(sessions, status, since, limit);
    return c.json(results);
  });

  // GET /sessions/:id
  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id');

    if (!sessionFiles.sessionExists(id)) {
      return c.json(errorEnvelope('session_not_found', `Session ${id} not found`), 404);
    }

    const linesParam = c.req.query('lines');
    let lines = 200;
    if (linesParam !== undefined) {
      const parsed = validateLines(linesParam);
      if (parsed === null) {
        return c.json(errorEnvelope('invalid_param', 'Invalid lines value', { param: 'lines', constraint: 'must be an integer between 1 and 2000' }), 400);
      }
      lines = parsed;
    }

    const meta = sessionFiles.readMeta(id);
    const streamPath = path.join(rootDir, 'sessions', id, 'stream.log');
    const { entries, skipped_lines } = tailStreamLog(streamPath, lines);

    return c.json({ meta, entries, skipped_lines });
  });

  // GET /sessions/:id/stream
  app.get('/sessions/:id/stream', (c) => {
    const id = c.req.param('id');

    if (!sessionFiles.sessionExists(id)) {
      return c.json(errorEnvelope('session_not_found', `Session ${id} not found`), 404);
    }

    const lastEventIdHeader = c.req.header('last-event-id');
    let lastEventId: number | undefined;
    if (lastEventIdHeader !== undefined) {
      const parsed = parseInt(lastEventIdHeader, 10);
      if (!isNaN(parsed) && parsed > 0) {
        lastEventId = parsed;
      }
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const clientId = sseBroker.subscribe(
      id,
      lastEventId,
      (chunk: string) => { writer.write(encoder.encode(chunk)).catch(() => {}); },
      () => { writer.close().catch(() => {}); },
    );

    // Clean up on client disconnect
    c.req.raw.signal.addEventListener('abort', () => {
      sseBroker.unsubscribe(id, clientId);
      writer.close().catch(() => {});
    });

    return new Response(readable as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  // POST /sessions/:id/inject
  app.post('/sessions/:id/inject', async (c) => {
    const id = c.req.param('id');
    const auth: AuthResult = c.get('auth');

    if (shuttingDown()) {
      return c.json(errorEnvelope('shutting_down', 'Server is shutting down'), 503);
    }

    if (!sessionFiles.sessionExists(id)) {
      return c.json(errorEnvelope('session_not_found', `Session ${id} not found`), 404);
    }

    const meta = sessionFiles.readMeta(id);
    if (meta.status !== 'active') {
      return c.json(errorEnvelope('session_not_active', 'Session is not active', { status: meta.status }), 409);
    }

    const handle = sessionMgr.getActiveSession(id);
    if (handle === null) {
      return c.json(errorEnvelope('session_not_resident', 'Session has no live process'), 409);
    }

    const body = await c.req.json();
    const result = validatePrompt(body);
    if (!result.valid) {
      return c.json(errorEnvelope('invalid_body', result.reason), 400);
    }

    // Log actor before enqueue
    try {
      sessionFiles.appendStream(id, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'web_inject',
        actor: auth.actor,
      });
    } catch {
      return c.json(errorEnvelope('logging_failed', 'Failed to write audit log'), 500);
    }

    // Fire-and-forget enqueue
    handle.turnQueue.enqueue(result.prompt, 'web', auth.actor).catch(() => {
      // Failure logged by turn queue itself as prompt_injection_failed
    });

    return c.json({ accepted: true }, 202);
  });

  // POST /sessions/:id/interrupt
  app.post('/sessions/:id/interrupt', (c) => {
    const id = c.req.param('id');
    const auth: AuthResult = c.get('auth');

    if (shuttingDown()) {
      return c.json(errorEnvelope('shutting_down', 'Server is shutting down'), 503);
    }

    if (!sessionFiles.sessionExists(id)) {
      return c.json(errorEnvelope('session_not_found', `Session ${id} not found`), 404);
    }

    const meta = sessionFiles.readMeta(id);
    if (meta.status !== 'active') {
      return c.json(errorEnvelope('session_not_active', 'Session is not active', { status: meta.status }), 409);
    }

    const handle = sessionMgr.getActiveSession(id);
    if (handle === null) {
      return c.json(errorEnvelope('session_not_resident', 'Session has no live process'), 409);
    }

    // Log actor
    try {
      sessionFiles.appendStream(id, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'web_interrupt',
        actor: auth.actor,
      });
    } catch {
      return c.json(errorEnvelope('logging_failed', 'Failed to write audit log'), 500);
    }

    // Fire cancel — no-op if idle
    handle.acp.cancel();

    return c.json({ ok: true }, 200);
  });

  // POST /sessions/:id/kill
  app.post('/sessions/:id/kill', async (c) => {
    const id = c.req.param('id');
    const auth: AuthResult = c.get('auth');

    if (shuttingDown()) {
      return c.json(errorEnvelope('shutting_down', 'Server is shutting down'), 503);
    }

    if (!sessionFiles.sessionExists(id)) {
      return c.json(errorEnvelope('session_not_found', `Session ${id} not found`), 404);
    }

    const meta = sessionFiles.readMeta(id);
    if (meta.status !== 'active') {
      return c.json(errorEnvelope('session_not_active', 'Session is not active', { status: meta.status }), 409);
    }

    const handle = sessionMgr.getActiveSession(id);
    if (handle === null) {
      return c.json(errorEnvelope('session_not_resident', 'Session has no live process'), 409);
    }

    // Log actor
    try {
      sessionFiles.appendStream(id, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'web_kill',
        actor: auth.actor,
      });
    } catch {
      return c.json(errorEnvelope('logging_failed', 'Failed to write audit log'), 500);
    }

    // Race terminateSession against 10s timeout
    const deadline = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000));
    const result = await Promise.race([
      sessionMgr.terminateSession(id, 'terminated_web', auth.actor).then(() => 'done' as const),
      deadline,
    ]);

    if (result === 'timeout') {
      return c.json(errorEnvelope('termination_timeout', 'ACP subprocess did not exit within 10 seconds'), 502);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}

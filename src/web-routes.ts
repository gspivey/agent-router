import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionManager } from './session-mgr.js';
import type { SessionFiles, SessionMeta } from './session-files.js';
import type { SSEBroker } from './sse-broker.js';
import type { Logger } from './log.js';
import type { AuthResult } from './web-auth.js';
import type { AgentRouterConfig, RepoConfig, CronConfig } from './config.js';
import type { TokenStore } from './token-store.js';
import { getTokenHealthSummary } from './token-store.js';
import type { Database, CronState } from './db.js';
import { getCronScheduleState } from './cron-state.js';
import { getNextCronFire } from './cron-next.js';
import { deriveWaitingFor } from './ui/logic.js';

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

export function validateOffset(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
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
  waiting_for: string | null;
}

export function metaToSummary(meta: SessionMeta, waitingFor?: string): SessionSummary {
  return {
    session_id: meta.session_id,
    repo: meta.repo ?? null,
    status: meta.status,
    created_at: meta.created_at,
    completed_at: meta.completed_at,
    termination_reason: meta.termination_reason ?? null,
    prs: meta.prs,
    waiting_for: waitingFor ?? null,
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
  return filtered.slice(0, limit).map(m => metaToSummary(m));
}

/**
 * Read the type field of the last NDJSON entry in a stream.log file.
 * Returns undefined if the file is empty or unreadable.
 */
export function getLastStreamEntryType(streamPath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(streamPath, 'utf-8');
  } catch {
    return undefined;
  }
  if (content.length === 0) return undefined;
  // Find the last non-empty line
  const lines = content.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && line.length > 0) {
      try {
        const entry = JSON.parse(line) as { type?: string };
        return entry.type;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export interface PaginatedResult {
  sessions: SessionSummary[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Paginate sessions with the rule that active sessions are always included.
 * Active sessions appear first, then non-active sessions fill the remaining slots.
 * The offset/limit apply to the non-active portion only; all active sessions are
 * always returned regardless of offset.
 */
export function paginateSessions(
  sessions: SessionMeta[],
  status: SessionMeta['status'] | undefined,
  since: number | undefined,
  limit: number,
  offset: number,
  waitingForFn: (meta: SessionMeta) => string | undefined,
): PaginatedResult {
  let filtered = sessions;
  if (status !== undefined) {
    filtered = filtered.filter(s => s.status === status);
  }
  if (since !== undefined) {
    filtered = filtered.filter(s => s.created_at >= since);
  }

  const total = filtered.length;

  // If a specific status is requested, simple slice pagination
  if (status !== undefined) {
    const page = filtered.slice(offset, offset + limit);
    return {
      sessions: page.map(m => metaToSummary(m, waitingForFn(m))),
      total,
      offset,
      limit,
    };
  }

  // Split into active (always shown) and non-active (paginated)
  const active = filtered.filter(s => s.status === 'active');
  const nonActive = filtered.filter(s => s.status !== 'active');

  const nonActivePage = nonActive.slice(offset, offset + limit);
  const combined = [...active, ...nonActivePage];

  return {
    sessions: combined.map(m => metaToSummary(m, waitingForFn(m))),
    total,
    offset,
    limit,
  };
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

// --- Repo grouping helpers (exported for testing) ---

export interface RepoGroupCron {
  readonly name: string;
  readonly schedule: string;
  readonly paused: boolean;
  readonly next_fire: string | null;
}

export interface RepoGroup {
  readonly repo: string;
  readonly active_sessions: SessionSummary[];
  readonly terminal_sessions: SessionSummary[];
  readonly terminal_total: number;
  readonly cron: RepoGroupCron | null;
  readonly open_pr_count: number;
}

/**
 * Group sessions by repo using config.repos as the canonical repo list.
 *
 * Pure function — all data passed in for testability.
 *
 * @param sessions - All sessions from sessionFiles.listSessions()
 * @param repos - Configured repos (defines the full set of sections)
 * @param cronEntries - Cron configuration entries
 * @param cronStates - Persisted cron pause states
 * @param perRepoLimit - Max terminal sessions per repo section
 * @param waitingForFn - Function to derive waiting_for for active sessions
 * @param now - Reference time for next_fire computation (defaults to current time)
 */
export function groupSessionsByRepo(
  sessions: SessionMeta[],
  repos: readonly RepoConfig[],
  cronEntries: readonly CronConfig[],
  cronStates: readonly CronState[],
  perRepoLimit: number,
  waitingForFn: (meta: SessionMeta) => string | undefined,
  now: Date = new Date(),
): RepoGroup[] {
  // Build a map of repo full name → sessions
  const sessionsByRepo = new Map<string, SessionMeta[]>();
  for (const session of sessions) {
    const repoName = session.repo;
    if (repoName === undefined) continue;
    const existing = sessionsByRepo.get(repoName);
    if (existing !== undefined) {
      existing.push(session);
    } else {
      sessionsByRepo.set(repoName, [session]);
    }
  }

  // Build cron state lookup
  const cronStateMap = new Map(cronStates.map(s => [s.name, s]));

  return repos.map(repo => {
    const repoFullName = `${repo.owner}/${repo.name}`;
    const repoSessions = sessionsByRepo.get(repoFullName) ?? [];

    // Split into active and terminal
    const active: SessionMeta[] = [];
    const terminal: SessionMeta[] = [];
    for (const s of repoSessions) {
      if (s.status === 'active') {
        active.push(s);
      } else {
        terminal.push(s);
      }
    }

    // Sort terminal by created_at descending
    terminal.sort((a, b) => b.created_at - a.created_at);

    // Slice terminal to perRepoLimit
    const terminalPage = terminal.slice(0, perRepoLimit);

    // Find matching cron entry for this repo
    const cronEntry = cronEntries.find(e => e.repo === repoFullName);
    let cron: RepoGroupCron | null = null;
    if (cronEntry !== undefined) {
      const state = cronStateMap.get(cronEntry.name);
      const paused = state !== undefined && state.paused;
      let nextFire: string | null = null;
      if (!paused) {
        const next = getNextCronFire(cronEntry.schedule, now);
        nextFire = next !== null ? next.toISOString() : null;
      }
      cron = {
        name: cronEntry.name,
        schedule: cronEntry.schedule,
        paused,
        next_fire: nextFire,
      };
    }

    // Compute open PR count: count PRs across all sessions for this repo
    // where the PR has no merged_at
    let openPrCount = 0;
    const seenPrs = new Set<string>();
    for (const s of repoSessions) {
      for (const pr of s.prs) {
        const key = `${pr.repo}#${pr.pr_number}`;
        if (!seenPrs.has(key) && pr.merged_at === undefined) {
          seenPrs.add(key);
          openPrCount++;
        }
      }
    }

    return {
      repo: repoFullName,
      active_sessions: active.map(m => metaToSummary(m, waitingForFn(m))),
      terminal_sessions: terminalPage.map(m => metaToSummary(m, waitingForFn(m))),
      terminal_total: terminal.length,
      cron,
      open_pr_count: openPrCount,
    };
  });
}

/**
 * Validate per_repo_limit query parameter. Returns validated number or null for invalid.
 */
export function validatePerRepoLimit(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) return null;
  return n;
}

// --- Route factory ---

export function createWebRoutes(deps: {
  sessionMgr: SessionManager;
  sessionFiles: SessionFiles;
  sseBroker: SSEBroker;
  rootDir: string;
  log: Logger;
  shuttingDown: () => boolean;
  config?: AgentRouterConfig;
  tokenStore?: TokenStore;
  db?: Database;
}): Hono<WebEnv> {
  const { sessionMgr, sessionFiles, sseBroker, rootDir, log, shuttingDown, config, tokenStore, db } = deps;
  const app = new Hono<WebEnv>();

  // GET /sessions
  app.get('/sessions', (c) => {
    const statusParam = c.req.query('status');
    const sinceParam = c.req.query('since');
    const limitParam = c.req.query('limit');
    const offsetParam = c.req.query('offset');

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

    let limit = 20;
    if (limitParam !== undefined) {
      const parsed = validateLimit(limitParam);
      if (parsed === null) {
        return c.json(errorEnvelope('invalid_param', 'Invalid limit value', { param: 'limit', constraint: 'must be an integer between 1 and 500' }), 400);
      }
      limit = parsed;
    }

    let offset = 0;
    if (offsetParam !== undefined) {
      const parsed = validateOffset(offsetParam);
      if (parsed === null) {
        return c.json(errorEnvelope('invalid_param', 'Invalid offset value', { param: 'offset', constraint: 'must be a non-negative integer' }), 400);
      }
      offset = parsed;
    }

    const sessions = sessionFiles.listSessions();

    const waitingForFn = (meta: SessionMeta): string | undefined => {
      if (meta.status !== 'active') return undefined;
      const streamPath = path.join(rootDir, 'sessions', meta.session_id, 'stream.log');
      const lastType = getLastStreamEntryType(streamPath);
      return deriveWaitingFor(lastType);
    };

    const result = paginateSessions(sessions, status, since, limit, offset, waitingForFn);
    return c.json(result);
  });

  // GET /repos/sessions — grouped sessions by repo
  app.get('/repos/sessions', (c) => {
    if (!config || !db) {
      return c.json(errorEnvelope('not_configured', 'Repos endpoint requires config and database'), 503);
    }

    const perRepoLimitParam = c.req.query('per_repo_limit');
    let perRepoLimit = 5;
    if (perRepoLimitParam !== undefined) {
      const parsed = validatePerRepoLimit(perRepoLimitParam);
      if (parsed === null) {
        return c.json(errorEnvelope('invalid_param', 'Invalid per_repo_limit value', { param: 'per_repo_limit', constraint: 'must be an integer between 1 and 50' }), 400);
      }
      perRepoLimit = parsed;
    }

    const sessions = sessionFiles.listSessions();
    const cronStates = db.getAllCronStates();

    const waitingForFn = (meta: SessionMeta): string | undefined => {
      if (meta.status !== 'active') return undefined;
      const streamPath = path.join(rootDir, 'sessions', meta.session_id, 'stream.log');
      const lastType = getLastStreamEntryType(streamPath);
      return deriveWaitingFor(lastType);
    };

    const repos = groupSessionsByRepo(
      sessions,
      config.repos,
      config.cron,
      cronStates,
      perRepoLimit,
      waitingForFn,
    );

    return c.json({ repos });
  });

  // GET /repos/:repo/sessions — per-repo terminal session pagination
  app.get('/repos/:repo/sessions', (c) => {
    if (!config) {
      return c.json(errorEnvelope('not_configured', 'Repos endpoint requires config'), 503);
    }

    const repoParam = decodeURIComponent(c.req.param('repo'));

    // Validate that repo matches a configured repo
    const matchedRepo = config.repos.find(r => `${r.owner}/${r.name}` === repoParam);
    if (matchedRepo === undefined) {
      return c.json(errorEnvelope('repo_not_found', `Repo "${repoParam}" is not configured`), 404);
    }

    const limitParam = c.req.query('limit');
    let limit = 5;
    if (limitParam !== undefined) {
      const parsed = validatePerRepoLimit(limitParam);
      if (parsed === null) {
        return c.json(errorEnvelope('invalid_param', 'Invalid limit value', { param: 'limit', constraint: 'must be an integer between 1 and 50' }), 400);
      }
      limit = parsed;
    }

    const offsetParam = c.req.query('offset');
    let offset = 0;
    if (offsetParam !== undefined) {
      const parsed = validateOffset(offsetParam);
      if (parsed === null) {
        return c.json(errorEnvelope('invalid_param', 'Invalid offset value', { param: 'offset', constraint: 'must be a non-negative integer' }), 400);
      }
      offset = parsed;
    }

    const sessions = sessionFiles.listSessions();

    // Filter to target repo, exclude active, sort by created_at desc
    const repoFullName = `${matchedRepo.owner}/${matchedRepo.name}`;
    const repoSessions = sessions.filter(s => s.repo === repoFullName && s.status !== 'active');
    repoSessions.sort((a, b) => b.created_at - a.created_at);

    const total = repoSessions.length;
    const page = repoSessions.slice(offset, offset + limit);

    const waitingForFn = (meta: SessionMeta): string | undefined => {
      if (meta.status !== 'active') return undefined;
      const streamPath = path.join(rootDir, 'sessions', meta.session_id, 'stream.log');
      const lastType = getLastStreamEntryType(streamPath);
      return deriveWaitingFor(lastType);
    };

    return c.json({
      repo: repoFullName,
      sessions: page.map(m => metaToSummary(m, waitingForFn(m))),
      total,
      offset,
      limit,
    });
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

    // Initial flush: comment line + retry hint so proxies open the stream promptly
    writer.write(encoder.encode(':ok\nretry: 1000\n\n')).catch(() => {});

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
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
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

  // GET /config
  app.get('/config', (c) => {
    if (!config || !tokenStore || !db) {
      return c.json({ error: 'Configuration endpoint not available' }, 503);
    }
    try {
      const now = new Date();

      // Token health from the token store
      const tokenHealth = getTokenHealthSummary(tokenStore.getTokenMap(), now);

      // Cron schedule state
      const cronStates = db.getAllCronStates();
      const crons = getCronScheduleState(config.cron, cronStates, now);

      // Repos — expose name only, never secret values
      const repos = config.repos.map(r => ({
        name: `${r.owner}/${r.name}`,
        webhookSecretName: r.webhookSecret !== undefined
          ? `[configured]`
          : `WEBHOOK_SECRET_${r.owner}_${r.name}`,
      }));

      return c.json({
        sessionTimeouts: {
          inactivityMinutes: config.sessionTimeout.inactivityMinutes,
          maxLifetimeMinutes: config.sessionTimeout.maxLifetimeMinutes,
          gracePeriodAfterMergeSeconds: config.sessionTimeout.gracePeriodAfterMergeSeconds,
        },
        rateLimits: {
          perPRSeconds: config.rateLimit.perPRSeconds,
        },
        crons,
        tokens: tokenHealth,
        repos,
      });
    } catch (err) {
      log.error('Failed to assemble config response', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: 'Failed to load configuration' }, 500);
    }
  });

  return app;
}

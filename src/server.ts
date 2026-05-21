import { Hono } from 'hono';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from './db.js';
import type { QueuedEvent } from './queue.js';
import type { Logger } from './log.js';
import type { DaemonTokenStore } from './daemon-token.js';
import type { VerifySessionFn } from './verify-session.js';

/**
 * If AGENT_ROUTER_CAPTURE_PAYLOADS is set to a directory path, write the raw
 * verified webhook body to that directory as `<unix-ms>-<event-type>.json`.
 * Used to capture authentic GitHub payloads from tier 3 runs for fixture use.
 * Silently no-ops on any error so capture never breaks the webhook path.
 */
function capturePayload(rawBody: Buffer, eventType: string, log: Logger): void {
  const dir = process.env['AGENT_ROUTER_CAPTURE_PAYLOADS'];
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fname = `${Date.now()}-${eventType.replace(/[^a-z0-9_-]/gi, '_')}.json`;
    fs.writeFileSync(path.join(dir, fname), rawBody);
    log.debug('Webhook payload captured', { file: fname, dir });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Payload capture failed', { error: msg });
  }
}

/**
 * Verify a GitHub webhook HMAC-SHA256 signature.
 *
 * Computes `sha256=<hex>` from the secret + payload and compares
 * against the provided signature header using timing-safe comparison.
 * Returns false for missing, malformed, or incorrect signatures.
 */
export function verifySignature(
  secret: string,
  payload: Buffer,
  signature: string,
): boolean {
  if (!signature.startsWith('sha256=')) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expectedFull = `sha256=${expected}`;

  if (signature.length !== expectedFull.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedFull),
    );
  } catch {
    return false;
  }
}

/**
 * Extract the repo full_name from a parsed webhook payload.
 * GitHub payloads always include `repository.full_name`.
 */
function extractRepo(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const repo = p['repository'];
  if (typeof repo !== 'object' || repo === null) return null;
  const fullName = (repo as Record<string, unknown>)['full_name'];
  return typeof fullName === 'string' ? fullName : null;
}

/**
 * Extract the PR number from a parsed webhook payload.
 * Tries common locations across event types.
 */
function extractPRNumber(eventType: string, payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  if (eventType === 'pull_request_review_comment') {
    const pr = p['pull_request'];
    if (typeof pr === 'object' && pr !== null) {
      const num = (pr as Record<string, unknown>)['number'];
      if (typeof num === 'number') return num;
    }
  }

  if (eventType === 'issue_comment') {
    const issue = p['issue'];
    if (typeof issue === 'object' && issue !== null) {
      const num = (issue as Record<string, unknown>)['number'];
      if (typeof num === 'number') return num;
    }
  }

  if (eventType === 'check_run') {
    const checkRun = p['check_run'];
    if (typeof checkRun === 'object' && checkRun !== null) {
      const prs = (checkRun as Record<string, unknown>)['pull_requests'];
      if (Array.isArray(prs) && prs.length > 0) {
        const first = prs[0] as unknown;
        if (typeof first === 'object' && first !== null) {
          const num = (first as Record<string, unknown>)['number'];
          if (typeof num === 'number') return num;
        }
      }
    }
  }

  return null;
}

/**
 * Create the Hono HTTP app for the webhook server.
 *
 * Routes:
 *  - POST /webhook — signature verification → event logging → enqueue → 200
 *  - Any method on /webhook other than POST → 405 with Allow: POST
 *  - Everything else → 404
 */
export function createApp(deps: {
  webhookSecret: string;
  db: Database;
  enqueue: (event: QueuedEvent) => void;
  log: Logger;
  /**
   * Optional: when set, registers POST /hooks/event for adapter-driven
   * verification triggers. Authenticated via bearer token from tokenStore.
   */
  tokenStore?: DaemonTokenStore;
  /**
   * Optional: verification fn for /hooks/event. Required if tokenStore is set.
   */
  verifySession?: VerifySessionFn;
}): Hono {
  const app = new Hono();

  // POST /hooks/event — adapter / hand-installed hook trigger for verifySession.
  // Authenticated via daemon-issued bearer token. Body must include session_id.
  // Always responds within ~10ms by deferring the verifySession work.
  if (deps.tokenStore !== undefined && deps.verifySession !== undefined) {
    const tokenStore = deps.tokenStore;
    const verifySession = deps.verifySession;
    app.post('/hooks/event', async (c) => {
      const auth = c.req.header('authorization');
      const expected = `Bearer ${tokenStore.read()}`;
      if (auth !== expected) {
        deps.log.warn('Hook event unauthorized', { hasAuth: auth !== undefined });
        return c.json({ error: 'unauthorized' }, 401);
      }

      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return c.json({ error: 'invalid json' }, 400);
      }

      const sessionId = body['session_id'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return c.json({ error: 'missing or invalid session_id' }, 400);
      }

      const eventType = body['event_type'];
      const knownEventTypes = new Set(['session.start', 'tool.post', 'turn.end', 'session.end']);
      if (typeof eventType === 'string' && !knownEventTypes.has(eventType)) {
        deps.log.warn('Hook event with unknown event_type', { event_type: eventType });
      }

      deps.log.info('Hook event received', {
        event_type: typeof eventType === 'string' ? eventType : 'unspecified',
        session_id: sessionId,
        agent_name: typeof body['agent_name'] === 'string' ? body['agent_name'] : undefined,
        tool_name: typeof body['tool_name'] === 'string' ? body['tool_name'] : undefined,
      });

      // Fire-and-forget — endpoint responds immediately
      void verifySession(sessionId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log.error('verifySession from hook failed', { session_id: sessionId, error: msg });
      });

      return c.json({ accepted: true }, 202);
    });

    // Non-POST on /hooks/event → 405 (must be registered before the catch-all)
    app.all('/hooks/event', (c) => {
      c.header('Allow', 'POST');
      return c.text('Method Not Allowed', 405);
    });
  }

  // POST /webhook — the main handler
  app.post('/webhook', async (c) => {
    // Extract raw body as Buffer for HMAC verification
    const rawBody = Buffer.from(await c.req.arrayBuffer());

    // Check for signature header
    const signatureHeader = c.req.header('x-hub-signature-256');
    if (!signatureHeader) {
      deps.log.warn('Missing X-Hub-Signature-256 header');
      return c.text('Unauthorized', 401);
    }

    // Verify HMAC-SHA256 signature
    if (!verifySignature(deps.webhookSecret, rawBody, signatureHeader)) {
      deps.log.warn('Invalid webhook signature');
      return c.text('Unauthorized', 401);
    }

    // Extract event type from header
    const eventType = c.req.header('x-github-event') ?? 'unknown';

    // Optional payload capture (no-op unless AGENT_ROUTER_CAPTURE_PAYLOADS is set)
    capturePayload(rawBody, eventType, deps.log);

    // Parse JSON payload
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      deps.log.warn('Invalid JSON payload');
      return c.text('Bad Request', 400);
    }

    const repo = extractRepo(payload) ?? 'unknown';
    const prNumber = extractPRNumber(eventType, payload);
    const payloadStr = rawBody.toString('utf-8');
    const receivedAt = Math.floor(Date.now() / 1000);

    // Insert event into DB synchronously
    const eventId = deps.db.insertEvent({
      repo,
      prNumber,
      eventType,
      payload: payloadStr,
      receivedAt,
    });

    deps.log.info('Webhook received', {
      event_id: eventId,
      event_type: eventType,
      repo,
      pr_number: prNumber,
    });

    // Enqueue for async processing
    deps.enqueue({
      id: eventId,
      repo,
      prNumber,
      eventType,
      payload: payloadStr,
      source: 'webhook',
    });

    return c.text('OK', 200);
  });

  // Non-POST on /webhook → 405 with Allow: POST
  app.all('/webhook', (c) => {
    c.header('Allow', 'POST');
    return c.text('Method Not Allowed', 405);
  });

  // Catch-all → 404
  app.all('*', (c) => {
    return c.text('Not Found', 404);
  });

  return app;
}

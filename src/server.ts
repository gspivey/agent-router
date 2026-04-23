import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { Database } from './db.js';
import type { QueuedEvent } from './queue.js';
import type { Logger } from './log.js';

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
}): Hono {
  const app = new Hono();

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

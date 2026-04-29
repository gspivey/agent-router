import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { createApp, verifySignature } from '../../src/server.js';
import type { Database, NewEvent } from '../../src/db.js';
import type { QueuedEvent } from '../../src/queue.js';
import type { Logger } from '../../src/log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignature(secret: string, body: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

function makeLogger(): Logger {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => makeLogger(),
  };
}

function makeDb(overrides: Partial<Database> = {}): Database {
  return {
    insertEvent: vi.fn(() => 1),
    updateEventProcessed: vi.fn(),
    markStaleEvents: vi.fn(),
    findSession: vi.fn(() => null),
    tryAcquireWakeSlot: vi.fn(() => false),
    insertSession: vi.fn(),
    insertOutboundComment: vi.fn(),
    isOutboundComment: vi.fn(() => false),
    pruneOutboundComments: vi.fn(),
    walCheckpoint: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const WEBHOOK_SECRET = 'test-secret-for-hmac';

function makeApp(overrides?: {
  db?: Partial<Database>;
  enqueue?: (event: QueuedEvent) => void;
}) {
  const db = makeDb(overrides?.db);
  const enqueue = overrides?.enqueue ?? vi.fn();
  const app = createApp({
    webhookSecret: WEBHOOK_SECRET,
    db,
    enqueue,
    log: makeLogger(),
  });
  return { app, db, enqueue };
}

function webhookPayload(repo: string, prNumber: number) {
  return {
    action: 'completed',
    check_run: {
      conclusion: 'failure',
      pull_requests: [{ number: prNumber }],
    },
    repository: { full_name: repo },
  };
}

// ---------------------------------------------------------------------------
// verifySignature
// ---------------------------------------------------------------------------

describe('verifySignature', () => {
  const secret = 'my-secret';
  const payload = Buffer.from('{"hello":"world"}');

  it('returns true for correct HMAC', () => {
    const sig = makeSignature(secret, payload.toString());
    expect(verifySignature(secret, payload, sig)).toBe(true);
  });

  it('returns false for wrong HMAC', () => {
    const sig = makeSignature('wrong-secret', payload.toString());
    expect(verifySignature(secret, payload, sig)).toBe(false);
  });

  it('returns false for malformed signature header (no sha256= prefix)', () => {
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifySignature(secret, payload, hmac)).toBe(false);
  });

  it('returns false for empty signature string', () => {
    expect(verifySignature(secret, payload, '')).toBe(false);
  });

  it('returns false for sha256= with wrong length hex', () => {
    expect(verifySignature(secret, payload, 'sha256=abc')).toBe(false);
  });

  it('returns false for sha256= with correct length but wrong content', () => {
    const correctSig = makeSignature(secret, payload.toString());
    // Flip a character
    const wrongSig = correctSig.slice(0, -1) + (correctSig.endsWith('0') ? '1' : '0');
    expect(verifySignature(secret, payload, wrongSig)).toBe(false);
  });

  it('handles empty payload', () => {
    const emptyPayload = Buffer.from('');
    const sig = makeSignature(secret, '');
    expect(verifySignature(secret, emptyPayload, sig)).toBe(true);
  });

  it('handles large payload', () => {
    const largePayload = Buffer.from('x'.repeat(100_000));
    const sig = makeSignature(secret, largePayload.toString());
    expect(verifySignature(secret, largePayload, sig)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /webhook — valid signature → 200
// ---------------------------------------------------------------------------

describe('POST /webhook with valid signature', () => {
  it('returns 200 and inserts event into DB', async () => {
    const { app, db, enqueue } = makeApp();
    const body = JSON.stringify(webhookPayload('myorg/myrepo', 42));
    const sig = makeSignature(WEBHOOK_SECRET, body);

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'check_run',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(db.insertEvent).toHaveBeenCalledOnce();

    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as NewEvent;
    expect(insertCall.repo).toBe('myorg/myrepo');
    expect(insertCall.prNumber).toBe(42);
    expect(insertCall.eventType).toBe('check_run');
    expect(insertCall.payload).toBe(body);

    expect(enqueue).toHaveBeenCalledOnce();
    const enqueueCall = (enqueue as ReturnType<typeof vi.fn>).mock.calls[0]![0] as QueuedEvent;
    expect(enqueueCall.id).toBe(1);
    expect(enqueueCall.repo).toBe('myorg/myrepo');
    expect(enqueueCall.eventType).toBe('check_run');
    expect(enqueueCall.source).toBe('webhook');
  });
});

// ---------------------------------------------------------------------------
// POST /webhook — missing signature → 401
// ---------------------------------------------------------------------------

describe('POST /webhook with missing signature', () => {
  it('returns 401 when X-Hub-Signature-256 header is absent', async () => {
    const { app, db, enqueue } = makeApp();
    const body = JSON.stringify(webhookPayload('myorg/myrepo', 42));

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'check_run',
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(db.insertEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /webhook — invalid signature → 401
// ---------------------------------------------------------------------------

describe('POST /webhook with invalid signature', () => {
  it('returns 401 when signature does not match', async () => {
    const { app, db, enqueue } = makeApp();
    const body = JSON.stringify(webhookPayload('myorg/myrepo', 42));
    const wrongSig = makeSignature('wrong-secret', body);

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'check_run',
        'X-Hub-Signature-256': wrongSig,
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(db.insertEvent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-POST on /webhook → 405 with Allow: POST
// ---------------------------------------------------------------------------

describe('Non-POST on /webhook', () => {
  it('GET /webhook returns 405 with Allow: POST header', async () => {
    const { app } = makeApp();
    const res = await app.request('/webhook', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('PUT /webhook returns 405 with Allow: POST header', async () => {
    const { app } = makeApp();
    const res = await app.request('/webhook', { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('DELETE /webhook returns 405 with Allow: POST header', async () => {
    const { app } = makeApp();
    const res = await app.request('/webhook', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });

  it('PATCH /webhook returns 405 with Allow: POST header', async () => {
    const { app } = makeApp();
    const res = await app.request('/webhook', { method: 'PATCH' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });
});

// ---------------------------------------------------------------------------
// Non-/webhook paths → 404
// ---------------------------------------------------------------------------

describe('Non-/webhook paths', () => {
  it('GET /other-path returns 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/other-path', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('POST /other-path returns 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/other-path', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('GET / returns 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('GET /health returns 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

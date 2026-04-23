/**
 * Tier 2 test: signed/unsigned webhooks through the full HTTP server.
 *
 * Exercises the Hono app directly (no daemon subprocess needed) with
 * real HMAC signing from FakeGitHubBackend and the full createApp stack.
 *
 * Requirements: 3.1, 3.2, 3.3, 24.6
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { createApp, verifySignature } from '../../src/server.js';
import type { Database, NewEvent } from '../../src/db.js';
import type { QueuedEvent } from '../../src/queue.js';
import type { Logger } from '../../src/log.js';

const WEBHOOK_SECRET = 'tier2-test-secret-xyz';

function signPayload(secret: string, body: string): string {
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

function makeDb(): Database {
  let nextId = 1;
  return {
    insertEvent: vi.fn((_event: NewEvent) => nextId++),
    updateEventProcessed: vi.fn(),
    markStaleEvents: vi.fn(),
    findSession: vi.fn(() => null),
    tryAcquireWakeSlot: vi.fn(() => false),
    insertSession: vi.fn(),
    walCheckpoint: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
  };
}

describe('Tier 2: signed/unsigned webhooks', () => {
  let db: Database;
  let enqueuedEvents: QueuedEvent[];
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeDb();
    enqueuedEvents = [];
    app = createApp({
      webhookSecret: WEBHOOK_SECRET,
      db,
      enqueue: (event: QueuedEvent) => { enqueuedEvents.push(event); },
      log: makeLogger(),
    });
  });

  it('accepts a properly signed webhook and inserts + enqueues the event', async () => {
    const payload = {
      action: 'completed',
      check_run: {
        conclusion: 'failure',
        pull_requests: [{ number: 5 }],
      },
      repository: { full_name: 'testowner/testrepo' },
    };
    const body = JSON.stringify(payload);
    const sig = signPayload(WEBHOOK_SECRET, body);

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

    // Event was inserted into DB
    expect(db.insertEvent).toHaveBeenCalledOnce();
    const insertCall = (db.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as NewEvent;
    expect(insertCall.repo).toBe('testowner/testrepo');
    expect(insertCall.prNumber).toBe(5);
    expect(insertCall.eventType).toBe('check_run');
    expect(JSON.parse(insertCall.payload)).toEqual(payload);

    // Event was enqueued
    expect(enqueuedEvents).toHaveLength(1);
    expect(enqueuedEvents[0]!.repo).toBe('testowner/testrepo');
    expect(enqueuedEvents[0]!.source).toBe('webhook');
  });

  it('rejects an unsigned webhook with 401', async () => {
    const body = JSON.stringify({
      action: 'created',
      comment: { body: '/agent fix' },
      issue: { number: 3, pull_request: { url: 'https://...' } },
      repository: { full_name: 'testowner/testrepo' },
    });

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issue_comment',
        // No X-Hub-Signature-256 header
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(db.insertEvent).not.toHaveBeenCalled();
    expect(enqueuedEvents).toHaveLength(0);
  });

  it('rejects a webhook signed with the wrong secret with 401', async () => {
    const body = JSON.stringify({
      action: 'created',
      pull_request: { number: 10 },
      repository: { full_name: 'testowner/testrepo' },
    });
    const wrongSig = signPayload('wrong-secret', body);

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review_comment',
        'X-Hub-Signature-256': wrongSig,
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(db.insertEvent).not.toHaveBeenCalled();
    expect(enqueuedEvents).toHaveLength(0);
  });

  it('rejects a webhook with a tampered body with 401', async () => {
    const originalBody = JSON.stringify({
      action: 'completed',
      check_run: { conclusion: 'failure', pull_requests: [{ number: 1 }] },
      repository: { full_name: 'testowner/testrepo' },
    });
    const sig = signPayload(WEBHOOK_SECRET, originalBody);

    // Tamper with the body after signing
    const tamperedBody = JSON.stringify({
      action: 'completed',
      check_run: { conclusion: 'failure', pull_requests: [{ number: 999 }] },
      repository: { full_name: 'testowner/testrepo' },
    });

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'check_run',
        'X-Hub-Signature-256': sig,
      },
      body: tamperedBody,
    });

    expect(res.status).toBe(401);
    expect(db.insertEvent).not.toHaveBeenCalled();
  });

  it('handles multiple signed webhooks sequentially with incrementing event IDs', async () => {
    for (let i = 1; i <= 3; i++) {
      const payload = {
        action: 'created',
        comment: { body: `/agent task ${i}` },
        issue: { number: i, pull_request: { url: 'https://...' } },
        repository: { full_name: 'testowner/testrepo' },
      };
      const body = JSON.stringify(payload);
      const sig = signPayload(WEBHOOK_SECRET, body);

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issue_comment',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      expect(res.status).toBe(200);
    }

    expect(db.insertEvent).toHaveBeenCalledTimes(3);
    expect(enqueuedEvents).toHaveLength(3);

    // Each enqueued event should have a unique incrementing ID
    expect(enqueuedEvents[0]!.id).toBe(1);
    expect(enqueuedEvents[1]!.id).toBe(2);
    expect(enqueuedEvents[2]!.id).toBe(3);
  });
});

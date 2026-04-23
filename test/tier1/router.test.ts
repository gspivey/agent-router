import { describe, it, expect } from 'vitest';
import {
  filterEventType,
  isCommandTrigger,
  resolvePRNumber,
  evaluateWakePolicy,
} from '../../src/router.js';
import type { QueuedEvent } from '../../src/queue.js';
import type { Database, Session } from '../../src/db.js';
import type { AgentRouterConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// isCommandTrigger
// ---------------------------------------------------------------------------

describe('isCommandTrigger', () => {
  it('matches /agent followed by a space', () => {
    expect(isCommandTrigger('/agent fix the tests')).toBe(true);
  });

  it('matches /agent followed by a newline', () => {
    expect(isCommandTrigger('/agent\ndo something')).toBe(true);
  });

  it('matches /agent at end-of-string', () => {
    expect(isCommandTrigger('/agent')).toBe(true);
  });

  it('matches /agent followed by tab', () => {
    expect(isCommandTrigger('/agent\trun ci')).toBe(true);
  });

  it('rejects /agentsmith (no word boundary)', () => {
    expect(isCommandTrigger('/agentsmith')).toBe(false);
  });

  it('rejects /agents', () => {
    expect(isCommandTrigger('/agents deploy')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isCommandTrigger('')).toBe(false);
  });

  it('rejects plain text without /agent prefix', () => {
    expect(isCommandTrigger('please /agent fix')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterEventType
// ---------------------------------------------------------------------------

describe('filterEventType', () => {
  describe('check_run events', () => {
    it('classifies check_run completed+failure as wakeable', () => {
      const payload = {
        action: 'completed',
        check_run: { conclusion: 'failure' },
      };
      expect(filterEventType('check_run', payload)).toBe(true);
    });

    it('rejects check_run completed+success', () => {
      const payload = {
        action: 'completed',
        check_run: { conclusion: 'success' },
      };
      expect(filterEventType('check_run', payload)).toBe(false);
    });

    it('rejects check_run with action != completed', () => {
      const payload = {
        action: 'created',
        check_run: { conclusion: 'failure' },
      };
      expect(filterEventType('check_run', payload)).toBe(false);
    });
  });

  describe('pull_request_review_comment events', () => {
    it('classifies pull_request_review_comment created as wakeable', () => {
      const payload = { action: 'created' };
      expect(filterEventType('pull_request_review_comment', payload)).toBe(true);
    });

    it('rejects pull_request_review_comment with action != created', () => {
      const payload = { action: 'edited' };
      expect(filterEventType('pull_request_review_comment', payload)).toBe(false);
    });
  });

  describe('issue_comment events', () => {
    it('classifies issue_comment created with /agent trigger as wakeable', () => {
      const payload = {
        action: 'created',
        comment: { body: '/agent fix this' },
      };
      expect(filterEventType('issue_comment', payload)).toBe(true);
    });

    it('classifies issue_comment created with bare /agent as wakeable', () => {
      const payload = {
        action: 'created',
        comment: { body: '/agent' },
      };
      expect(filterEventType('issue_comment', payload)).toBe(true);
    });

    it('rejects issue_comment created without /agent trigger', () => {
      const payload = {
        action: 'created',
        comment: { body: 'looks good to me' },
      };
      expect(filterEventType('issue_comment', payload)).toBe(false);
    });

    it('rejects issue_comment created with /agentsmith (no boundary)', () => {
      const payload = {
        action: 'created',
        comment: { body: '/agentsmith' },
      };
      expect(filterEventType('issue_comment', payload)).toBe(false);
    });

    it('rejects issue_comment with action != created', () => {
      const payload = {
        action: 'deleted',
        comment: { body: '/agent fix' },
      };
      expect(filterEventType('issue_comment', payload)).toBe(false);
    });
  });

  describe('non-wakeable event types', () => {
    it('rejects push events', () => {
      expect(filterEventType('push', { action: 'completed' })).toBe(false);
    });

    it('rejects pull_request events', () => {
      expect(filterEventType('pull_request', { action: 'opened' })).toBe(false);
    });

    it('rejects null payload', () => {
      expect(filterEventType('check_run', null)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePRNumber
// ---------------------------------------------------------------------------

describe('resolvePRNumber', () => {
  describe('pull_request_review_comment', () => {
    it('extracts PR number from pull_request.number', () => {
      const payload = { pull_request: { number: 42 } };
      expect(resolvePRNumber('pull_request_review_comment', payload)).toBe(42);
    });

    it('returns null when pull_request is missing', () => {
      expect(resolvePRNumber('pull_request_review_comment', {})).toBeNull();
    });
  });

  describe('issue_comment', () => {
    it('extracts PR number from issue.number when issue.pull_request exists', () => {
      const payload = {
        issue: {
          number: 15,
          pull_request: { url: 'https://api.github.com/...' },
        },
      };
      expect(resolvePRNumber('issue_comment', payload)).toBe(15);
    });

    it('returns null when issue.pull_request is absent', () => {
      const payload = { issue: { number: 15 } };
      expect(resolvePRNumber('issue_comment', payload)).toBeNull();
    });

    it('returns null when issue is missing entirely', () => {
      expect(resolvePRNumber('issue_comment', {})).toBeNull();
    });
  });

  describe('check_run', () => {
    it('extracts PR number from first entry of check_run.pull_requests', () => {
      const payload = {
        check_run: {
          pull_requests: [{ number: 7 }, { number: 8 }],
        },
      };
      expect(resolvePRNumber('check_run', payload)).toBe(7);
    });

    it('returns null when check_run.pull_requests is empty', () => {
      const payload = {
        check_run: { pull_requests: [] },
      };
      expect(resolvePRNumber('check_run', payload)).toBeNull();
    });

    it('returns null when check_run is missing', () => {
      expect(resolvePRNumber('check_run', {})).toBeNull();
    });
  });

  describe('unknown event types', () => {
    it('returns null for unrecognized event types', () => {
      expect(resolvePRNumber('push', { ref: 'refs/heads/main' })).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateWakePolicy
// ---------------------------------------------------------------------------

describe('evaluateWakePolicy', () => {
  function makeEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
    return {
      id: 1,
      repo: 'myorg/myrepo',
      prNumber: null,
      eventType: 'check_run',
      payload: JSON.stringify({
        action: 'completed',
        check_run: {
          conclusion: 'failure',
          pull_requests: [{ number: 42 }],
        },
      }),
      source: 'webhook',
      ...overrides,
    };
  }

  function makeDb(overrides: Partial<Database> = {}): Database {
    return {
      insertEvent: () => 0,
      updateEventProcessed: () => undefined,
      markStaleEvents: () => undefined,
      findSession: () => ({
        sessionId: 'sess-abc',
        repo: 'myorg/myrepo',
        prNumber: 42,
        lastWakedAt: null,
      }),
      tryAcquireWakeSlot: () => true,
      walCheckpoint: () => undefined,
      shutdown: () => Promise.resolve(),
      ...overrides,
    };
  }

  const config: AgentRouterConfig = {
    port: 3000,
    webhookSecret: 'secret',
    kiroPath: '/usr/bin/kiro',
    rateLimit: { perPRSeconds: 60 },
    repos: [{ owner: 'myorg', name: 'myrepo' }],
    cron: [],
  };

  it('returns wake=true when all checks pass', () => {
    const result = evaluateWakePolicy(makeEvent(), makeDb(), config);
    expect(result.wake).toBe(true);
    expect(result.sessionId).toBe('sess-abc');
    expect(result.prNumber).toBe(42);
  });

  it('returns wake=false for non-wakeable event type', () => {
    const event = makeEvent({
      eventType: 'push',
      payload: JSON.stringify({ ref: 'refs/heads/main' }),
    });
    const result = evaluateWakePolicy(event, makeDb(), config);
    expect(result.wake).toBe(false);
    expect(result.reason).toContain('not wakeable');
  });

  it('returns wake=false when PR number cannot be resolved', () => {
    const event = makeEvent({
      eventType: 'check_run',
      payload: JSON.stringify({
        action: 'completed',
        check_run: { conclusion: 'failure', pull_requests: [] },
      }),
    });
    const result = evaluateWakePolicy(event, makeDb(), config);
    expect(result.wake).toBe(false);
    expect(result.reason).toContain('PR number');
  });

  it('returns wake=false when no session exists', () => {
    const db = makeDb({ findSession: () => null });
    const result = evaluateWakePolicy(makeEvent(), db, config);
    expect(result.wake).toBe(false);
    expect(result.reason).toContain('No session');
    expect(result.prNumber).toBe(42);
  });

  it('returns wake=false when rate limited', () => {
    const db = makeDb({ tryAcquireWakeSlot: () => false });
    const result = evaluateWakePolicy(makeEvent(), db, config);
    expect(result.wake).toBe(false);
    expect(result.reason).toContain('Rate limited');
    expect(result.sessionId).toBe('sess-abc');
    expect(result.prNumber).toBe(42);
  });

  it('returns wake=false for invalid JSON payload', () => {
    const event = makeEvent({ payload: 'not json{' });
    const result = evaluateWakePolicy(event, makeDb(), config);
    expect(result.wake).toBe(false);
    expect(result.reason).toContain('Invalid JSON');
  });

  it('works for issue_comment with /agent trigger', () => {
    const event = makeEvent({
      eventType: 'issue_comment',
      payload: JSON.stringify({
        action: 'created',
        comment: { body: '/agent fix tests' },
        issue: {
          number: 10,
          pull_request: { url: 'https://api.github.com/...' },
        },
      }),
    });
    const db = makeDb({
      findSession: (_repo: string, prNumber: number) => ({
        sessionId: 'sess-xyz',
        repo: 'myorg/myrepo',
        prNumber,
        lastWakedAt: null,
      }),
    });
    const result = evaluateWakePolicy(event, db, config);
    expect(result.wake).toBe(true);
    expect(result.prNumber).toBe(10);
    expect(result.sessionId).toBe('sess-xyz');
  });

  it('works for pull_request_review_comment', () => {
    const event = makeEvent({
      eventType: 'pull_request_review_comment',
      payload: JSON.stringify({
        action: 'created',
        pull_request: { number: 55 },
      }),
    });
    const db = makeDb({
      findSession: (_repo: string, prNumber: number) => ({
        sessionId: 'sess-review',
        repo: 'myorg/myrepo',
        prNumber,
        lastWakedAt: null,
      }),
    });
    const result = evaluateWakePolicy(event, db, config);
    expect(result.wake).toBe(true);
    expect(result.prNumber).toBe(55);
  });
});

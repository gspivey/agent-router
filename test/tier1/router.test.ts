import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  filterEventType,
  isCommandTrigger,
  resolvePRNumber,
  evaluateWakePolicy,
  computeTrustTier,
  extractCommentAuthor,
  extractRepoOwnerLogin,
  extractWebhookCommentId,
} from '../../src/router.js';
import type { CommentAuthor } from '../../src/router.js';
import type { QueuedEvent } from '../../src/queue.js';
import type { Database, Session } from '../../src/db.js';
import type { AgentRouterConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Helper: build a comment payload with trust fields
// ---------------------------------------------------------------------------

function commentPayload(opts: {
  body: string;
  login: string;
  userType?: string;
  authorAssociation?: string;
  repoOwner?: string;
  action?: string;
}): Record<string, unknown> {
  return {
    action: opts.action ?? 'created',
    comment: {
      body: opts.body,
      user: {
        login: opts.login,
        type: opts.userType ?? 'User',
      },
      author_association: opts.authorAssociation ?? 'NONE',
    },
    repository: {
      full_name: `${opts.repoOwner ?? 'owner'}/repo`,
      owner: { login: opts.repoOwner ?? 'owner' },
    },
  };
}

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
// computeTrustTier
// ---------------------------------------------------------------------------

describe('computeTrustTier', () => {
  it('returns tier_1 when login matches repo owner', () => {
    const author: CommentAuthor = { login: 'alice', type: 'User', authorAssociation: 'NONE' };
    expect(computeTrustTier(author, 'alice')).toBe('tier_1');
  });

  it('returns tier_1 when author_association is OWNER', () => {
    const author: CommentAuthor = { login: 'alice', type: 'User', authorAssociation: 'OWNER' };
    expect(computeTrustTier(author, 'someone-else')).toBe('tier_1');
  });

  it('returns tier_1 for github-actions[bot]', () => {
    const author: CommentAuthor = { login: 'github-actions[bot]', type: 'Bot', authorAssociation: 'NONE' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_1');
  });

  it('returns tier_3 for a non-github-actions bot (e.g. dependabot)', () => {
    const author: CommentAuthor = { login: 'dependabot[bot]', type: 'Bot', authorAssociation: 'NONE' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_3');
  });

  it('returns tier_3 for an arbitrary bot', () => {
    const author: CommentAuthor = { login: 'my-app[bot]', type: 'Bot', authorAssociation: 'NONE' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_3');
  });

  it('returns tier_2 for MEMBER', () => {
    const author: CommentAuthor = { login: 'bob', type: 'User', authorAssociation: 'MEMBER' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_2');
  });

  it('returns tier_2 for COLLABORATOR', () => {
    const author: CommentAuthor = { login: 'carol', type: 'User', authorAssociation: 'COLLABORATOR' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_2');
  });

  it('returns tier_3 for CONTRIBUTOR', () => {
    const author: CommentAuthor = { login: 'dave', type: 'User', authorAssociation: 'CONTRIBUTOR' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_3');
  });

  it('returns tier_3 for FIRST_TIME_CONTRIBUTOR', () => {
    const author: CommentAuthor = { login: 'eve', type: 'User', authorAssociation: 'FIRST_TIME_CONTRIBUTOR' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_3');
  });

  it('returns tier_3 for NONE', () => {
    const author: CommentAuthor = { login: 'frank', type: 'User', authorAssociation: 'NONE' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_3');
  });

  it('returns tier_3 for MANNEQUIN', () => {
    const author: CommentAuthor = { login: 'ghost', type: 'User', authorAssociation: 'MANNEQUIN' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_3');
  });

  it('returns tier_3 for unknown association value', () => {
    const author: CommentAuthor = { login: 'x', type: 'User', authorAssociation: 'SOMETHING_NEW' };
    expect(computeTrustTier(author, 'owner')).toBe('tier_3');
  });
});

// ---------------------------------------------------------------------------
// extractCommentAuthor
// ---------------------------------------------------------------------------

describe('extractCommentAuthor', () => {
  it('extracts author from a well-formed payload', () => {
    const payload = commentPayload({ body: 'hi', login: 'alice', userType: 'User', authorAssociation: 'OWNER', repoOwner: 'alice' });
    const author = extractCommentAuthor(payload);
    expect(author).toEqual({ login: 'alice', type: 'User', authorAssociation: 'OWNER' });
  });

  it('returns null when comment is missing', () => {
    expect(extractCommentAuthor({ action: 'created' })).toBeNull();
  });

  it('returns null when comment.user is missing', () => {
    expect(extractCommentAuthor({ comment: { body: 'hi', author_association: 'NONE' } })).toBeNull();
  });

  it('returns null when author_association is missing', () => {
    expect(extractCommentAuthor({ comment: { body: 'hi', user: { login: 'a', type: 'User' } } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractRepoOwnerLogin
// ---------------------------------------------------------------------------

describe('extractRepoOwnerLogin', () => {
  it('extracts owner login from a well-formed payload', () => {
    const payload = commentPayload({ body: 'hi', login: 'alice', repoOwner: 'bob' });
    expect(extractRepoOwnerLogin(payload)).toBe('bob');
  });

  it('returns null when repository is missing', () => {
    expect(extractRepoOwnerLogin({})).toBeNull();
  });

  it('returns null when repository.owner is missing', () => {
    expect(extractRepoOwnerLogin({ repository: { full_name: 'a/b' } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// filterEventType
// ---------------------------------------------------------------------------

describe('filterEventType', () => {
  describe('check_run events', () => {
    it('wakes on check_run completed+failure', () => {
      const payload = { action: 'completed', check_run: { conclusion: 'failure' } };
      expect(filterEventType('check_run', payload)).toEqual({ wakeable: true, trustTier: 'n/a', filterReason: 'wakeable' });
    });

    it('wakes on check_run completed+success', () => {
      const payload = { action: 'completed', check_run: { conclusion: 'success' } };
      expect(filterEventType('check_run', payload)).toEqual({ wakeable: true, trustTier: 'n/a', filterReason: 'wakeable' });
    });

    it('wakes on check_run completed+neutral', () => {
      const payload = { action: 'completed', check_run: { conclusion: 'neutral' } };
      expect(filterEventType('check_run', payload)).toEqual({ wakeable: true, trustTier: 'n/a', filterReason: 'wakeable' });
    });

    it('rejects check_run with action != completed', () => {
      const payload = { action: 'created', check_run: { conclusion: 'failure' } };
      expect(filterEventType('check_run', payload).wakeable).toBe(false);
    });
  });

  describe('tier 1 — repo owner comments', () => {
    it('wakes on issue_comment from repo owner (any body)', () => {
      const payload = commentPayload({ body: 'looks good', login: 'owner', authorAssociation: 'OWNER', repoOwner: 'owner' });
      const result = filterEventType('issue_comment', payload);
      expect(result).toEqual({ wakeable: true, trustTier: 'tier_1', filterReason: 'wakeable' });
    });

    it('wakes on pull_request_review_comment from repo owner', () => {
      const payload = commentPayload({ body: 'nit: rename this', login: 'owner', authorAssociation: 'OWNER', repoOwner: 'owner' });
      const result = filterEventType('pull_request_review_comment', payload);
      expect(result).toEqual({ wakeable: true, trustTier: 'tier_1', filterReason: 'wakeable' });
    });

    it('wakes on comment from github-actions[bot]', () => {
      const payload = commentPayload({ body: 'CI summary', login: 'github-actions[bot]', userType: 'Bot', authorAssociation: 'NONE', repoOwner: 'owner' });
      const result = filterEventType('issue_comment', payload);
      expect(result).toEqual({ wakeable: true, trustTier: 'tier_1', filterReason: 'wakeable' });
    });
  });

  describe('tier 2 — collaborator comments', () => {
    it('wakes on MEMBER comment with /agent prefix', () => {
      const payload = commentPayload({ body: '/agent fix tests', login: 'bob', authorAssociation: 'MEMBER', repoOwner: 'owner' });
      const result = filterEventType('issue_comment', payload);
      expect(result).toEqual({ wakeable: true, trustTier: 'tier_2', filterReason: 'wakeable' });
    });

    it('wakes on COLLABORATOR comment with /agent prefix', () => {
      const payload = commentPayload({ body: '/agent deploy', login: 'carol', authorAssociation: 'COLLABORATOR', repoOwner: 'owner' });
      const result = filterEventType('pull_request_review_comment', payload);
      expect(result).toEqual({ wakeable: true, trustTier: 'tier_2', filterReason: 'wakeable' });
    });

    it('does NOT wake on MEMBER comment without /agent prefix', () => {
      const payload = commentPayload({ body: 'looks good to me', login: 'bob', authorAssociation: 'MEMBER', repoOwner: 'owner' });
      const result = filterEventType('issue_comment', payload);
      expect(result).toEqual({ wakeable: false, trustTier: 'tier_2', filterReason: 'tier_2_no_command' });
    });

    it('does NOT wake on COLLABORATOR comment without /agent prefix', () => {
      const payload = commentPayload({ body: 'nice work', login: 'carol', authorAssociation: 'COLLABORATOR', repoOwner: 'owner' });
      const result = filterEventType('pull_request_review_comment', payload);
      expect(result).toEqual({ wakeable: false, trustTier: 'tier_2', filterReason: 'tier_2_no_command' });
    });
  });

  describe('tier 3 — untrusted comments', () => {
    it('does NOT wake on CONTRIBUTOR comment even with /agent', () => {
      const payload = commentPayload({ body: '/agent hack', login: 'dave', authorAssociation: 'CONTRIBUTOR', repoOwner: 'owner' });
      expect(filterEventType('issue_comment', payload)).toEqual({ wakeable: false, trustTier: 'tier_3', filterReason: 'tier_3_blocked' });
    });

    it('does NOT wake on FIRST_TIME_CONTRIBUTOR comment', () => {
      const payload = commentPayload({ body: '/agent inject', login: 'eve', authorAssociation: 'FIRST_TIME_CONTRIBUTOR', repoOwner: 'owner' });
      expect(filterEventType('issue_comment', payload)).toEqual({ wakeable: false, trustTier: 'tier_3', filterReason: 'tier_3_blocked' });
    });

    it('does NOT wake on NONE comment', () => {
      const payload = commentPayload({ body: '/agent do stuff', login: 'frank', authorAssociation: 'NONE', repoOwner: 'owner' });
      expect(filterEventType('issue_comment', payload)).toEqual({ wakeable: false, trustTier: 'tier_3', filterReason: 'tier_3_blocked' });
    });

    it('does NOT wake on MANNEQUIN comment', () => {
      const payload = commentPayload({ body: '/agent', login: 'ghost', authorAssociation: 'MANNEQUIN', repoOwner: 'owner' });
      expect(filterEventType('issue_comment', payload)).toEqual({ wakeable: false, trustTier: 'tier_3', filterReason: 'tier_3_blocked' });
    });

    it('does NOT wake on non-github-actions bot (dependabot)', () => {
      const payload = commentPayload({ body: 'bump deps', login: 'dependabot[bot]', userType: 'Bot', authorAssociation: 'NONE', repoOwner: 'owner' });
      expect(filterEventType('issue_comment', payload)).toEqual({ wakeable: false, trustTier: 'tier_3', filterReason: 'tier_3_blocked' });
    });
  });

  describe('edge cases', () => {
    it('rejects comment with action != created', () => {
      const payload = commentPayload({ body: '/agent fix', login: 'owner', authorAssociation: 'OWNER', repoOwner: 'owner', action: 'deleted' });
      expect(filterEventType('issue_comment', payload).wakeable).toBe(false);
    });

    it('returns tier_3 when trust fields are missing from comment', () => {
      const payload = { action: 'created', comment: { body: '/agent fix' }, repository: { full_name: 'a/b' } };
      const result = filterEventType('issue_comment', payload);
      expect(result).toEqual({ wakeable: false, trustTier: 'tier_3', filterReason: 'missing_trust_fields' });
    });

    it('rejects push events', () => {
      expect(filterEventType('push', { action: 'completed' }).wakeable).toBe(false);
    });

    it('rejects pull_request events', () => {
      expect(filterEventType('pull_request', { action: 'opened' }).wakeable).toBe(false);
    });

    it('rejects null payload', () => {
      expect(filterEventType('check_run', null).wakeable).toBe(false);
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
      getLastWakedAt: () => null,
      insertSession: () => undefined,
      insertOutboundComment: () => undefined,
      isOutboundComment: () => false,
      pruneOutboundComments: () => undefined,
      upsertPendingWake: () => undefined,
      getDuePendingWakes: () => [],
      clearPendingWake: () => undefined,
      getEventById: () => undefined,
      getCronState: () => null,
      setCronPaused: () => undefined,
      getAllCronStates: () => [],
      walCheckpoint: () => undefined,
      shutdown: () => Promise.resolve(),
      raw: (() => ({})) as unknown as Database['raw'],
      ...overrides,
    };
  }

  const config: AgentRouterConfig = {
    port: 3000,
    webhookSecret: 'secret',
    kiroPath: '/usr/bin/kiro',
    rateLimit: { perPRSeconds: 60 },
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    repos: [{ owner: 'myorg', name: 'myrepo' }],
    cron: [],
    controlPort: 3100,
    bindPublic: false,
    shutdownDrainSeconds: 60,
    credentialMode: 'env',
    reaper: { enabled: false, gracePeriodMinutes: 60, retentionDays: 30, agentRunsDir: '/tmp/agent-runs', sweepIntervalMinutes: 15 },
    idleTimeoutSeconds: 900,
    setupTimeoutSeconds: 120,
    taskTranscript: { archiveGraceMinutes: 60, retentionDays: 90, sweepIntervalMinutes: 30 },
    roadmap: { scanIntervalMinutes: 15 },
  };

  it('returns wake=true for check_run with trustTier=n/a', () => {
    const result = evaluateWakePolicy(makeEvent(), makeDb(), config);
    expect(result.wake).toBe(true);
    expect(result.sessionId).toBe('sess-abc');
    expect(result.prNumber).toBe(42);
    expect(result.trustTier).toBe('n/a');
  });

  it('returns wake=true for check_run success (not just failure)', () => {
    const event = makeEvent({
      payload: JSON.stringify({
        action: 'completed',
        check_run: {
          conclusion: 'success',
          pull_requests: [{ number: 42 }],
        },
      }),
    });
    const result = evaluateWakePolicy(event, makeDb(), config);
    expect(result.wake).toBe(true);
    expect(result.trustTier).toBe('n/a');
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

  it('wakes for tier 1 issue_comment (owner, any body)', () => {
    const event = makeEvent({
      eventType: 'issue_comment',
      payload: JSON.stringify({
        ...commentPayload({ body: 'just a note', login: 'owner', authorAssociation: 'OWNER', repoOwner: 'owner' }),
        issue: { number: 10, pull_request: { url: 'https://api.github.com/...' } },
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
    expect(result.trustTier).toBe('tier_1');
    expect(result.prNumber).toBe(10);
  });

  it('wakes for tier 2 issue_comment with /agent trigger', () => {
    const event = makeEvent({
      eventType: 'issue_comment',
      payload: JSON.stringify({
        ...commentPayload({ body: '/agent fix tests', login: 'bob', authorAssociation: 'MEMBER', repoOwner: 'owner' }),
        issue: { number: 10, pull_request: { url: 'https://api.github.com/...' } },
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
    expect(result.trustTier).toBe('tier_2');
  });

  it('does NOT wake for tier 3 issue_comment even with /agent', () => {
    const event = makeEvent({
      eventType: 'issue_comment',
      payload: JSON.stringify({
        ...commentPayload({ body: '/agent hack', login: 'stranger', authorAssociation: 'NONE', repoOwner: 'owner' }),
        issue: { number: 10, pull_request: { url: 'https://api.github.com/...' } },
      }),
    });
    const result = evaluateWakePolicy(event, makeDb(), config);
    expect(result.wake).toBe(false);
    expect(result.trustTier).toBe('tier_3');
  });

  it('works for pull_request_review_comment from owner', () => {
    const event = makeEvent({
      eventType: 'pull_request_review_comment',
      payload: JSON.stringify({
        ...commentPayload({ body: 'fix this', login: 'owner', authorAssociation: 'OWNER', repoOwner: 'owner' }),
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
    expect(result.trustTier).toBe('tier_1');
  });
});

// ---------------------------------------------------------------------------
// extractWebhookCommentId
// ---------------------------------------------------------------------------

describe('extractWebhookCommentId', () => {
  it('extracts comment id from issue_comment payload', () => {
    const payload = {
      action: 'created',
      comment: { id: 1234567890, body: 'hello', user: { login: 'alice', type: 'User' } },
    };
    expect(extractWebhookCommentId(payload)).toBe(1234567890);
  });

  it('returns null when comment is missing', () => {
    expect(extractWebhookCommentId({ action: 'created' })).toBeNull();
  });

  it('returns null when comment.id is missing', () => {
    expect(extractWebhookCommentId({ comment: { body: 'hi' } })).toBeNull();
  });

  it('returns null when comment.id is a string', () => {
    expect(extractWebhookCommentId({ comment: { id: 'abc' } })).toBeNull();
  });

  it('returns null when comment.id is a float', () => {
    expect(extractWebhookCommentId({ comment: { id: 1.5 } })).toBeNull();
  });

  it('returns null for null payload', () => {
    expect(extractWebhookCommentId(null)).toBeNull();
  });

  it('returns null for non-object payload', () => {
    expect(extractWebhookCommentId('string')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateWakePolicy — self-authored comment prevention
// ---------------------------------------------------------------------------

describe('evaluateWakePolicy — self-wake prevention', () => {
  function commentPayloadWithId(commentId: number): Record<string, unknown> {
    return {
      action: 'created',
      comment: {
        id: commentId,
        body: 'looks good',
        user: { login: 'owner', type: 'User' },
        author_association: 'OWNER',
      },
      issue: { number: 10, pull_request: { url: 'https://api.github.com/...' } },
      repository: {
        full_name: 'myorg/myrepo',
        owner: { login: 'owner' },
      },
    };
  }

  function makeEvent(commentId: number): QueuedEvent {
    return {
      id: 1,
      repo: 'myorg/myrepo',
      prNumber: 10,
      eventType: 'issue_comment',
      payload: JSON.stringify(commentPayloadWithId(commentId)),
      source: 'webhook',
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
        prNumber: 10,
        lastWakedAt: null,
      }),
      tryAcquireWakeSlot: () => true,
      getLastWakedAt: () => null,
      insertSession: () => undefined,
      insertOutboundComment: () => undefined,
      isOutboundComment: () => false,
      pruneOutboundComments: () => undefined,
      upsertPendingWake: () => undefined,
      getDuePendingWakes: () => [],
      clearPendingWake: () => undefined,
      getEventById: () => undefined,
      getCronState: () => null,
      setCronPaused: () => undefined,
      getAllCronStates: () => [],
      walCheckpoint: () => undefined,
      shutdown: () => Promise.resolve(),
      raw: (() => ({})) as unknown as Database['raw'],
      ...overrides,
    };
  }

  const config: AgentRouterConfig = {
    port: 3000,
    webhookSecret: 'secret',
    kiroPath: '/usr/bin/kiro',
    rateLimit: { perPRSeconds: 60 },
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    repos: [{ owner: 'myorg', name: 'myrepo' }],
    cron: [],
    controlPort: 3100,
    bindPublic: false,
    shutdownDrainSeconds: 60,
    credentialMode: 'env',
    reaper: { enabled: false, gracePeriodMinutes: 60, retentionDays: 30, agentRunsDir: '/tmp/agent-runs', sweepIntervalMinutes: 15 },
    idleTimeoutSeconds: 900,
    setupTimeoutSeconds: 120,
    taskTranscript: { archiveGraceMinutes: 60, retentionDays: 90, sweepIntervalMinutes: 30 },
    roadmap: { scanIntervalMinutes: 15 },
  };

  it('blocks wake when comment is self-authored (in outbound table)', () => {
    const db = makeDb({ isOutboundComment: (id: number) => id === 42 });
    const result = evaluateWakePolicy(makeEvent(42), db, config);
    expect(result.wake).toBe(false);
    expect(result.reason).toBe('self_authored');
  });

  it('allows wake when comment is NOT self-authored', () => {
    const db = makeDb({ isOutboundComment: () => false });
    const result = evaluateWakePolicy(makeEvent(42), db, config);
    expect(result.wake).toBe(true);
    expect(result.trustTier).toBe('tier_1');
  });

  it('skips self-authored check for check_run events (no comment.id)', () => {
    const event: QueuedEvent = {
      id: 1,
      repo: 'myorg/myrepo',
      prNumber: null,
      eventType: 'check_run',
      payload: JSON.stringify({
        action: 'completed',
        check_run: { conclusion: 'failure', pull_requests: [{ number: 10 }] },
      }),
      source: 'webhook',
    };
    // isOutboundComment always returns true, but check_run should bypass the check
    const db = makeDb({ isOutboundComment: () => true });
    const result = evaluateWakePolicy(event, db, config);
    expect(result.wake).toBe(true);
  });

  it('allows wake when comment has no id field', () => {
    const payload = {
      action: 'created',
      comment: {
        body: 'hello',
        user: { login: 'owner', type: 'User' },
        author_association: 'OWNER',
      },
      issue: { number: 10, pull_request: { url: 'https://...' } },
      repository: { full_name: 'myorg/myrepo', owner: { login: 'owner' } },
    };
    const event: QueuedEvent = {
      id: 1,
      repo: 'myorg/myrepo',
      prNumber: 10,
      eventType: 'issue_comment',
      payload: JSON.stringify(payload),
      source: 'webhook',
    };
    const db = makeDb({ isOutboundComment: () => true });
    const result = evaluateWakePolicy(event, db, config);
    // No comment.id → extractWebhookCommentId returns null → skip self-authored check
    expect(result.wake).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 6: Event type filtering (spec task 8.4)
// ---------------------------------------------------------------------------

describe('Property 6: Event type filtering', () => {
  // Arbitrary payload structure for comment events (issue_comment /
  // pull_request_review_comment).  We need the minimal fields that
  // filterEventType inspects: action, comment.user.login, comment.user.type,
  // comment.author_association, and repository.owner.login.
  const arbitraryCommentPayload = (action: string, authorAssoc: string, ownerLogin: string, commentBody: string) =>
    fc.record({
      action: fc.constant(action),
      comment: fc.record({
        body: fc.constant(commentBody),
        user: fc.record({
          login: fc.constant(ownerLogin),
          type: fc.constant('User'),
        }),
        author_association: fc.constant(authorAssoc),
      }),
      repository: fc.record({
        full_name: fc.constant(`${ownerLogin}/repo`),
        owner: fc.record({ login: fc.constant(ownerLogin) }),
      }),
      issue: fc.constant({ number: 1, pull_request: {} }),
    });

  // Any string that is NOT one of the three known event types
  const nonWakeableEventType = fc.string({ minLength: 1, maxLength: 40 }).filter(
    (s) => s !== 'check_run' && s !== 'issue_comment' && s !== 'pull_request_review_comment',
  );

  it('Property 6.1: unknown event types always produce wakeable:false with wrong_event_type', () => {
    fc.assert(
      fc.property(
        nonWakeableEventType,
        fc.anything(),
        (eventType, payload) => {
          const result = filterEventType(eventType, payload);
          return result.wakeable === false && result.filterReason === 'wrong_event_type';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.2: check_run with action=completed is always wakeable', () => {
    fc.assert(
      fc.property(
        fc.record({
          action: fc.constant('completed'),
          check_run: fc.record({
            conclusion: fc.string({ minLength: 1, maxLength: 20 }),
            pull_requests: fc.array(fc.record({ number: fc.nat({ max: 10000 }) }), { maxLength: 3 }),
          }),
        }),
        (payload) => {
          const result = filterEventType('check_run', payload);
          return result.wakeable === true && result.filterReason === 'wakeable';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.3: check_run with action !== completed is never wakeable', () => {
    const nonCompletedAction = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s !== 'completed');
    fc.assert(
      fc.property(
        nonCompletedAction,
        (action) => {
          const result = filterEventType('check_run', { action });
          return result.wakeable === false && result.filterReason === 'wrong_action';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.4: comment events with action !== created are never wakeable', () => {
    const nonCreatedAction = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s !== 'created');
    const commentEventType = fc.constantFrom('issue_comment', 'pull_request_review_comment');
    fc.assert(
      fc.property(
        commentEventType,
        nonCreatedAction,
        (eventType, action) => {
          const result = filterEventType(eventType, { action });
          return result.wakeable === false && result.filterReason === 'wrong_action';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.5: tier-1 comment events (owner) are always wakeable', () => {
    // Owner login match → tier_1 → wake regardless of body
    fc.assert(
      fc.property(
        fc.constantFrom('issue_comment', 'pull_request_review_comment'),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-z0-9-]+$/i.test(s)), // valid GitHub login chars
        fc.string({ minLength: 0, maxLength: 200 }), // any comment body
        (eventType, ownerLogin, body) => {
          const payload = {
            action: 'created',
            comment: {
              body,
              user: { login: ownerLogin, type: 'User' },
              author_association: 'OWNER',
            },
            repository: {
              full_name: `${ownerLogin}/repo`,
              owner: { login: ownerLogin },
            },
            issue: { number: 1, pull_request: {} },
            pull_request: { number: 1 },
          };
          const result = filterEventType(eventType, payload);
          return result.wakeable === true && result.trustTier === 'tier_1';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.6: tier-2 comment events (MEMBER) wake only when body starts with /agent', () => {
    const commandBody = fc.oneof(
      fc.constant('/agent'),
      fc.string({ minLength: 1, maxLength: 100 }).map((s) => `/agent ${s}`),
      fc.string({ minLength: 1, maxLength: 100 }).map((s) => `/agent\n${s}`),
    );
    const nonCommandBody = fc.string({ minLength: 0, maxLength: 100 }).filter(
      (s) => !s.startsWith('/agent') || (s.length > 6 && s[6] !== ' ' && s[6] !== '\n'),
    ).filter((s) => s !== '/agent');

    fc.assert(
      fc.property(
        fc.constantFrom('issue_comment', 'pull_request_review_comment'),
        commandBody,
        (eventType, body) => {
          const payload = {
            action: 'created',
            comment: {
              body,
              user: { login: 'collab', type: 'User' },
              author_association: 'MEMBER',
            },
            repository: {
              full_name: 'owner/repo',
              owner: { login: 'owner' },
            },
            issue: { number: 1, pull_request: {} },
            pull_request: { number: 1 },
          };
          const result = filterEventType(eventType, payload);
          return result.wakeable === true && result.trustTier === 'tier_2';
        },
      ),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(
        fc.constantFrom('issue_comment', 'pull_request_review_comment'),
        nonCommandBody,
        (eventType, body) => {
          const payload = {
            action: 'created',
            comment: {
              body,
              user: { login: 'collab', type: 'User' },
              author_association: 'MEMBER',
            },
            repository: {
              full_name: 'owner/repo',
              owner: { login: 'owner' },
            },
            issue: { number: 1, pull_request: {} },
            pull_request: { number: 1 },
          };
          const result = filterEventType(eventType, payload);
          return result.wakeable === false && result.trustTier === 'tier_2';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.7: tier-3 comment events (NONE) are never wakeable', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('issue_comment', 'pull_request_review_comment'),
        fc.string({ minLength: 0, maxLength: 200 }), // any body including /agent
        (eventType, body) => {
          const payload = {
            action: 'created',
            comment: {
              body,
              user: { login: 'outsider', type: 'User' },
              author_association: 'NONE',
            },
            repository: {
              full_name: 'owner/repo',
              owner: { login: 'owner' },
            },
            issue: { number: 1, pull_request: {} },
            pull_request: { number: 1 },
          };
          const result = filterEventType(eventType, payload);
          return result.wakeable === false && result.trustTier === 'tier_3';
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: PR number resolution (spec task 8.5)
// ---------------------------------------------------------------------------

describe('Property 7: PR number resolution', () => {
  it('Property 7.1: pull_request_review_comment with valid pull_request.number returns it', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100000 }),
        (prNumber) => {
          const payload = { pull_request: { number: prNumber } };
          const result = resolvePRNumber('pull_request_review_comment', payload);
          return result === prNumber;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 7.2: pull_request_review_comment without pull_request.number returns null', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant({}),
          fc.constant({ pull_request: null }),
          fc.constant({ pull_request: {} }),
          fc.constant({ pull_request: { number: 'not-a-number' } }),
          fc.constant({ pull_request: { number: true } }),
        ),
        (payload) => {
          const result = resolvePRNumber('pull_request_review_comment', payload);
          return result === null;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('Property 7.3: issue_comment without issue.pull_request always returns null', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100000 }),
        (issueNumber) => {
          const payload = { issue: { number: issueNumber } }; // no pull_request field
          const result = resolvePRNumber('issue_comment', payload);
          return result === null;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 7.4: issue_comment with issue.pull_request and valid number returns it', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100000 }),
        (prNumber) => {
          const payload = {
            issue: { number: prNumber, pull_request: { url: 'https://github.com/...' } },
          };
          const result = resolvePRNumber('issue_comment', payload);
          return result === prNumber;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 7.5: check_run with pull_requests[0].number returns it', () => {
    fc.assert(
      fc.property(
        fc.record({ number: fc.nat({ max: 100000 }) }),
        fc.array(
          fc.record({ number: fc.nat({ max: 100000 }) }),
          { minLength: 0, maxLength: 4 },
        ),
        (firstPr, otherPrs) => {
          const prs = [firstPr, ...otherPrs];
          const payload = { check_run: { pull_requests: prs } };
          const result = resolvePRNumber('check_run', payload);
          return result === firstPr.number;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 7.6: check_run with empty pull_requests returns null', () => {
    const result = resolvePRNumber('check_run', { check_run: { pull_requests: [] } });
    expect(result).toBeNull();
  });

  it('Property 7.7: non-null return is always a positive integer', () => {
    const knownEventTypes = ['check_run', 'issue_comment', 'pull_request_review_comment'];
    fc.assert(
      fc.property(
        fc.constantFrom(...knownEventTypes),
        fc.anything(),
        (eventType, payload) => {
          const result = resolvePRNumber(eventType, payload);
          if (result === null) return true;
          return Number.isInteger(result) && result > 0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property 7.8: unknown event types always return null', () => {
    const unknownEventType = fc.string({ minLength: 1, maxLength: 40 }).filter(
      (s) => !['check_run', 'issue_comment', 'pull_request_review_comment'].includes(s),
    );
    fc.assert(
      fc.property(
        unknownEventType,
        fc.anything(),
        (eventType, payload) => {
          return resolvePRNumber(eventType, payload) === null;
        },
      ),
      { numRuns: 100 },
    );
  });
});

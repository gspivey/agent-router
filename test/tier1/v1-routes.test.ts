import { describe, it, expect } from 'vitest';
import {
  serializeTask,
  serializeAttempt,
  serializeAttemptSummary,
  validateTaskStateParam,
  validateSinceParam,
} from '../../src/v1-routes.js';
import type { AttemptRecord, TaskRecord } from '../../src/task-types.js';

/**
 * Tier 1 tests for the pure `/v1` serializers and validators (task 10.1):
 * ISO-8601 timestamp rendering, the top-level `pr_url` mirror of
 * `artifacts.pr_url`, the `blocked` field passthrough, and the `state`/`since`
 * param validators.
 */

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    externalId: null,
    repo: 'o/r',
    source: 'api',
    sourceRef: null,
    title: 'Title',
    spec: 'Spec',
    baseRef: null,
    agent: 'kiro',
    budget: null,
    metadata: null,
    state: 'queued',
    resumeSessionId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    taskId: 'task-1',
    attemptNo: 1,
    sessionId: 'sess-1',
    worktreeBranch: 'agent/attempt-1',
    worktreePath: '/tmp/agent-runs/attempt-1',
    state: 'ended',
    leaseExpiresAt: null,
    outcome: 'succeeded',
    failureClass: null,
    reasonCode: null,
    reason: null,
    blocked: null,
    artifacts: { pr_url: 'https://github.com/o/r/pull/7' },
    usage: { wall_ms: 1234 },
    agentVersion: 'v1',
    model: 'auto',
    promptHash: 'abc',
    pid: null,
    pgid: null,
    processStartTime: null,
    processCmdline: null,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...overrides,
  };
}

describe('serializeTask', () => {
  it('renders timestamps as ISO 8601 and preserves fields', () => {
    const s = serializeTask(makeTask({ externalId: 'ext-9', metadata: { k: 'v' } }));
    expect(s.created_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(s.updated_at).toBe(new Date(1_700_000_000_500).toISOString());
    expect(s.external_id).toBe('ext-9');
    expect(s.metadata).toEqual({ k: 'v' });
    expect(s.state).toBe('queued');
    // No raw unix-ms integers leak through.
    expect(typeof s.created_at).toBe('string');
  });

  it('maps null metadata to null', () => {
    expect(serializeTask(makeTask()).metadata).toBeNull();
  });
});

describe('serializeAttempt', () => {
  it('mirrors artifacts.pr_url to a top-level pr_url', () => {
    const s = serializeAttempt(makeAttempt());
    expect(s.pr_url).toBe('https://github.com/o/r/pull/7');
  });

  it('pr_url is null when artifacts has none', () => {
    const s = serializeAttempt(makeAttempt({ artifacts: { branch: 'x' } }));
    expect(s.pr_url).toBeNull();
  });

  it('surfaces the blocked object for a blocked attempt', () => {
    const s = serializeAttempt(
      makeAttempt({ outcome: 'blocked', blocked: { question: 'which?', needs: 'decision' } })
    );
    expect(s.blocked).toEqual({ question: 'which?', needs: 'decision' });
  });

  it('blocked is null for a non-blocked attempt', () => {
    expect(serializeAttempt(makeAttempt()).blocked).toBeNull();
  });

  it('renders started_at / ended_at as ISO 8601 with ended_at null when running', () => {
    const running = serializeAttempt(makeAttempt({ state: 'running', endedAt: null }));
    expect(running.ended_at).toBeNull();
    expect(running.started_at).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe('serializeAttemptSummary', () => {
  it('returns null when there is no attempt', () => {
    expect(serializeAttemptSummary(null)).toBeNull();
  });
  it('serializes when present', () => {
    expect(serializeAttemptSummary(makeAttempt())?.id).toBe('attempt-1');
  });
});

describe('validateTaskStateParam', () => {
  it('accepts every valid state', () => {
    for (const s of ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled']) {
      expect(validateTaskStateParam(s).valid).toBe(true);
    }
  });
  it('rejects an unknown state', () => {
    expect(validateTaskStateParam('nope').valid).toBe(false);
  });
});

describe('validateSinceParam', () => {
  it('defaults to 0 when absent or empty', () => {
    expect(validateSinceParam(undefined)).toEqual({ valid: true, since: 0 });
    expect(validateSinceParam('')).toEqual({ valid: true, since: 0 });
  });
  it('accepts a non-negative integer', () => {
    expect(validateSinceParam('42')).toEqual({ valid: true, since: 42 });
  });
  it('rejects a float', () => {
    expect(validateSinceParam('1.5').valid).toBe(false);
  });
  it('rejects a negative value', () => {
    expect(validateSinceParam('-1').valid).toBe(false);
  });
  it('rejects non-numeric junk', () => {
    expect(validateSinceParam('abc').valid).toBe(false);
  });
});

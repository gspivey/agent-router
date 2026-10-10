/**
 * Tier 1 tests: task service pure validators + state machine
 * (task-attempt-outcome, task 3.3).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  validateSubmitBody,
  parseBudget,
  validateTaskState,
  nextTaskStateForOutcome,
  canRetry,
  canCancel,
} from '../../src/task-service.js';
import type { AttemptOutcome, TaskState } from '../../src/task-types.js';

const REPOS = new Set(['owner/repo', 'owner/other']);

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo: 'owner/repo', title: 'Do a thing', spec: 'The full spec text', ...overrides };
}

describe('validateSubmitBody', () => {
  it('accepts a minimal valid body and applies defaults', () => {
    const r = validateSubmitBody(base(), REPOS);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.value.agent).toBe('kiro');
      expect(r.value.source).toBe('api');
      expect(r.value.baseRef).toBeNull();
      expect(r.value.externalId).toBeNull();
      expect(r.value.budget).toBeNull();
      expect(r.value.metadata).toBeNull();
    }
  });

  it('rejects a non-object body', () => {
    for (const bad of [null, undefined, 42, 'str', [1, 2]]) {
      const r = validateSubmitBody(bad, REPOS);
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.code).toBe('invalid_body');
    }
  });

  it('rejects missing required fields', () => {
    for (const field of ['repo', 'title', 'spec']) {
      const body = base();
      delete body[field];
      const r = validateSubmitBody(body, REPOS);
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.code).toBe('invalid_body');
    }
  });

  it('rejects a repo that is not configured', () => {
    const r = validateSubmitBody(base({ repo: 'owner/unknown' }), REPOS);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.code).toBe('invalid_repo');
  });

  it('rejects an invalid agent and accepts a known one', () => {
    const bad = validateSubmitBody(base({ agent: 'gpt' }), REPOS);
    expect(bad.valid).toBe(false);
    if (!bad.valid) expect(bad.code).toBe('invalid_agent');

    const good = validateSubmitBody(base({ agent: 'claude' }), REPOS);
    expect(good.valid).toBe(true);
    if (good.valid) expect(good.value.agent).toBe('claude');
  });

  it('preserves external_id, source_ref, base_ref, and metadata', () => {
    const r = validateSubmitBody(
      base({
        external_id: 'ext-1',
        source: 'roadmap',
        source_ref: 'ROADMAP.md#abc',
        base_ref: 'main',
        metadata: { k: 'v' },
      }),
      REPOS
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.value.externalId).toBe('ext-1');
      expect(r.value.source).toBe('roadmap');
      expect(r.value.sourceRef).toBe('ROADMAP.md#abc');
      expect(r.value.baseRef).toBe('main');
      expect(r.value.metadata).toEqual({ k: 'v' });
    }
  });

  it('rejects an invalid budget', () => {
    const r = validateSubmitBody(base({ budget: { max_wall_s: -1 } }), REPOS);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.code).toBe('invalid_budget');
  });
});

describe('parseBudget', () => {
  it('accepts known numeric fields and allow_resume', () => {
    const r = parseBudget({
      max_wall_s: 60,
      max_tokens: 1000,
      max_turns: 10,
      heartbeat_interval_s: 30,
      allow_resume: true,
    });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.value.allow_resume).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(parseBudget(42).valid).toBe(false);
    expect(parseBudget(null).valid).toBe(false);
  });

  it('rejects negative or non-numeric numeric fields', () => {
    expect(parseBudget({ max_tokens: -5 }).valid).toBe(false);
    expect(parseBudget({ max_tokens: 'lots' }).valid).toBe(false);
    expect(parseBudget({ max_wall_s: Infinity }).valid).toBe(false);
  });

  it('rejects a non-boolean allow_resume', () => {
    expect(parseBudget({ allow_resume: 'yes' }).valid).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(parseBudget({ max_cost: 10 }).valid).toBe(false);
  });
});

describe('validateTaskState', () => {
  it('accepts all valid states and rejects others', () => {
    for (const s of ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled']) {
      expect(validateTaskState(s)).toBe(true);
    }
    for (const s of ['done', 'pending', '', 'QUEUED']) {
      expect(validateTaskState(s)).toBe(false);
    }
  });
});

describe('nextTaskStateForOutcome', () => {
  const ALL_OUTCOMES: AttemptOutcome[] = [
    'succeeded',
    'failed',
    'blocked',
    'cancelled',
    'timed_out',
    'budget_exceeded',
    'interrupted',
  ];
  const VALID_STATES: TaskState[] = [
    'queued',
    'running',
    'succeeded',
    'failed',
    'blocked',
    'cancelled',
  ];

  it('maps each outcome to the correct terminal task state', () => {
    expect(nextTaskStateForOutcome('succeeded')).toBe('succeeded');
    expect(nextTaskStateForOutcome('blocked')).toBe('blocked');
    expect(nextTaskStateForOutcome('cancelled')).toBe('cancelled');
    expect(nextTaskStateForOutcome('failed')).toBe('failed');
    expect(nextTaskStateForOutcome('timed_out')).toBe('failed');
    expect(nextTaskStateForOutcome('budget_exceeded')).toBe('failed');
    // interrupted maps to failed, NOT queued (no auto-retry).
    expect(nextTaskStateForOutcome('interrupted')).toBe('failed');
  });

  it('is total over the outcome enum (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_OUTCOMES), (outcome) => {
        const next = nextTaskStateForOutcome(outcome);
        expect(VALID_STATES).toContain(next);
      }),
      { numRuns: 200 }
    );
  });
});

describe('canRetry / canCancel', () => {
  it('canRetry is true only for failed and blocked', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('blocked')).toBe(true);
    for (const s of ['queued', 'running', 'succeeded', 'cancelled'] as TaskState[]) {
      expect(canRetry(s)).toBe(false);
    }
  });

  it('canCancel is true for every non-terminal state', () => {
    for (const s of ['queued', 'running', 'failed', 'blocked'] as TaskState[]) {
      expect(canCancel(s)).toBe(true);
    }
    expect(canCancel('succeeded')).toBe(false);
    expect(canCancel('cancelled')).toBe(false);
  });
});

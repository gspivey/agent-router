/**
 * Tier 1 tests: task event broker pure helpers
 * (task-attempt-outcome, task 7.3).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveSince, envelopeFromRow } from '../../src/task-event-broker.js';
import type { TaskEventRecord, TaskRecord } from '../../src/task-types.js';

describe('resolveSince', () => {
  it('uses the larger of ?since and Last-Event-ID', () => {
    expect(resolveSince('5', '10')).toEqual({ valid: true, since: 10 });
    expect(resolveSince('20', '10')).toEqual({ valid: true, since: 20 });
  });

  it('uses whichever is present alone', () => {
    expect(resolveSince('7', undefined)).toEqual({ valid: true, since: 7 });
    expect(resolveSince(undefined, '9')).toEqual({ valid: true, since: 9 });
    expect(resolveSince('', '')).toEqual({ valid: true, since: 0 });
  });

  it('defaults to 0 when neither is present', () => {
    expect(resolveSince(undefined, undefined)).toEqual({ valid: true, since: 0 });
  });

  it('rejects non-integer values', () => {
    expect(resolveSince('abc', undefined)).toEqual({ valid: false });
    expect(resolveSince('1.5', undefined)).toEqual({ valid: false });
    expect(resolveSince(undefined, 'x')).toEqual({ valid: false });
    expect(resolveSince('-1', undefined)).toEqual({ valid: false });
  });

  it('property: result is the max of two valid non-negative integers', () => {
    fc.assert(
      fc.property(fc.nat(1_000_000), fc.nat(1_000_000), (a, b) => {
        const r = resolveSince(String(a), String(b));
        expect(r).toEqual({ valid: true, since: Math.max(a, b) });
      }),
      { numRuns: 200 }
    );
  });
});

function makeEvent(overrides: Partial<TaskEventRecord> = {}): TaskEventRecord {
  return {
    seq: 42,
    id: 'evt-1',
    ts: 1_700_000_000_000,
    type: 'attempt.started',
    repo: 'owner/repo',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    data: { attempt_no: 1 },
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    externalId: 'ext-9',
    repo: 'owner/repo',
    source: 'api',
    sourceRef: null,
    title: 't',
    spec: 's',
    baseRef: null,
    agent: 'kiro',
    budget: null,
    metadata: { team: 'core' },
    state: 'running',
    resumeSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('envelopeFromRow', () => {
  it('renders ts as ISO-8601 and sets v:1', () => {
    const env = envelopeFromRow(makeEvent(), makeTask());
    expect(env.v).toBe(1);
    expect(env.ts).toBe(new Date(1_700_000_000_000).toISOString());
    expect(env.seq).toBe(42);
    expect(env.type).toBe('attempt.started');
  });

  it('echoes external_id and metadata from the task', () => {
    const env = envelopeFromRow(makeEvent(), makeTask());
    expect(env.external_id).toBe('ext-9');
    expect(env.metadata).toEqual({ team: 'core' });
  });

  it('sets external_id/metadata to null when there is no task', () => {
    const env = envelopeFromRow(makeEvent({ taskId: null }), null);
    expect(env.external_id).toBeNull();
    expect(env.metadata).toBeNull();
  });

  it('null external_id when the task has none', () => {
    const env = envelopeFromRow(makeEvent(), makeTask({ externalId: null }));
    expect(env.external_id).toBeNull();
  });

  it('carries data through unchanged', () => {
    const env = envelopeFromRow(makeEvent({ data: { foo: 'bar', n: 3 } }), makeTask());
    expect(env.data).toEqual({ foo: 'bar', n: 3 });
  });
});

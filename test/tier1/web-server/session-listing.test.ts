import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateStatus,
  validateSince,
  validateLimit,
  filterSessions,
  metaToSummary,
} from '../../../src/web-routes.js';
import type { SessionMeta } from '../../../src/session-files.js';

function arbSessionMeta(): fc.Arbitrary<SessionMeta> {
  return fc.oneof(
    fc.record({
      session_id: fc.uuid(),
      original_prompt: fc.string({ minLength: 1, maxLength: 50 }),
      repo: fc.string({ minLength: 3, maxLength: 30 }),
      status: fc.constantFrom('active' as const, 'completed' as const, 'abandoned' as const, 'failed' as const),
      created_at: fc.integer({ min: 0, max: 2000000000 }),
      completed_at: fc.option(fc.integer({ min: 0, max: 2000000000 }), { nil: null }),
      termination_reason: fc.constantFrom(
        'timeout_inactivity' as const,
        'timeout_max_lifetime' as const,
        'completed' as const,
        'failed' as const,
        'terminated_cli' as const,
        'terminated_web' as const,
        'shutdown' as const,
        'merged' as const,
        'closed_without_merge' as const,
      ),
      prs: fc.array(
        fc.record({
          repo: fc.string({ minLength: 3, maxLength: 20 }),
          pr_number: fc.integer({ min: 1, max: 10000 }),
          registered_at: fc.integer({ min: 0, max: 2000000000 }),
        }),
        { maxLength: 3 },
      ),
    }),
    fc.record({
      session_id: fc.uuid(),
      original_prompt: fc.string({ minLength: 1, maxLength: 50 }),
      status: fc.constantFrom('active' as const, 'completed' as const, 'abandoned' as const, 'failed' as const),
      created_at: fc.integer({ min: 0, max: 2000000000 }),
      completed_at: fc.option(fc.integer({ min: 0, max: 2000000000 }), { nil: null }),
      prs: fc.array(
        fc.record({
          repo: fc.string({ minLength: 3, maxLength: 20 }),
          pr_number: fc.integer({ min: 1, max: 10000 }),
          registered_at: fc.integer({ min: 0, max: 2000000000 }),
        }),
        { maxLength: 3 },
      ),
    }),
  );
}

describe('Property 7: Session Listing Filter Invariants', () => {
  it('all returned sessions satisfy the status filter', () => {
    fc.assert(
      fc.property(
        fc.array(arbSessionMeta(), { maxLength: 20 }),
        fc.constantFrom('active' as const, 'completed' as const, 'abandoned' as const, 'failed' as const),
        fc.integer({ min: 1, max: 500 }),
        (sessions, status, limit) => {
          // Pre-sort by created_at desc (as listSessions would)
          const sorted = [...sessions].sort((a, b) => b.created_at - a.created_at);
          const results = filterSessions(sorted, status, undefined, limit);
          for (const r of results) {
            expect(r.status).toBe(status);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all returned sessions have created_at >= since', () => {
    fc.assert(
      fc.property(
        fc.array(arbSessionMeta(), { maxLength: 20 }),
        fc.integer({ min: 0, max: 2000000000 }),
        fc.integer({ min: 1, max: 500 }),
        (sessions, since, limit) => {
          const sorted = [...sessions].sort((a, b) => b.created_at - a.created_at);
          const results = filterSessions(sorted, undefined, since, limit);
          for (const r of results) {
            expect(r.created_at).toBeGreaterThanOrEqual(since);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('result length is <= min(limit, total matching)', () => {
    fc.assert(
      fc.property(
        fc.array(arbSessionMeta(), { maxLength: 50 }),
        fc.option(fc.constantFrom('active' as const, 'completed' as const, 'abandoned' as const, 'failed' as const), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 2000000000 }), { nil: undefined }),
        fc.integer({ min: 1, max: 500 }),
        (sessions, status, since, limit) => {
          const sorted = [...sessions].sort((a, b) => b.created_at - a.created_at);
          const results = filterSessions(sorted, status, since, limit);
          expect(results.length).toBeLessThanOrEqual(limit);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('results are sorted by created_at descending', () => {
    fc.assert(
      fc.property(
        fc.array(arbSessionMeta(), { maxLength: 20 }),
        fc.integer({ min: 1, max: 500 }),
        (sessions, limit) => {
          const sorted = [...sessions].sort((a, b) => b.created_at - a.created_at);
          const results = filterSessions(sorted, undefined, undefined, limit);
          for (let i = 1; i < results.length; i++) {
            expect(results[i]!.created_at).toBeLessThanOrEqual(results[i - 1]!.created_at);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 8: Session Summary Completeness', () => {
  it('summary contains all required fields with correct types', () => {
    fc.assert(
      fc.property(arbSessionMeta(), (meta) => {
        const summary = metaToSummary(meta);
        expect(typeof summary.session_id).toBe('string');
        expect(summary.repo === null || typeof summary.repo === 'string').toBe(true);
        expect(['active', 'completed', 'abandoned', 'failed']).toContain(summary.status);
        expect(typeof summary.created_at).toBe('number');
        expect(summary.created_at).toBeGreaterThanOrEqual(0);
        expect(summary.completed_at === null || typeof summary.completed_at === 'number').toBe(true);
        expect(summary.termination_reason === null || typeof summary.termination_reason === 'string').toBe(true);
        expect(Array.isArray(summary.prs)).toBe(true);
        for (const pr of summary.prs) {
          expect(typeof pr.repo).toBe('string');
          expect(typeof pr.pr_number).toBe('number');
          expect(typeof pr.registered_at).toBe('number');
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('validateStatus', () => {
  it('accepts valid statuses', () => {
    expect(validateStatus('active')).toBe(true);
    expect(validateStatus('completed')).toBe(true);
    expect(validateStatus('abandoned')).toBe(true);
    expect(validateStatus('failed')).toBe(true);
  });

  it('rejects invalid statuses', () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => !['active', 'completed', 'abandoned', 'failed'].includes(s)),
        (s) => {
          expect(validateStatus(s)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('validateSince', () => {
  it('accepts non-negative integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000000000 }), (n) => {
        expect(validateSince(String(n))).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects negative or non-integer values', () => {
    expect(validateSince('-1')).toBeNull();
    expect(validateSince('abc')).toBeNull();
    expect(validateSince('1.5')).toBeNull();
  });
});

describe('validateLimit', () => {
  it('accepts integers between 1 and 500', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (n) => {
        expect(validateLimit(String(n))).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects out-of-range values', () => {
    expect(validateLimit('0')).toBeNull();
    expect(validateLimit('501')).toBeNull();
    expect(validateLimit('-1')).toBeNull();
    expect(validateLimit('abc')).toBeNull();
  });
});

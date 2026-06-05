import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  mergeEvents,
  trackLastEventId,
  computeBackoff,
  statusToBadge,
  deriveWaitingFor,
  parseHashRoute,
} from '../../../src/ui/logic.js';
import type { SessionStatus, SSEEvent } from '../../../src/ui/logic.js';

const ALL_STATUSES: SessionStatus[] = ['active', 'completed', 'abandoned', 'failed'];

describe('ui/logic', () => {
  describe('computeBackoff', () => {
    it('always returns at least 1000ms', () => {
      fc.assert(
        fc.property(fc.nat(100), (attempt) => {
          expect(computeBackoff(attempt)).toBeGreaterThanOrEqual(1000);
        }),
        { numRuns: 100 },
      );
    });

    it('never exceeds 30000ms', () => {
      fc.assert(
        fc.property(fc.nat(100), (attempt) => {
          expect(computeBackoff(attempt)).toBeLessThanOrEqual(30000);
        }),
        { numRuns: 100 },
      );
    });

    it('is monotonically non-decreasing', () => {
      fc.assert(
        fc.property(fc.nat(99), (attempt) => {
          expect(computeBackoff(attempt + 1)).toBeGreaterThanOrEqual(computeBackoff(attempt));
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('mergeEvents (dedup)', () => {
    it('applying the same events twice yields no duplicates', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ id: fc.nat(1000), data: fc.string() }), { minLength: 1, maxLength: 20 }),
          (events) => {
            const merged = mergeEvents(events, events);
            const ids = merged.map((e) => e.id);
            const uniqueIds = new Set(ids);
            expect(ids.length).toBe(uniqueIds.size);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('result is sorted by id ascending', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ id: fc.nat(1000), data: fc.string() }), { maxLength: 20 }),
          fc.array(fc.record({ id: fc.nat(1000), data: fc.string() }), { maxLength: 20 }),
          (existing, incoming) => {
            const merged = mergeEvents(existing, incoming);
            for (let i = 1; i < merged.length; i++) {
              expect(merged[i]!.id).toBeGreaterThan(merged[i - 1]!.id);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('parseHashRoute', () => {
    it('produces valid parse results for arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string(), (hash) => {
          const result = parseHashRoute(hash);
          expect(result.view === 'list' || result.view === 'detail').toBe(true);
          if (result.view === 'detail') {
            expect(result.sessionId.length).toBeGreaterThan(0);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('parses #/sessions/<id> as detail view', () => {
      fc.assert(
        fc.property(
          fc.stringOf(fc.constantFrom(...'abcdef0123456789-'.split('')), { minLength: 1, maxLength: 36 }),
          (id) => {
            const result = parseHashRoute(`#/sessions/${id}`);
            expect(result).toEqual({ view: 'detail', sessionId: id });
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns list view for empty or #/', () => {
      expect(parseHashRoute('')).toEqual({ view: 'list' });
      expect(parseHashRoute('#/')).toEqual({ view: 'list' });
      expect(parseHashRoute('#')).toEqual({ view: 'list' });
    });
  });

  describe('statusToBadge', () => {
    it('covers all Session_Status values', () => {
      for (const status of ALL_STATUSES) {
        const badge = statusToBadge(status);
        expect(['green', 'gray', 'yellow', 'red']).toContain(badge);
      }
    });

    it('maps correctly', () => {
      expect(statusToBadge('active')).toBe('green');
      expect(statusToBadge('completed')).toBe('gray');
      expect(statusToBadge('abandoned')).toBe('yellow');
      expect(statusToBadge('failed')).toBe('red');
    });
  });

  describe('trackLastEventId', () => {
    it('returns the maximum of current and new', () => {
      fc.assert(
        fc.property(fc.nat(10000), fc.nat(10000), (current, newId) => {
          expect(trackLastEventId(current, newId)).toBe(Math.max(current, newId));
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('deriveWaitingFor', () => {
    it('returns undefined for session_ended', () => {
      expect(deriveWaitingFor('session_ended')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(deriveWaitingFor(undefined)).toBeUndefined();
    });

    it('returns a string for any non-terminal type', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter((s) => s !== 'session_ended'),
          (type) => {
            const result = deriveWaitingFor(type);
            expect(typeof result).toBe('string');
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

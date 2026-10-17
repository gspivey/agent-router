import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  mergeEvents,
  trackLastEventId,
  computeBackoff,
  statusToBadge,
  deriveWaitingFor,
  parseHashRoute,
  routeTitle,
  formatRelativeTime,
  groupLabelVisible,
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
          expect(
            result.view === 'overview' ||
              result.view === 'list' ||
              result.view === 'detail' ||
              result.view === 'config',
          ).toBe(true);
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

    it('returns overview view for empty or #/ (spa-polish ROADMAP 88, Req 9.1)', () => {
      expect(parseHashRoute('')).toEqual({ view: 'overview' });
      expect(parseHashRoute('#/')).toEqual({ view: 'overview' });
      expect(parseHashRoute('#')).toEqual({ view: 'overview' });
    });

    it('parses bare #/sessions as the session list (Req 9.2)', () => {
      expect(parseHashRoute('#/sessions')).toEqual({ view: 'list' });
    });

    it('parses #/config as the config view', () => {
      expect(parseHashRoute('#/config')).toEqual({ view: 'config' });
    });

    it('treats unrecognized hashes (e.g. #/config/, #/repos) as overview (Req 9.1 fallback)', () => {
      expect(parseHashRoute('#/config/').view).toBe('overview');
      expect(parseHashRoute('#/repos').view).toBe('overview');
    });
  });

  describe('routeTitle (spa-polish ROADMAP 88, Req 9.5)', () => {
    it('maps each view to its document title', () => {
      expect(routeTitle({ view: 'overview' })).toBe('Agent Router');
      expect(routeTitle({ view: 'list' })).toBe('Sessions · Agent Router');
      expect(routeTitle({ view: 'config' })).toBe('Config · Agent Router');
      expect(routeTitle({ view: 'detail', sessionId: 'x' })).toBe('Session · Agent Router');
    });
  });

  describe('formatRelativeTime (spa-polish ROADMAP 88, Req 11.3)', () => {
    const NOW = 1_000_000_000_000;
    it('buckets the elapsed time', () => {
      expect(formatRelativeTime(NOW, NOW)).toBe('just now');
      expect(formatRelativeTime(NOW, NOW - 30_000)).toBe('just now');
      expect(formatRelativeTime(NOW, NOW - 3 * 60_000)).toBe('3m ago');
      expect(formatRelativeTime(NOW, NOW - 2 * 3_600_000)).toBe('2h ago');
      expect(formatRelativeTime(NOW, NOW - 5 * 86_400_000)).toBe('5d ago');
    });

    it('clamps a future timestamp to "just now"', () => {
      expect(formatRelativeTime(NOW, NOW + 10_000)).toBe('just now');
    });

    it('is monotonic — a larger elapsed time never yields a smaller unit', () => {
      const rank = (s: string): number => {
        if (s === 'just now') return 0;
        if (s.endsWith('m ago')) return 1;
        if (s.endsWith('h ago')) return 2;
        return 3; // d ago
      };
      fc.assert(
        fc.property(fc.nat(20_000_000), fc.nat(20_000_000), (a, b) => {
          const smaller = Math.min(a, b);
          const larger = Math.max(a, b);
          const rankSmaller = rank(formatRelativeTime(NOW, NOW - smaller));
          const rankLarger = rank(formatRelativeTime(NOW, NOW - larger));
          expect(rankLarger).toBeGreaterThanOrEqual(rankSmaller);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('groupLabelVisible (spa-polish ROADMAP 88, Req 11.4)', () => {
    it('shows the label when there is no previous row', () => {
      expect(groupLabelVisible(null, { kind: 'agent', label: 'Agent' })).toBe(true);
    });

    it('hides the label only when kind AND label both match', () => {
      expect(
        groupLabelVisible({ kind: 'agent', label: 'Agent' }, { kind: 'agent', label: 'Agent' }),
      ).toBe(false);
    });

    it('shows the label when the label differs (same kind)', () => {
      expect(
        groupLabelVisible({ kind: 'prompt', label: 'You' }, { kind: 'prompt', label: 'Prompt' }),
      ).toBe(true);
    });

    it('shows the label when the kind differs', () => {
      expect(
        groupLabelVisible({ kind: 'agent', label: 'Agent' }, { kind: 'error', label: 'Agent' }),
      ).toBe(true);
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

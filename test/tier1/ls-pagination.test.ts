import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { selectVisibleSessions, DEFAULT_LS_LIMIT } from '../../src/ls-pagination.js';
import type { LsSession, SelectOptions } from '../../src/ls-pagination.js';

function makeSession(status: string, id?: string): LsSession & { session_id: string } {
  return { session_id: id ?? Math.random().toString(36).slice(2), status };
}

describe('selectVisibleSessions', () => {
  describe('default cap (limit = 20)', () => {
    it('returns all sessions when total <= limit', () => {
      const sessions = Array.from({ length: 15 }, (_, i) => makeSession('completed', `s${i}`));
      const result = selectVisibleSessions(sessions, { all: false, limit: DEFAULT_LS_LIMIT });
      expect(result).toHaveLength(15);
    });

    it('caps inactive sessions at limit when no active sessions', () => {
      const sessions = Array.from({ length: 30 }, (_, i) => makeSession('completed', `s${i}`));
      const result = selectVisibleSessions(sessions, { all: false, limit: DEFAULT_LS_LIMIT });
      expect(result).toHaveLength(20);
    });

    it('always includes active sessions even when over the cap', () => {
      const active = Array.from({ length: 25 }, (_, i) => makeSession('active', `a${i}`));
      const inactive = Array.from({ length: 10 }, (_, i) => makeSession('completed', `c${i}`));
      const sessions = [...active, ...inactive];
      const result = selectVisibleSessions(sessions, { all: false, limit: DEFAULT_LS_LIMIT });
      // All 25 active must appear; no room for inactive
      expect(result).toHaveLength(25);
      expect(result.every((s) => s.status === 'active')).toBe(true);
    });

    it('fills remaining slots with inactive sessions after active', () => {
      const active = Array.from({ length: 5 }, (_, i) => makeSession('active', `a${i}`));
      const inactive = Array.from({ length: 30 }, (_, i) => makeSession('completed', `c${i}`));
      const sessions = [...active, ...inactive];
      const result = selectVisibleSessions(sessions, { all: false, limit: DEFAULT_LS_LIMIT });
      // 5 active + 15 inactive = 20
      expect(result).toHaveLength(20);
      expect(result.filter((s) => s.status === 'active')).toHaveLength(5);
      expect(result.filter((s) => s.status !== 'active')).toHaveLength(15);
    });
  });

  describe('--all flag', () => {
    it('returns every session regardless of count', () => {
      const sessions = Array.from({ length: 100 }, (_, i) => makeSession('completed', `s${i}`));
      const result = selectVisibleSessions(sessions, { all: true, limit: DEFAULT_LS_LIMIT });
      expect(result).toHaveLength(100);
    });
  });

  describe('--limit N override', () => {
    it('respects a custom limit', () => {
      const sessions = Array.from({ length: 50 }, (_, i) => makeSession('completed', `s${i}`));
      const result = selectVisibleSessions(sessions, { all: false, limit: 10 });
      expect(result).toHaveLength(10);
    });

    it('active sessions still shown when custom limit is small', () => {
      const active = Array.from({ length: 3 }, (_, i) => makeSession('active', `a${i}`));
      const inactive = Array.from({ length: 50 }, (_, i) => makeSession('completed', `c${i}`));
      const sessions = [...active, ...inactive];
      const result = selectVisibleSessions(sessions, { all: false, limit: 5 });
      // 3 active + 2 inactive = 5
      expect(result).toHaveLength(5);
      expect(result.filter((s) => s.status === 'active')).toHaveLength(3);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty input', () => {
      const result = selectVisibleSessions([], { all: false, limit: DEFAULT_LS_LIMIT });
      expect(result).toHaveLength(0);
    });

    it('limit of 0 still shows active sessions', () => {
      const active = [makeSession('active', 'a1')];
      const inactive = [makeSession('completed', 'c1')];
      const result = selectVisibleSessions([...active, ...inactive], { all: false, limit: 0 });
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe('active');
    });

    it('DEFAULT_LS_LIMIT is 20', () => {
      expect(DEFAULT_LS_LIMIT).toBe(20);
    });
  });

  describe('property tests', () => {
    const sessionArb = fc.record({
      session_id: fc.uuid(),
      status: fc.oneof(fc.constant('active'), fc.constant('completed'), fc.constant('failed'), fc.constant('abandoned')),
    });

    const optsArb = fc.record({
      all: fc.boolean(),
      limit: fc.integer({ min: 0, max: 200 }),
    });

    it('active sessions are never dropped', () => {
      fc.assert(
        fc.property(fc.array(sessionArb, { minLength: 0, maxLength: 100 }), optsArb, (sessions, opts) => {
          const result = selectVisibleSessions(sessions, opts);
          const activeInput = sessions.filter((s) => s.status === 'active');
          const activeOutput = result.filter((s) => s.status === 'active');
          expect(activeOutput).toHaveLength(activeInput.length);
        }),
        { numRuns: 200 },
      );
    });

    it('result length <= total sessions', () => {
      fc.assert(
        fc.property(fc.array(sessionArb, { minLength: 0, maxLength: 100 }), optsArb, (sessions, opts) => {
          const result = selectVisibleSessions(sessions, opts);
          expect(result.length).toBeLessThanOrEqual(sessions.length);
        }),
        { numRuns: 200 },
      );
    });

    it('--all always returns everything', () => {
      fc.assert(
        fc.property(fc.array(sessionArb, { minLength: 0, maxLength: 100 }), fc.integer({ min: 0, max: 200 }), (sessions, limit) => {
          const result = selectVisibleSessions(sessions, { all: true, limit });
          expect(result).toHaveLength(sessions.length);
        }),
        { numRuns: 200 },
      );
    });

    it('without --all, inactive count <= max(0, limit - activeCount)', () => {
      fc.assert(
        fc.property(fc.array(sessionArb, { minLength: 0, maxLength: 100 }), fc.integer({ min: 0, max: 200 }), (sessions, limit) => {
          const result = selectVisibleSessions(sessions, { all: false, limit });
          const activeCount = sessions.filter((s) => s.status === 'active').length;
          const inactiveInResult = result.filter((s) => s.status !== 'active').length;
          expect(inactiveInResult).toBeLessThanOrEqual(Math.max(0, limit - activeCount));
        }),
        { numRuns: 200 },
      );
    });
  });
});

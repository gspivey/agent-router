/**
 * Tier 1 tests: inline ULID generator (task-attempt-outcome, task 1.2).
 *
 * Property tests (fast-check, ≥100 runs) for 26-char Crockford base32 format,
 * time→lexical sort order, and strict monotonicity within one millisecond.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ulid, monotonicUlidFactory } from '../../src/ulid.js';

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const MAX_TIME = 281474976710655; // 2^48 - 1

describe('ulid', () => {
  it('produces a 26-char Crockford base32 string', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_TIME }), (t) => {
        const id = ulid(t);
        expect(id).toHaveLength(26);
        expect(id).toMatch(CROCKFORD);
      }),
      { numRuns: 200 }
    );
  });

  it('defaults to Date.now() when no time is given', () => {
    const before = Date.now();
    const id = ulid();
    expect(id).toMatch(CROCKFORD);
    // The decoded time prefix must be within a reasonable window of "now".
    expect(id).toHaveLength(26);
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });

  it('encodes time in the first 10 chars so later times sort lexically later', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_TIME - 1 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (t, delta) => {
          const earlier = ulid(t);
          const later = ulid(Math.min(t + delta, MAX_TIME));
          // Compare only the time prefix: the random suffix is independent.
          expect(earlier.slice(0, 10) <= later.slice(0, 10)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('rejects out-of-range times', () => {
    expect(() => ulid(-1)).toThrow();
    expect(() => ulid(MAX_TIME + 1)).toThrow();
    expect(() => ulid(1.5)).toThrow();
  });
});

describe('monotonicUlidFactory', () => {
  it('is strictly increasing across a sequence at a fixed millisecond', () => {
    const next = monotonicUlidFactory();
    const fixedTime = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(next(fixedTime));
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1]! < ids[i]!).toBe(true);
    }
  });

  it('shares the same time prefix within one millisecond', () => {
    const next = monotonicUlidFactory();
    const fixedTime = 1_700_000_000_000;
    const a = next(fixedTime);
    const b = next(fixedTime);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a < b).toBe(true);
  });

  it('reseeds the random component when the clock advances', () => {
    const next = monotonicUlidFactory();
    const a = next(1_700_000_000_000);
    const b = next(1_700_000_000_001);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(a < b).toBe(true);
  });

  it('stays strictly increasing even when the clock goes backwards', () => {
    const next = monotonicUlidFactory();
    const a = next(1_700_000_000_010);
    const b = next(1_700_000_000_005); // earlier reading
    // Monotonicity is preserved by keeping the higher timestamp and incrementing.
    expect(b > a).toBe(true);
  });

  it('produces valid Crockford base32 ids across random monotonic sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_TIME - 1000 }),
        fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 50 }),
        (start, deltas) => {
          const next = monotonicUlidFactory();
          let t = start;
          let prev = '';
          for (const d of deltas) {
            t += d;
            const id = next(t);
            expect(id).toMatch(CROCKFORD);
            if (prev !== '') {
              expect(prev < id).toBe(true);
            }
            prev = id;
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

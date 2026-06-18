/**
 * Tier 1 tests for fetch resilience pure functions (src/ui/logic.ts).
 * Covers: isRetryableStatus, classifyFetchError, computeFetchRetryDelay.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { isRetryableStatus, classifyFetchError, computeFetchRetryDelay } from '../../src/ui/logic.js';

describe('isRetryableStatus', () => {
  it('returns true for 5xx status codes', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it('returns false for 401', () => {
    expect(isRetryableStatus(401)).toBe(false);
  });

  it('returns false for 2xx', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(201)).toBe(false);
  });

  it('returns false for other 4xx', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(429)).toBe(false);
  });

  it('property: all 5xx are retryable', () => {
    fc.assert(
      fc.property(fc.integer({ min: 500, max: 599 }), (status) => {
        expect(isRetryableStatus(status)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('property: no 4xx are retryable', () => {
    fc.assert(
      fc.property(fc.integer({ min: 400, max: 499 }), (status) => {
        expect(isRetryableStatus(status)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('classifyFetchError', () => {
  it('classifies 401 as auth', () => {
    expect(classifyFetchError(401)).toBe('auth');
  });

  it('classifies 5xx as network', () => {
    expect(classifyFetchError(500)).toBe('network');
    expect(classifyFetchError(503)).toBe('network');
  });

  it('classifies other errors as network', () => {
    expect(classifyFetchError(400)).toBe('network');
  });
});

describe('computeFetchRetryDelay', () => {
  it('returns base delay on attempt 0', () => {
    expect(computeFetchRetryDelay(0)).toBe(500);
  });

  it('doubles with each attempt', () => {
    expect(computeFetchRetryDelay(0)).toBe(500);
    expect(computeFetchRetryDelay(1)).toBe(1000);
    expect(computeFetchRetryDelay(2)).toBe(2000);
    expect(computeFetchRetryDelay(3)).toBe(4000);
  });

  it('caps at maxMs', () => {
    expect(computeFetchRetryDelay(4)).toBe(5000);
    expect(computeFetchRetryDelay(10)).toBe(5000);
  });

  it('accepts custom base and max', () => {
    expect(computeFetchRetryDelay(0, 100, 1000)).toBe(100);
    expect(computeFetchRetryDelay(3, 100, 1000)).toBe(800);
    expect(computeFetchRetryDelay(4, 100, 1000)).toBe(1000);
  });

  it('property: delay never exceeds maxMs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 100, max: 2000 }),
        fc.integer({ min: 1000, max: 60000 }),
        (attempt, base, max) => {
          expect(computeFetchRetryDelay(attempt, base, max)).toBeLessThanOrEqual(max);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: delay is always positive', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (attempt) => {
        expect(computeFetchRetryDelay(attempt)).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});

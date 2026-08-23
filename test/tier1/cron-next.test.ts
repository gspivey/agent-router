import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getNextCronFire } from '../../src/cron-next.js';

describe('getNextCronFire', () => {
  const baseDate = new Date('2026-08-23T12:00:00Z');

  it('returns the next minute for every-minute expression', () => {
    const result = getNextCronFire('* * * * *', baseDate);
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBe(new Date('2026-08-23T12:01:00Z').getTime());
  });

  it('returns the next occurrence for a specific hour', () => {
    // Every day at 15:30 UTC
    const result = getNextCronFire('30 15 * * *', baseDate);
    expect(result).not.toBeNull();
    expect(result!.getUTCHours()).toBe(15);
    expect(result!.getUTCMinutes()).toBe(30);
    // Should be same day since 15:30 > 12:00
    expect(result!.getUTCDate()).toBe(23);
  });

  it('advances to next day when hour has passed', () => {
    const lateDate = new Date('2026-08-23T16:00:00Z');
    // Every day at 15:30 UTC — already past
    const result = getNextCronFire('30 15 * * *', lateDate);
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(24);
    expect(result!.getUTCHours()).toBe(15);
    expect(result!.getUTCMinutes()).toBe(30);
  });

  it('handles day-of-week constraint (Mon-Fri)', () => {
    // 2026-08-23 is a Sunday, next Mon-Fri is Aug 24 (Monday)
    const result = getNextCronFire('0 9 * * 1-5', baseDate);
    expect(result).not.toBeNull();
    expect(result!.getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(result!.getUTCDay()).toBeLessThanOrEqual(5);
    expect(result!.getUTCHours()).toBe(9);
    expect(result!.getUTCMinutes()).toBe(0);
  });

  it('handles step intervals (every 10 minutes)', () => {
    const result = getNextCronFire('*/10 * * * *', baseDate);
    expect(result).not.toBeNull();
    expect(result!.getUTCMinutes() % 10).toBe(0);
    // Should be 12:10 (next 10-min mark after 12:00)
    expect(result!.getTime()).toBe(new Date('2026-08-23T12:10:00Z').getTime());
  });

  it('handles lists (1,15,30)', () => {
    const result = getNextCronFire('1,15,30 * * * *', baseDate);
    expect(result).not.toBeNull();
    expect([1, 15, 30]).toContain(result!.getUTCMinutes());
    expect(result!.getTime()).toBe(new Date('2026-08-23T12:01:00Z').getTime());
  });

  it('returns null for invalid expression', () => {
    expect(getNextCronFire('invalid', baseDate)).toBeNull();
    expect(getNextCronFire('* *', baseDate)).toBeNull();
    expect(getNextCronFire('', baseDate)).toBeNull();
    expect(getNextCronFire('60 * * * *', baseDate)).toBeNull();
  });

  it('uses current time when now is not provided', () => {
    const result = getNextCronFire('* * * * *');
    expect(result).not.toBeNull();
    // Should be within a reasonable range of "now"
    const diff = result!.getTime() - Date.now();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(60_000);
  });

  it('property: result is always strictly after now', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        (now) => {
          const result = getNextCronFire('* * * * *', now);
          if (result !== null) {
            expect(result.getTime()).toBeGreaterThan(now.getTime());
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: result matches the cron expression minute field', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        (minute, now) => {
          const result = getNextCronFire(`${minute} * * * *`, now);
          if (result !== null) {
            expect(result.getUTCMinutes()).toBe(minute);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: result matches the cron expression hour field', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 23 }),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        (hour, now) => {
          const result = getNextCronFire(`0 ${hour} * * *`, now);
          if (result !== null) {
            expect(result.getUTCHours()).toBe(hour);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Tier 1 tests: getCronScheduleState + nextCronFire — pure logic.
 * Spec: .kiro/specs/web-ui-config-view/ · task 2b
 */
import { describe, it, expect } from 'vitest';
import {
  nextCronFire,
  getCronScheduleState,
  parseCronFields,
  expandField,
} from '../../src/cron-state.js';
import type { CronConfig } from '../../src/config.js';
import type { CronState } from '../../src/db.js';

describe('expandField', () => {
  it('expands wildcard for minutes', () => {
    const result = expandField('*', 0, 59);
    expect(result).toHaveLength(60);
    expect(result[0]).toBe(0);
    expect(result[59]).toBe(59);
  });

  it('expands a single value', () => {
    expect(expandField('5', 0, 59)).toEqual([5]);
  });

  it('expands a range', () => {
    expect(expandField('1-5', 0, 59)).toEqual([1, 2, 3, 4, 5]);
  });

  it('expands a step', () => {
    expect(expandField('*/15', 0, 59)).toEqual([0, 15, 30, 45]);
  });

  it('expands a range with step', () => {
    expect(expandField('1-10/3', 0, 59)).toEqual([1, 4, 7, 10]);
  });

  it('expands a list', () => {
    expect(expandField('1,5,10', 0, 59)).toEqual([1, 5, 10]);
  });

  it('clamps to max', () => {
    expect(expandField('28-32', 1, 31)).toEqual([28, 29, 30, 31]);
  });
});

describe('parseCronFields', () => {
  it('parses a standard 5-field expression', () => {
    const result = parseCronFields('0 9 * * 1-5');
    expect(result).not.toBeNull();
    expect(result!.minutes).toEqual([0]);
    expect(result!.hours).toEqual([9]);
    expect(result!.daysOfMonth).toHaveLength(31);
    expect(result!.months).toHaveLength(12);
    expect(result!.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns null for invalid field count', () => {
    expect(parseCronFields('0 9 * *')).toBeNull();
    expect(parseCronFields('0 9 * * * *')).toBeNull();
  });

  it('normalizes day-of-week 7 to 0 (Sunday)', () => {
    const result = parseCronFields('0 0 * * 7');
    expect(result).not.toBeNull();
    expect(result!.daysOfWeek).toContain(0);
  });
});

describe('nextCronFire', () => {
  it('computes next fire for a simple daily schedule', () => {
    // "0 9 * * *" = daily at 09:00
    const after = new Date('2026-08-23T08:00:00Z');
    const result = nextCronFire('0 9 * * *', after);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-08-23T09:00:00.000Z');
  });

  it('advances to next day if already past the hour', () => {
    const after = new Date('2026-08-23T10:00:00Z');
    const result = nextCronFire('0 9 * * *', after);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-08-24T09:00:00.000Z');
  });

  it('respects day-of-week (Mon-Fri)', () => {
    // 2026-08-23 is a Sunday. Next weekday is Monday 2026-08-24.
    const after = new Date('2026-08-23T10:00:00Z');
    const result = nextCronFire('0 9 * * 1-5', after);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-08-24T09:00:00.000Z');
  });

  it('handles every-15-minutes schedule', () => {
    const after = new Date('2026-08-23T10:02:00Z');
    const result = nextCronFire('*/15 * * * *', after);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-08-23T10:15:00.000Z');
  });

  it('returns null for invalid cron expression', () => {
    expect(nextCronFire('invalid', new Date())).toBeNull();
  });

  it('handles monthly schedule', () => {
    // "0 0 1 * *" = midnight on the 1st of each month
    const after = new Date('2026-08-15T00:00:00Z');
    const result = nextCronFire('0 0 1 * *', after);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('handles specific months', () => {
    // "0 0 1 6 *" = midnight on June 1st
    const after = new Date('2026-08-01T00:00:00Z');
    const result = nextCronFire('0 0 1 6 *', after);
    expect(result).not.toBeNull();
    // Next June 1st is 2027
    expect(result!.getUTCFullYear()).toBe(2027);
    expect(result!.getUTCMonth()).toBe(5); // June is 0-indexed to 5
    expect(result!.getUTCDate()).toBe(1);
  });
});

describe('getCronScheduleState', () => {
  const now = new Date('2026-08-23T12:00:00Z');

  const cronConfigs: CronConfig[] = [
    { name: 'nightly', schedule: '0 3 * * *', repo: 'owner/repo', promptFile: '/path/to/prompt.md' },
    { name: 'weekday-review', schedule: '0 9 * * 1-5', repo: 'owner/other', promptFile: '/path/other.md' },
  ];

  it('returns entries with correct next fire times', () => {
    const cronStates: CronState[] = [];
    const result = getCronScheduleState(cronConfigs, cronStates, now);

    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('nightly');
    expect(result[0]!.repo).toBe('owner/repo');
    expect(result[0]!.schedule).toBe('0 3 * * *');
    expect(result[0]!.paused).toBe(false);
    expect(result[0]!.nextFireTime).not.toBeNull();
    // Next 03:00 after 2026-08-23T12:00:00Z is 2026-08-24T03:00:00Z
    expect(result[0]!.nextFireTime).toBe('2026-08-24T03:00:00.000Z');
  });

  it('marks paused entries correctly', () => {
    const cronStates: CronState[] = [
      { name: 'nightly', paused: true, updatedAt: 1000 },
    ];
    const result = getCronScheduleState(cronConfigs, cronStates, now);

    expect(result[0]!.paused).toBe(true);
    expect(result[0]!.nextFireTime).toBeNull(); // No next fire when paused
    expect(result[1]!.paused).toBe(false);
    expect(result[1]!.nextFireTime).not.toBeNull();
  });

  it('returns empty array for empty config', () => {
    expect(getCronScheduleState([], [], now)).toEqual([]);
  });

  it('returns nextFireTime: null for invalid cron expression', () => {
    const invalidConfigs: CronConfig[] = [
      { name: 'broken', schedule: 'invalid cron', repo: 'o/r', promptFile: '/p' },
    ];
    const result = getCronScheduleState(invalidConfigs, [], now);
    expect(result[0]!.nextFireTime).toBeNull();
    expect(result[0]!.paused).toBe(false);
  });
});

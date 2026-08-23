/**
 * Cron schedule state — pure helpers for the web UI config view.
 *
 * Computes next fire times from cron expressions and surfaces pause state.
 * No I/O; all external data passed as arguments for testability.
 */

import type { CronConfig } from './config.js';
import type { CronState, Database } from './db.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CronScheduleEntry {
  readonly name: string;
  readonly repo: string;
  readonly schedule: string;
  readonly nextFireTime: string | null;
  readonly paused: boolean;
}

// ---------------------------------------------------------------------------
// Next fire time computation (pure)
// ---------------------------------------------------------------------------

/**
 * Parse a 5-field cron expression into its component arrays.
 * Returns null if the expression cannot be parsed.
 *
 * Fields: minute, hour, day-of-month, month, day-of-week
 */
export function parseCronFields(expression: string): {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
} | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    const minutes = expandField(parts[0]!, 0, 59);
    const hours = expandField(parts[1]!, 0, 23);
    const daysOfMonth = expandField(parts[2]!, 1, 31);
    const months = expandField(parts[3]!, 1, 12);
    const daysOfWeek = expandField(parts[4]!, 0, 7).map(d => d === 7 ? 0 : d); // normalize 7 → 0 (Sunday)
    return { minutes, hours, daysOfMonth, months, daysOfWeek: [...new Set(daysOfWeek)].sort((a, b) => a - b) };
  } catch {
    return null;
  }
}

/**
 * Expand a single cron field into a sorted array of valid values.
 * Supports: wildcards, ranges (1-5), steps (star/5, 1-10/2), lists (1,3,5).
 */
export function expandField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    // Step: */n or range/n
    const stepMatch = /^(.+)\/(\d+)$/.exec(trimmed);
    if (stepMatch) {
      const step = parseInt(stepMatch[2]!, 10);
      if (step <= 0) throw new Error(`Invalid step: ${step}`);
      let rangeStart = min;
      let rangeEnd = max;
      if (stepMatch[1] !== '*') {
        const rangeParts = stepMatch[1]!.split('-');
        rangeStart = parseInt(rangeParts[0]!, 10);
        rangeEnd = rangeParts.length > 1 ? parseInt(rangeParts[1]!, 10) : max;
      }
      for (let i = rangeStart; i <= rangeEnd; i += step) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    // Wildcard
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Range: a-b
    const rangeMatch = /^(\d+)-(\d+)$/.exec(trimmed);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.add(i);
      }
      continue;
    }

    // Single value
    const num = parseInt(trimmed, 10);
    if (isNaN(num)) throw new Error(`Invalid cron field value: ${trimmed}`);
    if (num >= min && num <= max) values.add(num);
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Compute the next fire time for a cron expression starting from `after`.
 * Returns null if it cannot determine a next fire within 366 days.
 *
 * All computation uses UTC — cron expressions are interpreted as UTC schedules.
 * Pure function — no side effects.
 */
export function nextCronFire(expression: string, after: Date): Date | null {
  const fields = parseCronFields(expression);
  if (fields === null) return null;

  const { minutes, hours, daysOfMonth, months, daysOfWeek } = fields;
  if (minutes.length === 0 || hours.length === 0 || daysOfMonth.length === 0 || months.length === 0 || daysOfWeek.length === 0) {
    return null;
  }

  // Start from the next minute after `after` (in UTC)
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Limit search to 366 days to prevent infinite loops
  const limit = after.getTime() + 366 * 24 * 60 * 60 * 1000;

  while (candidate.getTime() <= limit) {
    const month = candidate.getUTCMonth() + 1; // 1-indexed
    const dayOfMonth = candidate.getUTCDate();
    const dayOfWeek = candidate.getUTCDay(); // 0=Sunday
    const hour = candidate.getUTCHours();
    const minute = candidate.getUTCMinutes();

    // Check month
    if (!months.includes(month)) {
      // Advance to the first day of the next matching month
      advanceToNextMonth(candidate, months);
      continue;
    }

    // Check day-of-month AND day-of-week
    const domAll = daysOfMonth.length === 31;
    const dowAll = daysOfWeek.length === 7;
    const domMatch = daysOfMonth.includes(dayOfMonth);
    const dowMatch = daysOfWeek.includes(dayOfWeek);

    let dayMatch: boolean;
    if (domAll && dowAll) {
      dayMatch = true;
    } else if (domAll) {
      dayMatch = dowMatch;
    } else if (dowAll) {
      dayMatch = domMatch;
    } else {
      // Both restricted: standard cron OR logic
      dayMatch = domMatch || dowMatch;
    }

    if (!dayMatch) {
      // Advance to next day at 00:00 UTC
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    if (!hours.includes(hour)) {
      const nextHour = hours.find(h => h > hour);
      if (nextHour !== undefined) {
        candidate.setUTCHours(nextHour, minutes[0]!, 0, 0);
      } else {
        // Advance to next day
        candidate.setUTCDate(candidate.getUTCDate() + 1);
        candidate.setUTCHours(0, 0, 0, 0);
      }
      continue;
    }

    // Check minute
    if (!minutes.includes(minute)) {
      const nextMinute = minutes.find(m => m > minute);
      if (nextMinute !== undefined) {
        candidate.setUTCMinutes(nextMinute, 0, 0);
      } else {
        // Advance to next hour
        const nextHour = hours.find(h => h > hour);
        if (nextHour !== undefined) {
          candidate.setUTCHours(nextHour, minutes[0]!, 0, 0);
        } else {
          candidate.setUTCDate(candidate.getUTCDate() + 1);
          candidate.setUTCHours(0, 0, 0, 0);
        }
      }
      continue;
    }

    // All fields match
    return candidate;
  }

  return null;
}

function advanceToNextMonth(date: Date, validMonths: number[]): void {
  const currentMonth = date.getUTCMonth() + 1;
  const nextMonth = validMonths.find(m => m > currentMonth);
  if (nextMonth !== undefined) {
    date.setUTCMonth(nextMonth - 1, 1);
    date.setUTCHours(0, 0, 0, 0);
  } else {
    // Wrap to next year, first valid month
    date.setUTCFullYear(date.getUTCFullYear() + 1);
    date.setUTCMonth(validMonths[0]! - 1, 1);
    date.setUTCHours(0, 0, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Compute the full cron schedule state for the web UI.
 * Pure function — all data passed in.
 */
export function getCronScheduleState(
  cronConfigs: readonly CronConfig[],
  cronStates: readonly CronState[],
  now: Date,
): CronScheduleEntry[] {
  const stateMap = new Map(cronStates.map(s => [s.name, s]));

  return cronConfigs.map(entry => {
    const state = stateMap.get(entry.name);
    const paused = state !== undefined && state.paused;

    let nextFireTime: string | null = null;
    if (!paused) {
      const next = nextCronFire(entry.schedule, now);
      nextFireTime = next !== null ? next.toISOString() : null;
    }

    return {
      name: entry.name,
      repo: entry.repo,
      schedule: entry.schedule,
      nextFireTime,
      paused,
    };
  });
}

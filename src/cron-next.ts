/**
 * Cron next-fire utility — public API for computing the next fire time
 * from a 5-field cron expression.
 *
 * Delegates to the existing `nextCronFire` in `./cron-state.js` which already
 * handles full 5-field parsing (wildcards, lists, ranges, steps, day-of-week
 * OR logic). This module provides the `getNextCronFire` signature specified by
 * the web-ui-sessions-by-repo spec.
 *
 * Pure function — no I/O, injectable `now` for testability.
 */

import { nextCronFire } from './cron-state.js';

/**
 * Compute the next fire time for a standard 5-field cron expression.
 *
 * @param schedule - A 5-field cron expression (minute hour dom month dow)
 * @param now - Reference time (defaults to current time). Next fire is always
 *              strictly after this instant.
 * @returns The next matching Date in UTC, or null if the expression is invalid
 *          or no match is found within 366 days.
 */
export function getNextCronFire(schedule: string, now: Date = new Date()): Date | null {
  return nextCronFire(schedule, now);
}

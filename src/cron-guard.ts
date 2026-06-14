import type { SessionMeta } from './session-files.js';

/**
 * Pure guard: determines whether a cron job may re-fire given the last
 * terminal session for the same repo. `completed` and `abandoned` permit
 * re-fire; `failed` and `active` block it.
 */
export function canCronRefire(lastTerminal: SessionMeta | undefined): boolean {
  if (lastTerminal === undefined) return true;
  return lastTerminal.status === 'completed' || lastTerminal.status === 'abandoned';
}

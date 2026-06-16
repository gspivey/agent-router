/**
 * Pure row-selection logic for `agent-router ls` pagination.
 *
 * Default behaviour: show at most `limit` rows (default 20), but always
 * include every active session regardless of the cap. `--all` bypasses
 * the cap entirely.
 */

export const DEFAULT_LS_LIMIT = 20;

export interface LsSession {
  readonly status: string;
}

export interface SelectOptions {
  /** When true, return all sessions with no cap. */
  readonly all: boolean;
  /** Maximum non-active rows to show (active rows are always included). */
  readonly limit: number;
}

/**
 * Select which sessions to display given the pagination options.
 *
 * Sessions are assumed to be pre-sorted (most-recent first) by the daemon.
 * Active sessions are always included. Inactive sessions fill the remaining
 * slots up to `limit`. When `all` is true, every session is returned.
 */
export function selectVisibleSessions<T extends LsSession>(
  sessions: readonly T[],
  opts: SelectOptions,
): T[] {
  if (opts.all) return [...sessions];

  const active: T[] = [];
  const inactive: T[] = [];

  for (const s of sessions) {
    if (s.status === 'active') {
      active.push(s);
    } else {
      inactive.push(s);
    }
  }

  const inactiveSlots = Math.max(0, opts.limit - active.length);
  return [...active, ...inactive.slice(0, inactiveSlots)];
}

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
  readonly prs?: ReadonlyArray<{ readonly merged_at?: number }>;
}

export interface SelectOptions {
  /** When true, return all sessions with no cap. */
  readonly all: boolean;
  /** Maximum non-active rows to show (active rows are always included). */
  readonly limit: number;
  /** When true, show only sessions that shipped a merged PR. */
  readonly merged?: boolean;
}

/**
 * Select which sessions to display given the pagination options.
 *
 * Sessions are assumed to be pre-sorted (most-recent first) by the daemon.
 * Active sessions are always included. Inactive sessions fill the remaining
 * slots up to `limit`. When `all` is true, every session is returned.
 * When `merged` is true, only sessions with at least one merged PR are shown.
 */
export function selectVisibleSessions<T extends LsSession>(
  sessions: readonly T[],
  opts: SelectOptions,
): T[] {
  let filtered: readonly T[] = sessions;

  if (opts.merged === true) {
    filtered = sessions.filter((s) =>
      s.prs !== undefined && s.prs.some((pr) => pr.merged_at !== undefined),
    );
  }

  if (opts.all) return [...filtered];

  const active: T[] = [];
  const inactive: T[] = [];

  for (const s of filtered) {
    if (s.status === 'active') {
      active.push(s);
    } else {
      inactive.push(s);
    }
  }

  const inactiveSlots = Math.max(0, opts.limit - active.length);
  return [...active, ...inactive.slice(0, inactiveSlots)];
}

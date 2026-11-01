/**
 * Pure logic for the `prune-sessions` CLI subcommand.
 *
 * Exported functions are stateless and unit-testable without filesystem access.
 */

import type { SessionMeta } from './session-files.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A session directory discovered on disk. */
export interface SessionDirEntry {
  sessionId: string;
  /** Modification time of the meta.json file (Unix seconds), or directory mtime if meta absent. */
  modifiedAt: number;
}

/** Input for selectSessionsToPrune. */
export interface PruneInput {
  /** All session directories found on disk. */
  entries: SessionDirEntry[];
  /** Active session IDs read from the daemon DB (via IPC or direct DB). */
  activeIds: ReadonlySet<string>;
  /** Sessions from the session-files metadata layer. */
  metas: ReadonlyMap<string, SessionMeta>;
  /** Current time (Unix seconds). */
  nowSeconds: number;
  /** Prune sessions whose terminal_at is older than this many seconds. */
  retentionSeconds: number;
}

/** A session ID selected for pruning and the reason. */
export interface PruneCandidateReason {
  /** 'terminal_at' — used meta.terminal_at for age check. */
  ageSource: 'terminal_at' | 'dir_mtime';
  ageSeconds: number;
}

export interface PruneCandidate {
  sessionId: string;
  reason: PruneCandidateReason;
}

export interface PruneSelection {
  toPrune: PruneCandidate[];
  skippedActive: number;
  skippedTooNew: number;
  skippedNoMeta: number;
}

// ---------------------------------------------------------------------------
// Core pure function
// ---------------------------------------------------------------------------

/**
 * Determine which session directories should be pruned.
 *
 * Rules (in order of evaluation):
 * 1. Skip if sessionId is in activeIds (daemon says it's active).
 * 2. Skip if meta.status === 'active' (meta file says active — belt-and-suspenders).
 * 3. For sessions with a terminal_at timestamp: prune if age >= retentionSeconds.
 * 4. For sessions with no meta (orphaned dirs): prune if modifiedAt age >= retentionSeconds.
 * 5. Sessions with meta but no terminal_at and status not 'active': skip (conservative).
 */
export function selectSessionsToPrune(input: PruneInput): PruneSelection {
  const { entries, activeIds, metas, nowSeconds, retentionSeconds } = input;

  const toPrune: PruneCandidate[] = [];
  let skippedActive = 0;
  let skippedTooNew = 0;
  let skippedNoMeta = 0;

  for (const entry of entries) {
    const { sessionId, modifiedAt } = entry;

    // Rule 1: daemon actively knows this session is alive.
    if (activeIds.has(sessionId)) {
      skippedActive++;
      continue;
    }

    const meta = metas.get(sessionId);

    // Rule 2: meta file says active.
    if (meta !== undefined && meta.status === 'active') {
      skippedActive++;
      continue;
    }

    // Rule 3: terminal_at is the authoritative age source.
    if (meta !== undefined && meta.terminal_at !== undefined) {
      const age = nowSeconds - meta.terminal_at;
      if (age < retentionSeconds) {
        skippedTooNew++;
        continue;
      }
      toPrune.push({
        sessionId,
        reason: { ageSource: 'terminal_at', ageSeconds: age },
      });
      continue;
    }

    // Rule 5: has meta but no terminal_at (and not 'active' by Rule 2).
    // This shouldn't normally happen, but be conservative and skip.
    if (meta !== undefined && meta.terminal_at === undefined) {
      skippedNoMeta++;
      continue;
    }

    // Rule 4: orphaned directory (no meta at all) — use directory/file mtime.
    if (meta === undefined) {
      const age = nowSeconds - modifiedAt;
      if (age < retentionSeconds) {
        skippedTooNew++;
        continue;
      }
      toPrune.push({
        sessionId,
        reason: { ageSource: 'dir_mtime', ageSeconds: age },
      });
      continue;
    }
  }

  return { toPrune, skippedActive, skippedTooNew, skippedNoMeta };
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './log.js';
import type { SessionFiles, SessionMeta } from './session-files.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReaperConfig {
  enabled: boolean;
  gracePeriodMinutes: number;
  retentionDays: number;
  agentRunsDir: string;
  sweepIntervalMinutes: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Reaper {
  /** Called by session manager when a session enters terminal state. */
  onSessionTerminal(sessionId: string): void;

  /** Start the periodic sweep timer. Called once at daemon startup. */
  start(): void;

  /** Cancel all pending timers and stop the sweep. Called on shutdown. */
  shutdown(): void;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Returns true if `target` is a strict child of `resolvedParent`.
 *
 * Uses fs.realpathSync on the target to resolve symlinks before
 * the startsWith check. The `resolvedParent` parameter MUST already
 * be resolved via fs.realpathSync (done once at Reaper init).
 *
 * Error handling:
 * - ENOENT on target: target was already deleted — return false.
 * - Any other error (EPERM, EIO, etc.): rethrow so caller can log.
 */
export function isStrictChild(target: string, resolvedParent: string): boolean {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
  return resolved.startsWith(resolvedParent + path.sep);
}

// ---------------------------------------------------------------------------
// Directory timestamp parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `YYYYMMDD-HHMMSS` string into a Unix timestamp (seconds).
 * Returns null if the string does not match the expected format or
 * produces an invalid date.
 */
export function parseDirTimestamp(tsStr: string): number | null {
  const match = tsStr.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (match === null) return null;

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10) - 1; // 0-indexed
  const day = parseInt(match[3]!, 10);
  const hour = parseInt(match[4]!, 10);
  const minute = parseInt(match[5]!, 10);
  const second = parseInt(match[6]!, 10);

  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (isNaN(date.getTime())) return null;

  // Validate that the date components round-trip
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }

  return Math.floor(date.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Worktree discovery heuristic
// ---------------------------------------------------------------------------

const FIVE_MINUTES_S = 5 * 60;

/**
 * Discover a worktree directory for a session by matching directory names
 * against the format `<YYYYMMDD-HHMMSS>-<repo>`.
 *
 * Returns the full path on a unique match, or null on zero/multiple matches.
 * All callers MUST pass `createdAt` — returns null when undefined.
 */
export function discoverWorktree(
  agentRunsDir: string,
  sessionId: string,
  repo: string | undefined,
  createdAt: number | undefined,
  log: Logger,
): string | null {
  if (repo === undefined) return null;
  if (createdAt === undefined) return null;

  const slug = repo.includes('/') ? repo.split('/')[1]! : repo;
  if (!fs.existsSync(agentRunsDir)) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentRunsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirMatch = entry.name.match(/^(\d{8}-\d{6})-(.+)$/);
    if (dirMatch === null) continue;

    const tsStr = dirMatch[1]!;
    const dirSlug = dirMatch[2]!;

    if (dirSlug !== slug) continue;

    const parsed = parseDirTimestamp(tsStr);
    if (parsed === null) continue;

    if (Math.abs(parsed - createdAt) <= FIVE_MINUTES_S) {
      matches.push(entry.name);
    }
  }

  if (matches.length === 1) {
    return path.join(agentRunsDir, matches[0]!);
  }
  if (matches.length === 0) {
    log.debug('No worktree found via timestamp match', { sessionId, repo });
    return null;
  }
  log.warn('Ambiguous worktree discovery', { sessionId, matches });
  return null;
}

// ---------------------------------------------------------------------------
// Eligibility check (pure)
// ---------------------------------------------------------------------------

export interface EligibilityInput {
  status: SessionMeta['status'];
  terminal_at?: number | undefined;
  worktree_reaped_at?: number | undefined;
}

/**
 * Determine if a session's worktree is eligible for reaping.
 * Returns true when:
 * - status is terminal (not 'active')
 * - terminal_at is set
 * - grace period has elapsed
 * - worktree has not already been reaped
 */
export function isEligibleForWorktreeReap(
  session: EligibilityInput,
  nowSeconds: number,
  gracePeriodSeconds: number,
): boolean {
  if (session.status === 'active') return false;
  if (session.terminal_at === undefined) return false;
  if (session.worktree_reaped_at !== undefined) return false;
  const age = nowSeconds - session.terminal_at;
  return age >= gracePeriodSeconds;
}

/**
 * Determine if a session's metadata directory is eligible for pruning.
 * Returns true when:
 * - status is terminal (not 'active')
 * - terminal_at is set
 * - retention window has elapsed
 */
export function isEligibleForMetadataPrune(
  session: EligibilityInput,
  nowSeconds: number,
  retentionSeconds: number,
): boolean {
  if (session.status === 'active') return false;
  if (session.terminal_at === undefined) return false;
  const age = nowSeconds - session.terminal_at;
  return age >= retentionSeconds;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReaper(deps: {
  config: ReaperConfig;
  sessionFiles: SessionFiles;
  isActive: (sessionId: string) => boolean;
  log: Logger;
  /** Override for testing — defaults to Date.now */
  now?: () => number;
}): Reaper {
  const { config, sessionFiles, isActive, log } = deps;
  const now = deps.now ?? (() => Date.now());

  // Resolve agentRunsDir once at init
  const resolvedDir = path.resolve(config.agentRunsDir);
  let resolvedParent: string;
  try {
    resolvedParent = fs.realpathSync(resolvedDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Create the directory if it doesn't exist
      fs.mkdirSync(resolvedDir, { recursive: true });
      resolvedParent = fs.realpathSync(resolvedDir);
    } else {
      throw err;
    }
  }

  const gracePeriodMs = config.gracePeriodMinutes * 60 * 1000;
  const gracePeriodSeconds = config.gracePeriodMinutes * 60;
  const retentionSeconds = config.retentionDays * 24 * 60 * 60;
  const sweepIntervalMs = config.sweepIntervalMinutes * 60 * 1000;

  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;

  function deleteWorktree(sessionId: string, worktreePath: string): boolean {
    // Safety: validate path is a strict child of agentRunsDir
    try {
      if (!isStrictChild(worktreePath, resolvedParent)) {
        log.error('Worktree path outside agentRunsDir, skipping', { sessionId, path: worktreePath });
        return false;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Path validation failed', { sessionId, path: worktreePath, error: msg });
      return false;
    }

    if (!fs.existsSync(worktreePath)) {
      log.debug('Worktree already deleted', { sessionId, path: worktreePath });
      return false;
    }

    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      const nowSec = Math.floor(now() / 1000);
      try {
        sessionFiles.updateMeta(sessionId, { worktree_reaped_at: nowSec } as Partial<SessionMeta>);
      } catch {
        // Session may already be terminal — write directly to meta.json
        writeWorktreeReapedAt(sessionId, nowSec);
      }
      log.info('Worktree reaped', { sessionId, path: worktreePath });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Worktree deletion failed', { sessionId, path: worktreePath, error: msg });
      return false;
    }
  }

  /**
   * Write worktree_reaped_at directly to meta.json for terminal sessions.
   * This bypasses the "only active sessions" guard in sessionFiles.updateMeta.
   */
  function writeWorktreeReapedAt(sessionId: string, timestamp: number): void {
    try {
      const paths = sessionFiles.getSessionPaths(sessionId);
      const raw = fs.readFileSync(paths.meta, 'utf-8');
      const meta = JSON.parse(raw) as Record<string, unknown>;
      meta['worktree_reaped_at'] = timestamp;
      // Atomic write
      const tmpPath = paths.meta + `.tmp-${process.pid}-${Date.now()}`;
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(meta, null, 2) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, paths.meta);
    } catch {
      // Best effort — if meta is unreadable, skip
    }
  }

  function resolveWorktreePath(sessionId: string, meta: SessionMeta): string | null {
    if (typeof meta.worktree_path === 'string' && meta.worktree_path.length > 0) {
      return meta.worktree_path;
    }
    return discoverWorktree(config.agentRunsDir, sessionId, meta.repo, meta.created_at, log);
  }

  function handleGraceExpiry(sessionId: string): void {
    graceTimers.delete(sessionId);
    if (shuttingDown) return;
    if (isActive(sessionId)) {
      log.warn('Session reactivated during grace period, aborting reap', { sessionId });
      return;
    }

    let meta: SessionMeta;
    try {
      meta = sessionFiles.readMeta(sessionId);
    } catch {
      log.warn('Cannot read meta for reaping', { sessionId });
      return;
    }

    if (meta.status === 'active') {
      log.warn('Session status is active, aborting reap', { sessionId });
      return;
    }

    const worktreePath = resolveWorktreePath(sessionId, meta);
    if (worktreePath === null) {
      log.debug('No worktree to reap', { sessionId });
      return;
    }

    deleteWorktree(sessionId, worktreePath);
  }

  function sweep(): void {
    if (shuttingDown) return;

    const stats = {
      scanned: 0,
      worktrees_reaped: 0,
      metadata_pruned: 0,
      skipped: 0,
      errors: 0,
    };

    const nowSec = Math.floor(now() / 1000);

    let sessions: SessionMeta[];
    try {
      sessions = sessionFiles.listSessions();
    } catch {
      log.error('Failed to list sessions for sweep');
      return;
    }

    // Phase 1: Worktree sweep
    for (const session of sessions) {
      stats.scanned++;

      if (isActive(session.session_id)) {
        stats.skipped++;
        continue;
      }
      if (session.status === 'active') {
        stats.skipped++;
        continue;
      }

      const terminalAt = session.terminal_at;
      if (terminalAt === undefined) {
        stats.skipped++;
        continue;
      }

      if (session.worktree_reaped_at !== undefined) continue;

      const age = nowSec - terminalAt;
      if (age < gracePeriodSeconds) continue;

      const worktreePath = resolveWorktreePath(session.session_id, session);
      if (worktreePath === null) continue;

      if (deleteWorktree(session.session_id, worktreePath)) {
        stats.worktrees_reaped++;
      } else {
        stats.errors++;
      }
    }

    // Phase 2: Metadata sweep
    for (const session of sessions) {
      if (isActive(session.session_id)) continue;
      if (session.status === 'active') continue;

      const terminalAt = session.terminal_at;
      if (terminalAt === undefined) continue;

      const age = nowSec - terminalAt;
      if (age < retentionSeconds) continue;

      try {
        const paths = sessionFiles.getSessionPaths(session.session_id);
        if (fs.existsSync(paths.dir)) {
          fs.rmSync(paths.dir, { recursive: true, force: true });
          stats.metadata_pruned++;
          log.info('Session metadata pruned', {
            sessionId: session.session_id,
            age_days: Math.floor(age / 86400),
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Metadata pruning failed', { sessionId: session.session_id, error: msg });
        stats.errors++;
      }
    }

    log.info('Reaper sweep complete', stats);
  }

  function backfill(): void {
    let sessions: SessionMeta[];
    try {
      sessions = sessionFiles.listSessions();
    } catch {
      log.error('Failed to list sessions for backfill');
      return;
    }

    let discovered = 0;
    for (const session of sessions) {
      if (session.status === 'active') continue;
      if (isActive(session.session_id)) continue;

      if (typeof session.worktree_path === 'string' && session.worktree_path.length > 0) continue;

      const worktreePath = discoverWorktree(
        config.agentRunsDir,
        session.session_id,
        session.repo,
        session.created_at,
        log,
      );

      if (worktreePath !== null) {
        try {
          const paths = sessionFiles.getSessionPaths(session.session_id);
          const raw = fs.readFileSync(paths.meta, 'utf-8');
          const meta = JSON.parse(raw) as Record<string, unknown>;
          meta['worktree_path'] = worktreePath;
          const tmpPath = paths.meta + `.tmp-${process.pid}-${Date.now()}`;
          const fd = fs.openSync(tmpPath, 'w');
          try {
            fs.writeSync(fd, JSON.stringify(meta, null, 2) + '\n');
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.renameSync(tmpPath, paths.meta);
          discovered++;
        } catch {
          // Best effort
        }
      }
    }

    if (discovered > 0) {
      log.info('Startup backfill discovered worktree paths', { discovered });
    }
  }

  return {
    onSessionTerminal(sessionId: string): void {
      if (shuttingDown) return;
      if (!config.enabled) return;

      const timer = setTimeout(() => handleGraceExpiry(sessionId), gracePeriodMs);
      graceTimers.set(sessionId, timer);
    },

    start(): void {
      if (!config.enabled) return;

      // Run startup backfill first
      backfill();

      // Initial sweep immediately
      sweep();

      // Periodic sweep
      sweepTimer = setInterval(() => sweep(), sweepIntervalMs);
    },

    shutdown(): void {
      shuttingDown = true;

      // Clear all grace timers
      for (const [, timer] of graceTimers) {
        clearTimeout(timer);
      }
      graceTimers.clear();

      // Clear sweep interval
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
  };
}

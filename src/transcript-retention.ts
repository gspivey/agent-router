/**
 * Two-phase transcript retention (task-attempt-outcome, tasks 8.1–8.3).
 *
 * An attempt's transcript is its session `stream.log`. Phases:
 *   active   — raw file on disk, served directly.
 *   archived — after `endedAt + grace`, compressed to `.zst` (zstd via
 *              `node:zlib`), raw file removed, `artifacts.transcript_ref` points
 *              at the `.zst`.
 *   deleted  — after `endedAt + ttl`, the archived file is removed.
 *
 * The pure `classifyRetentionPhase` is exported for Tier 1 testing; the archive/
 * delete/read helpers and the periodic sweeper perform the filesystem effects.
 * This TTL is independent of the agent-run reaper's TTL (Requirement 11.4).
 */
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { zstdCompressSync, zstdDecompressSync, createZstdDecompress } from 'node:zlib';
import type { Readable } from 'node:stream';
import type { Logger } from './log.js';
import type { TaskDatabase } from './task-db.js';

/** Retention phase for a transcript (Requirement 11). */
export type RetentionPhase = 'active' | 'archived' | 'deleted';

/**
 * Classify a transcript's retention phase from the current time and the
 * attempt's `endedAt` (Requirement 11.1–11.3). An attempt that has not ended
 * (`endedAt === null`) is always `active`. `graceMs` is the active→archived
 * grace; `ttlMs` is the archived→deleted TTL (both measured from `endedAt`).
 */
export function classifyRetentionPhase(
  now: number,
  endedAt: number | null,
  graceMs: number,
  ttlMs: number
): RetentionPhase {
  if (endedAt === null) return 'active';
  const age = now - endedAt;
  if (age >= ttlMs) return 'deleted';
  if (age >= graceMs) return 'archived';
  return 'active';
}

/** `.zst` suffix for an archived transcript. */
const ZST_SUFFIX = '.zst';

/** True when a transcript ref points at an archived (compressed) file. */
export function isArchivedRef(ref: string): boolean {
  return ref.endsWith(ZST_SUFFIX);
}

/**
 * Archive a raw transcript: compress `rawPath` to `rawPath.zst` with zstd,
 * remove the raw file, and return the archived path. Idempotent — if the raw
 * file is already gone and the archive exists, returns the archive path.
 */
export async function archiveTranscript(rawPath: string): Promise<string> {
  const archivedPath = rawPath + ZST_SUFFIX;
  if (!existsSync(rawPath)) {
    // Already archived (or never existed): return the archive path if present.
    return archivedPath;
  }
  const raw = await readFile(rawPath);
  const compressed = zstdCompressSync(raw);
  await writeFile(archivedPath, compressed);
  await rm(rawPath, { force: true });
  return archivedPath;
}

/** Delete an archived (or raw) transcript file. Idempotent. */
export async function deleteTranscript(ref: string): Promise<void> {
  await rm(ref, { force: true });
}

/**
 * Open a transcript for reading, decompressing `.zst` transparently
 * (Requirement 10.4). Returns `null` when the file does not exist (so the
 * caller can 404). For an archived ref the returned stream is the decompressed
 * content.
 */
export function readTranscript(ref: string): Readable | null {
  if (!existsSync(ref)) return null;
  if (isArchivedRef(ref)) {
    const source = createReadStream(ref);
    const decompress = createZstdDecompress();
    source.on('error', (err) => decompress.destroy(err));
    return source.pipe(decompress);
  }
  return createReadStream(ref);
}

/** Read an entire transcript into a buffer, decompressing `.zst` transparently. */
export async function readTranscriptBuffer(ref: string): Promise<Buffer | null> {
  if (!existsSync(ref)) return null;
  const raw = await readFile(ref);
  if (isArchivedRef(ref)) {
    return Buffer.from(zstdDecompressSync(raw));
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

export interface TranscriptRetentionConfig {
  /** active → archived grace in minutes (default 60). */
  archiveGraceMinutes?: number;
  /** archived → deleted TTL in days (default 90). */
  retentionDays?: number;
  /** sweep cadence in minutes (default 30). */
  sweepIntervalMinutes?: number;
}

export interface TranscriptRetentionDeps {
  db: TaskDatabase;
  log: Logger;
  config?: TranscriptRetentionConfig;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_ARCHIVE_GRACE_MINUTES = 60;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_SWEEP_INTERVAL_MINUTES = 30;

/**
 * Periodic retention sweeper (Requirement 11.2–11.4). On each tick it classifies
 * every ended attempt's transcript and advances it to the next phase, updating
 * `artifacts.transcript_ref` on archive. Runs independently of the reaper.
 */
export class TranscriptRetentionSweeper {
  private readonly db: TaskDatabase;
  private readonly log: Logger;
  private readonly graceMs: number;
  private readonly ttlMs: number;
  private readonly sweepMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(deps: TranscriptRetentionDeps) {
    this.db = deps.db;
    this.log = deps.log;
    const cfg = deps.config ?? {};
    this.graceMs = (cfg.archiveGraceMinutes ?? DEFAULT_ARCHIVE_GRACE_MINUTES) * 60_000;
    this.ttlMs = (cfg.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60_000;
    this.sweepMs = (cfg.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES) * 60_000;
    this.now = deps.now ?? (() => Date.now());
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h));
  }

  /** The grace/ttl windows this sweeper applies (for tests/diagnostics). */
  windows(): { graceMs: number; ttlMs: number } {
    return { graceMs: this.graceMs, ttlMs: this.ttlMs };
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.setIntervalFn(() => {
      void this.sweepOnce();
    }, this.sweepMs);
  }

  stop(): void {
    if (this.handle !== null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }

  /**
   * Advance a single transcript, given its current `transcript_ref` and the
   * attempt's `endedAt`. Returns the next phase and (when archived) the new ref.
   */
  async advance(
    ref: string | undefined,
    endedAt: number | null
  ): Promise<{ phase: RetentionPhase; ref: string | undefined }> {
    const phase = classifyRetentionPhase(this.now(), endedAt, this.graceMs, this.ttlMs);
    if (ref === undefined) return { phase, ref };
    if (phase === 'archived' && !isArchivedRef(ref)) {
      const archived = await archiveTranscript(ref);
      return { phase, ref: archived };
    }
    if (phase === 'deleted') {
      await deleteTranscript(ref);
      return { phase, ref: undefined };
    }
    return { phase, ref };
  }

  /**
   * Run one sweep over all ended attempts, advancing phases and persisting the
   * updated `transcript_ref` on archive. Best-effort per attempt; one failure
   * does not abort the sweep.
   */
  async sweepOnce(): Promise<void> {
    // Iterate every attempt via its task; running attempts are skipped (endedAt null).
    for (const task of this.db.listTasks({})) {
      for (const attempt of this.db.getAttemptsForTask(task.id)) {
        if (attempt.state !== 'ended') continue;
        const ref = attempt.artifacts?.transcript_ref;
        try {
          await this.advance(ref, attempt.endedAt);
        } catch (err: unknown) {
          this.log.warn('transcript retention sweep failed for attempt', {
            attempt_id: attempt.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}

/**
 * Tier 1 tests: transcript retention (task-attempt-outcome, task 8.3).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import * as zlib from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyRetentionPhase,
  archiveTranscript,
  deleteTranscript,
  readTranscriptBuffer,
  isArchivedRef,
} from '../../src/transcript-retention.js';

const hasZstd = typeof (zlib as unknown as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'retention-test-'));
  dirs.push(d);
  return d;
}

describe('classifyRetentionPhase', () => {
  it('a running attempt (endedAt null) is always active', () => {
    expect(classifyRetentionPhase(1_000_000, null, 1000, 2000)).toBe('active');
  });

  it('active before grace, archived after grace, deleted after ttl', () => {
    const endedAt = 10_000;
    const grace = 1000;
    const ttl = 5000;
    expect(classifyRetentionPhase(endedAt + 0, endedAt, grace, ttl)).toBe('active');
    expect(classifyRetentionPhase(endedAt + 999, endedAt, grace, ttl)).toBe('active');
    expect(classifyRetentionPhase(endedAt + 1000, endedAt, grace, ttl)).toBe('archived');
    expect(classifyRetentionPhase(endedAt + 4999, endedAt, grace, ttl)).toBe('archived');
    expect(classifyRetentionPhase(endedAt + 5000, endedAt, grace, ttl)).toBe('deleted');
  });

  it('property: boundaries are consistent across random now/endedAt/grace/ttl', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        (now, endedAt, grace, extra) => {
          const ttl = grace + extra; // ensure ttl >= grace
          const phase = classifyRetentionPhase(now, endedAt, grace, ttl);
          const age = now - endedAt;
          if (age >= ttl) expect(phase).toBe('deleted');
          else if (age >= grace) expect(phase).toBe('archived');
          else expect(phase).toBe('active');
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('isArchivedRef', () => {
  it('true only for .zst refs', () => {
    expect(isArchivedRef('/x/stream.log.zst')).toBe(true);
    expect(isArchivedRef('/x/stream.log')).toBe(false);
  });
});

describe('archive / read / delete round-trip', () => {
  it.skipIf(!hasZstd)('compresses, removes the raw file, and reads back decompressed', async () => {
    const dir = tmp();
    const raw = join(dir, 'stream.log');
    const body = 'line one\nline two\n{"event":"x"}\n';
    writeFileSync(raw, body);

    const archived = await archiveTranscript(raw);
    expect(archived).toBe(raw + '.zst');
    expect(existsSync(raw)).toBe(false);
    expect(existsSync(archived)).toBe(true);

    const back = await readTranscriptBuffer(archived);
    expect(back?.toString('utf8')).toBe(body);

    await deleteTranscript(archived);
    expect(existsSync(archived)).toBe(false);
    expect(await readTranscriptBuffer(archived)).toBeNull();
  });

  it('reads a raw (active) transcript directly', async () => {
    const dir = tmp();
    const raw = join(dir, 'stream.log');
    writeFileSync(raw, 'raw content');
    const back = await readTranscriptBuffer(raw);
    expect(back?.toString('utf8')).toBe('raw content');
  });
});

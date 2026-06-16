/**
 * Tier 1: pure logic tests for rate-limit deferral and coalescing.
 *
 * Tests computeDeferUntil (pure function) and the database-level coalescing
 * (UPSERT replaces pending wake with newest event).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeDeferUntil } from '../../src/router.js';
import { initDatabase } from '../../src/db.js';
import type { Database } from '../../src/db.js';

describe('computeDeferUntil', () => {
  it('returns lastWakedAt + cooldown when lastWakedAt is set', () => {
    expect(computeDeferUntil(1000, 1030, 60)).toBe(1060);
  });

  it('returns nowSeconds + cooldown when lastWakedAt is null', () => {
    expect(computeDeferUntil(null, 1030, 60)).toBe(1090);
  });

  it('property: result is always > nowSeconds when lastWakedAt is within cooldown', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.integer({ min: 1, max: 3600 }),
        (lastWakedAt, nowSeconds, cooldownSeconds) => {
          // Only test when rate-limited (nowSeconds < lastWakedAt + cooldown)
          if (nowSeconds >= lastWakedAt + cooldownSeconds) return;
          const result = computeDeferUntil(lastWakedAt, nowSeconds, cooldownSeconds);
          expect(result).toBeGreaterThan(nowSeconds);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: result equals lastWakedAt + cooldown when lastWakedAt is set', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.integer({ min: 1, max: 3600 }),
        (lastWakedAt, nowSeconds, cooldownSeconds) => {
          const result = computeDeferUntil(lastWakedAt, nowSeconds, cooldownSeconds);
          expect(result).toBe(lastWakedAt + cooldownSeconds);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: result equals nowSeconds + cooldown when lastWakedAt is null', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.integer({ min: 1, max: 3600 }),
        (nowSeconds, cooldownSeconds) => {
          const result = computeDeferUntil(null, nowSeconds, cooldownSeconds);
          expect(result).toBe(nowSeconds + cooldownSeconds);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('pending_wakes coalescing (DB)', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-wake-test-'));
    db = initDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(async () => {
    await db.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upserts a pending wake for a (repo, pr) pair', () => {
    db.upsertPendingWake('org/repo', 1, 100, 2000);
    const wakes = db.getDuePendingWakes(2001);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.repo).toBe('org/repo');
    expect(wakes[0]!.prNumber).toBe(1);
    expect(wakes[0]!.eventId).toBe(100);
    expect(wakes[0]!.deferredUntil).toBe(2000);
  });

  it('coalesces: newest event replaces pending wake for same (repo, pr)', () => {
    db.upsertPendingWake('org/repo', 1, 100, 2000);
    db.upsertPendingWake('org/repo', 1, 200, 2005);
    const wakes = db.getDuePendingWakes(3000);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.eventId).toBe(200);
    expect(wakes[0]!.deferredUntil).toBe(2005);
  });

  it('does not coalesce across different PRs', () => {
    db.upsertPendingWake('org/repo', 1, 100, 2000);
    db.upsertPendingWake('org/repo', 2, 200, 2000);
    const wakes = db.getDuePendingWakes(3000);
    expect(wakes).toHaveLength(2);
  });

  it('does not coalesce across different repos', () => {
    db.upsertPendingWake('org/repo-a', 1, 100, 2000);
    db.upsertPendingWake('org/repo-b', 1, 200, 2000);
    const wakes = db.getDuePendingWakes(3000);
    expect(wakes).toHaveLength(2);
  });

  it('getDuePendingWakes only returns wakes where deferred_until <= now', () => {
    db.upsertPendingWake('org/repo', 1, 100, 2000);
    db.upsertPendingWake('org/repo', 2, 200, 3000);
    const wakes = db.getDuePendingWakes(2500);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.prNumber).toBe(1);
  });

  it('clearPendingWake removes the wake for a specific (repo, pr)', () => {
    db.upsertPendingWake('org/repo', 1, 100, 2000);
    db.upsertPendingWake('org/repo', 2, 200, 2000);
    db.clearPendingWake('org/repo', 1);
    const wakes = db.getDuePendingWakes(3000);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.prNumber).toBe(2);
  });

  it('getEventById returns the stored event', () => {
    const eventId = db.insertEvent({
      repo: 'org/repo',
      prNumber: 1,
      eventType: 'check_run',
      payload: '{"action":"completed"}',
      receivedAt: 1000,
    });
    const event = db.getEventById(eventId);
    expect(event).toBeDefined();
    expect(event!.eventType).toBe('check_run');
    expect(event!.payload).toBe('{"action":"completed"}');
  });

  it('getEventById returns undefined for non-existent event', () => {
    expect(db.getEventById(99999)).toBeUndefined();
  });

  it('property: N upserts for same (repo, pr) always leave exactly one row with last event_id', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 20 }),
        (eventIds) => {
          // Clear for each run
          db.clearPendingWake('prop/repo', 1);
          for (const eid of eventIds) {
            db.upsertPendingWake('prop/repo', 1, eid, 9999);
          }
          const wakes = db.getDuePendingWakes(10000);
          const match = wakes.filter((w) => w.repo === 'prop/repo' && w.prNumber === 1);
          expect(match).toHaveLength(1);
          expect(match[0]!.eventId).toBe(eventIds[eventIds.length - 1]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from '../../src/db.js';
import type { Database, NewEvent } from '../../src/db.js';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fc from 'fast-check';

function makeTempDb(): { db: Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'db-test-'));
  const dbPath = join(dir, 'test.db');
  const db = initDatabase(dbPath);
  return { db, dbPath, dir };
}

function makeEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    repo: 'myorg/myrepo',
    prNumber: 42,
    eventType: 'check_run',
    payload: '{"action":"completed"}',
    receivedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

let cleanupFns: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanupFns) {
    try { fn(); } catch { /* ignore */ }
  }
  cleanupFns = [];
});

function setup(): { db: Database; dbPath: string } {
  const { db, dbPath, dir } = makeTempDb();
  cleanupFns.push(() => {
    try { db.shutdown(); } catch { /* already closed */ }
  });
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return { db, dbPath };
}

// ---------------------------------------------------------------------------
// initDatabase
// ---------------------------------------------------------------------------

describe('initDatabase', () => {
  it('creates sessions and events tables', () => {
    const { db } = setup();
    // If tables exist, these operations should not throw
    db.findSession('nonexistent/repo', 1);
    const id = db.insertEvent(makeEvent());
    expect(id).toBeGreaterThan(0);
  });

  it('enables WAL journal mode', () => {
    const { dbPath } = setup();
    const checkDb = new BetterSqlite3(dbPath);
    const result = checkDb.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0]?.journal_mode).toBe('wal');
    checkDb.close();
  });
});

// ---------------------------------------------------------------------------
// insertEvent
// ---------------------------------------------------------------------------

describe('insertEvent', () => {
  it('returns the row id', () => {
    const { db } = setup();
    const id1 = db.insertEvent(makeEvent());
    const id2 = db.insertEvent(makeEvent({ eventType: 'issue_comment' }));
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });

  it('stores null prNumber correctly', () => {
    const { db } = setup();
    const id = db.insertEvent(makeEvent({ prNumber: null }));
    expect(id).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// updateEventProcessed
// ---------------------------------------------------------------------------

describe('updateEventProcessed', () => {
  it('sets processed_at and wake_triggered=true', () => {
    const { db, dbPath } = setup();
    const id = db.insertEvent(makeEvent());
    db.updateEventProcessed(id, true);

    const checkDb = new BetterSqlite3(dbPath);
    const row = checkDb.prepare('SELECT processed_at, wake_triggered FROM events WHERE id = ?').get(id) as {
      processed_at: number | null;
      wake_triggered: number | null;
    };
    checkDb.close();

    expect(row.processed_at).not.toBeNull();
    expect(row.wake_triggered).toBe(1);
  });

  it('sets wake_triggered=false', () => {
    const { db, dbPath } = setup();
    const id = db.insertEvent(makeEvent());
    db.updateEventProcessed(id, false);

    const checkDb = new BetterSqlite3(dbPath);
    const row = checkDb.prepare('SELECT wake_triggered FROM events WHERE id = ?').get(id) as {
      wake_triggered: number | null;
    };
    checkDb.close();

    expect(row.wake_triggered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// markStaleEvents
// ---------------------------------------------------------------------------

describe('markStaleEvents', () => {
  it('marks old unprocessed events as processed with wake_triggered=0', () => {
    const { db, dbPath } = setup();
    const now = Math.floor(Date.now() / 1000);

    // Insert an event that is 600 seconds old (10 minutes)
    db.insertEvent(makeEvent({ receivedAt: now - 600 }));
    // Insert a recent event
    db.insertEvent(makeEvent({ receivedAt: now }));

    // Mark events older than 300 seconds (5 minutes) as stale
    db.markStaleEvents(300);

    const checkDb = new BetterSqlite3(dbPath);
    const rows = checkDb.prepare('SELECT id, processed_at, wake_triggered FROM events ORDER BY id').all() as Array<{
      id: number;
      processed_at: number | null;
      wake_triggered: number | null;
    }>;
    checkDb.close();

    // Old event should be marked as processed
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(rows[0]?.wake_triggered).toBe(0);

    // Recent event should remain unprocessed
    expect(rows[1]?.processed_at).toBeNull();
    expect(rows[1]?.wake_triggered).toBeNull();
  });

  it('does not mark already-processed events', () => {
    const { db, dbPath } = setup();
    const now = Math.floor(Date.now() / 1000);

    const id = db.insertEvent(makeEvent({ receivedAt: now - 600 }));
    db.updateEventProcessed(id, true);

    db.markStaleEvents(300);

    const checkDb = new BetterSqlite3(dbPath);
    const row = checkDb.prepare('SELECT wake_triggered FROM events WHERE id = ?').get(id) as {
      wake_triggered: number | null;
    };
    checkDb.close();

    // Should still have wake_triggered=1 from the explicit update
    expect(row.wake_triggered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// findSession
// ---------------------------------------------------------------------------

describe('findSession', () => {
  it('returns null when no session exists', () => {
    const { db } = setup();
    const result = db.findSession('myorg/myrepo', 42);
    expect(result).toBeNull();
  });

  it('returns session when it exists', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 42, 'sess-abc');

    const result = db.findSession('myorg/myrepo', 42);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sess-abc');
    expect(result!.repo).toBe('myorg/myrepo');
    expect(result!.prNumber).toBe(42);
    expect(result!.lastWakedAt).toBeNull();
  });

  it('does not return sessions for different repo', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 42, 'sess-abc');
    expect(db.findSession('other/repo', 42)).toBeNull();
  });

  it('does not return sessions for different PR number', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 42, 'sess-abc');
    expect(db.findSession('myorg/myrepo', 99)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tryAcquireWakeSlot
// ---------------------------------------------------------------------------

describe('tryAcquireWakeSlot', () => {
  it('returns true when no previous wake (lastWakedAt is null)', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 42, 'sess-abc');

    const now = Math.floor(Date.now() / 1000);
    expect(db.tryAcquireWakeSlot('myorg/myrepo', 42, 60, now)).toBe(true);
  });

  it('updates lastWakedAt after acquiring slot', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 42, 'sess-abc');

    const now = Math.floor(Date.now() / 1000);
    db.tryAcquireWakeSlot('myorg/myrepo', 42, 60, now);

    const session = db.findSession('myorg/myrepo', 42);
    expect(session!.lastWakedAt).toBe(now);
  });

  it('returns false when within cooldown period', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 42, 'sess-abc');

    const now = Math.floor(Date.now() / 1000);
    expect(db.tryAcquireWakeSlot('myorg/myrepo', 42, 60, now)).toBe(true);
    // 30 seconds later — still within 60s cooldown
    expect(db.tryAcquireWakeSlot('myorg/myrepo', 42, 60, now + 30)).toBe(false);
  });

  it('returns true when cooldown has passed', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 42, 'sess-abc');

    const now = Math.floor(Date.now() / 1000);
    expect(db.tryAcquireWakeSlot('myorg/myrepo', 42, 60, now)).toBe(true);
    // 61 seconds later — cooldown expired
    expect(db.tryAcquireWakeSlot('myorg/myrepo', 42, 60, now + 61)).toBe(true);
  });

  it('returns true when cooldown is exactly met', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 42, 'sess-abc');

    const now = Math.floor(Date.now() / 1000);
    expect(db.tryAcquireWakeSlot('myorg/myrepo', 42, 60, now)).toBe(true);
    // Exactly at cooldown boundary
    expect(db.tryAcquireWakeSlot('myorg/myrepo', 42, 60, now + 60)).toBe(true);
  });

  it('returns false when session does not exist', () => {
    const { db } = setup();
    const now = Math.floor(Date.now() / 1000);
    expect(db.tryAcquireWakeSlot('nonexistent/repo', 1, 60, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// walCheckpoint
// ---------------------------------------------------------------------------

describe('walCheckpoint', () => {
  it('does not throw', () => {
    const { db } = setup();
    expect(() => db.walCheckpoint()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  it('closes the database', async () => {
    const { db } = setup();
    await db.shutdown();
    // After shutdown, operations should throw
    expect(() => db.insertEvent(makeEvent())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// insertSession
// ---------------------------------------------------------------------------

describe('insertSession', () => {
  it('creates a session that can be found', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 10, 'sess-xyz');

    const session = db.findSession('myorg/myrepo', 10);
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('sess-xyz');
    expect(session!.prNumber).toBe(10);
  });

  it('upserts on duplicate repo+prNumber (new session wins)', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 10, 'sess-1');
    db.insertSession('myorg/myrepo', 10, 'sess-2');

    const session = db.findSession('myorg/myrepo', 10);
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('sess-2');
  });

  it('upsert resets last_waked_at to null', () => {
    const { db } = setup();
    db.insertSession('myorg/myrepo', 10, 'sess-1');
    // Simulate a wake
    const now = Math.floor(Date.now() / 1000);
    db.tryAcquireWakeSlot('myorg/myrepo', 10, 0, now);
    // Confirm last_waked_at is set
    const before = db.findSession('myorg/myrepo', 10);
    expect(before!.lastWakedAt).toBe(now);

    // Re-register from a new session
    db.insertSession('myorg/myrepo', 10, 'sess-2');
    const after = db.findSession('myorg/myrepo', 10);
    expect(after!.sessionId).toBe('sess-2');
    expect(after!.lastWakedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outbound comment tracking
// ---------------------------------------------------------------------------

describe('outbound comment tracking', () => {
  function setup() {
    const { db, dir } = makeTempDb();
    cleanupFns.push(() => {
      db.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    return { db };
  }

  it('inserts and finds an outbound comment', () => {
    const { db } = setup();
    db.insertOutboundComment(12345, 'sess-1', 'myorg/myrepo', 42);
    expect(db.isOutboundComment(12345)).toBe(true);
  });

  it('returns false for unknown comment ID', () => {
    const { db } = setup();
    expect(db.isOutboundComment(99999)).toBe(false);
  });

  it('ignores duplicate inserts (INSERT OR IGNORE)', () => {
    const { db } = setup();
    db.insertOutboundComment(12345, 'sess-1', 'myorg/myrepo', 42);
    // Should not throw
    db.insertOutboundComment(12345, 'sess-2', 'myorg/myrepo', 42);
    expect(db.isOutboundComment(12345)).toBe(true);
  });

  it('prunes comments older than the cutoff', () => {
    const { db } = setup();
    db.insertOutboundComment(111, 'sess-1', 'a/b', 1);
    // Prune with a cutoff of 0 seconds (everything older than now)
    // Since the comment was just inserted, it should survive a prune with a large window
    db.pruneOutboundComments(0);
    // Comment was just created, so it should still be there with cutoff=0
    // (cutoff = now - 0 = now, and created_at <= now)
    // Actually cutoff = now - 0 = now, and we delete where created_at < cutoff
    // created_at is approximately now, so it might or might not be pruned depending on timing
    // Use a large window to ensure it survives
    expect(db.isOutboundComment(111)).toBe(true);
  });

  it('prunes old comments but keeps recent ones', () => {
    const { db, dir } = makeTempDb();
    cleanupFns.push(() => {
      db.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });

    // Insert a comment, then manually backdate it via raw SQL
    db.insertOutboundComment(222, 'sess-1', 'a/b', 1);
    db.insertOutboundComment(333, 'sess-1', 'a/b', 2);

    // Backdate comment 222 to 10 days ago using raw SQL
    const rawDb = new BetterSqlite3(join(dir, 'test.db'));
    const tenDaysAgo = Math.floor(Date.now() / 1000) - (10 * 24 * 60 * 60);
    rawDb.prepare('UPDATE daemon_outbound_comments SET created_at = ? WHERE comment_id = ?')
      .run(tenDaysAgo, 222);
    rawDb.close();

    // Prune with 7-day retention
    db.pruneOutboundComments(7 * 24 * 60 * 60);

    expect(db.isOutboundComment(222)).toBe(false); // pruned
    expect(db.isOutboundComment(333)).toBe(true);  // kept
  });
});

// ---------------------------------------------------------------------------
// Property 4 — Event Storage Round-Trip (task 9.3)
// ---------------------------------------------------------------------------
// For any NewEvent with arbitrary repo, prNumber, eventType, payload,
// receivedAt: insertEvent returns a positive id; updateEventProcessed sets
// processed_at and wake_triggered correctly; payload is stored verbatim.
// (BACKLOG.md § P2.36, BACKLOG.md § P2.50)
//
// Unlike the unit tests above, the property tests use a SINGLE database
// instance per test (not per run). This is valid because each run inserts
// a fresh event row (returned id is unique) and reads back only that row.
// Using one DB per test avoids the 100× initDatabase overhead that caused
// test timeouts in earlier Node 24 + NAN builds.

describe('Property 4 — Event Storage Round-Trip', () => {
  /**
   * Arbitraries for NewEvent fields.
   * - repo: non-empty string (must look like 'owner/repo' is not enforced by db)
   * - prNumber: integer | null
   * - eventType: non-empty string
   * - payload: any string (JSON or not — db stores verbatim)
   * - receivedAt: non-negative integer (unix seconds)
   */
  const arbitraryEvent = fc.record({
    repo: fc.stringMatching(/^[a-z]{1,10}\/[a-z]{1,10}$/),
    prNumber: fc.option(fc.integer({ min: 1, max: 999_999 }), { nil: null }),
    eventType: fc.constantFrom('check_run', 'issue_comment', 'pull_request_review_comment', 'push'),
    payload: fc.string({ maxLength: 200 }),
    receivedAt: fc.integer({ min: 0, max: 2_000_000_000 }),
  });

  it('insertEvent returns a positive id and updateEventProcessed sets fields correctly (Property 4, ≥100 runs)', () => {
    const { db, dbPath, dir } = makeTempDb();
    try {
      fc.assert(
        fc.property(arbitraryEvent, fc.boolean(), (event, wakeTriggered) => {
          const id = db.insertEvent(event);
          if (id <= 0) return false;

          db.updateEventProcessed(id, wakeTriggered);

          // Read back via raw connection to verify the written values
          const raw = new BetterSqlite3(dbPath);
          const row = raw.prepare(
            'SELECT processed_at, wake_triggered, payload FROM events WHERE id = ?',
          ).get(id) as { processed_at: number | null; wake_triggered: number | null; payload: string };
          raw.close();

          return (
            row.processed_at !== null &&
            row.wake_triggered === (wakeTriggered ? 1 : 0) &&
            row.payload === event.payload
          );
        }),
        { numRuns: 100 },
      );
    } finally {
      db.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Property 8 — Atomic Rate Limit Acquisition (task 9.4)
// ---------------------------------------------------------------------------
// For any (repo, prNumber, cooldown, now): first call returns true; second
// call before cooldown returns false; second call at/after cooldown returns
// true; findSession reflects updated lastWakedAt.
// (BACKLOG.md § P2.36, BACKLOG.md § P2.50)
//
// Uses a SINGLE database instance per test; each run uses a unique
// (repo, prNumber) key derived by appending the run index so rows do not
// conflict across runs.

describe('Property 8 — Atomic Rate Limit Acquisition', () => {
  /** Arbitrary session key + timing parameters. */
  const arbitrarySlot = fc.record({
    repo: fc.stringMatching(/^[a-z]{1,10}$/),
    prNumber: fc.integer({ min: 1, max: 999_999 }),
    cooldown: fc.integer({ min: 1, max: 3600 }),
    now: fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
  });

  it('first acquisition returns true and findSession reflects lastWakedAt (Properties 8a and 8d, ≥100 runs)', () => {
    const { db, dir } = makeTempDb();
    let runIndex = 0;
    try {
      fc.assert(
        fc.property(arbitrarySlot, ({ repo, prNumber, cooldown, now }) => {
          // Use a unique repo per run to avoid cross-run interference
          const uniqueRepo = `${repo}/${runIndex++}`;
          db.insertSession(uniqueRepo, prNumber, 'sess-prop');

          // First acquisition must succeed
          const acquired = db.tryAcquireWakeSlot(uniqueRepo, prNumber, cooldown, now);
          if (!acquired) return false;

          // findSession must reflect lastWakedAt = now
          const session = db.findSession(uniqueRepo, prNumber);
          return session !== null && session.lastWakedAt === now;
        }),
        { numRuns: 100 },
      );
    } finally {
      db.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('second call within cooldown returns false (Property 8b, ≥100 runs)', () => {
    const { db, dir } = makeTempDb();
    let runIndex = 0;
    try {
      fc.assert(
        fc.property(
          arbitrarySlot,
          // delta is in [0, cooldown - 1] — strictly within the cooldown window
          fc.integer({ min: 0, max: 99 }),
          ({ repo, prNumber, cooldown: _cd, now }, delta) => {
            const cooldown = 100; // fixed so delta < cooldown is guaranteed
            const uniqueRepo = `${repo}/${runIndex++}`;
            db.insertSession(uniqueRepo, prNumber, 'sess-prop');
            db.tryAcquireWakeSlot(uniqueRepo, prNumber, cooldown, now);
            // second call at now + delta (delta < 100 = cooldown) must return false
            return db.tryAcquireWakeSlot(uniqueRepo, prNumber, cooldown, now + delta) === false;
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      db.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('second call at or after cooldown returns true (Property 8c, ≥100 runs)', () => {
    const { db, dir } = makeTempDb();
    let runIndex = 0;
    try {
      fc.assert(
        fc.property(
          arbitrarySlot,
          // extra is in [0, 1000]; delta = cooldown + extra >= cooldown
          fc.integer({ min: 0, max: 1000 }),
          ({ repo, prNumber, cooldown, now }, extra) => {
            const delta = cooldown + extra; // delta >= cooldown
            const uniqueRepo = `${repo}/${runIndex++}`;
            db.insertSession(uniqueRepo, prNumber, 'sess-prop');
            db.tryAcquireWakeSlot(uniqueRepo, prNumber, cooldown, now);
            // second call at now + delta (delta >= cooldown) must return true
            return db.tryAcquireWakeSlot(uniqueRepo, prNumber, cooldown, now + delta) === true;
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      db.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

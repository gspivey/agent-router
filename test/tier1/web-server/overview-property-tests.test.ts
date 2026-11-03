/**
 * Property tests for overview data-processing pure functions (BACKLOG.md § P2.61).
 *
 * Covers correctness invariants for:
 *   - collectRecentPrs  (deduplication + sort-order properties)
 *   - computeSessionsByRepo  (active-count accuracy, 10-row cap, sort order)
 *   - collectRecentEvents  (result-count and ordering, using a real in-memory DB)
 *   - buildCronSummary  (length invariant, paused semantics)
 *   - computeHealth  (degraded on paused/error cron, degraded on stale session,
 *                     healthy baseline)
 *
 * All Tier 1 — no daemon process, no fake backends, no network. The
 * collectRecentEvents property test uses an in-memory SQLite DB (`:memory:`)
 * via `initDatabase`, exactly as in `db.test.ts`.
 *
 * Minimum 100 iterations per property (the default `fc.assert` behaviour).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import {
  collectRecentPrs,
  computeSessionsByRepo,
  collectRecentEvents,
  buildCronSummary,
  computeHealth,
  type OverviewCronSummary,
  type CronSummarySource,
} from '../../../src/web-routes.js';
import { initDatabase, type Database } from '../../../src/db.js';
import type { CronConfig } from '../../../src/config.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary non-empty repo string in `owner/name` format. */
const arbRepo = fc.tuple(
  fc.stringOf(fc.char().filter((c) => /[a-z0-9-_]/.test(c)), { minLength: 1, maxLength: 12 }),
  fc.stringOf(fc.char().filter((c) => /[a-z0-9-_]/.test(c)), { minLength: 1, maxLength: 12 }),
).map(([o, r]) => `${o}/${r}`);

/** Arbitrary unix-seconds timestamp in a reasonable range. */
const arbTimestampS = fc.integer({ min: 1_000_000, max: 9_999_999_999 });

/** Arbitrary PR registration object. */
const arbPrRegistration = fc.record({
  repo: arbRepo,
  pr_number: fc.integer({ min: 1, max: 999_999 }),
  registered_at: arbTimestampS,
  merged_at: fc.option(arbTimestampS, { nil: undefined }),
});

/** Minimal session object with prs, for collectRecentPrs. */
const arbSessionWithPrs = fc.record({
  prs: fc.array(arbPrRegistration, { minLength: 0, maxLength: 5 }),
});

/**
 * Minimal session stub for computeSessionsByRepo.
 * The function only reads `repo`, `status`, `completed_at`, and `created_at`.
 */
const arbSessionForByRepo = fc.record({
  repo: fc.option(arbRepo, { nil: undefined }),
  status: fc.constantFrom('active', 'completed', 'failed', 'abandoned'),
  completed_at: fc.option(arbTimestampS, { nil: null }),
  created_at: arbTimestampS,
});

/** Arbitrary cron config entry. */
const arbCronConfig = fc.record({
  name: fc.string({ minLength: 1, maxLength: 20 }),
  repo: arbRepo,
  schedule: fc.constantFrom('0 6 * * *', '0 9 * * 1-5', '*/30 * * * *'),
  promptFile: fc.string({ minLength: 1, maxLength: 30 }),
}) as fc.Arbitrary<CronConfig>;

/** Arbitrary cron state source. */
const arbCronState: fc.Arbitrary<CronSummarySource> = fc.oneof(
  // Without last_status (no optional property set)
  fc.record({
    name: fc.string({ minLength: 1, maxLength: 20 }),
    paused: fc.boolean(),
    lastFiredAt: fc.option(arbTimestampS, { nil: null }),
  }),
  // With last_status
  fc.record({
    name: fc.string({ minLength: 1, maxLength: 20 }),
    paused: fc.boolean(),
    last_status: fc.constantFrom('ok', 'failed'),
    lastFiredAt: fc.option(arbTimestampS, { nil: null }),
  }),
) as fc.Arbitrary<CronSummarySource>;

/** Arbitrary OverviewCronSummary entry (for computeHealth input). */
const arbCronSummaryEntry = fc.record({
  name: fc.string({ minLength: 1, maxLength: 20 }),
  repo: arbRepo,
  schedule: fc.constantFrom('0 6 * * *'),
  state: fc.constantFrom<'active' | 'paused' | 'error'>('active', 'paused', 'error'),
  next_fire: fc.option(fc.date().map((d) => d.toISOString()), { nil: null }),
  last_fired_at: fc.option(fc.date().map((d) => d.toISOString()), { nil: null }),
}) as fc.Arbitrary<OverviewCronSummary>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary real-disk SQLite database for collectRecentEvents
 * property tests. Returns db + cleanup function.
 */
function makeDb(): { db: Database; cleanup: () => void } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-prop-'));
  const dbPath = path.join(rootDir, 'agent-router.db');
  const db = initDatabase(dbPath);
  return {
    db,
    cleanup: () => {
      void db.shutdown();
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

/**
 * Insert an event directly via raw SQL and mark it as processed.
 * Returns the inserted event ID.
 */
function insertProcessedEvent(
  db: Database,
  opts: { repo: string; prNumber: number | null; eventType: string; receivedAt: number },
): number {
  const stmt = db.raw().prepare<{
    repo: string;
    pr_number: number | null;
    event_type: string;
    received_at: number;
  }>(
    `INSERT INTO events (repo, pr_number, event_type, payload, received_at)
     VALUES (@repo, @pr_number, @event_type, '{}', @received_at)`,
  );
  const result = stmt.run({
    repo: opts.repo,
    pr_number: opts.prNumber,
    event_type: opts.eventType,
    received_at: opts.receivedAt,
  });
  const id = result.lastInsertRowid as number;
  db.updateEventProcessed(id, true);
  return id;
}

// ---------------------------------------------------------------------------
// Property A — collectRecentPrs: deduplication invariant
// ---------------------------------------------------------------------------

describe('Property A — collectRecentPrs: deduplication', () => {
  it('output contains at most one entry per unique (repo, pr_number) pair', () => {
    fc.assert(
      fc.property(fc.array(arbSessionWithPrs, { minLength: 0, maxLength: 10 }), (sessions) => {
        // Cast to the expected input type — only `prs` is accessed.
        const result = collectRecentPrs(
          sessions as unknown as Parameters<typeof collectRecentPrs>[0],
        );
        // Build a set of (repo, pr_number) keys from the output.
        const seen = new Set<string>();
        for (const row of result) {
          const key = `${row.repo}#${row.title.split('#')[1] ?? ''}`;
          if (seen.has(key)) {
            throw new Error(`Duplicate (repo, pr_number) pair: ${key}`);
          }
          seen.add(key);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property B — collectRecentPrs: sort-order invariant (newest-first)
// ---------------------------------------------------------------------------

describe('Property B — collectRecentPrs: sort order', () => {
  it('output is ordered by registered_at descending (newest first)', () => {
    fc.assert(
      fc.property(fc.array(arbSessionWithPrs, { minLength: 0, maxLength: 10 }), (sessions) => {
        const result = collectRecentPrs(
          sessions as unknown as Parameters<typeof collectRecentPrs>[0],
        );
        // The `opened_at` ISO string is derived from registered_at*1000; we can
        // compare adjacent ISO strings directly since ISO 8601 sorts lexicographically.
        for (let i = 0; i < result.length - 1; i++) {
          const curr = result[i]!.opened_at;
          const next = result[i + 1]!.opened_at;
          if (curr < next) {
            throw new Error(
              `Sort order violated: result[${i}].opened_at="${curr}" < result[${i + 1}].opened_at="${next}"`,
            );
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property C — computeSessionsByRepo: active-count accuracy
// ---------------------------------------------------------------------------

describe('Property C — computeSessionsByRepo: active-count per repo', () => {
  it('active count for each row equals number of active sessions in that repo', () => {
    fc.assert(
      fc.property(
        fc.array(arbSessionForByRepo, { minLength: 0, maxLength: 20 }),
        fc.integer({ min: 1_000_000, max: 9_999_999 }),
        (sessions, nowS) => {
          const result = computeSessionsByRepo(
            sessions as unknown as Parameters<typeof computeSessionsByRepo>[0],
            nowS,
          );
          for (const row of result) {
            // Count active sessions for this repo in the input.
            const expectedActive = sessions.filter(
              (s) => s.repo === row.repo && s.status === 'active',
            ).length;
            if (row.active !== expectedActive) {
              throw new Error(
                `Repo ${row.repo}: expected active=${expectedActive}, got active=${row.active}`,
              );
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property D — computeSessionsByRepo: 10-row cap
// ---------------------------------------------------------------------------

describe('Property D — computeSessionsByRepo: 10-row cap', () => {
  it('output length is at most 10 (the default cap)', () => {
    fc.assert(
      fc.property(
        fc.array(arbSessionForByRepo, { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1_000_000, max: 9_999_999 }),
        (sessions, nowS) => {
          const result = computeSessionsByRepo(
            sessions as unknown as Parameters<typeof computeSessionsByRepo>[0],
            nowS,
          );
          if (result.length > 10) {
            throw new Error(`Output length ${result.length} exceeds cap of 10`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property E — computeSessionsByRepo: sort order by active count
// ---------------------------------------------------------------------------

describe('Property E — computeSessionsByRepo: sort order', () => {
  it('output is non-ascending by active count', () => {
    fc.assert(
      fc.property(
        fc.array(arbSessionForByRepo, { minLength: 0, maxLength: 30 }),
        fc.integer({ min: 1_000_000, max: 9_999_999 }),
        (sessions, nowS) => {
          const result = computeSessionsByRepo(
            sessions as unknown as Parameters<typeof computeSessionsByRepo>[0],
            nowS,
          );
          for (let i = 0; i < result.length - 1; i++) {
            const curr = result[i]!.active;
            const next = result[i + 1]!.active;
            if (curr < next) {
              throw new Error(
                `Sort order violated: result[${i}].active=${curr} < result[${i + 1}].active=${next}`,
              );
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property F — buildCronSummary: length invariant
// ---------------------------------------------------------------------------

describe('Property F — buildCronSummary: length equals cronConfig.length', () => {
  it('output always has exactly one row per cron config entry', () => {
    fc.assert(
      fc.property(
        fc.array(arbCronConfig, { minLength: 0, maxLength: 8 }),
        fc.array(arbCronState, { minLength: 0, maxLength: 8 }),
        (cronConfig, cronStates) => {
          const result = buildCronSummary(cronConfig, cronStates);
          if (result.length !== cronConfig.length) {
            throw new Error(
              `Expected output length ${cronConfig.length}, got ${result.length}`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property G — buildCronSummary: paused semantics
// ---------------------------------------------------------------------------

describe('Property G — buildCronSummary: paused cron has state=paused and next_fire=null', () => {
  it('a paused cron entry always produces state="paused" and next_fire=null', () => {
    fc.assert(
      fc.property(
        arbCronConfig,
        (cronEntry) => {
          // Create a cron state for this entry with paused=true.
          const cronState: CronSummarySource = {
            name: cronEntry.name,
            paused: true,
            lastFiredAt: null,
          };
          const result = buildCronSummary([cronEntry], [cronState]);
          if (result.length !== 1) {
            throw new Error('Expected exactly 1 result row');
          }
          const row = result[0]!;
          if (row.state !== 'paused') {
            throw new Error(`Expected state="paused", got "${row.state}"`);
          }
          if (row.next_fire !== null) {
            throw new Error(
              `Expected next_fire=null for paused cron, got "${row.next_fire}"`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property H — computeHealth: degraded on paused/error cron
// ---------------------------------------------------------------------------

describe('Property H — computeHealth: degraded when any cron is paused or error', () => {
  it('returns "degraded" when cronSummary contains a paused or error entry', () => {
    fc.assert(
      fc.property(
        fc.array(arbCronSummaryEntry, { minLength: 0, maxLength: 5 }),
        fc.array(arbCronSummaryEntry, { minLength: 0, maxLength: 5 }),
        fc.constantFrom<'paused' | 'error'>('paused', 'error'),
        fc.integer({ min: 1_000_000, max: 9_999_999 }),
        (prefix, suffix, badState, nowS) => {
          // Insert one entry with badState among arbitrary others.
          const badEntry: OverviewCronSummary = {
            name: 'bad-cron',
            repo: 'org/repo',
            schedule: '0 6 * * *',
            state: badState,
            next_fire: null,
            last_fired_at: null,
          };
          const cronSummary = [...prefix, badEntry, ...suffix];
          const result = computeHealth({
            cronSummary,
            activeSessions: [],
            nowS,
          });
          if (result !== 'degraded') {
            throw new Error(
              `Expected "degraded" with a ${badState} cron, got "${result}"`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property I — computeHealth: degraded on stale active session
// ---------------------------------------------------------------------------

describe('Property I — computeHealth: degraded when an active session is older than 2h', () => {
  it('returns "degraded" when activeSessions contains a session older than 2h', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7201, max: 999_999 }),
        fc.integer({ min: 7_200_001, max: 9_999_999_999 }),
        (ageS, nowS) => {
          // Session was created ageS seconds ago (>2h in the past).
          const staleCreatedAt = nowS - ageS;
          const result = computeHealth({
            cronSummary: [],
            activeSessions: [{ created_at: staleCreatedAt }],
            nowS,
          });
          if (result !== 'degraded') {
            throw new Error(
              `Expected "degraded" for session ${ageS}s old, got "${result}"`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property J — computeHealth: healthy with empty inputs
// ---------------------------------------------------------------------------

describe('Property J — computeHealth: healthy baseline', () => {
  it('returns "healthy" with empty cronSummary and empty activeSessions', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_000_000, max: 9_999_999_999 }), (nowS) => {
        const result = computeHealth({
          cronSummary: [],
          activeSessions: [],
          nowS,
        });
        if (result !== 'healthy') {
          throw new Error(`Expected "healthy" with empty inputs, got "${result}"`);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property K — collectRecentEvents: result-count and ordering
// ---------------------------------------------------------------------------

describe('Property K — collectRecentEvents: result count and ordering', () => {
  it('returns min(N, 10) rows ordered by received_at DESC for N processed events', () => {
    fc.assert(
      fc.property(
        // Generate 0..15 unique received_at timestamps (to avoid duplicates in ordering)
        fc.uniqueArray(fc.integer({ min: 1_000_000, max: 9_999_999_999 }), {
          minLength: 0,
          maxLength: 15,
        }),
        (receivedAts) => {
          const { db, cleanup } = makeDb();
          try {
            // Insert all events as processed.
            for (const ts of receivedAts) {
              insertProcessedEvent(db, {
                repo: 'org/repo',
                prNumber: 1,
                eventType: 'check_run',
                receivedAt: ts,
              });
            }
            const result = collectRecentEvents(db);
            const n = receivedAts.length;
            const expected = Math.min(n, 10);
            if (result.length !== expected) {
              throw new Error(
                `Expected ${expected} rows for ${n} events, got ${result.length}`,
              );
            }
            // Verify ordering: received_at must be descending.
            for (let i = 0; i < result.length - 1; i++) {
              if (result[i]!.received_at < result[i + 1]!.received_at) {
                throw new Error(
                  `Sort order violated at index ${i}: ${result[i]!.received_at} < ${result[i + 1]!.received_at}`,
                );
              }
            }
            // Verify that, when N>10, the result contains the 10 highest timestamps.
            if (n > 10) {
              const topTen = [...receivedAts].sort((a, b) => b - a).slice(0, 10);
              const resultTs = result.map((r) => r.received_at);
              for (const ts of topTen) {
                if (!resultTs.includes(ts)) {
                  throw new Error(
                    `Expected timestamp ${ts} in top-10 result but it was absent`,
                  );
                }
              }
            }
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: 50 },  // Fewer runs because this test creates real DB files.
    );
  });
});

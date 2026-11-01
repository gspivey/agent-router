import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  selectSessionsToPrune,
  type SessionDirEntry,
  type PruneInput,
} from '../../src/prune-sessions.js';
import type { SessionMeta } from '../../src/session-files.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1000000; // arbitrary Unix seconds
const RETENTION_30_DAYS = 30 * 24 * 60 * 60;

// Use a looser type for test overrides to avoid exactOptionalPropertyTypes constraints.
type TestMetaOverrides = Omit<Partial<SessionMeta>, 'terminal_at'> & {
  // Allow explicit `undefined` to mean "remove the field"
  terminal_at?: number | undefined;
};

function makeMeta(overrides: TestMetaOverrides): SessionMeta {
  const base: SessionMeta = {
    session_id: 'test-session',
    original_prompt: 'test',
    status: 'completed',
    created_at: NOW - RETENTION_30_DAYS - 1,
    completed_at: NOW - RETENTION_30_DAYS - 1,
    terminal_at: NOW - RETENTION_30_DAYS - 1,
    prs: [],
  };
  // Use Object.assign to handle exactOptionalPropertyTypes: keys set to undefined
  // in overrides need to be deleted from the result, not kept as undefined.
  const result = { ...base };
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (v === undefined) {
      delete (result as Record<string, unknown>)[k];
    } else {
      (result as Record<string, unknown>)[k] = v;
    }
  }
  return result;
}

function makeEntry(sessionId: string, modifiedAt: number): SessionDirEntry {
  return { sessionId, modifiedAt };
}

function makeInput(overrides: Partial<PruneInput> = {}): PruneInput {
  return {
    entries: [],
    activeIds: new Set<string>(),
    metas: new Map<string, SessionMeta>(),
    nowSeconds: NOW,
    retentionSeconds: RETENTION_30_DAYS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('selectSessionsToPrune', () => {
  it('returns empty when no entries', () => {
    const result = selectSessionsToPrune(makeInput());
    expect(result.toPrune).toHaveLength(0);
    expect(result.skippedActive).toBe(0);
    expect(result.skippedTooNew).toBe(0);
  });

  it('skips sessions in activeIds (daemon says active)', () => {
    const sessionId = 'abc-123';
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, NOW - RETENTION_30_DAYS - 1)],
        activeIds: new Set([sessionId]),
        metas: new Map([[sessionId, makeMeta({ session_id: sessionId })]]),
      }),
    );
    expect(result.toPrune).toHaveLength(0);
    expect(result.skippedActive).toBe(1);
  });

  it('skips sessions with meta.status === "active" (belt-and-suspenders)', () => {
    const sessionId = 'abc-123';
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, NOW - RETENTION_30_DAYS - 1)],
        activeIds: new Set<string>(),
        metas: new Map([
          [
            sessionId,
            makeMeta({ session_id: sessionId, status: 'active', terminal_at: undefined }),
          ],
        ]),
      }),
    );
    expect(result.toPrune).toHaveLength(0);
    expect(result.skippedActive).toBe(1);
  });

  it('prunes a completed session older than retention window', () => {
    const sessionId = 'abc-123';
    const oldTerminalAt = NOW - RETENTION_30_DAYS - 1;
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, oldTerminalAt)],
        metas: new Map([
          [sessionId, makeMeta({ session_id: sessionId, terminal_at: oldTerminalAt })],
        ]),
      }),
    );
    expect(result.toPrune).toHaveLength(1);
    expect(result.toPrune[0]?.sessionId).toBe(sessionId);
    expect(result.toPrune[0]?.reason.ageSource).toBe('terminal_at');
  });

  it('skips a completed session within the retention window', () => {
    const sessionId = 'abc-123';
    const recentTerminalAt = NOW - RETENTION_30_DAYS + 3600; // 1 hour before cutoff
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, recentTerminalAt)],
        metas: new Map([
          [sessionId, makeMeta({ session_id: sessionId, terminal_at: recentTerminalAt })],
        ]),
      }),
    );
    expect(result.toPrune).toHaveLength(0);
    expect(result.skippedTooNew).toBe(1);
  });

  it('prunes an orphaned directory (no meta) older than retention window', () => {
    const sessionId = 'abc-123';
    const oldMtime = NOW - RETENTION_30_DAYS - 1;
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, oldMtime)],
        metas: new Map<string, SessionMeta>(), // no meta
      }),
    );
    expect(result.toPrune).toHaveLength(1);
    expect(result.toPrune[0]?.reason.ageSource).toBe('dir_mtime');
  });

  it('skips an orphaned directory within the retention window', () => {
    const sessionId = 'abc-123';
    const recentMtime = NOW - RETENTION_30_DAYS + 3600;
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, recentMtime)],
        metas: new Map<string, SessionMeta>(),
      }),
    );
    expect(result.toPrune).toHaveLength(0);
    expect(result.skippedTooNew).toBe(1);
  });

  it('prunes a "failed" session beyond retention (uses terminal_at)', () => {
    const sessionId = 'fail-1';
    const oldTerminalAt = NOW - RETENTION_30_DAYS - 1;
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, oldTerminalAt)],
        metas: new Map([
          [
            sessionId,
            makeMeta({
              session_id: sessionId,
              status: 'failed',
              terminal_at: oldTerminalAt,
            }),
          ],
        ]),
      }),
    );
    expect(result.toPrune).toHaveLength(1);
  });

  it('skips a session with meta but no terminal_at (conservative)', () => {
    const sessionId = 'weird-1';
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, NOW - RETENTION_30_DAYS - 9999)],
        metas: new Map([
          [
            sessionId,
            makeMeta({
              session_id: sessionId,
              status: 'completed',
              terminal_at: undefined,
            }),
          ],
        ]),
      }),
    );
    expect(result.toPrune).toHaveLength(0);
    expect(result.skippedNoMeta).toBe(1);
  });

  it('handles mixed set correctly', () => {
    // active in daemon → skip
    const active = makeEntry('active-1', NOW - RETENTION_30_DAYS - 1);
    // meta.status active → skip
    const metaActive = makeEntry('meta-active-1', NOW - RETENTION_30_DAYS - 1);
    // old completed → prune
    const oldCompleted = makeEntry('old-1', NOW - RETENTION_30_DAYS - 1);
    // too new → skip
    const tooNew = makeEntry('new-1', NOW - 3600);
    // old orphaned → prune
    const orphaned = makeEntry('orphan-1', NOW - RETENTION_30_DAYS - 1);

    const result = selectSessionsToPrune(
      makeInput({
        entries: [active, metaActive, oldCompleted, tooNew, orphaned],
        activeIds: new Set(['active-1']),
        metas: new Map([
          [
            'meta-active-1',
            makeMeta({ session_id: 'meta-active-1', status: 'active', terminal_at: undefined }),
          ],
          [
            'old-1',
            makeMeta({
              session_id: 'old-1',
              terminal_at: NOW - RETENTION_30_DAYS - 1,
            }),
          ],
          [
            'new-1',
            makeMeta({ session_id: 'new-1', terminal_at: NOW - 3600 }),
          ],
        ]),
      }),
    );

    expect(result.toPrune.map((c) => c.sessionId).sort()).toEqual(['old-1', 'orphan-1'].sort());
    expect(result.skippedActive).toBe(2); // active-1 + meta-active-1
    expect(result.skippedTooNew).toBe(1); // new-1
  });

  it('terminal_at boundary: exactly at retention threshold IS pruned', () => {
    const sessionId = 'edge';
    const exactEdge = NOW - RETENTION_30_DAYS; // age == retentionSeconds (>= threshold)
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, exactEdge)],
        metas: new Map([
          [sessionId, makeMeta({ session_id: sessionId, terminal_at: exactEdge })],
        ]),
      }),
    );
    expect(result.toPrune).toHaveLength(1);
  });

  it('terminal_at boundary: one second before retention threshold is NOT pruned', () => {
    const sessionId = 'edge';
    const oneSecBefore = NOW - RETENTION_30_DAYS + 1; // age = retentionSeconds - 1
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, oneSecBefore)],
        metas: new Map([
          [sessionId, makeMeta({ session_id: sessionId, terminal_at: oneSecBefore })],
        ]),
      }),
    );
    expect(result.toPrune).toHaveLength(0);
    expect(result.skippedTooNew).toBe(1);
  });

  it('terminal_at boundary: one second past retention threshold IS pruned', () => {
    const sessionId = 'edge';
    const oneSecPast = NOW - RETENTION_30_DAYS - 1;
    const result = selectSessionsToPrune(
      makeInput({
        entries: [makeEntry(sessionId, oneSecPast)],
        metas: new Map([
          [sessionId, makeMeta({ session_id: sessionId, terminal_at: oneSecPast })],
        ]),
      }),
    );
    expect(result.toPrune).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('selectSessionsToPrune property tests', () => {
  it('active sessions are never selected for pruning', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 50 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: RETENTION_30_DAYS * 2 }),
        (sessionIds, activeCount, retentionSec) => {
          const retention = retentionSec + 1; // ensure > 0
          const uniqueIds = [...new Set(sessionIds)];
          const activeIds = new Set(uniqueIds.slice(0, activeCount));

          const entries: SessionDirEntry[] = uniqueIds.map((id) => ({
            sessionId: id,
            modifiedAt: NOW - retention - 1, // all old enough
          }));

          const metas = new Map<string, SessionMeta>(
            uniqueIds.map((id) => [
              id,
              makeMeta({ session_id: id, terminal_at: NOW - retention - 1 }),
            ]),
          );

          const result = selectSessionsToPrune({
            entries,
            activeIds,
            metas,
            nowSeconds: NOW,
            retentionSeconds: retention,
          });

          // No active session ID should be in toPrune
          const pruneIds = new Set(result.toPrune.map((c) => c.sessionId));
          for (const id of activeIds) {
            if (pruneIds.has(id)) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('no session with recent terminal_at is selected for pruning', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: RETENTION_30_DAYS - 1 }), // age < retention
        (sessionId, ageSeconds) => {
          const entries: SessionDirEntry[] = [
            { sessionId, modifiedAt: NOW - ageSeconds },
          ];
          const metas = new Map<string, SessionMeta>([
            [
              sessionId,
              makeMeta({
                session_id: sessionId,
                terminal_at: NOW - ageSeconds,
              }),
            ],
          ]);

          const result = selectSessionsToPrune({
            entries,
            activeIds: new Set<string>(),
            metas,
            nowSeconds: NOW,
            retentionSeconds: RETENTION_30_DAYS,
          });

          return result.toPrune.length === 0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('all old non-active sessions are selected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 30 }),
        fc.nat({ max: RETENTION_30_DAYS }),
        (sessionIds, extraAge) => {
          const uniqueIds = [...new Set(sessionIds)];
          const oldAge = RETENTION_30_DAYS + extraAge + 1; // strictly older than retention

          const entries: SessionDirEntry[] = uniqueIds.map((id) => ({
            sessionId: id,
            modifiedAt: NOW - oldAge,
          }));

          const metas = new Map<string, SessionMeta>(
            uniqueIds.map((id) => [
              id,
              makeMeta({ session_id: id, terminal_at: NOW - oldAge }),
            ]),
          );

          const result = selectSessionsToPrune({
            entries,
            activeIds: new Set<string>(),
            metas,
            nowSeconds: NOW,
            retentionSeconds: RETENTION_30_DAYS,
          });

          // All sessions should be selected since they're all old non-active sessions
          return result.toPrune.length === uniqueIds.length;
        },
      ),
      { numRuns: 200 },
    );
  });
});

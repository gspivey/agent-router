/**
 * Tier 1 tests for the Overview endpoint (spa-polish ROADMAP 87).
 *
 * Covers the pure helpers `computeHealth` (Req 1.6), `buildCronSummary`
 * (Req 1.5), and `collectRecentPrs`, plus a handler-shape test that asserts the
 * assembled `OverviewResponse` fields and the HTTP 200 zero/empty fallback when
 * optional data sources are absent (Req 1.1, 1.2, 1.8).
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildCronSummary,
  computeHealth,
  collectRecentPrs,
  createWebRoutes,
  type OverviewCronSummary,
  type OverviewResponse,
  type CronSummarySource,
} from '../../../src/web-routes.js';
import type { SessionMeta } from '../../../src/session-files.js';
import type { CronConfig } from '../../../src/config.js';

const fixedNow = new Date('2026-08-23T12:00:00Z');

function cronCfg(overrides: Partial<CronConfig> = {}): CronConfig {
  return {
    name: 'nightly',
    schedule: '0 9 * * *',
    repo: 'org/repo',
    promptFile: '/etc/prompt.md',
    ...overrides,
  };
}

describe('computeHealth', () => {
  it('is healthy with no crons and no stale sessions', () => {
    expect(computeHealth({ cronSummary: [], activeSessions: [], nowS: 1000 })).toBe('healthy');
  });

  it('is degraded when any cron is paused', () => {
    const cronSummary: OverviewCronSummary[] = [
      { name: 'a', repo: 'org/a', schedule: '* * * * *', state: 'paused', next_fire: null },
    ];
    expect(computeHealth({ cronSummary, activeSessions: [], nowS: 1000 })).toBe('degraded');
  });

  it('is degraded when any cron is error', () => {
    const cronSummary: OverviewCronSummary[] = [
      { name: 'a', repo: 'org/a', schedule: '* * * * *', state: 'error', next_fire: null },
    ];
    expect(computeHealth({ cronSummary, activeSessions: [], nowS: 1000 })).toBe('degraded');
  });

  it('is healthy at exactly the 2h boundary and degraded one second past it', () => {
    const nowS = 100_000;
    // created exactly 2h ago → NOT stale (strict less-than), still healthy.
    expect(
      computeHealth({ cronSummary: [], activeSessions: [{ created_at: nowS - 7200 }], nowS }),
    ).toBe('healthy');
    // created just over 2h ago → stale → degraded.
    expect(
      computeHealth({ cronSummary: [], activeSessions: [{ created_at: nowS - 7201 }], nowS }),
    ).toBe('degraded');
  });

  it('only ever returns healthy or degraded (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<OverviewCronSummary['state']>('active', 'paused', 'error')),
        fc.array(fc.integer({ min: 0, max: 200_000 })),
        fc.integer({ min: 0, max: 200_000 }),
        (states, createdAts, nowS) => {
          const cronSummary: OverviewCronSummary[] = states.map((state, i) => ({
            name: `c${i}`,
            repo: 'org/r',
            schedule: '* * * * *',
            state,
            next_fire: null,
          }));
          const activeSessions = createdAts.map(created_at => ({ created_at }));
          const h = computeHealth({ cronSummary, activeSessions, nowS });
          expect(h === 'healthy' || h === 'degraded').toBe(true);
          // Never healthy when any cron is paused/error.
          if (states.some(s => s === 'paused' || s === 'error')) {
            expect(h).toBe('degraded');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('buildCronSummary', () => {
  it('derives error-first: failed → error even when paused', () => {
    const states: CronSummarySource[] = [{ name: 'nightly', paused: true, last_status: 'failed' }];
    const [row] = buildCronSummary([cronCfg()], states, fixedNow);
    expect(row!.state).toBe('error');
  });

  it('derives paused when paused and not failed', () => {
    const states: CronSummarySource[] = [{ name: 'nightly', paused: true }];
    const [row] = buildCronSummary([cronCfg()], states, fixedNow);
    expect(row!.state).toBe('paused');
    // paused crons report no next fire.
    expect(row!.next_fire).toBeNull();
  });

  it('derives active when not paused and not failed, with a next_fire', () => {
    const states: CronSummarySource[] = [{ name: 'nightly', paused: false }];
    const [row] = buildCronSummary([cronCfg()], states, fixedNow);
    expect(row!.state).toBe('active');
    expect(row!.next_fire).not.toBeNull();
  });

  it('treats a missing cron-state entry as active (no error bit)', () => {
    const [row] = buildCronSummary([cronCfg()], [], fixedNow);
    expect(row!.state).toBe('active');
  });

  it('carries name/repo/schedule through unchanged', () => {
    const [row] = buildCronSummary([cronCfg({ name: 'x', repo: 'o/r', schedule: '5 4 * * *' })], [], fixedNow);
    expect(row).toMatchObject({ name: 'x', repo: 'o/r', schedule: '5 4 * * *' });
  });
});

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: crypto.randomUUID(),
    original_prompt: 'test',
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    completed_at: null,
    prs: [],
    ...overrides,
  };
}

describe('collectRecentPrs', () => {
  it('shapes PR rows and scales unix-seconds registered_at to ISO', () => {
    const sessions = [
      makeMeta({ prs: [{ repo: 'org/r', pr_number: 7, registered_at: 1_700_000_000 }] }),
    ];
    const rows = collectRecentPrs(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'org/r#7',
      repo: 'org/r',
      url: 'https://github.com/org/r/pull/7',
      state: 'open',
      opened_at: new Date(1_700_000_000 * 1000).toISOString(),
    });
  });

  it('marks merged PRs and dedupes repeated (repo, number)', () => {
    const sessions = [
      makeMeta({ prs: [{ repo: 'org/r', pr_number: 1, registered_at: 100, merged_at: 200 }] }),
      makeMeta({ prs: [{ repo: 'org/r', pr_number: 1, registered_at: 100 }] }),
    ];
    const rows = collectRecentPrs(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('merged');
  });

  it('sorts newest-first by registered_at', () => {
    const sessions = [
      makeMeta({ prs: [{ repo: 'org/r', pr_number: 1, registered_at: 100 }] }),
      makeMeta({ prs: [{ repo: 'org/r', pr_number: 2, registered_at: 300 }] }),
      makeMeta({ prs: [{ repo: 'org/r', pr_number: 3, registered_at: 200 }] }),
    ];
    const rows = collectRecentPrs(sessions);
    expect(rows.map(r => r.title)).toEqual(['org/r#2', 'org/r#3', 'org/r#1']);
  });
});

describe('GET /overview handler shape', () => {
  // Minimal stub deps: only sessionFiles.listSessions is consulted by the
  // handler; everything else is optional (db/config absent → fallbacks).
  function makeApp(sessions: SessionMeta[]) {
    const deps = {
      sessionMgr: {} as never,
      sessionFiles: { listSessions: () => sessions } as never,
      sseBroker: {} as never,
      rootDir: '/tmp',
      log: { info() {}, warn() {}, error() {}, debug() {} } as never,
      shuttingDown: () => false,
    };
    return createWebRoutes(deps);
  }

  it('returns 200 with zero/empty fallbacks when db and config are absent', async () => {
    const app = makeApp([]);
    const res = await app.request('/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.active_sessions).toBe(0);
    expect(body.queue_depth).toBe(0);
    expect(body.recent_prs).toEqual([]);
    expect(body.cron_summary).toEqual([]);
    expect(body.health).toBe('healthy');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime_s).toBe('number');
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('counts active sessions and collects recent PRs', async () => {
    const sessions: SessionMeta[] = [
      makeMeta({ status: 'active', created_at: Math.floor(Date.now() / 1000) }),
      makeMeta({ status: 'completed', prs: [{ repo: 'org/r', pr_number: 9, registered_at: 1000 }] }),
    ];
    const app = makeApp(sessions);
    const res = await app.request('/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.active_sessions).toBe(1);
    expect(body.recent_prs).toHaveLength(1);
    expect(body.recent_prs[0]!.title).toBe('org/r#9');
  });

  it('reports degraded health when an active session is stale (>2h)', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const sessions: SessionMeta[] = [makeMeta({ status: 'active', created_at: nowS - 7201 })];
    const app = makeApp(sessions);
    const res = await app.request('/overview');
    const body = (await res.json()) as OverviewResponse;
    expect(body.health).toBe('degraded');
  });
});

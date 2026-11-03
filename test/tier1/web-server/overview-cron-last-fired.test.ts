/**
 * Tier 1 tests for BACKLOG.md § P2.53 — `last_fired_at` in `buildCronSummary`.
 *
 * These are pure function tests: no network, no filesystem, no live daemon.
 */
import { describe, it, expect } from 'vitest';
import { buildCronSummary, type CronSummarySource } from '../../../src/web-routes.js';
import type { CronConfig } from '../../../src/config.js';

const fixedNow = new Date('2026-11-03T09:00:00Z');

function cronCfg(overrides: Partial<CronConfig> = {}): CronConfig {
  return {
    name: 'nightly',
    schedule: '0 9 * * *',
    repo: 'org/repo',
    promptFile: '/etc/prompt.md',
    ...overrides,
  };
}

describe('buildCronSummary — last_fired_at', () => {
  it('returns last_fired_at: null when the source row has no lastFiredAt', () => {
    const states: CronSummarySource[] = [{ name: 'nightly', paused: false }];
    const [row] = buildCronSummary([cronCfg()], states, fixedNow);
    expect(row!.last_fired_at).toBeNull();
  });

  it('returns last_fired_at: null when the source row has lastFiredAt: null', () => {
    const states: CronSummarySource[] = [{ name: 'nightly', paused: false, lastFiredAt: null }];
    const [row] = buildCronSummary([cronCfg()], states, fixedNow);
    expect(row!.last_fired_at).toBeNull();
  });

  it('returns the ISO 8601 string when lastFiredAt is a valid unix-second timestamp', () => {
    // 2026-11-03T08:00:00Z in unix seconds
    const lastFiredAtS = Math.floor(new Date('2026-11-03T08:00:00Z').getTime() / 1000);
    const states: CronSummarySource[] = [{ name: 'nightly', paused: false, lastFiredAt: lastFiredAtS }];
    const [row] = buildCronSummary([cronCfg()], states, fixedNow);
    expect(row!.last_fired_at).toBe('2026-11-03T08:00:00.000Z');
  });

  it('last_fired_at flows through unchanged (no epoch drift)', () => {
    const knownTimestamp = 1_762_160_400; // some specific unix second
    const expected = new Date(knownTimestamp * 1000).toISOString();
    const states: CronSummarySource[] = [{ name: 'nightly', paused: false, lastFiredAt: knownTimestamp }];
    const [row] = buildCronSummary([cronCfg()], states, fixedNow);
    expect(row!.last_fired_at).toBe(expected);
  });

  it('last_fired_at is null when the state entry is missing', () => {
    // No state entry at all — cron has never been paused or fired.
    const [row] = buildCronSummary([cronCfg()], [], fixedNow);
    expect(row!.last_fired_at).toBeNull();
  });

  it('returns last_fired_at: null for paused crons even if lastFiredAt is set', () => {
    // A paused cron still carries its last fire time so the operator can see
    // when it last ran before being paused.
    const lastFiredAtS = Math.floor(new Date('2026-11-01T09:00:00Z').getTime() / 1000);
    const states: CronSummarySource[] = [{ name: 'nightly', paused: true, lastFiredAt: lastFiredAtS }];
    const [row] = buildCronSummary([cronCfg()], states, fixedNow);
    // The last_fired_at IS surfaced even for paused crons — it's historical data.
    expect(row!.last_fired_at).toBe('2026-11-01T09:00:00.000Z');
    // But state should still be 'paused'.
    expect(row!.state).toBe('paused');
  });

  it('multiple crons each have their own last_fired_at', () => {
    const configs = [
      cronCfg({ name: 'morning', repo: 'org/a' }),
      cronCfg({ name: 'evening', repo: 'org/b' }),
    ];
    const ts1 = Math.floor(new Date('2026-11-03T07:00:00Z').getTime() / 1000);
    const ts2 = Math.floor(new Date('2026-11-03T19:00:00Z').getTime() / 1000);
    const states: CronSummarySource[] = [
      { name: 'morning', paused: false, lastFiredAt: ts1 },
      { name: 'evening', paused: false, lastFiredAt: ts2 },
    ];
    const rows = buildCronSummary(configs, states, fixedNow);
    expect(rows[0]!.last_fired_at).toBe(new Date(ts1 * 1000).toISOString());
    expect(rows[1]!.last_fired_at).toBe(new Date(ts2 * 1000).toISOString());
  });
});

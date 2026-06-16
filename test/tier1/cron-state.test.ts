/**
 * Tier 1 tests: cron_state persistence layer.
 * Requirements: 3.4 (paused/active state persists across daemon restarts)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from '../../src/db.js';
import type { Database } from '../../src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let cleanupFns: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanupFns) {
    try { fn(); } catch { /* ignore */ }
  }
  cleanupFns = [];
});

function setup(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'cron-state-test-'));
  const dbPath = join(dir, 'test.db');
  const db = initDatabase(dbPath);
  cleanupFns.push(() => { try { db.shutdown(); } catch { /* */ } });
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return db;
}

describe('cron_state persistence', () => {
  it('getCronState returns null for unknown name (default = active)', () => {
    const db = setup();
    expect(db.getCronState('nightly-tasks')).toBeNull();
  });

  it('setCronPaused(true) persists paused state', () => {
    const db = setup();
    db.setCronPaused('nightly-tasks', true);
    const state = db.getCronState('nightly-tasks');
    expect(state).not.toBeNull();
    expect(state!.name).toBe('nightly-tasks');
    expect(state!.paused).toBe(true);
    expect(state!.updatedAt).toBeGreaterThan(0);
  });

  it('setCronPaused(false) clears paused state', () => {
    const db = setup();
    db.setCronPaused('nightly-tasks', true);
    db.setCronPaused('nightly-tasks', false);
    const state = db.getCronState('nightly-tasks');
    expect(state).not.toBeNull();
    expect(state!.paused).toBe(false);
  });

  it('round-trip: pause then resume', () => {
    const db = setup();
    db.setCronPaused('job-a', true);
    expect(db.getCronState('job-a')!.paused).toBe(true);
    db.setCronPaused('job-a', false);
    expect(db.getCronState('job-a')!.paused).toBe(false);
  });

  it('getAllCronStates returns all entries', () => {
    const db = setup();
    db.setCronPaused('job-a', true);
    db.setCronPaused('job-b', false);
    const states = db.getAllCronStates();
    expect(states).toHaveLength(2);
    const names = states.map((s) => s.name).sort();
    expect(names).toEqual(['job-a', 'job-b']);
  });

  it('getAllCronStates returns empty array when no state exists', () => {
    const db = setup();
    expect(db.getAllCronStates()).toEqual([]);
  });

  it('state survives DB re-open (persistence round-trip)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-state-persist-'));
    const dbPath = join(dir, 'test.db');
    cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));

    const db1 = initDatabase(dbPath);
    db1.setCronPaused('nightly', true);
    db1.walCheckpoint();
    db1.shutdown();

    const db2 = initDatabase(dbPath);
    cleanupFns.push(() => { try { db2.shutdown(); } catch { /* */ } });
    const state = db2.getCronState('nightly');
    expect(state).not.toBeNull();
    expect(state!.paused).toBe(true);
  });

  it('setCronPaused updates updated_at on each call', async () => {
    const db = setup();
    db.setCronPaused('job-a', true);
    const t1 = db.getCronState('job-a')!.updatedAt;
    // Wait enough for the second-precision timestamp to advance
    await new Promise((r) => setTimeout(r, 1100));
    db.setCronPaused('job-a', false);
    const t2 = db.getCronState('job-a')!.updatedAt;
    expect(t2).toBeGreaterThan(t1);
  });
});

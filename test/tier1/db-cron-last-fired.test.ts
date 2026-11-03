/**
 * Tier 1 tests for BACKLOG.md § P2.53 — `db.setLastFiredAt`.
 *
 * Pure DB tests — no network, no fake backends, no live daemon.
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

function setup(): { db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'db-cron-test-'));
  const dbPath = join(dir, 'test.db');
  const db = initDatabase(dbPath);
  cleanupFns.push(() => {
    try { void db.shutdown(); } catch { /* already closed */ }
  });
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return { db };
}

describe('db.setLastFiredAt', () => {
  it('creates a new cron_state row when none exists', () => {
    const { db } = setup();
    const nowS = Math.floor(Date.now() / 1000);
    db.setLastFiredAt('my-cron', nowS);
    const state = db.getCronState('my-cron');
    expect(state).not.toBeNull();
    expect(state!.lastFiredAt).toBe(nowS);
  });

  it('updates last_fired_at on an existing row without changing paused state', () => {
    const { db } = setup();
    // First pause the cron to create a row with paused=true
    db.setCronPaused('my-cron', true);
    const before = db.getCronState('my-cron');
    expect(before!.paused).toBe(true);
    expect(before!.lastFiredAt).toBeNull();

    // Fire should update lastFiredAt but NOT change paused
    const nowS = Math.floor(Date.now() / 1000);
    db.setLastFiredAt('my-cron', nowS);
    const after = db.getCronState('my-cron');
    expect(after!.lastFiredAt).toBe(nowS);
    // paused should still be true — setLastFiredAt only touches last_fired_at and updated_at
    // Note: per spec the upsert sets paused=0 only on INSERT; on UPDATE it only sets last_fired_at.
    // The spec upsert only updates last_fired_at and updated_at on conflict.
    expect(after!.paused).toBe(true);
  });

  it('updates last_fired_at on a subsequent call', () => {
    const { db } = setup();
    const nowS = Math.floor(Date.now() / 1000);
    db.setLastFiredAt('my-cron', nowS);
    const laterS = nowS + 86400; // one day later
    db.setLastFiredAt('my-cron', laterS);
    const state = db.getCronState('my-cron');
    expect(state!.lastFiredAt).toBe(laterS);
  });

  it('getAllCronStates returns the updated last_fired_at', () => {
    const { db } = setup();
    const nowS = Math.floor(Date.now() / 1000);
    db.setLastFiredAt('cron-a', nowS);
    db.setLastFiredAt('cron-b', nowS + 100);

    const states = db.getAllCronStates();
    const a = states.find(s => s.name === 'cron-a');
    const b = states.find(s => s.name === 'cron-b');
    expect(a!.lastFiredAt).toBe(nowS);
    expect(b!.lastFiredAt).toBe(nowS + 100);
  });

  it('getAllCronStates returns lastFiredAt: null for never-fired crons', () => {
    const { db } = setup();
    // Create a cron state row via setCronPaused but never fire it
    db.setCronPaused('never-fired', false);
    const states = db.getAllCronStates();
    const row = states.find(s => s.name === 'never-fired');
    expect(row!.lastFiredAt).toBeNull();
  });

  it('getCronState returns lastFiredAt: null when the cron has never fired', () => {
    const { db } = setup();
    db.setCronPaused('fresh-cron', false);
    const state = db.getCronState('fresh-cron');
    expect(state!.lastFiredAt).toBeNull();
  });
});

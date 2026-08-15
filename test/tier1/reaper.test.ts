/**
 * Tier 1 tests: Session reaper — pure logic, config validation, eligibility, discovery.
 * Spec: .kiro/specs/session-reaper/ tasks 1.4, 4.1, 4.2, 4.3, 4.4, 4.5
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseDirTimestamp,
  isStrictChild,
  discoverWorktree,
  isEligibleForWorktreeReap,
  isEligibleForMetadataPrune,
  createReaper,
} from '../../src/reaper.js';
import type { ReaperConfig } from '../../src/reaper.js';
import { validateConfig } from '../../src/config.js';
import type { Logger } from '../../src/log.js';
import { createSessionFiles } from '../../src/session-files.js';
import type { SessionFiles } from '../../src/session-files.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function nopLogger(): Logger {
  const nop = () => {};
  return {
    info: nop,
    warn: nop,
    error: nop,
    debug: nop,
    child: () => nopLogger(),
  } as unknown as Logger;
}

function makeBaseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    port: 3000,
    webhookSecret: 'test-secret',
    kiroPath: process.execPath, // points to node, which is executable
    repos: [{ owner: 'org', name: 'repo' }],
    cron: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseDirTimestamp
// ---------------------------------------------------------------------------

describe('parseDirTimestamp', () => {
  it('parses a valid YYYYMMDD-HHMMSS string', () => {
    const ts = parseDirTimestamp('20260101-120000');
    expect(ts).toBe(Math.floor(new Date('2026-01-01T12:00:00Z').getTime() / 1000));
  });

  it('returns null for invalid format', () => {
    expect(parseDirTimestamp('2026-01-01')).toBeNull();
    expect(parseDirTimestamp('')).toBeNull();
    expect(parseDirTimestamp('abcdefgh-ijklmn')).toBeNull();
  });

  it('returns null for out-of-range date components', () => {
    expect(parseDirTimestamp('20261301-120000')).toBeNull(); // month 13
    expect(parseDirTimestamp('20260230-120000')).toBeNull(); // Feb 30
  });

  it('property: round-trips valid timestamps', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        (d: Date) => {
          const y = d.getUTCFullYear().toString();
          const mo = (d.getUTCMonth() + 1).toString().padStart(2, '0');
          const day = d.getUTCDate().toString().padStart(2, '0');
          const h = d.getUTCHours().toString().padStart(2, '0');
          const mi = d.getUTCMinutes().toString().padStart(2, '0');
          const s = d.getUTCSeconds().toString().padStart(2, '0');
          const tsStr = `${y}${mo}${day}-${h}${mi}${s}`;
          const parsed = parseDirTimestamp(tsStr);
          const expected = Math.floor(Date.UTC(
            d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
            d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
          ) / 1000);
          return parsed === expected;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// isStrictChild
// ---------------------------------------------------------------------------

describe('isStrictChild', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-strict-child-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true for a direct child', () => {
    const child = path.join(tmpDir, 'child');
    fs.mkdirSync(child);
    const resolved = fs.realpathSync(tmpDir);
    expect(isStrictChild(child, resolved)).toBe(true);
  });

  it('returns false for the parent itself', () => {
    const resolved = fs.realpathSync(tmpDir);
    expect(isStrictChild(tmpDir, resolved)).toBe(false);
  });

  it('returns false for a sibling with shared prefix', () => {
    const parent = path.join(tmpDir, 'runs');
    const sibling = path.join(tmpDir, 'runs-malicious');
    fs.mkdirSync(parent);
    fs.mkdirSync(sibling);
    const resolved = fs.realpathSync(parent);
    expect(isStrictChild(sibling, resolved)).toBe(false);
  });

  it('returns false for ENOENT target', () => {
    const resolved = fs.realpathSync(tmpDir);
    expect(isStrictChild(path.join(tmpDir, 'nonexistent'), resolved)).toBe(false);
  });

  it('resolves symlinks in target', () => {
    const actual = path.join(tmpDir, 'actual');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, link);
    const resolved = fs.realpathSync(tmpDir);
    expect(isStrictChild(link, resolved)).toBe(true);
  });

  it('rejects symlinked target that escapes parent', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-outside-'));
    const link = path.join(tmpDir, 'escape-link');
    fs.symlinkSync(outsideDir, link);
    const resolved = fs.realpathSync(tmpDir);
    expect(isStrictChild(link, resolved)).toBe(false);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('property: no ../traversal bypasses the check', () => {
    const parent = path.join(tmpDir, 'parent');
    fs.mkdirSync(parent);
    const resolved = fs.realpathSync(parent);

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('..', 'a', 'b', 'c'), { minLength: 1, maxLength: 5 }),
        (segments: string[]) => {
          const target = path.join(parent, ...segments);
          // If the target exists and isStrictChild returns true, verify it actually is
          if (fs.existsSync(target)) {
            const realTarget = fs.realpathSync(target);
            if (isStrictChild(target, resolved)) {
              return realTarget.startsWith(resolved + path.sep);
            }
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// discoverWorktree
// ---------------------------------------------------------------------------

describe('discoverWorktree', () => {
  let tmpDir: string;
  const log = nopLogger();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-discover-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the matching directory on a unique hit', () => {
    const createdAt = Math.floor(new Date('2026-03-15T14:30:00Z').getTime() / 1000);
    fs.mkdirSync(path.join(tmpDir, '20260315-143000-myrepo'));

    const result = discoverWorktree(tmpDir, 'session-1', 'org/myrepo', createdAt, log);
    expect(result).toBe(path.join(tmpDir, '20260315-143000-myrepo'));
  });

  it('returns null when timestamp is outside 5-minute window', () => {
    const createdAt = Math.floor(new Date('2026-03-15T14:30:00Z').getTime() / 1000);
    // 10 minutes off
    fs.mkdirSync(path.join(tmpDir, '20260315-144000-myrepo'));

    const result = discoverWorktree(tmpDir, 'session-1', 'org/myrepo', createdAt, log);
    expect(result).toBeNull();
  });

  it('returns null on zero matches', () => {
    const createdAt = Math.floor(new Date('2026-03-15T14:30:00Z').getTime() / 1000);
    const result = discoverWorktree(tmpDir, 'session-1', 'org/myrepo', createdAt, log);
    expect(result).toBeNull();
  });

  it('returns null on multiple matches', () => {
    const createdAt = Math.floor(new Date('2026-03-15T14:30:00Z').getTime() / 1000);
    fs.mkdirSync(path.join(tmpDir, '20260315-143000-myrepo'));
    fs.mkdirSync(path.join(tmpDir, '20260315-143100-myrepo'));

    const result = discoverWorktree(tmpDir, 'session-1', 'org/myrepo', createdAt, log);
    expect(result).toBeNull();
  });

  it('returns null when createdAt is undefined', () => {
    fs.mkdirSync(path.join(tmpDir, '20260315-143000-myrepo'));
    const result = discoverWorktree(tmpDir, 'session-1', 'org/myrepo', undefined, log);
    expect(result).toBeNull();
  });

  it('returns null when repo is undefined', () => {
    const createdAt = Math.floor(new Date('2026-03-15T14:30:00Z').getTime() / 1000);
    fs.mkdirSync(path.join(tmpDir, '20260315-143000-myrepo'));
    const result = discoverWorktree(tmpDir, 'session-1', undefined, createdAt, log);
    expect(result).toBeNull();
  });

  it('property: single match within 5 min window returns path', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 299 }), // offset seconds within 5 minutes
        fc.boolean(), // direction: before or after
        (offsetSeconds: number, before: boolean) => {
          const baseTs = Math.floor(new Date('2026-06-01T10:00:00Z').getTime() / 1000);
          const dirTs = before ? baseTs - offsetSeconds : baseTs + offsetSeconds;

          const d = new Date(dirTs * 1000);
          const y = d.getUTCFullYear().toString();
          const mo = (d.getUTCMonth() + 1).toString().padStart(2, '0');
          const day = d.getUTCDate().toString().padStart(2, '0');
          const h = d.getUTCHours().toString().padStart(2, '0');
          const mi = d.getUTCMinutes().toString().padStart(2, '0');
          const s = d.getUTCSeconds().toString().padStart(2, '0');
          const dirName = `${y}${mo}${day}-${h}${mi}${s}-testrepo`;

          const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-prop-'));
          fs.mkdirSync(path.join(testDir, dirName));

          const result = discoverWorktree(testDir, 'sid', 'org/testrepo', baseTs, log);
          fs.rmSync(testDir, { recursive: true, force: true });

          return result === path.join(testDir, dirName);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Eligibility logic
// ---------------------------------------------------------------------------

describe('eligibility logic', () => {
  const NOW = 1700000000;
  const GRACE = 3600; // 1 hour
  const RETENTION = 30 * 86400; // 30 days

  describe('isEligibleForWorktreeReap', () => {
    it('returns false for active sessions', () => {
      expect(isEligibleForWorktreeReap({ status: 'active', terminal_at: NOW - GRACE - 1 }, NOW, GRACE)).toBe(false);
    });

    it('returns false when terminal_at is undefined', () => {
      expect(isEligibleForWorktreeReap({ status: 'completed' }, NOW, GRACE)).toBe(false);
    });

    it('returns false when already reaped', () => {
      expect(isEligibleForWorktreeReap(
        { status: 'completed', terminal_at: NOW - GRACE - 1, worktree_reaped_at: NOW - 100 },
        NOW,
        GRACE,
      )).toBe(false);
    });

    it('returns false when grace period not elapsed', () => {
      expect(isEligibleForWorktreeReap(
        { status: 'completed', terminal_at: NOW - GRACE + 100 },
        NOW,
        GRACE,
      )).toBe(false);
    });

    it('returns true when all conditions met', () => {
      expect(isEligibleForWorktreeReap(
        { status: 'completed', terminal_at: NOW - GRACE - 1 },
        NOW,
        GRACE,
      )).toBe(true);
    });

    it('property: eligible iff all conditions hold', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('active', 'completed', 'failed', 'abandoned'),
          fc.option(fc.integer({ min: 0, max: 2000000000 }), { nil: undefined }),
          fc.option(fc.integer({ min: 0, max: 2000000000 }), { nil: undefined }),
          fc.integer({ min: 1000000000, max: 2000000000 }),
          (status, terminalAt, reapedAt, now) => {
            const input = { status: status as 'active' | 'completed' | 'failed' | 'abandoned', terminal_at: terminalAt, worktree_reaped_at: reapedAt };
            const result = isEligibleForWorktreeReap(input, now, GRACE);
            const expected =
              status !== 'active' &&
              terminalAt !== undefined &&
              reapedAt === undefined &&
              (now - terminalAt) >= GRACE;
            return result === expected;
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('isEligibleForMetadataPrune', () => {
    it('returns true when retention window elapsed', () => {
      expect(isEligibleForMetadataPrune(
        { status: 'completed', terminal_at: NOW - RETENTION - 1 },
        NOW,
        RETENTION,
      )).toBe(true);
    });

    it('returns false when retention window not elapsed', () => {
      expect(isEligibleForMetadataPrune(
        { status: 'completed', terminal_at: NOW - RETENTION + 100 },
        NOW,
        RETENTION,
      )).toBe(false);
    });

    it('returns false for active sessions', () => {
      expect(isEligibleForMetadataPrune(
        { status: 'active', terminal_at: NOW - RETENTION - 1 },
        NOW,
        RETENTION,
      )).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Reaper config validation
// ---------------------------------------------------------------------------

describe('reaper config validation', () => {
  it('applies defaults when reaper key is absent', () => {
    const config = validateConfig(makeBaseConfig());
    expect(config.reaper.enabled).toBe(true);
    expect(config.reaper.gracePeriodMinutes).toBe(60);
    expect(config.reaper.retentionDays).toBe(30);
    expect(config.reaper.sweepIntervalMinutes).toBe(15);
    expect(config.reaper.agentRunsDir).toContain('agent-runs');
  });

  it('applies overrides from config', () => {
    const config = validateConfig(makeBaseConfig({
      reaper: {
        enabled: false,
        gracePeriodMinutes: 30,
        retentionDays: 7,
        agentRunsDir: '/tmp/custom-runs',
        sweepIntervalMinutes: 5,
      },
    }));
    expect(config.reaper.enabled).toBe(false);
    expect(config.reaper.gracePeriodMinutes).toBe(30);
    expect(config.reaper.retentionDays).toBe(7);
    expect(config.reaper.agentRunsDir).toBe('/tmp/custom-runs');
    expect(config.reaper.sweepIntervalMinutes).toBe(5);
  });

  it('expands ~ in agentRunsDir', () => {
    const config = validateConfig(makeBaseConfig({
      reaper: { agentRunsDir: '~/my-runs' },
    }));
    expect(config.reaper.agentRunsDir).toBe(path.join(os.homedir(), 'my-runs'));
  });

  it('throws FatalError on non-positive gracePeriodMinutes', () => {
    expect(() => validateConfig(makeBaseConfig({
      reaper: { gracePeriodMinutes: 0 },
    }))).toThrow(/gracePeriodMinutes/);
  });

  it('throws FatalError on non-positive retentionDays', () => {
    expect(() => validateConfig(makeBaseConfig({
      reaper: { retentionDays: -1 },
    }))).toThrow(/retentionDays/);
  });

  it('throws FatalError on non-positive sweepIntervalMinutes', () => {
    expect(() => validateConfig(makeBaseConfig({
      reaper: { sweepIntervalMinutes: 0 },
    }))).toThrow(/sweepIntervalMinutes/);
  });

  it('throws FatalError on non-boolean enabled', () => {
    expect(() => validateConfig(makeBaseConfig({
      reaper: { enabled: 'yes' },
    }))).toThrow(/enabled/);
  });

  it('throws FatalError on non-string agentRunsDir', () => {
    expect(() => validateConfig(makeBaseConfig({
      reaper: { agentRunsDir: 123 },
    }))).toThrow(/agentRunsDir/);
  });
});

// ---------------------------------------------------------------------------
// onSessionTerminal with mock deps
// ---------------------------------------------------------------------------

describe('onSessionTerminal', () => {
  let tmpDir: string;
  let sessionFiles: SessionFiles;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-terminal-'));
    sessionFiles = createSessionFiles(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('schedules grace timer and reaps after expiry', async () => {
    const agentRunsDir = path.join(tmpDir, 'agent-runs');
    fs.mkdirSync(agentRunsDir);

    // Create a session and mark it terminal
    const sessionPaths = sessionFiles.createSession('sess-1', 'test prompt');
    sessionFiles.updateMeta('sess-1', { status: 'completed', completed_at: 100, termination_reason: 'completed' });

    // Create a worktree directory and register it
    const wtPath = path.join(agentRunsDir, '20260101-120000-myrepo');
    fs.mkdirSync(wtPath);
    sessionFiles.updateMeta('sess-1', { worktree_path: wtPath });

    let nowMs = Date.now();
    const config: ReaperConfig = {
      enabled: true,
      gracePeriodMinutes: 0, // immediate for testing (we'll use now override)
      retentionDays: 30,
      agentRunsDir,
      sweepIntervalMinutes: 60,
    };

    const reaper = createReaper({
      config: { ...config, gracePeriodMinutes: 0 },
      sessionFiles,
      isActive: () => false,
      log: nopLogger(),
      now: () => nowMs,
    });

    // Very short grace period - using 0 minutes so the timer fires at 0ms setTimeout
    reaper.onSessionTerminal('sess-1');

    // Wait for the timer to fire (0ms grace = immediate)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Worktree should be deleted
    expect(fs.existsSync(wtPath)).toBe(false);

    // Meta should have worktree_reaped_at
    const meta = sessionFiles.readMeta('sess-1');
    expect(meta.worktree_reaped_at).toBeDefined();

    reaper.shutdown();
  });

  it('skips deletion when session becomes active again', async () => {
    const agentRunsDir = path.join(tmpDir, 'agent-runs');
    fs.mkdirSync(agentRunsDir);

    const sessionPaths = sessionFiles.createSession('sess-2', 'test prompt');
    sessionFiles.updateMeta('sess-2', { status: 'completed', completed_at: 100, termination_reason: 'completed' });

    const wtPath = path.join(agentRunsDir, '20260101-120000-myrepo');
    fs.mkdirSync(wtPath);
    sessionFiles.updateMeta('sess-2', { worktree_path: wtPath });

    const reaper = createReaper({
      config: { enabled: true, gracePeriodMinutes: 0, retentionDays: 30, agentRunsDir, sweepIntervalMinutes: 60 },
      sessionFiles,
      isActive: () => true, // Simulate reactivation
      log: nopLogger(),
    });

    reaper.onSessionTerminal('sess-2');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Worktree should NOT be deleted
    expect(fs.existsSync(wtPath)).toBe(true);

    reaper.shutdown();
  });

  it('handles missing worktree path gracefully', async () => {
    const agentRunsDir = path.join(tmpDir, 'agent-runs');
    fs.mkdirSync(agentRunsDir);

    sessionFiles.createSession('sess-3', 'test prompt');
    sessionFiles.updateMeta('sess-3', { status: 'completed', completed_at: 100, termination_reason: 'completed' });
    // No worktree_path registered, no matching directory

    const reaper = createReaper({
      config: { enabled: true, gracePeriodMinutes: 0, retentionDays: 30, agentRunsDir, sweepIntervalMinutes: 60 },
      sessionFiles,
      isActive: () => false,
      log: nopLogger(),
    });

    reaper.onSessionTerminal('sess-3');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No crash — test passes if we get here
    reaper.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Sweep logic
// ---------------------------------------------------------------------------

describe('sweep logic', () => {
  let tmpDir: string;
  let sessionFiles: SessionFiles;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-sweep-'));
    sessionFiles = createSessionFiles(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reaps eligible worktrees and prunes old metadata', () => {
    const agentRunsDir = path.join(tmpDir, 'agent-runs');
    fs.mkdirSync(agentRunsDir);

    // Create a session that's past the grace period
    sessionFiles.createSession('old-1', 'test');
    sessionFiles.updateMeta('old-1', {
      status: 'completed',
      completed_at: 100,
      termination_reason: 'completed',
      terminal_at: 100,
    });

    const wtPath = path.join(agentRunsDir, 'old-worktree');
    fs.mkdirSync(wtPath);
    sessionFiles.updateMeta('old-1', { worktree_path: wtPath });

    // Create a session that's past retention (for metadata sweep)
    sessionFiles.createSession('ancient-1', 'test');
    sessionFiles.updateMeta('ancient-1', {
      status: 'failed',
      completed_at: 10,
      termination_reason: 'failed',
      terminal_at: 10,
      worktree_reaped_at: 20, // worktree already reaped
    });

    const nowMs = (100 + 3601) * 1000; // Just past 1h grace for old-1
    const nowForMetadata = (10 + 30 * 86400 + 1) * 1000; // Just past 30d for ancient-1

    const reaper = createReaper({
      config: { enabled: true, gracePeriodMinutes: 60, retentionDays: 30, agentRunsDir, sweepIntervalMinutes: 60 },
      sessionFiles,
      isActive: () => false,
      log: nopLogger(),
      now: () => nowForMetadata,
    });

    reaper.start();

    // Worktree should be reaped
    expect(fs.existsSync(wtPath)).toBe(false);

    // Ancient session metadata should be pruned
    expect(sessionFiles.sessionExists('ancient-1')).toBe(false);

    reaper.shutdown();
  });

  it('skips active sessions', () => {
    const agentRunsDir = path.join(tmpDir, 'agent-runs');
    fs.mkdirSync(agentRunsDir);

    sessionFiles.createSession('active-1', 'test');
    // Don't set to terminal — leave as active
    const wtPath = path.join(agentRunsDir, 'active-worktree');
    fs.mkdirSync(wtPath);
    sessionFiles.updateMeta('active-1', { worktree_path: wtPath });

    const reaper = createReaper({
      config: { enabled: true, gracePeriodMinutes: 0, retentionDays: 0, agentRunsDir, sweepIntervalMinutes: 60 },
      sessionFiles,
      isActive: (id) => id === 'active-1',
      log: nopLogger(),
      now: () => Date.now() + 100000000,
    });

    reaper.start();

    // Worktree should NOT be deleted
    expect(fs.existsSync(wtPath)).toBe(true);
    // Session metadata should NOT be deleted
    expect(sessionFiles.sessionExists('active-1')).toBe(true);

    reaper.shutdown();
  });
});

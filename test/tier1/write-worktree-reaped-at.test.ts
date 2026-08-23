/**
 * Tier 1 tests: SessionFiles.writeWorktreeReapedAt
 * Spec: BACKLOG.md § P2.17
 *
 * Verifies:
 * - writeWorktreeReapedAt atomically updates the worktree_reaped_at field
 * - Works on terminal sessions (completed, abandoned, failed)
 * - Works on active sessions
 * - Does not clobber other meta fields
 * - reaper.ts no longer contains a local writeWorktreeReapedAt function
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionFiles } from '../../src/session-files.js';
import type { SessionFiles, SessionMeta } from '../../src/session-files.js';

let rootDir: string;
let sf: SessionFiles;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-reaped-at-'));
  sf = createSessionFiles(rootDir);
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('SessionFiles.writeWorktreeReapedAt', () => {
  it('sets worktree_reaped_at on a terminal (completed) session', () => {
    sf.createSession('sess-1', 'test prompt');
    sf.updateMeta('sess-1', {
      status: 'completed',
      completed_at: 1000,
      termination_reason: 'completed',
      terminal_at: 1000,
    });

    sf.writeWorktreeReapedAt('sess-1', 2000);

    const meta = sf.readMeta('sess-1');
    expect(meta.worktree_reaped_at).toBe(2000);
    expect(meta.status).toBe('completed');
    expect(meta.session_id).toBe('sess-1');
  });

  it('sets worktree_reaped_at on a terminal (abandoned) session', () => {
    sf.createSession('sess-2', 'test prompt');
    sf.updateMeta('sess-2', {
      status: 'abandoned',
      completed_at: 1500,
      termination_reason: 'shutdown',
      terminal_at: 1500,
    });

    sf.writeWorktreeReapedAt('sess-2', 3000);

    const meta = sf.readMeta('sess-2');
    expect(meta.worktree_reaped_at).toBe(3000);
    expect(meta.status).toBe('abandoned');
  });

  it('sets worktree_reaped_at on a terminal (failed) session', () => {
    sf.createSession('sess-3', 'test prompt');
    sf.updateMeta('sess-3', {
      status: 'failed',
      completed_at: 1200,
      termination_reason: 'failed',
      terminal_at: 1200,
    });

    sf.writeWorktreeReapedAt('sess-3', 4000);

    const meta = sf.readMeta('sess-3');
    expect(meta.worktree_reaped_at).toBe(4000);
    expect(meta.status).toBe('failed');
  });

  it('sets worktree_reaped_at on an active session', () => {
    sf.createSession('sess-4', 'test prompt');

    sf.writeWorktreeReapedAt('sess-4', 5000);

    const meta = sf.readMeta('sess-4');
    expect(meta.worktree_reaped_at).toBe(5000);
    expect(meta.status).toBe('active');
  });

  it('does not clobber other meta fields', () => {
    sf.createSession('sess-5', 'original prompt');
    sf.updateMeta('sess-5', {
      repo: 'org/repo',
      worktree_path: '/some/path',
      status: 'completed',
      completed_at: 1000,
      termination_reason: 'merged',
      terminal_at: 1000,
    });

    sf.writeWorktreeReapedAt('sess-5', 6000);

    const meta = sf.readMeta('sess-5');
    expect(meta.worktree_reaped_at).toBe(6000);
    expect(meta.original_prompt).toBe('original prompt');
    expect(meta.repo).toBe('org/repo');
    expect(meta.worktree_path).toBe('/some/path');
    expect(meta.termination_reason).toBe('merged');
    expect(meta.prs).toEqual([]);
  });

  it('throws when session does not exist', () => {
    expect(() => sf.writeWorktreeReapedAt('nonexistent', 1000)).toThrow(
      /Failed to read meta.json/,
    );
  });

  it('overwrites a previously set worktree_reaped_at', () => {
    sf.createSession('sess-6', 'test prompt');
    sf.updateMeta('sess-6', {
      status: 'completed',
      completed_at: 1000,
      termination_reason: 'completed',
      terminal_at: 1000,
    });

    sf.writeWorktreeReapedAt('sess-6', 7000);
    sf.writeWorktreeReapedAt('sess-6', 8000);

    const meta = sf.readMeta('sess-6');
    expect(meta.worktree_reaped_at).toBe(8000);
  });
});

describe('reaper.ts no longer has local writeWorktreeReapedAt', () => {
  it('does not contain a local writeWorktreeReapedAt function definition', () => {
    const reaperSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/reaper.ts'),
      'utf-8',
    );
    // The old code had: function writeWorktreeReapedAt(sessionId: string, timestamp: number): void
    // Ensure that pattern is gone — the only reference should be to sessionFiles.writeWorktreeReapedAt
    const localFnPattern = /^\s*function writeWorktreeReapedAt\(/m;
    expect(localFnPattern.test(reaperSource)).toBe(false);
  });

  it('uses sessionFiles.writeWorktreeReapedAt in deleteWorktree', () => {
    const reaperSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/reaper.ts'),
      'utf-8',
    );
    expect(reaperSource).toContain('sessionFiles.writeWorktreeReapedAt(');
  });
});

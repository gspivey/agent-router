/**
 * Tier 2 tests: worktree-manager — two simultaneous sessions on same repo
 * get isolated worktrees and both clean up on termination.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createWorktreeManager, canonicalClonePath, worktreePath } from '../../src/worktree-manager.js';
import type { WorktreeManager } from '../../src/worktree-manager.js';
import { createLogger } from '../../src/log.js';

let rootDir: string;
let bareRepo: string;
let mgr: WorktreeManager;

/**
 * Create a minimal bare git repo that the worktree manager can clone from.
 * We use a local file:// URL so no network access is needed.
 */
function createLocalBareRepo(dir: string): string {
  const repoPath = path.join(dir, 'upstream.git');
  execFileSync('git', ['init', '--bare', repoPath], { stdio: 'pipe' });

  // Create an initial commit so the repo has a HEAD
  const tmpWork = path.join(dir, 'tmp-work');
  fs.mkdirSync(tmpWork);
  execFileSync('git', ['clone', repoPath, tmpWork], { stdio: 'pipe' });
  fs.writeFileSync(path.join(tmpWork, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tmpWork, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init'], { cwd: tmpWork, stdio: 'pipe' });
  execFileSync('git', ['push'], { cwd: tmpWork, stdio: 'pipe' });
  fs.rmSync(tmpWork, { recursive: true, force: true });

  return repoPath;
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tier2-'));
  bareRepo = createLocalBareRepo(rootDir);

  // The worktree manager uses `git clone --bare <url>`. We override the clone
  // URL by pre-creating the canonical clone directory pointing at our local bare repo.
  const canonDir = canonicalClonePath(rootDir, 'testorg', 'testrepo');
  fs.mkdirSync(path.dirname(canonDir), { recursive: true });
  execFileSync('git', ['clone', '--bare', bareRepo, canonDir], { stdio: 'pipe' });

  mgr = createWorktreeManager({
    rootDir,
    log: createLogger({ level: 'error', output: () => {} }),
  });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('worktree manager: two simultaneous sessions', () => {
  it('creates isolated worktrees for each session', () => {
    const wt1 = mgr.ensureWorktree('testorg/testrepo', 'session-aaa');
    const wt2 = mgr.ensureWorktree('testorg/testrepo', 'session-bbb');

    // Both paths exist and are different
    expect(wt1).not.toBe(wt2);
    expect(fs.existsSync(wt1)).toBe(true);
    expect(fs.existsSync(wt2)).toBe(true);

    // Both contain the repo's README
    expect(fs.existsSync(path.join(wt1, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(wt2, 'README.md'))).toBe(true);

    // Writing a file in one worktree does not affect the other
    fs.writeFileSync(path.join(wt1, 'only-in-1.txt'), 'hello');
    expect(fs.existsSync(path.join(wt2, 'only-in-1.txt'))).toBe(false);
  });

  it('cleans up worktrees on removal', () => {
    const wt1 = mgr.ensureWorktree('testorg/testrepo', 'session-aaa');
    const wt2 = mgr.ensureWorktree('testorg/testrepo', 'session-bbb');

    mgr.removeWorktree('testorg/testrepo', 'session-aaa');
    expect(fs.existsSync(wt1)).toBe(false);
    // Second worktree is unaffected
    expect(fs.existsSync(wt2)).toBe(true);

    mgr.removeWorktree('testorg/testrepo', 'session-bbb');
    expect(fs.existsSync(wt2)).toBe(false);
  });

  it('worktree branches are independent of each other', () => {
    const wt1 = mgr.ensureWorktree('testorg/testrepo', 'session-aaa');
    const wt2 = mgr.ensureWorktree('testorg/testrepo', 'session-bbb');

    // Commit in session-aaa worktree
    fs.writeFileSync(path.join(wt1, 'new.txt'), 'data');
    execFileSync('git', ['add', '.'], { cwd: wt1, stdio: 'pipe' });
    execFileSync(
      'git', ['-c', 'user.name=Test', '-c', 'user.email=t@t.com', 'commit', '-m', 'wt1 commit'],
      { cwd: wt1, stdio: 'pipe' },
    );

    // session-bbb should not see the commit
    const filesInWt2 = fs.readdirSync(wt2);
    expect(filesInWt2).not.toContain('new.txt');
  });

  it('removeWorktree is idempotent (no-throw on double call)', () => {
    mgr.ensureWorktree('testorg/testrepo', 'session-aaa');
    mgr.removeWorktree('testorg/testrepo', 'session-aaa');
    // Second call should not throw
    expect(() => mgr.removeWorktree('testorg/testrepo', 'session-aaa')).not.toThrow();
  });
});

describe('worktree manager: canonical clone auto-create', () => {
  it('fetches updates on subsequent calls', () => {
    // First call creates the worktree
    const wt1 = mgr.ensureWorktree('testorg/testrepo', 'session-ccc');
    expect(fs.existsSync(wt1)).toBe(true);
    mgr.removeWorktree('testorg/testrepo', 'session-ccc');

    // Second call should still work (fetch + worktree add)
    const wt2 = mgr.ensureWorktree('testorg/testrepo', 'session-ddd');
    expect(fs.existsSync(wt2)).toBe(true);
    mgr.removeWorktree('testorg/testrepo', 'session-ddd');
  });
});

describe('worktree manager: invalid repo', () => {
  it('throws on invalid repo format', () => {
    expect(() => mgr.ensureWorktree('noslash', 'session-x')).toThrow(/Invalid repo format/);
    expect(() => mgr.ensureWorktree('/leadingslash', 'session-x')).toThrow(/Invalid repo format/);
    expect(() => mgr.ensureWorktree('trailing/', 'session-x')).toThrow(/Invalid repo format/);
  });
});

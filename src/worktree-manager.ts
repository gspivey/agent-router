/**
 * Worktree manager — provides isolated git worktrees per session.
 *
 * Maintains a single canonical bare clone per repo under
 * `<rootDir>/repos/<owner>/<name>` and creates per-session worktrees
 * via `git worktree add`. Cleanup on termination via
 * `git worktree remove --force`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Logger } from './log.js';

export interface WorktreeManager {
  /**
   * Ensure a canonical clone exists for the repo and create a session worktree.
   * Returns the absolute path to the worktree directory.
   */
  ensureWorktree(repo: string, sessionId: string): string;

  /**
   * Remove a session's worktree and its branch. Best-effort — logs on failure.
   */
  removeWorktree(repo: string, sessionId: string): void;
}

export interface WorktreeManagerDeps {
  rootDir: string;
  log: Logger;
  /** Override git executable for testing. Defaults to 'git'. */
  gitBin?: string;
}

/**
 * Resolve the canonical clone directory for a repo.
 */
export function canonicalClonePath(rootDir: string, owner: string, name: string): string {
  return path.join(rootDir, 'repos', owner, name);
}

/**
 * Resolve the worktree directory for a session.
 */
export function worktreePath(rootDir: string, sessionId: string): string {
  return path.join(rootDir, 'worktrees', sessionId);
}

export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  const { rootDir, log } = deps;
  const git = deps.gitBin ?? 'git';

  function parseRepo(repo: string): { owner: string; name: string } {
    const slash = repo.indexOf('/');
    if (slash < 1 || slash === repo.length - 1) {
      throw new Error(`Invalid repo format "${repo}": expected "owner/name"`);
    }
    return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
  }

  function ensureCanonicalClone(owner: string, name: string): string {
    const cloneDir = canonicalClonePath(rootDir, owner, name);

    if (fs.existsSync(path.join(cloneDir, 'HEAD'))) {
      // Bare clone exists — fetch latest
      try {
        execFileSync(git, ['fetch', '--all', '--prune'], { cwd: cloneDir, stdio: 'pipe' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Failed to fetch canonical clone, proceeding with stale data', {
          repo: `${owner}/${name}`,
          error: msg,
        });
      }
      return cloneDir;
    }

    // Create the canonical bare clone
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    const url = `https://github.com/${owner}/${name}.git`;
    execFileSync(git, ['clone', '--bare', url, cloneDir], { stdio: 'pipe' });
    log.info('Created canonical bare clone', { repo: `${owner}/${name}`, path: cloneDir });
    return cloneDir;
  }

  function defaultBranch(cloneDir: string): string {
    try {
      const ref = execFileSync(git, ['symbolic-ref', 'HEAD'], {
        cwd: cloneDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      // e.g. refs/heads/main → main
      return ref.replace(/^refs\/heads\//, '');
    } catch {
      return 'main';
    }
  }

  return {
    ensureWorktree(repo: string, sessionId: string): string {
      const { owner, name } = parseRepo(repo);
      const cloneDir = ensureCanonicalClone(owner, name);
      const wtPath = worktreePath(rootDir, sessionId);
      const branch = `session/${sessionId}`;
      const base = defaultBranch(cloneDir);

      fs.mkdirSync(path.dirname(wtPath), { recursive: true });

      execFileSync(git, ['worktree', 'add', '-b', branch, wtPath, base], {
        cwd: cloneDir,
        stdio: 'pipe',
      });

      log.info('Created session worktree', { repo, sessionId, path: wtPath, branch });
      return wtPath;
    },

    removeWorktree(repo: string, sessionId: string): void {
      const { owner, name } = parseRepo(repo);
      const cloneDir = canonicalClonePath(rootDir, owner, name);
      const wtPath = worktreePath(rootDir, sessionId);

      // Remove the worktree (--force handles uncommitted changes)
      try {
        execFileSync(git, ['worktree', 'remove', '--force', wtPath], {
          cwd: cloneDir,
          stdio: 'pipe',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Failed to remove worktree via git', { repo, sessionId, error: msg });
      }

      // Remove the session branch
      const branch = `session/${sessionId}`;
      try {
        execFileSync(git, ['branch', '-D', branch], {
          cwd: cloneDir,
          stdio: 'pipe',
        });
      } catch {
        // Branch may not exist or already deleted — fine
      }

      // Remove the directory if it still exists
      if (fs.existsSync(wtPath)) {
        try {
          fs.rmSync(wtPath, { recursive: true, force: true });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('Failed to remove worktree directory', { repo, sessionId, path: wtPath, error: msg });
        }
      }

      log.info('Removed session worktree', { repo, sessionId });
    },
  };
}

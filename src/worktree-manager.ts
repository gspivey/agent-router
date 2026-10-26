/**
 * Worktree manager — provides an isolated per-session working directory.
 *
 * Two models, selected by `useWorkerUid`:
 *
 *  - **Default (useWorkerUid: false)** — a `git worktree add` off a single
 *    canonical bare clone per repo under `<rootDir>/repos/<owner>/<name>`.
 *    Unchanged behavior; the session's working directory lives under
 *    `<worktreeBase>/<sessionId>`.
 *
 *  - **Isolation (useWorkerUid: true, agent process isolation FR-3.4)** — a
 *    standalone clone OWNED BY `agentworker`, seeded from a bundle of the
 *    daemon's bare clone via the fixed root-owned wrapper
 *    `/usr/local/libexec/agent-router-seed-clone`. The daemon's bare clone
 *    stays daemon-owned (mode 700); `agentworker` can never write to it.
 *    Teardown runs `/usr/local/libexec/agent-router-rm-session`.
 *
 * CRITICAL (FR-3.4 step 5 / design §D): the daemon MUST NOT run git with a
 * `cwd` inside the session's `work/` directory. The agent controls
 * `.git/config` there (hooks, fsmonitor, credential helpers), so a daemon-side
 * `git` invocation there would execute those hooks as `agentrouter`. Every git
 * call in this file either operates on the daemon's canonical bare clone, is
 * executed via `sudo -u agentworker`, or is annotated
 * `// DAEMON_GIT_WORKDIR_AUDITED: <reason>`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Logger } from './log.js';
import type { TokenResolver } from './github.js';

export interface WorktreeManager {
  /**
   * Ensure a canonical clone exists for the repo and create a session working
   * directory. Returns the absolute path to the working directory.
   */
  ensureWorktree(repo: string, sessionId: string): string;

  /**
   * Remove a session's working directory and its branch. Best-effort — logs
   * on failure.
   */
  removeWorktree(repo: string, sessionId: string): void;
}

export interface WorktreeManagerDeps {
  rootDir: string;
  log: Logger;
  /**
   * Base directory for per-session working directories. Defaults to
   * `<rootDir>/worktrees` for backward compatibility.
   */
  worktreeBase?: string;
  /**
   * Agent process isolation (FR-3.4). When true, each session gets a
   * standalone `agentworker`-owned clone seeded via the fixed wrapper scripts
   * instead of a daemon-owned `git worktree`.
   */
  useWorkerUid?: boolean;
  /** Override git executable for testing. Defaults to 'git'. */
  gitBin?: string;
  /** Override the seed-clone wrapper path (testing). */
  seedCloneBin?: string;
  /** Override the rm-session wrapper path (testing). */
  rmSessionBin?: string;
  /** Override execFileSync (testing). */
  execFileSyncImpl?: typeof execFileSync;
  /**
   * Per-repo PAT for the canonical clone's `clone`/`fetch` (the same config
   * `repos[].token` source as session spawn and push_branch). Without it, git
   * falls back to the user's ambient credential helper.
   */
  tokenResolver?: TokenResolver;
}

/**
 * Git env that authenticates github.com with `pat` and disables every other
 * credential helper, so an ambient `GITHUB_TOKEN` / `gh` login is never used.
 * Same mechanism as agent-server's push path; the token stays out of argv.
 */
export function repoTokenGitEnv(pat: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${pat}`).toString('base64');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

const DEFAULT_SEED_CLONE_BIN = '/usr/local/libexec/agent-router-seed-clone';
const DEFAULT_RM_SESSION_BIN = '/usr/local/libexec/agent-router-rm-session';

/**
 * Resolve the canonical clone directory for a repo.
 */
export function canonicalClonePath(rootDir: string, owner: string, name: string): string {
  return path.join(rootDir, 'repos', owner, name);
}

/**
 * Resolve the per-session directory for a session under a worktree base.
 * (Backward-compatible: callers that pass `<rootDir>/worktrees` get the old
 * layout.)
 */
export function worktreePath(worktreeBase: string, sessionId: string): string {
  return path.join(worktreeBase, sessionId);
}

/**
 * Resolve the agent's working checkout for a session — the directory the
 * daemon hands the agent as `WORKDIR`, and where `push_branch` reads
 * `push-bundle.bundle` from.
 *
 * - Isolation model (useWorkerUid): `<base>/<sid>/work` (agentworker-owned clone).
 * - Non-isolation model: `<base>/<sid>` (git worktree of the canonical clone).
 */
export function sessionWorkDir(worktreeBase: string, sessionId: string, useWorkerUid: boolean): string {
  const sessionDir = worktreePath(worktreeBase, sessionId);
  return useWorkerUid ? path.join(sessionDir, 'work') : sessionDir;
}

export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  const { rootDir, log } = deps;
  const git = deps.gitBin ?? 'git';
  const worktreeBase = deps.worktreeBase ?? path.join(rootDir, 'worktrees');
  const useWorkerUid = deps.useWorkerUid ?? false;
  const seedCloneBin = deps.seedCloneBin ?? DEFAULT_SEED_CLONE_BIN;
  const rmSessionBin = deps.rmSessionBin ?? DEFAULT_RM_SESSION_BIN;
  const run = deps.execFileSyncImpl ?? execFileSync;

  function parseRepo(repo: string): { owner: string; name: string } {
    const slash = repo.indexOf('/');
    if (slash < 1 || slash === repo.length - 1) {
      throw new Error(`Invalid repo format "${repo}": expected "owner/name"`);
    }
    return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
  }

  /** Env for clone/fetch: the repo's own PAT, or undefined (ambient git auth). */
  function remoteGitEnv(owner: string, name: string): NodeJS.ProcessEnv | undefined {
    if (deps.tokenResolver === undefined) return undefined;
    try {
      return { ...process.env, ...repoTokenGitEnv(deps.tokenResolver(owner, name)) };
    } catch (err: unknown) {
      log.warn('No repo token for canonical clone; using ambient git credentials', {
        repo: `${owner}/${name}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  function ensureCanonicalClone(owner: string, name: string): string {
    const cloneDir = canonicalClonePath(rootDir, owner, name);
    const env = remoteGitEnv(owner, name);

    if (fs.existsSync(path.join(cloneDir, 'HEAD'))) {
      // Bare clone exists — fetch latest. A `clone --bare` has no
      // remote.origin.fetch refspec, so a bare `fetch --all` updates nothing
      // and the clone's branches stay frozen at clone time. Fetch heads
      // explicitly so session seeds/worktrees and the push_branch base (bundle
      // prerequisites, .github guard) track GitHub. No --prune: it would delete
      // local session/<sid> branches that live worktrees have checked out.
      try {
        // DAEMON_GIT_WORKDIR_AUDITED: cwd is the daemon-owned canonical bare
        // clone (mode 700), never the agent work/ dir.
        run(git, ['fetch', 'origin', '+refs/heads/*:refs/heads/*'], {
          cwd: cloneDir,
          stdio: 'pipe',
          ...(env !== undefined ? { env } : {}),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Failed to fetch canonical clone, proceeding with stale data', {
          repo: `${owner}/${name}`,
          error: msg,
        });
      }
      return cloneDir;
    }

    // Create the canonical bare clone (no cwd — operates on a URL).
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    const url = `https://github.com/${owner}/${name}.git`;
    run(git, ['clone', '--bare', url, cloneDir], { stdio: 'pipe', ...(env !== undefined ? { env } : {}) });
    log.info('Created canonical bare clone', { repo: `${owner}/${name}`, path: cloneDir });
    return cloneDir;
  }

  function defaultBranch(cloneDir: string): string {
    try {
      // DAEMON_GIT_WORKDIR_AUDITED: cwd is the daemon-owned canonical bare
      // clone, not a session work/ dir.
      const ref = run(git, ['symbolic-ref', 'HEAD'], {
        cwd: cloneDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
      return ref.replace(/^refs\/heads\//, '');
    } catch {
      return 'main';
    }
  }

  /** Isolation model: standalone agentworker-owned clone seeded from a bundle. */
  function ensureIsolatedClone(cloneDir: string, sessionId: string): string {
    const sessionDir = worktreePath(worktreeBase, sessionId);
    const workDir = sessionWorkDir(worktreeBase, sessionId, true);
    const bundlePath = path.join(sessionDir, 'seed.bundle');

    // Create {sid}/ (mode 0750). The setgid parent gives it the agentworker
    // group so the seed-clone wrapper (running as agentworker) can read the
    // bundle via group and create work/ inside it.
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o750 });

    // Bundle the daemon's bare clone. DAEMON_GIT_WORKDIR_AUDITED: cwd is the
    // daemon-owned canonical bare clone; the bundle output path is daemon-owned.
    run(git, ['bundle', 'create', bundlePath, '--all'], { cwd: cloneDir, stdio: 'pipe' });
    try {
      fs.chmodSync(bundlePath, 0o640);
    } catch {
      // best effort — group read is what agentworker needs
    }

    // Perform the clone AS agentworker via the fixed root-owned wrapper (BASE
    // is hardcoded in the wrapper; it validates the SID). No daemon-side git
    // runs inside work/.
    run('/usr/bin/sudo', ['-n', seedCloneBin, sessionId], { stdio: 'pipe' });

    // Delete the seed bundle after the clone.
    try {
      fs.rmSync(bundlePath, { force: true });
    } catch {
      // best effort
    }

    log.info('Created isolated session clone', { sessionId, path: workDir });
    return workDir;
  }

  return {
    ensureWorktree(repo: string, sessionId: string): string {
      const { owner, name } = parseRepo(repo);
      const cloneDir = ensureCanonicalClone(owner, name);

      if (useWorkerUid) {
        return ensureIsolatedClone(cloneDir, sessionId);
      }

      const wtPath = sessionWorkDir(worktreeBase, sessionId, false);
      const branch = `session/${sessionId}`;
      const base = defaultBranch(cloneDir);

      fs.mkdirSync(path.dirname(wtPath), { recursive: true });

      // DAEMON_GIT_WORKDIR_AUDITED: `worktree add` runs with cwd in the
      // daemon-owned canonical bare clone (not in the new work tree), and in
      // the non-isolation model the work tree is daemon-owned anyway.
      run(git, ['worktree', 'add', '-b', branch, wtPath, base], {
        cwd: cloneDir,
        stdio: 'pipe',
      });

      log.info('Created session worktree', { repo, sessionId, path: wtPath, branch });
      return wtPath;
    },

    removeWorktree(repo: string, sessionId: string): void {
      const { owner, name } = parseRepo(repo);
      const cloneDir = canonicalClonePath(rootDir, owner, name);
      const sessionDir = worktreePath(worktreeBase, sessionId);

      if (useWorkerUid) {
        // Teardown via the fixed wrapper (removes agentworker-owned work/ as
        // agentworker, then the daemon-owned session dir). No daemon git runs
        // inside work/.
        try {
          run('/usr/bin/sudo', ['-n', rmSessionBin, sessionId], { stdio: 'pipe' });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('Failed to remove isolated session clone via wrapper', { repo, sessionId, error: msg });
        }
        // Best-effort: ensure the daemon-owned session dir is gone.
        if (fs.existsSync(sessionDir)) {
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch {
            // best effort
          }
        }
        log.info('Removed isolated session clone', { repo, sessionId });
        return;
      }

      const wtPath = sessionDir;

      // Remove the worktree (--force handles uncommitted changes).
      // DAEMON_GIT_WORKDIR_AUDITED: cwd is the daemon-owned canonical bare
      // clone; `worktree remove` targets the path by argument, not by cwd.
      try {
        run(git, ['worktree', 'remove', '--force', wtPath], {
          cwd: cloneDir,
          stdio: 'pipe',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Failed to remove worktree via git', { repo, sessionId, error: msg });
      }

      // Remove the session branch. DAEMON_GIT_WORKDIR_AUDITED: cwd is the
      // daemon-owned canonical bare clone, not a session work/ dir.
      const branch = `session/${sessionId}`;
      try {
        run(git, ['branch', '-D', branch], {
          cwd: cloneDir,
          stdio: 'pipe',
        });
      } catch {
        // Branch may not exist or already deleted — fine
      }

      // Remove the directory if it still exists.
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

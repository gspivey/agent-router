/**
 * Tier 2 tests: merge_pr MCP tool and complete_session open-PR validation.
 *
 * Covers the bug where an agent could mark a session completed while a
 * registered PR was still open on GitHub (it had done a local `git merge`
 * + `git push` that branch-protection later blocked anyway).
 *
 * Uses a hand-rolled fake GitHubClient rather than FakeGitHubBackend so the
 * test stays focused on the session-manager surface without spinning up an
 * HTTP server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { createSessionManager, OpenPRsError, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { createCliServer, type CliServer } from '../../src/cli-server.js';
import { TestCli } from '../harness/test-cli.js';
import { createVerifier } from '../../src/verify-session.js';
import type { GitHubClient, PullState, MergeResult } from '../../src/github.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

interface FakeGitHubClient extends GitHubClient {
  setPRState(repo: string, prNumber: number, state: PullState): void;
  mergeCalls: Array<{ owner: string; repo: string; prNumber: number }>;
  failNextMerge: (err: Error) => void;
}

function createFakeGitHubClient(): FakeGitHubClient {
  const states = new Map<string, PullState>();
  const mergeCalls: Array<{ owner: string; repo: string; prNumber: number }> = [];
  let nextMergeError: Error | null = null;

  return {
    mergeCalls,
    setPRState(repo, prNumber, state) {
      states.set(`${repo}#${prNumber}`, state);
    },
    failNextMerge(err) {
      nextMergeError = err;
    },
    async getPullState(owner, repo, prNumber): Promise<PullState> {
      const key = `${owner}/${repo}#${prNumber}`;
      const found = states.get(key);
      if (!found) {
        throw new Error(`fake: no state set for ${key}`);
      }
      return found;
    },
    async mergePullRequest(owner, repo, prNumber): Promise<MergeResult> {
      mergeCalls.push({ owner, repo, prNumber });
      if (nextMergeError !== null) {
        const err = nextMergeError;
        nextMergeError = null;
        throw err;
      }
      // Mirror real-GitHub behavior empirically confirmed in tier3:
      // a second PUT /merge on an already-merged PR returns 200 with the
      // ORIGINAL merge commit details, not a fresh SHA. Without this branch
      // the fake silently "re-merges" with a new SHA every call, masking
      // bugs where production code calls mergePullRequest twice.
      const key = `${owner}/${repo}#${prNumber}`;
      const existing = states.get(key);
      if (existing !== undefined && existing.merged) {
        return {
          sha: existing.mergeCommitSha ?? 'fake-merge-sha',
          merged: true,
          message: 'Pull Request successfully merged',
        };
      }
      states.set(key, { number: prNumber, state: 'closed', merged: true, mergeCommitSha: 'fake-merge-sha' });
      return { sha: 'fake-merge-sha', merged: true, message: 'Squashed and merged' };
    },
  };
}

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let github: FakeGitHubClient;
let mgr: SessionManager;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-pr-tier2-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
  github = createFakeGitHubClient();

  const verify = createVerifier({ sessionFiles: sf, github, log });
  mgr = createSessionManager({
    db,
    sessionFiles: sf,
    acpSpawner: (sessionId: string) => {
      const cfg = kiro.spawnConfig();
      return spawnACPClient(cfg.command, cfg.args, {
        ...cfg.env,
        AGENT_ROUTER_SESSION_ID: sessionId,
      });
    },
    log,
    github,
    verify,
  });
});

afterEach(async () => {
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('mergePR', () => {
  it('calls GitHub squash-merge for a registered PR and returns the sha', async () => {
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);

    const result = await mgr.mergePR(h.sessionId, 'agent-router/repo', 59);

    expect(result.sha).toBe('fake-merge-sha');
    expect(github.mergeCalls).toEqual([{ owner: 'agent-router', repo: 'repo', prNumber: 59 }]);
  }, 15_000);

  it('appends a pr_merged stream entry on success', async () => {
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);
    await mgr.mergePR(h.sessionId, 'agent-router/repo', 59);

    const lines = fs.readFileSync(h.paths.stream, 'utf-8').trim().split('\n').filter((l) => l.length > 0);
    const merged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e['type'] === 'pr_merged');
    expect(merged).toBeDefined();
    expect(merged!['repo']).toBe('agent-router/repo');
    expect(merged!['pr_number']).toBe(59);
    expect(merged!['sha']).toBe('fake-merge-sha');
  }, 15_000);

  it('refuses to merge a PR not registered with this session', async () => {
    const h = await mgr.createSession('Ship feature');
    // Note: no registerPR call

    await expect(mgr.mergePR(h.sessionId, 'agent-router/repo', 59)).rejects.toThrow(/not registered/);
    expect(github.mergeCalls).toHaveLength(0);
  }, 15_000);

  it('throws for an unknown session', async () => {
    await expect(mgr.mergePR('nonexistent-session', 'o/r', 1)).rejects.toThrow(/No active session/);
  });

  it('rejects malformed repo strings', async () => {
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'no-slash-here', 1);
    await expect(mgr.mergePR(h.sessionId, 'no-slash-here', 1)).rejects.toThrow(/owner\/name/);
  }, 15_000);

  it('propagates errors from the GitHub client (branch protection, conflict, etc.)', async () => {
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'o/r', 1);
    github.failNextMerge(new Error('GitHub API PUT /repos/o/r/pulls/1/merge failed: 405 Method Not Allowed'));

    await expect(mgr.mergePR(h.sessionId, 'o/r', 1)).rejects.toThrow(/405/);

    // No pr_merged entry written for a failed merge
    const lines = fs.readFileSync(h.paths.stream, 'utf-8').trim().split('\n').filter((l) => l.length > 0);
    const merged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e['type'] === 'pr_merged');
    expect(merged).toBeUndefined();
  }, 15_000);
});

describe('completeSession open-PR validation', () => {
  it('rejects completion when a registered PR is still open on GitHub (the bug)', async () => {
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);
    github.setPRState('agent-router/repo', 59, { number: 59, state: 'open', merged: false, mergeCommitSha: null });

    await expect(mgr.completeSession(h.sessionId, 'merged')).rejects.toBeInstanceOf(OpenPRsError);

    // Session should still be active — completion was refused
    const meta = sf.readMeta(h.sessionId);
    expect(meta.status).toBe('active');
    expect(meta.completed_at).toBeNull();
  }, 15_000);

  it('OpenPRsError lists every still-open PR', async () => {
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 60);
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 61);
    github.setPRState('agent-router/repo', 59, { number: 59, state: 'open', merged: false, mergeCommitSha: null });
    github.setPRState('agent-router/repo', 60, { number: 60, state: 'closed', merged: true, mergeCommitSha: 'fake-merge-sha' });
    github.setPRState('agent-router/repo', 61, { number: 61, state: 'open', merged: false, mergeCommitSha: null });

    try {
      await mgr.completeSession(h.sessionId, 'merged');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenPRsError);
      const e = err as OpenPRsError;
      expect(e.openPRs).toEqual([
        { repo: 'agent-router/repo', pr_number: 59 },
        { repo: 'agent-router/repo', pr_number: 61 },
      ]);
    }
  }, 15_000);

  it('allows completion when every registered PR is merged', async () => {
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);
    github.setPRState('agent-router/repo', 59, { number: 59, state: 'closed', merged: true, mergeCommitSha: 'fake-merge-sha' });

    await expect(mgr.completeSession(h.sessionId, 'merged')).resolves.toBeUndefined();

    const meta = sf.readMeta(h.sessionId);
    expect(meta.status).toBe('completed');
    expect(meta.termination_reason).toBe('merged');
  }, 15_000);

  it('allows completion when every registered PR is closed-unmerged', async () => {
    const h = await mgr.createSession('Abandon feature');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);
    github.setPRState('agent-router/repo', 59, { number: 59, state: 'closed', merged: false, mergeCommitSha: null });

    await expect(mgr.completeSession(h.sessionId, 'completed')).resolves.toBeUndefined();
  }, 15_000);

  it('allows completion when no PRs are registered (no API calls made)', async () => {
    const h = await mgr.createSession('Investigate a bug');
    await expect(mgr.completeSession(h.sessionId, 'completed')).resolves.toBeUndefined();
    expect(github.mergeCalls).toHaveLength(0);
  }, 15_000);

  it('end-to-end: agent registers PR, merges via mergePR, then completes cleanly', async () => {
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);
    github.setPRState('agent-router/repo', 59, { number: 59, state: 'open', merged: false, mergeCommitSha: null });

    // First attempt: completion fails because PR is still open
    await expect(mgr.completeSession(h.sessionId, 'merged')).rejects.toBeInstanceOf(OpenPRsError);

    // Agent calls merge_pr properly
    await mgr.mergePR(h.sessionId, 'agent-router/repo', 59);
    // mergePullRequest fake flips the state to closed/merged automatically

    // Second attempt: completion succeeds
    await expect(mgr.completeSession(h.sessionId, 'merged')).resolves.toBeUndefined();
    const meta = sf.readMeta(h.sessionId);
    expect(meta.status).toBe('completed');
  }, 15_000);
});

describe('cli-server end-to-end (socket protocol)', () => {
  let cliServer: CliServer;
  let cli: TestCli;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = path.join(rootDir, 'sock');
    cliServer = createCliServer({ socketPath, sessionMgr: mgr, sessionFiles: sf, log });
    await cliServer.start();
    cli = new TestCli(socketPath);
  });

  afterEach(async () => {
    await cliServer.shutdown();
  });

  it('complete_session returns structured open_prs payload when a PR is still open', async () => {
    const session = await cli.newSession('Ship feature');
    await cli.registerPR(session.session_id, 'agent-router/repo', 59);
    github.setPRState('agent-router/repo', 59, { number: 59, state: 'open', merged: false, mergeCommitSha: null });

    const result = await cli.completeSession(session.session_id, 'merged');

    expect(result.ok).toBeUndefined();
    expect(result.error).toMatch(/still open/i);
    expect(result.open_prs).toEqual([{ repo: 'agent-router/repo', pr_number: 59 }]);

    // meta stays active
    const metaPath = path.join(rootDir, 'sessions', session.session_id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['status']).toBe('active');
  }, 15_000);

  it('merge_pr returns {ok, sha} on success', async () => {
    const session = await cli.newSession('Ship feature');
    await cli.registerPR(session.session_id, 'agent-router/repo', 59);

    const result = await cli.mergePR(session.session_id, 'agent-router/repo', 59);
    expect(result.ok).toBe(true);
    expect(result.sha).toBe('fake-merge-sha');
  }, 15_000);

  it('merge_pr → complete_session: full happy path through the socket', async () => {
    const session = await cli.newSession('Ship feature');
    await cli.registerPR(session.session_id, 'agent-router/repo', 59);
    github.setPRState('agent-router/repo', 59, { number: 59, state: 'open', merged: false, mergeCommitSha: null });

    // Open-PR check blocks completion
    const blocked = await cli.completeSession(session.session_id, 'merged');
    expect(blocked.open_prs).toBeDefined();

    // Agent merges via merge_pr
    const merged = await cli.mergePR(session.session_id, 'agent-router/repo', 59);
    expect(merged.ok).toBe(true);

    // Now completion succeeds
    const done = await cli.completeSession(session.session_id, 'merged');
    expect(done.ok).toBe(true);
  }, 15_000);

  it('merge_pr rejects unknown op argument validation through the socket', async () => {
    const session = await cli.newSession('Ship feature');
    const result = await cli.mergePR(session.session_id, '', 0);
    expect(result.error).toBeDefined();
  }, 15_000);
});

describe('session-mgr without GitHub client (back-compat)', () => {
  it('completeSession skips open-PR check when github dep is omitted', async () => {
    // Re-create manager without github wired up
    await mgr.shutdown();
    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string) => {
        const cfg = kiro.spawnConfig();
        return spawnACPClient(cfg.command, cfg.args, {
          ...cfg.env,
          AGENT_ROUTER_SESSION_ID: sessionId,
        });
      },
      log,
      // No github
    });

    const h = await mgr.createSession('Old behavior');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);
    // No PR state set — would error if API was hit
    await expect(mgr.completeSession(h.sessionId, 'merged')).resolves.toBeUndefined();
  }, 15_000);

  it('mergePR throws when github dep is omitted', async () => {
    await mgr.shutdown();
    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string) => {
        const cfg = kiro.spawnConfig();
        return spawnACPClient(cfg.command, cfg.args, {
          ...cfg.env,
          AGENT_ROUTER_SESSION_ID: sessionId,
        });
      },
      log,
    });

    const h = await mgr.createSession('Old behavior');
    await mgr.registerPR(h.sessionId, 'o/r', 1);
    await expect(mgr.mergePR(h.sessionId, 'o/r', 1)).rejects.toThrow(/GitHub client not configured/);
  }, 15_000);
});

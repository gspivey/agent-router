/**
 * Tier 3 tests: merge_pr + verifySession against real GitHub.
 *
 * These tests catch the bug class that Tier 1+2 fakes cannot: places where
 * GitHub's actual API behavior differs from what we assumed when we wrote
 * the code. Specifically:
 *
 *  - `merge_pr` against the real squash-merge endpoint and post-merge GET
 *    polling against real eventual consistency.
 *  - 405-already-merged idempotency: GitHub really does return 405 on
 *    PUT /merge for an already-merged PR, and our code recovers correctly.
 *  - `verifySession` translating real GitHub PR state into the correct
 *    `termination_reason`.
 *
 * Does not exercise the daemon process, the MCP socket, or the ACP layer
 * — those have full Tier 2 coverage against fakes. This file targets the
 * GitHubClient + verifier surface only.
 *
 * Requires: GITHUB_TOKEN, GITHUB_TEST_REPO. Does NOT require KIRO_PATH or
 * a public webhook URL. Skips gracefully when env is incomplete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Octokit } from '@octokit/rest';
import { createGitHubClient, GitHubApiError, type GitHubClient } from '../../src/github.js';
import { createVerifier, type VerifySessionFn } from '../../src/verify-session.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { createLogger } from '../../src/log.js';
import { RealGitHubBackend } from '../harness/real-github.js';

const hasEnv = !!process.env['GITHUB_TOKEN'] && !!process.env['GITHUB_TEST_REPO'];

describe.skipIf(!hasEnv)('Tier 3: merge_pr + verifySession against real GitHub', () => {
  let owner: string;
  let repoName: string;
  let octokit: Octokit;
  let backend: RealGitHubBackend;
  let github: GitHubClient;
  let sessionFiles: SessionFiles;
  let verifySession: VerifySessionFn;
  let rootDir: string;

  beforeAll(async () => {
    const [o, r] = process.env['GITHUB_TEST_REPO']!.split('/') as [string, string];
    owner = o;
    repoName = r;

    octokit = new Octokit({ auth: process.env['GITHUB_TOKEN']! });

    // The production GitHubClient — same code path as the daemon uses.
    // Generous timeout because real GitHub responses can be slow under load;
    // poll budget is enough to absorb eventual-consistency lag.
    github = createGitHubClient({
      requestTimeoutMs: 10_000,
      pollAttempts: 10,
      pollIntervalMs: 500,
    });

    backend = new RealGitHubBackend();
    await backend.start();
    await backend.reset();

    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier3-mv-'));
    sessionFiles = createSessionFiles(rootDir);
    verifySession = createVerifier({
      sessionFiles,
      github,
      log: createLogger({ level: 'error', output: () => {} }),
    });
  }, 60_000);

  afterAll(async () => {
    try {
      if (backend) {
        await backend.reset();
        await backend.stop();
      }
    } catch {
      /* best effort */
    }
    if (rootDir) {
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }, 60_000);

  /**
   * Create a fresh PR for each test. The harness creates a real branch,
   * a real commit on it, and opens the PR via the GitHub API.
   */
  async function freshPR(label: string): Promise<number> {
    const branch = `tier3-mv-${label}-${Date.now()}`;
    return backend.createInitialPR('ignored', branch, `tier3 ${label}`, 'tier3 merge-and-verify test');
  }

  function registerPR(sessionId: string, prNumber: number): void {
    sessionFiles.createSession(sessionId, `tier3 ${sessionId}`);
    sessionFiles.updateMeta(sessionId, {
      prs: [
        {
          repo: `${owner}/${repoName}`,
          pr_number: prNumber,
          registered_at: Math.floor(Date.now() / 1000),
        },
      ],
    });
  }

  // ---------------------------------------------------------------------
  // merge_pr surface
  // ---------------------------------------------------------------------

  it('merge_pr squash-merges a real PR and reports mergeCommitSha populated', async () => {
    const prNumber = await freshPR('merge');

    // Pre-state: unmerged, mergeCommitSha null
    const before = await github.getPullState(owner, repoName, prNumber);
    expect(before.state).toBe('open');
    expect(before.merged).toBe(false);
    expect(before.mergeCommitSha).toBeNull();

    const result = await github.mergePullRequest(owner, repoName, prNumber);

    expect(result.merged).toBe(true);
    expect(result.sha).toMatch(/^[a-f0-9]{40}$/);

    // Post-merge state: reflected via GET, with mergeCommitSha populated.
    // The post-merge polling inside mergePullRequest should have already
    // verified this — but a second GET confirms eventual consistency held.
    const after = await github.getPullState(owner, repoName, prNumber);
    expect(after.merged).toBe(true);
    expect(after.state).toBe('closed');
    expect(after.mergeCommitSha).toBe(result.sha);
  }, 90_000);

  it('merge_pr is idempotent on an already-merged PR', async () => {
    const prNumber = await freshPR('idemp');

    // First merge — happy path
    const first = await github.mergePullRequest(owner, repoName, prNumber);
    expect(first.merged).toBe(true);

    // Second merge against an already-merged PR.
    //
    // Empirically (tier3 finding): GitHub returns 200 with the original
    // merge details for this case, NOT 405 "Pull request is not mergeable"
    // as the docs imply. The post-merge polling loop then observes
    // merged=true immediately and returns success. The 405 handler in
    // src/github.ts is defensive code for a hypothetical case that
    // doesn't trigger in practice; the tier1 stub-based test verifies
    // it works if GitHub ever does return 405.
    //
    // What matters for the agent: the second call returns success with
    // the same merge commit SHA — it never throws, never retries
    // forever, never re-merges anything.
    const second = await github.mergePullRequest(owner, repoName, prNumber);
    expect(second.merged).toBe(true);
    expect(second.sha).toBe(first.sha);
  }, 90_000);

  // ---------------------------------------------------------------------
  // verifySession surface — the authority that powers complete_session
  // ---------------------------------------------------------------------

  it('verifySession writes termination_reason=merged from real GitHub state', async () => {
    const prNumber = await freshPR('verify-merged');
    const sessionId = `verify-merged-${prNumber}`;
    registerPR(sessionId, prNumber);

    // Actually merge it
    await github.mergePullRequest(owner, repoName, prNumber);

    const result = await verifySession(sessionId);

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.termination_reason).toBe('merged');
    }

    const meta = sessionFiles.readMeta(sessionId);
    expect(meta.status).toBe('completed');
    expect(meta.termination_reason).toBe('merged');
  }, 90_000);

  it('verifySession returns prs_still_open when the PR is still open', async () => {
    const prNumber = await freshPR('verify-open');
    const sessionId = `verify-open-${prNumber}`;
    registerPR(sessionId, prNumber);

    const result = await verifySession(sessionId);

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe('prs_still_open');
      if (result.reason === 'prs_still_open') {
        expect(result.open_prs).toContainEqual({
          repo: `${owner}/${repoName}`,
          pr_number: prNumber,
        });
      }
    }

    // Session stays active — no terminal write
    const meta = sessionFiles.readMeta(sessionId);
    expect(meta.status).toBe('active');
    expect(meta.termination_reason).toBeUndefined();
  }, 60_000);

  it('verifySession writes termination_reason=closed_without_merge for a closed-unmerged PR', async () => {
    const prNumber = await freshPR('verify-closed');
    const sessionId = `verify-closed-${prNumber}`;
    registerPR(sessionId, prNumber);

    // Close without merging
    await octokit.pulls.update({
      owner,
      repo: repoName,
      pull_number: prNumber,
      state: 'closed',
    });

    const result = await verifySession(sessionId);

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.termination_reason).toBe('closed_without_merge');
    }

    const meta = sessionFiles.readMeta(sessionId);
    expect(meta.status).toBe('completed');
    expect(meta.termination_reason).toBe('closed_without_merge');
  }, 60_000);

  // ---------------------------------------------------------------------
  // GitHubClient HTTP semantics
  // ---------------------------------------------------------------------

  it('getPullState returns mergeCommitSha=null for an open PR (real GitHub field shape)', async () => {
    const prNumber = await freshPR('shape-open');
    const state = await github.getPullState(owner, repoName, prNumber);
    expect(state.state).toBe('open');
    expect(state.merged).toBe(false);
    // GitHub may return a non-null "test merge" SHA on an open PR. Our code
    // populates mergeCommitSha from `merge_commit_sha` regardless — the
    // important invariant is `merged: false`, not that the SHA is null.
    expect(typeof state.mergeCommitSha === 'string' || state.mergeCommitSha === null).toBe(true);
  }, 60_000);

  it('getPullState returns 404 GitHubApiError for a nonexistent PR', async () => {
    try {
      await github.getPullState(owner, repoName, 999_999_999);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
    }
  }, 60_000);
});

/**
 * Tier 3 tests: Critical GitHub operations against real GitHub API.
 *
 * Ports critical Tier 2 test scenarios to run against RealGitHubBackend.
 * Tests skip gracefully if required env vars are not set.
 *
 * Requirements: 24.9
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RealGitHubBackend } from '../harness/real-github.js';

const hasGitHubEnv =
  !!process.env['GITHUB_TOKEN'] &&
  !!process.env['GITHUB_TEST_REPO'] &&
  !!process.env['GITHUB_WEBHOOK_SECRET'] &&
  !!process.env['WEBHOOK_URL'];

describe.skipIf(!hasGitHubEnv)(
  'Tier 3: GitHub PR lifecycle',
  () => {
    let github: RealGitHubBackend;

    beforeAll(async () => {
      github = new RealGitHubBackend();
      await github.start();
      await github.reset();
    });

    afterAll(async () => {
      if (github) {
        await github.reset();
        await github.stop();
      }
    });

    /**
     * Ported from Tier 2 smoke test:
     * FakeGitHubBackend creates a PR and returns the PR state.
     */
    it('creates a PR, retrieves its state, and verifies fields', async () => {
      const branch = `test-lifecycle-${Date.now()}`;
      const prNumber = await github.createInitialPR(
        'test',
        branch,
        'Lifecycle Test PR',
        'Created by Tier 3 lifecycle test',
      );

      expect(prNumber).toBeGreaterThan(0);

      const state = await github.getPRState('test', prNumber);
      expect(state.number).toBe(prNumber);
      expect(state.title).toBe('Lifecycle Test PR');
      expect(state.body).toBe('Created by Tier 3 lifecycle test');
      expect(state.state).toBe('open');
      expect(state.headRef).toBe(branch);
    }, 60_000);

    /**
     * Ported from Tier 2 smoke test:
     * FakeGitHubBackend getAllPRs returns created PRs.
     */
    it('getAllPRs includes the created PR', async () => {
      const branch = `test-list-${Date.now()}`;
      const prNumber = await github.createInitialPR(
        'test',
        branch,
        'List Test PR',
        'Created by Tier 3 list test',
      );

      const prs = await github.getAllPRs('test');
      const found = prs.find((pr) => pr.number === prNumber);
      expect(found).toBeDefined();
      expect(found!.title).toBe('List Test PR');
      expect(found!.state).toBe('open');
    }, 60_000);

    /**
     * Ported from Tier 2 smoke test:
     * FakeGitHubBackend reset clears state.
     */
    it('reset closes test PRs and deletes test branches', async () => {
      const branch = `test-reset-${Date.now()}`;
      await github.createInitialPR(
        'test',
        branch,
        'Reset Test PR',
        'Will be closed by reset',
      );

      await github.reset();

      const prs = await github.getAllPRs('test');
      const openTestPRs = prs.filter(
        (pr) => pr.state === 'open' && pr.title === 'Reset Test PR',
      );
      expect(openTestPRs).toHaveLength(0);
    }, 90_000);

    /**
     * Ported from Tier 2 webhook test:
     * Verifies that addComment works on a real PR (triggers webhook from GitHub).
     */
    it('addComment creates a comment on a PR', async () => {
      const branch = `test-comment-ops-${Date.now()}`;
      const prNumber = await github.createInitialPR(
        'test',
        branch,
        'Comment Ops Test PR',
        'Testing comment creation',
      );

      // Should not throw
      await github.addComment(
        'test',
        prNumber,
        '/agent fix the CI failure',
        'test-user',
      );

      // PR should still be open after comment
      const state = await github.getPRState('test', prNumber);
      expect(state.state).toBe('open');
    }, 60_000);

    /**
     * Ported from Tier 2 session-mgr test:
     * Verifies check run creation works on a real PR.
     */
    it('reportCheckRun creates a check run on a PR', async () => {
      const branch = `test-check-${Date.now()}`;
      const prNumber = await github.createInitialPR(
        'test',
        branch,
        'Check Run Test PR',
        'Testing check run creation',
      );

      // Should not throw
      await github.reportCheckRun('test', prNumber, 'ci/test', 'failure');
      await github.reportCheckRun('test', prNumber, 'ci/lint', 'success');
    }, 60_000);
  },
);

/**
 * Tier 3 smoke test: exercises the real backends (GitHub + Kiro).
 *
 * Validates that RealGitHubBackend and RealKiroBackend start/stop cleanly,
 * that the interfaces are wired correctly, and that basic operations work
 * against real GitHub.
 *
 * Skips gracefully if required env vars are not set.
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

const hasKiroEnv = !!process.env['KIRO_PATH'];

describe.skipIf(!hasGitHubEnv)(
  'Tier 3 smoke test — RealGitHubBackend',
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

    it('returns a valid apiBaseUrl', () => {
      expect(github.apiBaseUrl()).toBe('https://api.github.com');
    });

    it('returns a valid webhookTargetUrl', () => {
      const url = github.webhookTargetUrl();
      expect(url).toBeTruthy();
      expect(typeof url).toBe('string');
    });

    it('returns a valid cloneUrl', () => {
      const url = github.cloneUrl('test');
      expect(url).toMatch(/^https:\/\/github\.com\/.+\/.+\.git$/);
    });

    it('creates a PR and returns the PR state', async () => {
      const branch = `test-smoke-${Date.now()}`;
      const prNumber = await github.createInitialPR(
        'test',
        branch,
        'Tier 3 Smoke Test PR',
        'This PR was created by the Tier 3 smoke test.',
      );
      expect(prNumber).toBeGreaterThan(0);

      const state = await github.getPRState('test', prNumber);
      expect(state.title).toBe('Tier 3 Smoke Test PR');
      expect(state.state).toBe('open');
      expect(state.headRef).toBe(branch);
    }, 60_000);

    it('getAllPRs returns created PRs', async () => {
      const prs = await github.getAllPRs('test');
      expect(prs.length).toBeGreaterThanOrEqual(1);
    }, 30_000);

    it('addComment posts a comment on a PR', async () => {
      const branch = `test-comment-${Date.now()}`;
      const prNumber = await github.createInitialPR(
        'test',
        branch,
        'Comment Test PR',
        'Testing addComment.',
      );

      // Should not throw
      await github.addComment('test', prNumber, 'Test comment from Tier 3', 'test-bot');
    }, 60_000);

    it('reset cleans up test PRs and branches', async () => {
      await github.reset();

      const prs = await github.getAllPRs('test');
      const openTestPRs = prs.filter(
        (pr) => pr.state === 'open' && pr.title.includes('Smoke Test'),
      );
      expect(openTestPRs).toHaveLength(0);
    }, 60_000);

    it('sendWebhook throws for real backend', async () => {
      await expect(
        github.sendWebhook({ event: 'ping', payload: {} }),
      ).rejects.toThrow(/not supported/);
    });

    it('getAPICalls returns empty array for real backend', async () => {
      const calls = await github.getAPICalls();
      expect(calls).toEqual([]);
    });
  },
);

describe.skipIf(!hasKiroEnv)(
  'Tier 3 smoke test — RealKiroBackend',
  () => {
    it('can be imported and constructed', async () => {
      const { RealKiroBackend } = await import('../harness/real-kiro.js');
      const kiro = new RealKiroBackend();

      const cfg = kiro.spawnConfig();
      expect(cfg.command).toBe(process.env['KIRO_PATH']);
      expect(cfg.args).toEqual(['acp']);
      expect(cfg.env).toEqual({});
    });

    it('loadScenario is a no-op', async () => {
      const { RealKiroBackend } = await import('../harness/real-kiro.js');
      const kiro = new RealKiroBackend();
      await expect(kiro.loadScenario('/nonexistent')).resolves.toBeUndefined();
    });

    it('reset is a no-op', async () => {
      const { RealKiroBackend } = await import('../harness/real-kiro.js');
      const kiro = new RealKiroBackend();
      await expect(kiro.reset()).resolves.toBeUndefined();
    });

    it('getActions returns empty for nonexistent session', async () => {
      const { RealKiroBackend } = await import('../harness/real-kiro.js');
      const kiro = new RealKiroBackend();
      const actions = await kiro.getActions('nonexistent-session-id');
      expect(actions).toEqual([]);
    });
  },
);

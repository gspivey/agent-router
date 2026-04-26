/**
 * RealGitHubBackend — wraps the GitHub REST API via Octokit for Tier 3 tests.
 *
 * Uses a dedicated scratch repository for all test operations.
 * reset() closes open PRs and deletes test branches for cleanup.
 *
 * Requirements: 22.1, 24.7
 */
import { Octokit } from '@octokit/rest';
import type {
  GitHubBackend,
  WebhookEvent,
  APICall,
  PRState,
  PRSummary,
} from './interfaces.js';

/** Branches created by tests start with this prefix. */
const TEST_BRANCH_PREFIX = 'test-';

/** Maximum time (ms) to wait for a webhook delivery to appear. */
const WEBHOOK_POLL_TIMEOUT_MS = 30_000;

/** Interval (ms) between webhook delivery poll attempts. */
const WEBHOOK_POLL_INTERVAL_MS = 2_000;

export class RealGitHubBackend implements GitHubBackend {
  private octokit: Octokit | null = null;
  private owner = '';
  private repo = '';
  private token = '';
  private webhookSecret = '';
  private webhookUrl = '';

  async start(): Promise<void> {
    this.token = requireEnv('GITHUB_TOKEN');
    this.webhookSecret = requireEnv('GITHUB_WEBHOOK_SECRET');
    this.webhookUrl = requireEnv('WEBHOOK_URL');

    const testRepo = requireEnv('GITHUB_TEST_REPO');
    const parts = testRepo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `GITHUB_TEST_REPO must be in "owner/repo" format, got: "${testRepo}"`,
      );
    }
    this.owner = parts[0];
    this.repo = parts[1];

    this.octokit = new Octokit({ auth: this.token });

    // Verify repo access — will throw on 404 or 403
    try {
      await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
    } catch (err: unknown) {
      throwOnRateLimit(err);
      throw new Error(
        `Cannot access repository ${testRepo}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async stop(): Promise<void> {
    // No-op — Octokit has no persistent connections to close.
  }

  async reset(): Promise<void> {
    const ok = this.requireOctokit();

    // 1. Close all open PRs created by tests
    const openPRs = await ok.paginate(ok.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      per_page: 100,
    });

    for (const pr of openPRs) {
      if (pr.head.ref.startsWith(TEST_BRANCH_PREFIX)) {
        try {
          await ok.pulls.update({
            owner: this.owner,
            repo: this.repo,
            pull_number: pr.number,
            state: 'closed',
          });
        } catch (err: unknown) {
          throwOnRateLimit(err);
          // Best-effort cleanup — log but don't fail
        }
      }
    }

    // 2. Delete all test branches
    try {
      const refs = await ok.paginate(ok.git.listMatchingRefs, {
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${TEST_BRANCH_PREFIX}`,
      });

      for (const ref of refs) {
        try {
          await ok.git.deleteRef({
            owner: this.owner,
            repo: this.repo,
            ref: ref.ref.replace('refs/', ''),
          });
        } catch (err: unknown) {
          throwOnRateLimit(err);
          // Best-effort cleanup
        }
      }
    } catch (err: unknown) {
      throwOnRateLimit(err);
    }
  }

  apiBaseUrl(): string {
    return 'https://api.github.com';
  }

  webhookTargetUrl(): string {
    return this.webhookUrl;
  }

  cloneUrl(_repo: string): string {
    return `https://github.com/${this.owner}/${this.repo}.git`;
  }

  /**
   * For real GitHub, webhooks are triggered by API calls (createInitialPR,
   * addComment, etc.), not sent directly. This method is not supported.
   */
  async sendWebhook(_event: WebhookEvent): Promise<void> {
    throw new Error(
      'sendWebhook is not supported for RealGitHubBackend — ' +
      'webhooks are triggered by GitHub in response to API calls',
    );
  }

  async createInitialPR(
    _repo: string,
    branch: string,
    title: string,
    body: string,
  ): Promise<number> {
    const ok = this.requireOctokit();

    // Get the default branch SHA
    const { data: repoData } = await this.wrapRateLimit(() =>
      ok.repos.get({ owner: this.owner, repo: this.repo }),
    );
    const defaultBranch = repoData.default_branch;

    const { data: refData } = await this.wrapRateLimit(() =>
      ok.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${defaultBranch}`,
      }),
    );
    const baseSha = refData.object.sha;

    // Create the branch
    await this.wrapRateLimit(() =>
      ok.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      }),
    );

    // Create a commit on the branch (empty tree change via a test file)
    const testContent = `Test file created at ${new Date().toISOString()}\n`;
    await this.wrapRateLimit(() =>
      ok.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: `test-artifacts/${branch}.txt`,
        message: `test: create branch ${branch}`,
        content: Buffer.from(testContent).toString('base64'),
        branch,
      }),
    );

    // Open the PR
    const { data: pr } = await this.wrapRateLimit(() =>
      ok.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        head: branch,
        base: defaultBranch,
      }),
    );

    return pr.number;
  }

  async addComment(
    _repo: string,
    prNumber: number,
    body: string,
    _actor: string,
    _options?: { actorType?: string; authorAssociation?: string },
  ): Promise<void> {
    const ok = this.requireOctokit();
    await this.wrapRateLimit(() =>
      ok.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: prNumber,
        body,
      }),
    );
  }

  async reportCheckRun(
    _repo: string,
    prNumber: number,
    name: string,
    conclusion: 'success' | 'failure',
  ): Promise<void> {
    const ok = this.requireOctokit();

    // Get the head SHA of the PR
    const { data: pr } = await this.wrapRateLimit(() =>
      ok.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      }),
    );

    await this.wrapRateLimit(() =>
      ok.checks.create({
        owner: this.owner,
        repo: this.repo,
        name,
        head_sha: pr.head.sha,
        status: 'completed',
        conclusion,
        output: {
          title: `${name} — ${conclusion}`,
          summary: `Check run ${conclusion} for test purposes`,
        },
      }),
    );
  }

  /**
   * API call recording is not applicable for the real backend.
   * Returns an empty array.
   */
  async getAPICalls(): Promise<APICall[]> {
    return [];
  }

  async getPRState(_repo: string, prNumber: number): Promise<PRState> {
    const ok = this.requireOctokit();
    const { data: pr } = await this.wrapRateLimit(() =>
      ok.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      }),
    );

    let state: 'open' | 'closed' | 'merged';
    if (pr.merged) {
      state = 'merged';
    } else if (pr.state === 'closed') {
      state = 'closed';
    } else {
      state = 'open';
    }

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      state,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    };
  }

  async getAllPRs(_repo: string): Promise<PRSummary[]> {
    const ok = this.requireOctokit();
    const prs = await ok.paginate(ok.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: 'all',
      per_page: 100,
    });

    return prs.map((pr) => {
      let state: 'open' | 'closed' | 'merged';
      if (pr.merged_at !== null && pr.merged_at !== undefined) {
        state = 'merged';
      } else if (pr.state === 'closed') {
        state = 'closed';
      } else {
        state = 'open';
      }
      return { number: pr.number, title: pr.title, state };
    });
  }

  /**
   * Poll GitHub's webhook delivery endpoint until a delivery matching the
   * expected event appears, or the 30-second timeout expires.
   */
  async waitForWebhookDelivery(eventType: string): Promise<void> {
    const ok = this.requireOctokit();
    const deadline = Date.now() + WEBHOOK_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        // List recent webhook deliveries for the repo
        const { data: hooks } = await ok.repos.listWebhooks({
          owner: this.owner,
          repo: this.repo,
        });

        for (const hook of hooks) {
          const { data: deliveries } = await ok.repos.listWebhookDeliveries({
            owner: this.owner,
            repo: this.repo,
            hook_id: hook.id,
            per_page: 10,
          });

          const match = deliveries.find(
            (d) => d.event === eventType && d.status === 'OK',
          );
          if (match) return;
        }
      } catch (err: unknown) {
        throwOnRateLimit(err);
        // Transient errors during polling are acceptable — retry
      }

      await sleep(WEBHOOK_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Webhook delivery for event "${eventType}" not found within ${WEBHOOK_POLL_TIMEOUT_MS / 1000}s`,
    );
  }

  // ── Private helpers ──────────────────────────────────────────────

  private requireOctokit(): Octokit {
    if (!this.octokit) {
      throw new Error('RealGitHubBackend.start() must be called before use');
    }
    return this.octokit;
  }

  private async wrapRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      throwOnRateLimit(err);
      throw err;
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Required environment variable ${name} is not set. ` +
      'Tier 3 tests require real GitHub credentials.',
    );
  }
  return value;
}

function throwOnRateLimit(err: unknown): void {
  if (
    err !== null &&
    err !== undefined &&
    typeof err === 'object' &&
    'status' in err &&
    (err as { status: number }).status === 403
  ) {
    const message =
      err instanceof Error ? err.message : 'GitHub API rate limit exceeded';
    throw new Error(
      `GitHub API rate limit hit (403). ` +
      `Wait for the rate limit to reset before running Tier 3 tests. ` +
      `Details: ${message}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

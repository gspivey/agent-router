/**
 * Minimal GitHub REST API client.
 *
 * Two operations only — enough to support merge_pr and the open-PR check in
 * complete_session. Built as a thin fetch wrapper rather than pulling in
 * @octokit/rest so the production dependency surface stays small (per
 * CLAUDE.md guidance).
 *
 * Token resolution: each call reads GITHUB_TOKEN from process.env at call
 * time. If unset, the call throws — callers (cli-server handlers) surface
 * that as a structured error back to the agent.
 *
 * The baseUrl is configurable so the Tier 2 harness can point this at a
 * FakeGitHubBackend; production uses https://api.github.com.
 */

export interface PullState {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  /** GitHub's merge_commit_sha. Null when not yet computed or PR was closed unmerged. */
  mergeCommitSha: string | null;
}

export interface MergeResult {
  sha: string;
  merged: true;
  message: string;
}

export interface GitHubClient {
  getPullState(owner: string, repo: string, prNumber: number): Promise<PullState>;
  mergePullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    options?: { commitTitle?: string; commitMessage?: string },
  ): Promise<MergeResult>;
}

export interface GitHubClientOptions {
  /** Base URL for the GitHub API. Defaults to https://api.github.com. */
  baseUrl?: string;
  /** Override fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 5000 (5s). */
  requestTimeoutMs?: number;
  /** Number of post-merge state polls. Default 10. */
  pollAttempts?: number;
  /** Delay between polls in milliseconds. Default 300. */
  pollIntervalMs?: number;
}

export class GitHubApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.body = body;
  }
}

function readToken(): string {
  const token = process.env['GITHUB_TOKEN'];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('GITHUB_TOKEN environment variable is not set');
  }
  return token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGitHubClient(opts: GitHubClientOptions = {}): GitHubClient {
  const baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
  const pollAttempts = opts.pollAttempts ?? 10;
  const pollIntervalMs = opts.pollIntervalMs ?? 300;

  async function request(
    method: 'GET' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const token = readToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), requestTimeoutMs);

    const init: RequestInit = { method, headers, signal: ac.signal };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError') {
        throw new GitHubApiError(`GitHub API ${method} ${path} timeout after ${requestTimeoutMs}ms`, 0, '');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new GitHubApiError(
        `GitHub API ${method} ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        text,
      );
    }
    if (text.length === 0) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub API ${method} ${path} returned non-JSON body: ${text.slice(0, 200)}`);
    }
  }

  const client: GitHubClient = {
    async getPullState(owner, repo, prNumber): Promise<PullState> {
      const data = (await request('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`)) as Record<string, unknown>;
      const stateRaw = data['state'];
      const mergedRaw = data['merged'];
      const numberRaw = data['number'];
      const shaRaw = data['merge_commit_sha'];
      // GitHub returns state='closed' for both merged and closed-unmerged PRs;
      // 'merged' is the boolean discriminator.
      const state: 'open' | 'closed' = stateRaw === 'open' ? 'open' : 'closed';
      const merged: boolean = mergedRaw === true;
      const number: number = typeof numberRaw === 'number' ? numberRaw : prNumber;
      const mergeCommitSha: string | null = typeof shaRaw === 'string' && shaRaw.length > 0 ? shaRaw : null;
      return { number, state, merged, mergeCommitSha };
    },

    async mergePullRequest(owner, repo, prNumber, options): Promise<MergeResult> {
      const body: Record<string, unknown> = { merge_method: 'squash' };
      if (options?.commitTitle !== undefined) body['commit_title'] = options.commitTitle;
      if (options?.commitMessage !== undefined) body['commit_message'] = options.commitMessage;

      let data: Record<string, unknown>;
      try {
        data = (await request('PUT', `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, body)) as Record<
          string,
          unknown
        >;
      } catch (err) {
        // Idempotency: 405 may mean "already merged." Disambiguate via GET.
        if (err instanceof GitHubApiError && err.status === 405) {
          const state = await client.getPullState(owner, repo, prNumber);
          if (state.merged) {
            return {
              sha: state.mergeCommitSha ?? '',
              merged: true,
              message: 'already merged',
            };
          }
        }
        throw err;
      }

      const sha = typeof data['sha'] === 'string' ? data['sha'] : '';
      const merged = data['merged'] === true;
      const message = typeof data['message'] === 'string' ? data['message'] : '';
      if (!merged) {
        throw new Error(`GitHub reported merge=false for ${owner}/${repo}#${prNumber}: ${message}`);
      }

      // Post-merge polling: GitHub's merge response can race with the PR-state
      // surface. Confirm via GET before returning so complete_session doesn't
      // race against a not-yet-updated PR object.
      for (let i = 0; i < pollAttempts; i++) {
        const state = await client.getPullState(owner, repo, prNumber);
        if (state.merged) {
          return { sha: state.mergeCommitSha ?? sha, merged: true, message };
        }
        if (i < pollAttempts - 1) {
          await sleep(pollIntervalMs);
        }
      }
      // Best-effort: GitHub said 200 with merged=true, but the state hasn't
      // caught up within the polling budget. Return the original response —
      // session-level verification will retry later if needed.
      return { sha, merged: true, message };
    },
  };
  return client;
}

/**
 * Tier 1 tests: GitHub API client.
 *
 * Pure unit tests against a stub fetch — no network, no real GitHub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createGitHubClient, GitHubApiError } from '../../src/github.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeStubFetch(handler: (call: FetchCall) => { status: number; body: string }): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ORIG_TOKEN = process.env['GITHUB_TOKEN'];

beforeEach(() => {
  process.env['GITHUB_TOKEN'] = 'test-token-abc';
});

afterEach(() => {
  if (ORIG_TOKEN === undefined) {
    delete process.env['GITHUB_TOKEN'];
  } else {
    process.env['GITHUB_TOKEN'] = ORIG_TOKEN;
  }
});

describe('createGitHubClient', () => {
  describe('token resolution', () => {
    it('throws when GITHUB_TOKEN is not set', async () => {
      delete process.env['GITHUB_TOKEN'];
      const { fetchImpl } = makeStubFetch(() => ({ status: 200, body: '{}' }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      await expect(client.getPullState('o', 'r', 1)).rejects.toThrow(/GITHUB_TOKEN/);
    });

    it('throws when GITHUB_TOKEN is empty', async () => {
      process.env['GITHUB_TOKEN'] = '';
      const { fetchImpl } = makeStubFetch(() => ({ status: 200, body: '{}' }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      await expect(client.getPullState('o', 'r', 1)).rejects.toThrow(/GITHUB_TOKEN/);
    });

    it('sends Bearer auth header from process.env on each call', async () => {
      const { fetchImpl, calls } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ number: 1, state: 'open', merged: false }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      await client.getPullState('o', 'r', 1);
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-token-abc');
      expect(headers['Accept']).toBe('application/vnd.github+json');
    });

    it('reads token freshly on each call (no caching)', async () => {
      const { fetchImpl, calls } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ number: 1, state: 'open', merged: false }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      await client.getPullState('o', 'r', 1);
      process.env['GITHUB_TOKEN'] = 'rotated-token';
      await client.getPullState('o', 'r', 1);
      expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token-abc');
      expect((calls[1]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer rotated-token');
    });
  });

  describe('getPullState', () => {
    it('reports state=open, merged=false for an open PR', async () => {
      const { fetchImpl, calls } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ number: 42, state: 'open', merged: false }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      const result = await client.getPullState('octocat', 'hello', 42);
      expect(result).toEqual({ number: 42, state: 'open', merged: false });
      expect(calls[0]!.url).toBe('http://stub/repos/octocat/hello/pulls/42');
      expect(calls[0]!.init.method).toBe('GET');
    });

    it('reports state=closed, merged=true for a merged PR', async () => {
      const { fetchImpl } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ number: 7, state: 'closed', merged: true }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      const result = await client.getPullState('o', 'r', 7);
      expect(result).toEqual({ number: 7, state: 'closed', merged: true });
    });

    it('reports state=closed, merged=false for a closed-unmerged PR', async () => {
      const { fetchImpl } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ number: 7, state: 'closed', merged: false }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      const result = await client.getPullState('o', 'r', 7);
      expect(result).toEqual({ number: 7, state: 'closed', merged: false });
    });

    it('throws GitHubApiError on 404', async () => {
      const { fetchImpl } = makeStubFetch(() => ({ status: 404, body: '{"message":"Not Found"}' }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      await expect(client.getPullState('o', 'r', 999)).rejects.toBeInstanceOf(GitHubApiError);
    });

    it('attaches status on GitHubApiError', async () => {
      const { fetchImpl } = makeStubFetch(() => ({ status: 403, body: '{}' }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      try {
        await client.getPullState('o', 'r', 1);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).status).toBe(403);
      }
    });
  });

  describe('mergePullRequest', () => {
    it('PUTs to /repos/owner/name/pulls/N/merge with squash method', async () => {
      const { fetchImpl, calls } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ sha: 'abc123', merged: true, message: 'Pull Request successfully merged' }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      const result = await client.mergePullRequest('octocat', 'hello', 42);
      expect(result).toEqual({ sha: 'abc123', merged: true, message: 'Pull Request successfully merged' });
      expect(calls[0]!.url).toBe('http://stub/repos/octocat/hello/pulls/42/merge');
      expect(calls[0]!.init.method).toBe('PUT');
      const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
      expect(body['merge_method']).toBe('squash');
    });

    it('throws when GitHub returns merged=false', async () => {
      const { fetchImpl } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ sha: '', merged: false, message: 'Pull request not in mergeable state' }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      await expect(client.mergePullRequest('o', 'r', 1)).rejects.toThrow(/merge=false/);
    });

    it('throws GitHubApiError on 409 conflict', async () => {
      const { fetchImpl } = makeStubFetch(() => ({
        status: 409,
        body: '{"message":"Merge conflict"}',
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      await expect(client.mergePullRequest('o', 'r', 1)).rejects.toBeInstanceOf(GitHubApiError);
    });

    it('throws GitHubApiError on 405 branch-protection block', async () => {
      const { fetchImpl } = makeStubFetch(() => ({
        status: 405,
        body: '{"message":"Required status check has not passed"}',
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      try {
        await client.mergePullRequest('o', 'r', 1);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).status).toBe(405);
      }
    });

    it('passes optional commitTitle and commitMessage through', async () => {
      const { fetchImpl, calls } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ sha: 's', merged: true, message: 'ok' }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub', fetchImpl });
      await client.mergePullRequest('o', 'r', 1, { commitTitle: 'Custom title', commitMessage: 'Custom body' });
      const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
      expect(body['commit_title']).toBe('Custom title');
      expect(body['commit_message']).toBe('Custom body');
    });
  });

  describe('baseUrl handling', () => {
    it('strips trailing slash from baseUrl', async () => {
      const { fetchImpl, calls } = makeStubFetch(() => ({
        status: 200,
        body: JSON.stringify({ number: 1, state: 'open', merged: false }),
      }));
      const client = createGitHubClient({ baseUrl: 'http://stub/', fetchImpl });
      await client.getPullState('o', 'r', 1);
      expect(calls[0]!.url).toBe('http://stub/repos/o/r/pulls/1');
    });

    it('defaults to https://api.github.com when baseUrl omitted', async () => {
      const urls: string[] = [];
      const stub = (async (input: unknown) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
        urls.push(u);
        return new Response(JSON.stringify({ number: 1, state: 'open', merged: false }), { status: 200 });
      }) as unknown as typeof fetch;
      const client = createGitHubClient({ fetchImpl: stub });
      await client.getPullState('o', 'r', 1);
      expect(urls[0]).toBe('https://api.github.com/repos/o/r/pulls/1');
    });
  });
});

/**
 * Tier 2 tests for the credential testing harness extensions.
 *
 * Covers:
 * - FakeGitHubBackend: Authorization header validation (requireAuthToken)
 * - FakeGitHubBackend: Canned response registration
 * - FakeGitHubBackend: getLastAuthorizationHeader / getAllAuthorizationHeaders
 * - MockDaemonSocket: get_session_project IPC op
 * - MockDaemonSocket: get_token IPC op
 * - MockDaemonSocket: error responses for unknown sessions/projects
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import { FakeGitHubBackend } from '../../test/harness/fake-github.js';
import { createMockDaemonSocket } from '../../test/harness/mock-daemon-socket.js';

describe('FakeGitHubBackend credential extensions', () => {
  let github: FakeGitHubBackend;

  beforeAll(async () => {
    github = new FakeGitHubBackend('test-secret');
    await github.start();
  });

  afterAll(async () => {
    await github.stop();
  });

  describe('requireAuthToken', () => {
    afterAll(async () => {
      await github.reset();
    });

    it('returns 401 when token is required but not provided', async () => {
      github.requireAuthToken('ghp_valid_token');
      const resp = await fetch(`${github.apiBaseUrl()}/repos/org/repo`, {
        method: 'GET',
      });
      expect(resp.status).toBe(401);
      const body = await resp.json();
      expect(body).toEqual({ message: 'Bad credentials' });
    });

    it('returns 401 when token does not match', async () => {
      github.requireAuthToken('ghp_valid_token');
      const resp = await fetch(`${github.apiBaseUrl()}/repos/org/repo`, {
        method: 'GET',
        headers: { Authorization: 'Bearer ghp_wrong_token' },
      });
      expect(resp.status).toBe(401);
    });

    it('succeeds when token matches', async () => {
      github.requireAuthToken('ghp_valid_token');
      // createInitialPR first so we have a repo/PR to query
      const resp = await fetch(`${github.apiBaseUrl()}/repos/org/repo`, {
        method: 'GET',
        headers: { Authorization: 'Bearer ghp_valid_token' },
      });
      // 200 or 404 (no PR) — but NOT 401
      expect(resp.status).not.toBe(401);
    });

    it('succeeds with no auth validation when token is null', async () => {
      github.requireAuthToken(null);
      const resp = await fetch(`${github.apiBaseUrl()}/repos/org/repo`, {
        method: 'GET',
        // No Authorization header
      });
      expect(resp.status).not.toBe(401);
    });
  });

  describe('setCannedResponse', () => {
    afterAll(async () => {
      await github.reset();
    });

    it('returns canned response for matching method + path', async () => {
      github.setCannedResponse('GET', '/repos/org/repo/issues', {
        status: 200,
        body: [{ id: 1, title: 'Canned issue' }],
      });

      const resp = await fetch(`${github.apiBaseUrl()}/repos/org/repo/issues`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual([{ id: 1, title: 'Canned issue' }]);
    });

    it('returns canned response with custom headers', async () => {
      github.setCannedResponse('POST', '/repos/org/repo/issues', {
        status: 201,
        headers: { 'X-Custom': 'header-value' },
        body: { id: 2, title: 'Created issue' },
      });

      const resp = await fetch(`${github.apiBaseUrl()}/repos/org/repo/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'new issue' }),
      });
      expect(resp.status).toBe(201);
      expect(resp.headers.get('X-Custom')).toBe('header-value');
    });

    it('falls through to default routing when no canned response matches', async () => {
      github.clearCannedResponses();
      const resp = await fetch(`${github.apiBaseUrl()}/repos/org/repo`);
      // Default routing handles /repos/owner/name and should not 401 (no auth required)
      expect(resp.status).not.toBe(401);
    });
  });

  describe('getLastAuthorizationHeader', () => {
    afterAll(async () => {
      await github.reset();
    });

    it('returns undefined when no auth headers have been sent', async () => {
      await github.reset();
      await fetch(`${github.apiBaseUrl()}/repos/org/repo`);
      expect(github.getLastAuthorizationHeader()).toBeUndefined();
    });

    it('returns the most recent Authorization header', async () => {
      await github.reset();
      await fetch(`${github.apiBaseUrl()}/repos/org/repo`, {
        headers: { Authorization: 'Bearer first_token' },
      });
      await fetch(`${github.apiBaseUrl()}/repos/org/repo`, {
        headers: { Authorization: 'Bearer second_token' },
      });
      expect(github.getLastAuthorizationHeader()).toBe('Bearer second_token');
    });
  });

  describe('getAllAuthorizationHeaders', () => {
    afterAll(async () => {
      await github.reset();
    });

    it('returns all auth headers in order', async () => {
      await github.reset();
      await fetch(`${github.apiBaseUrl()}/repos/org/repo`, {
        headers: { Authorization: 'Bearer t1' },
      });
      await fetch(`${github.apiBaseUrl()}/repos/org/repo`); // no auth
      await fetch(`${github.apiBaseUrl()}/repos/org/repo`, {
        headers: { Authorization: 'Bearer t2' },
      });
      expect(github.getAllAuthorizationHeaders()).toEqual(['Bearer t1', 'Bearer t2']);
    });
  });
});

describe('MockDaemonSocket', () => {
  const mock = createMockDaemonSocket();

  beforeAll(async () => {
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  /** Send a JSON request over the Unix socket and return the response. */
  async function sendIpc(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(mock.socketPath());
      let buf = '';
      conn.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            resolve(JSON.parse(line));
          } catch (e) {
            reject(e);
          }
          conn.end();
          return;
        }
      });
      conn.on('error', reject);
      conn.write(JSON.stringify(request) + '\n');
    });
  }

  describe('get_session_project', () => {
    it('returns project info for a configured session', async () => {
      mock.setSessionProject('session-123', {
        project: 'my-project',
        repos: ['org/repo-a', 'org/repo-b'],
        read_repos: ['org/repo-c'],
      });

      const resp = await sendIpc({ op: 'get_session_project', session_id: 'session-123' });
      expect(resp).toEqual({
        project: 'my-project',
        repos: ['org/repo-a', 'org/repo-b'],
        read_repos: ['org/repo-c'],
      });
    });

    it('returns error for unknown session', async () => {
      const resp = await sendIpc({ op: 'get_session_project', session_id: 'unknown-session' });
      expect(resp).toEqual({ error: 'session_not_found' });
    });

    it('returns error for session with null project', async () => {
      mock.setSessionProject('session-null', null);
      const resp = await sendIpc({ op: 'get_session_project', session_id: 'session-null' });
      expect(resp).toEqual({ error: 'no_project_bound' });
    });

    it('returns error when session_id is missing', async () => {
      const resp = await sendIpc({ op: 'get_session_project' });
      expect(resp).toEqual({ error: 'missing_session_id' });
    });
  });

  describe('get_token', () => {
    it('returns token for a configured project', async () => {
      mock.setProjectToken('my-project', 'ghp_secret_123', '2027-04-25T00:00:00Z');
      const resp = await sendIpc({ op: 'get_token', project: 'my-project' });
      expect(resp).toEqual({ token: 'ghp_secret_123', expires_at: '2027-04-25T00:00:00Z' });
    });

    it('returns token without expires_at when not set', async () => {
      mock.setProjectToken('no-expiry', 'ghp_noexp');
      const resp = await sendIpc({ op: 'get_token', project: 'no-expiry' });
      expect(resp).toEqual({ token: 'ghp_noexp' });
    });

    it('returns error for unknown project', async () => {
      const resp = await sendIpc({ op: 'get_token', project: 'nonexistent' });
      expect(resp).toEqual({ error: 'project_not_found' });
    });

    it('returns error when project is missing', async () => {
      const resp = await sendIpc({ op: 'get_token' });
      expect(resp).toEqual({ error: 'missing_project' });
    });

    it('returns error after project token is cleared', async () => {
      mock.setProjectToken('temp-project', 'ghp_temp');
      mock.clearProjectToken('temp-project');
      const resp = await sendIpc({ op: 'get_token', project: 'temp-project' });
      expect(resp).toEqual({ error: 'project_not_found' });
    });
  });

  describe('unknown ops', () => {
    it('returns error for unknown op', async () => {
      const resp = await sendIpc({ op: 'nonexistent_op' });
      expect(resp).toEqual({ error: 'unknown_op' });
    });
  });

  describe('getRequests', () => {
    it('records all IPC requests', async () => {
      mock.clearRequests();
      await sendIpc({ op: 'get_token', project: 'my-project' });
      await sendIpc({ op: 'get_session_project', session_id: 'session-123' });

      const requests = mock.getRequests();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual({ op: 'get_token', project: 'my-project' });
      expect(requests[1]).toEqual({ op: 'get_session_project', session_id: 'session-123' });
    });
  });
});

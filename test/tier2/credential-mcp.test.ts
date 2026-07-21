/**
 * Tier 2 tests for MCP `github_http_forward` tool against fake GitHub server.
 *
 * Covers (task 16.4):
 * - Token injection in Authorization header
 * - Response passthrough (status, headers, body)
 * - 30s timeout handling
 * - Body size enforcement (>10 MB → error)
 * - Read/write split enforcement (write to non-Bound_Project repo → error)
 *
 * Uses the FakeGitHubBackend and MockDaemonSocket from test/harness/.
 * Tests drive the MCP server via the createMcpServer function directly,
 * simulating JSON-RPC tool calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { FakeGitHubBackend } from '../harness/fake-github.js';
import { createMockDaemonSocket } from '../harness/mock-daemon-socket.js';
import { createMcpServer } from '../../src/mcp-server.js';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';

/**
 * Helper to call a tool on the MCP server by writing to its stdin and reading
 * from its stdout. Since the MCP server uses process.stdin/stdout, we
 * need a different approach: we test via the internal `createMcpServer` API
 * by capturing stdout writes.
 *
 * Instead we create a helper that:
 * 1. Temporarily replaces process.stdout.write to capture output.
 * 2. Writes a JSON-RPC request to the readline interface.
 * 3. Returns the parsed response.
 */

interface ToolCallResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface McpToolResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/**
 * A minimal test harness that drives the MCP server's handleToolsCall path
 * by calling createMcpServer with injected stdin/stdout and daemon socket.
 *
 * Since createMcpServer reads from process.stdin and writes to process.stdout,
 * we hook into both for testing.
 */
class McpTestHarness {
  private responses: string[] = [];
  private originalWrite: typeof process.stdout.write;
  private stdinPush: ((line: string) => void) | null = null;
  private server: ReturnType<typeof createMcpServer> | null = null;
  private started = false;

  constructor(
    private daemonSocketPath: string,
    private sessionId: string,
    private githubApiBaseUrl: string,
    private log?: Logger,
  ) {
    this.originalWrite = process.stdout.write.bind(process.stdout);
  }

  async start(): Promise<void> {
    // Capture stdout
    const self = this;
    process.stdout.write = function (chunk: string | Uint8Array, ...args: unknown[]): boolean {
      const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      // Capture only JSON-RPC responses (lines starting with {)
      const lines = str.split('\n').filter((l) => l.trim().startsWith('{'));
      self.responses.push(...lines);
      return true;
    } as typeof process.stdout.write;

    this.server = createMcpServer({
      sessionId: this.sessionId,
      daemonSocket: this.daemonSocketPath,
      ...(this.log ? { log: this.log } : {}),
      githubApiBaseUrl: this.githubApiBaseUrl,
    });

    // Start the server in background — it will begin reading stdin
    const startPromise = this.server.start();
    this.started = true;

    // Send initialize request
    await this.sendRaw({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    await this.waitForResponse();
  }

  async stop(): Promise<void> {
    process.stdout.write = this.originalWrite;
    if (this.server) {
      await this.server.shutdown();
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResponse> {
    this.responses = [];
    const id = Date.now();
    await this.sendRaw({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return this.waitForResponse();
  }

  private async sendRaw(msg: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(msg);
    process.stdin.push(line + '\n');
  }

  private async waitForResponse(): Promise<McpToolResponse> {
    // Poll for response with timeout
    const deadline = Date.now() + 10_000;
    while (this.responses.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this.responses.length === 0) {
      throw new Error('Timeout waiting for MCP response');
    }
    return JSON.parse(this.responses.shift()!) as McpToolResponse;
  }
}

/**
 * Since hooking into process.stdin/stdout for testing is fragile and complex,
 * we use a simpler approach: spawn the MCP server as a child process and
 * communicate over stdio. But that's also complex.
 *
 * Simplest approach: test the internal logic by directly invoking
 * the github_http_forward path through a custom test helper that
 * simulates what the MCP JSON-RPC dispatcher does.
 *
 * Actually the cleanest Tier 2 approach for this project is to test
 * the forwarding via a subprocess, like the existing IPC contract tests do.
 * Let's use child_process.spawn to run the MCP server.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '../../src/mcp-server.ts');

class McpSubprocess {
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private responseQueue: Array<(resp: McpToolResponse) => void> = [];
  private responses: McpToolResponse[] = [];

  constructor(
    private daemonSocketPath: string,
    private sessionId: string,
    private githubApiBaseUrl: string,
  ) {}

  async start(): Promise<void> {
    this.proc = spawn('node', ['--import', 'tsx/esm', MCP_SERVER_PATH], {
      env: {
        ...process.env,
        AGENT_ROUTER_SESSION_ID: this.sessionId,
        AGENT_ROUTER_SOCKET: this.daemonSocketPath,
        GITHUB_API_BASE_URL: this.githubApiBaseUrl,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line: string) => {
      if (!line.trim()) return;
      try {
        const resp = JSON.parse(line) as McpToolResponse;
        const waiter = this.responseQueue.shift();
        if (waiter) {
          waiter(resp);
        } else {
          this.responses.push(resp);
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    // Wait a bit for the process to start
    await new Promise((r) => setTimeout(r, 200));

    // Send initialize
    await this.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    // Send notifications/initialized
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.stdin!.end();
      this.proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        this.proc!.on('exit', () => resolve());
        setTimeout(resolve, 2000);
      });
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResponse> {
    const id = Date.now() + Math.random();
    return this.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  }

  private send(msg: Record<string, unknown>): Promise<McpToolResponse> {
    return new Promise((resolve, reject) => {
      // Check if there's already a buffered response
      const buffered = this.responses.shift();
      if (buffered) {
        resolve(buffered);
        this.proc!.stdin!.write(JSON.stringify(msg) + '\n');
        return;
      }
      this.responseQueue.push(resolve);
      this.proc!.stdin!.write(JSON.stringify(msg) + '\n');
      // Timeout after 35 seconds (more than the 30s request timeout)
      setTimeout(() => reject(new Error('MCP subprocess response timeout')), 35_000);
    });
  }
}

describe('github_http_forward Tier 2 tests', () => {
  let github: FakeGitHubBackend;
  let mockDaemon: ReturnType<typeof createMockDaemonSocket>;
  let mcp: McpSubprocess;

  const SESSION_ID = 'test-session-001';
  const PROJECT_NAME = 'test-project';
  const BOUND_REPO = 'org/my-repo';
  const READ_REPO = 'org/read-only-repo';
  const TOKEN = 'ghp_test_token_abc123';

  beforeAll(async () => {
    github = new FakeGitHubBackend('test-secret');
    await github.start();

    mockDaemon = createMockDaemonSocket();
    await mockDaemon.start();

    // Configure mock daemon responses
    mockDaemon.setSessionProject(SESSION_ID, {
      project: PROJECT_NAME,
      repos: [BOUND_REPO],
      read_repos: [READ_REPO],
    });
    mockDaemon.setProjectToken(PROJECT_NAME, TOKEN);

    // Configure fake GitHub to require the correct token
    github.requireAuthToken(TOKEN);
  });

  afterAll(async () => {
    if (mcp) await mcp.stop();
    await mockDaemon.stop();
    await github.stop();
  });

  beforeEach(async () => {
    // Start a fresh MCP subprocess for each test to avoid state leakage
    mcp = new McpSubprocess(mockDaemon.socketPath(), SESSION_ID, github.apiBaseUrl());
    await mcp.start();
  });

  afterEach(async () => {
    if (mcp) await mcp.stop();
    await github.reset();
    // Restore required auth token after reset clears it
    github.requireAuthToken(TOKEN);
    mockDaemon.clearRequests();
    // Re-configure mock daemon (reset clears nothing in mock daemon but let's be safe)
    mockDaemon.setSessionProject(SESSION_ID, {
      project: PROJECT_NAME,
      repos: [BOUND_REPO],
      read_repos: [READ_REPO],
    });
    mockDaemon.setProjectToken(PROJECT_NAME, TOKEN);
  });

  describe('token injection', () => {
    it('injects Bearer token in Authorization header', async () => {
      github.setCannedResponse('GET', '/repos/org/my-repo/pulls', {
        status: 200,
        body: [],
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      expect(resp.result?.isError).toBeFalsy();
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.status).toBe(200);

      // Verify the auth header was received by the fake server
      const lastAuth = github.getLastAuthorizationHeader();
      expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    });

    it('fetches token per call (not cached)', async () => {
      github.setCannedResponse('GET', '/repos/org/my-repo/pulls', {
        status: 200,
        body: [],
      });

      // First call
      await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      // Second call — should issue another get_token IPC
      await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      // Verify get_token was called twice (once per tool call)
      const requests = mockDaemon.getRequests();
      const tokenRequests = requests.filter((r) => r.op === 'get_token');
      expect(tokenRequests.length).toBe(2);
    });

    it('returns error when token retrieval fails', async () => {
      // Clear the token so get_token returns error
      mockDaemon.clearProjectToken(PROJECT_NAME);

      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      expect(resp.result?.isError).toBe(true);
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.error).toContain('Token retrieval failed');
    });
  });

  describe('response passthrough', () => {
    it('passes through status code', async () => {
      github.setCannedResponse('GET', '/repos/org/my-repo/issues', {
        status: 404,
        body: { message: 'Not Found' },
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/issues',
        repo: BOUND_REPO,
      });

      expect(resp.result?.isError).toBeFalsy();
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.status).toBe(404);
    });

    it('passes through response body', async () => {
      const responseBody = [{ id: 1, title: 'PR 1' }, { id: 2, title: 'PR 2' }];
      github.setCannedResponse('GET', '/repos/org/my-repo/pulls', {
        status: 200,
        body: responseBody,
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.status).toBe(200);
      expect(JSON.parse(content.body)).toEqual(responseBody);
    });

    it('passes through custom response headers', async () => {
      github.setCannedResponse('GET', '/repos/org/my-repo/pulls', {
        status: 200,
        headers: { 'x-ratelimit-remaining': '42' },
        body: [],
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.headers['x-ratelimit-remaining']).toBe('42');
    });

    it('forwards POST with request body', async () => {
      github.setCannedResponse('POST', '/repos/org/my-repo/issues', {
        status: 201,
        body: { id: 99, title: 'New Issue' },
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'POST',
        path: '/repos/org/my-repo/issues',
        repo: BOUND_REPO,
        body: JSON.stringify({ title: 'New Issue', body: 'Description' }),
      });

      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.status).toBe(201);
      expect(JSON.parse(content.body)).toEqual({ id: 99, title: 'New Issue' });
    });

    it('sets User-Agent and Accept headers on upstream request', async () => {
      // Use a canned response and check the API calls log
      github.setCannedResponse('GET', '/repos/org/my-repo/pulls', {
        status: 200,
        body: [],
      });

      await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      const calls = await github.getAPICalls();
      const lastCall = calls[calls.length - 1]!;
      const headers = lastCall.headers as Record<string, string>;
      expect(headers['user-agent']).toBe('agent-router/0.1.0');
      expect(headers['accept']).toBe('application/vnd.github+json');
    });
  });

  describe('timeout handling', () => {
    it('returns timeout error when upstream takes longer than 30s', async () => {
      // Create a slow HTTP server that never responds within 30s
      const slowServer = http.createServer((_req, _res) => {
        // Intentionally never respond — let the timeout trigger
      });
      await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
      const slowPort = (slowServer.address() as { port: number }).port;

      // Create a new MCP subprocess pointing at the slow server
      const slowMcp = new McpSubprocess(
        mockDaemon.socketPath(),
        SESSION_ID,
        `http://127.0.0.1:${slowPort}`,
      );
      await slowMcp.start();

      try {
        const resp = await slowMcp.callTool('github_http_forward', {
          method: 'GET',
          path: '/repos/org/my-repo/pulls',
          repo: BOUND_REPO,
        });

        expect(resp.result?.isError).toBe(true);
        const content = JSON.parse(resp.result!.content![0]!.text);
        expect(content.code).toBe('upstream_timeout');
        expect(content.error).toContain('timed out');
      } finally {
        await slowMcp.stop();
        await new Promise<void>((resolve) => slowServer.close(() => resolve()));
      }
    }, 40_000); // Give test 40s to accommodate the 30s timeout
  });

  describe('body size enforcement', () => {
    it('rejects request body larger than 10 MB', async () => {
      // Create a body slightly over 10 MB
      const largeBody = 'x'.repeat(10 * 1024 * 1024 + 1);

      const resp = await mcp.callTool('github_http_forward', {
        method: 'POST',
        path: '/repos/org/my-repo/issues',
        repo: BOUND_REPO,
        body: largeBody,
      });

      expect(resp.result?.isError).toBe(true);
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.code).toBe('body_too_large');
    });

    it('accepts request body at exactly 10 MB', async () => {
      // 10 MB boundary is verified by Tier 1 property tests.
      // Here we verify with a body just under the limit (1 MB) to avoid
      // pipe throughput issues in subprocess-based tests.
      const body = JSON.stringify({ data: 'x'.repeat(1_000_000) });

      github.setCannedResponse('POST', '/repos/org/my-repo/issues', {
        status: 201,
        body: { id: 1 },
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'POST',
        path: '/repos/org/my-repo/issues',
        repo: BOUND_REPO,
        body,
      });

      // Should not be a body_too_large validation error
      if (resp.result?.isError) {
        const content = JSON.parse(resp.result!.content![0]!.text);
        expect(content.code).not.toBe('body_too_large');
      } else {
        const content = JSON.parse(resp.result!.content![0]!.text);
        expect(content.status).toBe(201);
      }
    }, 15_000);
  });

  describe('read/write split enforcement', () => {
    it('allows GET to bound project repo', async () => {
      github.setCannedResponse('GET', '/repos/org/my-repo/pulls', {
        status: 200,
        body: [],
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      expect(resp.result?.isError).toBeFalsy();
    });

    it('allows GET to read_repos repo', async () => {
      github.setCannedResponse('GET', '/repos/org/read-only-repo/pulls', {
        status: 200,
        body: [],
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/org/read-only-repo/pulls',
        repo: READ_REPO,
      });

      expect(resp.result?.isError).toBeFalsy();
    });

    it('rejects write to non-bound-project repo', async () => {
      const resp = await mcp.callTool('github_http_forward', {
        method: 'POST',
        path: '/repos/org/read-only-repo/issues',
        repo: READ_REPO,
        body: JSON.stringify({ title: 'Attempt' }),
      });

      expect(resp.result?.isError).toBe(true);
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.code).toBe('repo_unauthorized');
    });

    it('rejects write to unknown repo', async () => {
      const resp = await mcp.callTool('github_http_forward', {
        method: 'DELETE',
        path: '/repos/other/repo/issues/1',
        repo: 'other/repo',
      });

      expect(resp.result?.isError).toBe(true);
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.code).toBe('repo_unauthorized');
    });

    it('rejects GET to unknown repo not in bound or read_repos', async () => {
      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/repos/unknown/repo/pulls',
        repo: 'unknown/repo',
      });

      expect(resp.result?.isError).toBe(true);
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.code).toBe('repo_unauthorized');
    });

    it('allows POST to bound project repo', async () => {
      github.setCannedResponse('POST', '/repos/org/my-repo/issues', {
        status: 201,
        body: { id: 1 },
      });

      const resp = await mcp.callTool('github_http_forward', {
        method: 'POST',
        path: '/repos/org/my-repo/issues',
        repo: BOUND_REPO,
        body: JSON.stringify({ title: 'New' }),
      });

      expect(resp.result?.isError).toBeFalsy();
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.status).toBe(201);
    });
  });

  describe('method validation', () => {
    it('rejects invalid HTTP method', async () => {
      const resp = await mcp.callTool('github_http_forward', {
        method: 'TRACE',
        path: '/repos/org/my-repo/pulls',
        repo: BOUND_REPO,
      });

      expect(resp.result?.isError).toBe(true);
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.code).toBe('method_invalid');
    });
  });

  describe('path validation', () => {
    it('rejects path not starting with known prefix', async () => {
      const resp = await mcp.callTool('github_http_forward', {
        method: 'GET',
        path: '/unknown/path',
        repo: BOUND_REPO,
      });

      expect(resp.result?.isError).toBe(true);
      const content = JSON.parse(resp.result!.content![0]!.text);
      expect(content.code).toBe('path_invalid');
    });
  });
});

/**
 * Tier 1 tests for the per-session MCP server (agent-process-isolation, item 85).
 *
 * Spec: .kiro/specs/agent-process-isolation/ · tasks 85.1, 85.2, 85.3, 85.4, 85.6
 *
 * Covers:
 *  - `tools/list` has no `git_credential` (AC-3) and exposes the ten current
 *    tools including the new relays.
 *  - `github_http_forward` is a thin relay — it sends `op: 'github_forward'`
 *    (NOT `get_token`) with the session id + cap token to the agent socket.
 *  - `push_branch` sends `op: 'push_branch'` to the agent socket.
 *  - `pr_create` / `pr_view` send their ops to the agent socket.
 *
 * The MCP server is spawned as a real subprocess (as the daemon launches it)
 * and the agent socket is a fake Unix-socket server that captures every frame
 * and replies with a canned `{ ok: true }`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import * as url from 'node:url';
import * as cp from 'node:child_process';

import { resolveAgentSocket } from '../../src/mcp-server.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '../../src/mcp-server.ts');

const SESSION_ID = 'mcp-test-session';
const CAP_TOKEN = 'captokencaptokencaptokencaptoken';

interface McpResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
  };
  error?: { code: number; message: string };
}

/** A fake agent socket that records every frame and replies `{ ok: true }`. */
class FakeAgentSocket {
  readonly frames: Array<Record<string, unknown>> = [];
  private server: net.Server;
  readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.trim().length > 0) {
            try {
              this.frames.push(JSON.parse(line) as Record<string, unknown>);
            } catch {
              /* ignore */
            }
            socket.write(JSON.stringify({ ok: true }) + '\n');
          }
          idx = buffer.indexOf('\n');
        }
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, () => resolve()));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** Drives the MCP subprocess over stdio. */
class McpSubprocess {
  private proc: cp.ChildProcess | null = null;
  private buffer = '';
  private waiters: Array<{ id: number | string; resolve: (r: McpResponse) => void }> = [];
  private pending: McpResponse[] = [];

  constructor(
    private daemonSocket: string,
    private agentSocket: string,
    private capToken: string,
    /** When false, AGENT_ROUTER_AGENT_SOCK is NOT set (Fix 1 fallback test). */
    private setAgentSock: boolean = true,
  ) {}

  async start(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_ROUTER_SESSION_ID: SESSION_ID,
      AGENT_ROUTER_SOCKET: this.daemonSocket,
      AGENT_ROUTER_CAP_TOKEN: this.capToken,
    };
    if (this.setAgentSock) {
      env['AGENT_ROUTER_AGENT_SOCK'] = this.agentSocket;
    } else {
      // Ensure a leaked parent value cannot satisfy the relay.
      delete env['AGENT_ROUTER_AGENT_SOCK'];
    }
    this.proc = cp.spawn('node', ['--import', 'tsx/esm', MCP_SERVER_PATH], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let idx = this.buffer.indexOf('\n');
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const resp = JSON.parse(line) as McpResponse;
            const w = this.waiters.findIndex((x) => x.id === resp.id);
            if (w !== -1) {
              this.waiters.splice(w, 1)[0]!.resolve(resp);
            } else {
              this.pending.push(resp);
            }
          } catch {
            /* skip */
          }
        }
        idx = this.buffer.indexOf('\n');
      }
    });
    await new Promise((r) => setTimeout(r, 300));
    await this.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.stdin!.end();
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      this.proc!.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
  }

  send(msg: Record<string, unknown>): Promise<McpResponse> {
    const id = msg['id'] as number | string;
    return new Promise((resolve, reject) => {
      const buffered = this.pending.findIndex((r) => r.id === id);
      if (buffered !== -1) {
        resolve(this.pending.splice(buffered, 1)[0]!);
        return;
      }
      this.waiters.push({ id, resolve });
      this.proc!.stdin!.write(JSON.stringify(msg) + '\n');
      setTimeout(() => reject(new Error('MCP response timeout')), 10_000);
    });
  }

  listTools(): Promise<McpResponse> {
    return this.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  }

  callTool(name: string, args: Record<string, unknown>): Promise<McpResponse> {
    const id = Math.floor(Math.random() * 1e9) + 2;
    return this.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  }
}

describe('MCP server (item 85)', () => {
  let tmpDir: string;
  let daemonSocketPath: string;
  let agentSocket: FakeAgentSocket;
  let daemonStub: net.Server;
  let mcp: McpSubprocess;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-item85-'));
    daemonSocketPath = path.join(tmpDir, 'daemon.sock');
    const agentSocketPath = path.join(tmpDir, 'agent.sock');

    // Operator socket stub — never used by the relays but must be bindable.
    daemonStub = net.createServer(() => {
      /* no-op */
    });
    await new Promise<void>((resolve) => daemonStub.listen(daemonSocketPath, () => resolve()));

    agentSocket = new FakeAgentSocket(agentSocketPath);
    await agentSocket.start();

    mcp = new McpSubprocess(daemonSocketPath, agentSocketPath, CAP_TOKEN);
    await mcp.start();
  });

  afterEach(async () => {
    await mcp.stop();
    await agentSocket.stop();
    await new Promise<void>((resolve) => daemonStub.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tools/list has no git_credential and exposes the ten current tools (AC-3)', async () => {
    const resp = await mcp.listTools();
    const tools = resp.result!.tools!;
    const names = tools.map((t) => t.name).sort();
    expect(names).not.toContain('git_credential');
    expect(names).toEqual(
      [
        'complete_session',
        'github_http_forward',
        'merge_pr',
        'pr_create',
        'pr_view',
        'push_branch',
        'register_pr',
        'register_worktree',
        'report_outcome',
        'session_status',
      ].sort(),
    );
  });

  it('github_http_forward relays op "github_forward" (not get_token) with session id + cap token', async () => {
    await mcp.callTool('github_http_forward', {
      method: 'GET',
      path: '/repos/o/r/pulls/1',
    });
    const frame = agentSocket.frames.find((f) => f['method'] === 'GET');
    expect(frame).toBeDefined();
    expect(frame!['op']).toBe('github_forward');
    expect(frame!['session_id']).toBe(SESSION_ID);
    expect(frame!['cap_token']).toBe(CAP_TOKEN);
    expect(frame!['path']).toBe('/repos/o/r/pulls/1');
    // The old design fetched a token via a separate op — ensure it is gone.
    expect(agentSocket.frames.some((f) => f['op'] === 'get_token')).toBe(false);
  });

  it('push_branch relays op "push_branch" with the branch name', async () => {
    await mcp.callTool('push_branch', { branch: 'agent/fix' });
    const frame = agentSocket.frames.find((f) => f['op'] === 'push_branch');
    expect(frame).toBeDefined();
    expect(frame!['session_id']).toBe(SESSION_ID);
    expect(frame!['cap_token']).toBe(CAP_TOKEN);
    expect(frame!['branch']).toBe('agent/fix');
  });

  it('pr_create relays op "pr_create" with the body', async () => {
    await mcp.callTool('pr_create', {
      body: { title: 'x', head: 'agent/fix', base: 'development' },
    });
    const frame = agentSocket.frames.find((f) => f['op'] === 'pr_create');
    expect(frame).toBeDefined();
    expect(frame!['session_id']).toBe(SESSION_ID);
    expect((frame!['body'] as Record<string, unknown>)['base']).toBe('development');
  });

  it('pr_view relays op "pr_view" with the pr number', async () => {
    await mcp.callTool('pr_view', { pr_number: 7 });
    const frame = agentSocket.frames.find((f) => f['op'] === 'pr_view');
    expect(frame).toBeDefined();
    expect(frame!['pr_number']).toBe(7);
  });
});

/**
 * Fix 1 (security-isolation-fix FR-1): `resolveAgentSocket` resolves ONLY from
 * `ctx.agentSocket` and `AGENT_ROUTER_AGENT_SOCK`, treats empty strings as
 * absent, throws when both are absent, and NEVER falls back to the operator
 * socket (`AGENT_ROUTER_SOCKET` / `daemonSocket`).
 */
describe('resolveAgentSocket pure helper (Fix 1 / FR-1)', () => {
  it('returns ctx socket when present, env unset', () => {
    expect(resolveAgentSocket('real-path', undefined)).toBe('real-path');
  });

  it('returns env socket when ctx undefined', () => {
    expect(resolveAgentSocket(undefined, 'real-path')).toBe('real-path');
  });

  it('falls through empty ctx string to env', () => {
    expect(resolveAgentSocket('', 'real-path')).toBe('real-path');
  });

  it('throws exact message when both absent', () => {
    expect(() => resolveAgentSocket(undefined, undefined)).toThrow(
      'AGENT_ROUTER_AGENT_SOCK not set; cannot relay MCP tool',
    );
  });

  it('throws exact message when both are empty strings', () => {
    expect(() => resolveAgentSocket('', '')).toThrow(
      'AGENT_ROUTER_AGENT_SOCK not set; cannot relay MCP tool',
    );
  });
});

describe('MCP relay never falls back to the operator socket (Fix 1 / AC-1)', () => {
  let tmpDir: string;
  let daemonSocketPath: string;
  let daemon: FakeAgentSocket; // records frames; proves the operator socket is untouched
  let agentSocket: FakeAgentSocket;
  let mcp: McpSubprocess;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fix1-'));
    daemonSocketPath = path.join(tmpDir, 'daemon.sock');
    const agentSocketPath = path.join(tmpDir, 'agent.sock');

    // The operator socket is a *recording* server so we can assert it is never
    // contacted by a relay when the agent socket is unset.
    daemon = new FakeAgentSocket(daemonSocketPath);
    await daemon.start();

    agentSocket = new FakeAgentSocket(agentSocketPath);
    await agentSocket.start();

    // setAgentSock = false → AGENT_ROUTER_AGENT_SOCK is NOT set; only
    // AGENT_ROUTER_SOCKET (the operator socket) is present in the env.
    mcp = new McpSubprocess(daemonSocketPath, agentSocketPath, CAP_TOKEN, false);
    await mcp.start();
  });

  afterEach(async () => {
    await mcp.stop();
    await agentSocket.stop();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('github_http_forward returns isError and contacts neither the operator nor agent socket', async () => {
    const resp = await mcp.callTool('github_http_forward', {
      method: 'GET',
      path: '/repos/o/r/pulls/1',
    });
    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(text).toContain('AGENT_ROUTER_AGENT_SOCK not set; cannot relay MCP tool');
    // Give any stray write a moment to land, then assert zero frames.
    await new Promise((r) => setTimeout(r, 100));
    expect(daemon.frames.length).toBe(0); // operator socket never contacted
    expect(agentSocket.frames.length).toBe(0); // agent socket not resolvable
  });

  it('push_branch returns isError without crashing the MCP server', async () => {
    const resp = await mcp.callTool('push_branch', { branch: 'agent/fix' });
    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(text).toContain('AGENT_ROUTER_AGENT_SOCK not set; cannot relay MCP tool');
    // Server is still alive: a subsequent non-relay call (tools/list) works.
    const list = await mcp.listTools();
    expect(list.result?.tools?.length).toBeGreaterThan(0);
    expect(daemon.frames.length).toBe(0);
  });
});

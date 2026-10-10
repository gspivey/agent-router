/**
 * Tier 1 tests: ACP client forwards the `mcpServers` array into the
 * session/new and session/load JSON-RPC params.
 *
 * Spec: .kiro/specs/mcp-server-wiring/ · tasks 1, 2
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 9.1, 9.5
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createACPClientFromStreams, type McpServerEntry } from '../../src/acp.js';

interface JsonRpcLine {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function makeStreams() {
  const fakeStdout = new PassThrough(); // Kiro's output (we write here)
  const fakeStdin = new PassThrough(); // what the client sends to Kiro (we read here)

  const written: string[] = [];
  fakeStdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

  const sessionEnded = new Promise<void>(() => {
    // never resolves — no real subprocess
  });

  const client = createACPClientFromStreams(fakeStdin, fakeStdout, sessionEnded);

  function send(obj: unknown): void {
    fakeStdout.write(JSON.stringify(obj) + '\n');
  }

  /** Parse every complete JSON-RPC line the client has written to stdin so far. */
  function writtenLines(): JsonRpcLine[] {
    return written
      .join('')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as JsonRpcLine);
  }

  /** Find the first written request with the given method. */
  function findRequest(method: string): JsonRpcLine | undefined {
    return writtenLines().find((l) => l.method === method);
  }

  return { client, send, written, writtenLines, findRequest };
}

const ENTRY: McpServerEntry = {
  name: 'agent-router',
  command: '/usr/bin/node',
  args: ['--import', 'tsx/esm', '/abs/src/mcp-server.ts'],
  env: [
    { name: 'AGENT_ROUTER_SESSION_ID', value: 'sess-123' },
    { name: 'AGENT_ROUTER_SOCKET', value: '/tmp/sock' },
  ],
};

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('ACP client — newSession mcpServers forwarding', () => {
  it('includes the provided mcpServers array in session/new params', async () => {
    const { client, send, findRequest } = makeStreams();

    const p = client.newSession('/work', [ENTRY]);
    await tick();
    // Respond to the session/new request (id 1)
    send({ jsonrpc: '2.0', id: 1, result: { sessionId: 'fake-session-001' } });
    await p;

    const req = findRequest('session/new');
    expect(req).toBeDefined();
    expect(req!.params!['cwd']).toBe('/work');
    expect(req!.params!['mcpServers']).toEqual([ENTRY]);
  });

  it('sends mcpServers: [] when the argument is omitted (pre-feature parity)', async () => {
    const { client, send, findRequest } = makeStreams();

    const p = client.newSession('/work');
    await tick();
    send({ jsonrpc: '2.0', id: 1, result: { sessionId: 'fake-session-001' } });
    await p;

    const req = findRequest('session/new');
    expect(req).toBeDefined();
    expect(req!.params!['mcpServers']).toEqual([]);
  });
});

describe('ACP client — newSessionWithPrompt mcpServers forwarding', () => {
  it('includes mcpServers in session/new AND still sends session/prompt immediately', async () => {
    const { client, send, writtenLines } = makeStreams();

    const p = client.newSessionWithPrompt('/work', 'do the thing', [ENTRY]);
    await tick();
    send({ jsonrpc: '2.0', id: 1, result: { sessionId: 'fake-session-001' } });
    await p;
    await tick();

    const lines = writtenLines();
    const newReq = lines.find((l) => l.method === 'session/new');
    const promptReq = lines.find((l) => l.method === 'session/prompt');

    expect(newReq).toBeDefined();
    expect(newReq!.params!['mcpServers']).toEqual([ENTRY]);

    // The prompt request must follow (pipelined immediately after session/new)
    expect(promptReq).toBeDefined();
    expect(promptReq!.params!['sessionId']).toBe('fake-session-001');
  });

  it('sends mcpServers: [] when omitted', async () => {
    const { client, send, writtenLines } = makeStreams();

    const p = client.newSessionWithPrompt('/work', 'do the thing');
    await tick();
    send({ jsonrpc: '2.0', id: 1, result: { sessionId: 'fake-session-001' } });
    await p;

    const newReq = writtenLines().find((l) => l.method === 'session/new');
    expect(newReq!.params!['mcpServers']).toEqual([]);
  });
});

describe('ACP client — loadSession mcpServers forwarding', () => {
  it('includes { sessionId, cwd, mcpServers } with the provided array', async () => {
    const { client, send, findRequest } = makeStreams();

    const p = client.loadSession('kiro-abc', [ENTRY]);
    await tick();
    send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await p;

    const req = findRequest('session/load');
    expect(req).toBeDefined();
    expect(req!.params!['sessionId']).toBe('kiro-abc');
    expect(typeof req!.params!['cwd']).toBe('string');
    expect(req!.params!['mcpServers']).toEqual([ENTRY]);
  });

  it('sends { sessionId, cwd, mcpServers: [] } when the array is omitted (R2.2 bug fix)', async () => {
    const { client, send, findRequest } = makeStreams();

    const p = client.loadSession('kiro-abc');
    await tick();
    send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await p;

    const req = findRequest('session/load');
    expect(req).toBeDefined();
    expect(req!.params!['sessionId']).toBe('kiro-abc');
    expect(typeof req!.params!['cwd']).toBe('string');
    expect(req!.params!['mcpServers']).toEqual([]);
  });
});

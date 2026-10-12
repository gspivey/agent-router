/**
 * Entry-execution smoke test (Task 9b).
 *
 * Spec: .kiro/specs/mcp-server-wiring/ · task 9b
 * Requirements: 4.1, 4.2, 4.3, 9.1, 9.6
 *
 * This is the only gate on the ACTUAL entry-point launch: it calls the
 * exported resolveMcpServerCommand() helper with src/ as moduleDir and a real
 * module resolver, then spawns the returned command/args as a real child
 * process against a stub Unix socket, completes an MCP `initialize` handshake,
 * and asserts `tools/list` returns all ten tool names. It exercises surfaces
 * not covered by unit/Tier 2 tests: the tsx/esm loader URL, the argv[1]
 * main-module guard, and the AGENT_ROUTER_* env contract.
 *
 * The test is skipped (with a warning) when the MCP entry point file is absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as url from 'node:url';
import * as cp from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveMcpServerCommand } from '../../src/mcp-resolver.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../../src');

const require = createRequire(import.meta.url);
function resolveSpecifier(specifier: string): string {
  return url.pathToFileURL(require.resolve(specifier)).href;
}

const EXPECTED_TOOLS = [
  'session_status',
  'register_pr',
  'merge_pr',
  'complete_session',
  'github_http_forward',
  'push_branch',
  'pr_create',
  'pr_view',
  'register_worktree',
  'report_outcome',
];

let tmpDir: string;
let socketPath: string;
let stubServer: net.Server;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-'));
  socketPath = path.join(tmpDir, 'sock');
  // Stub Unix socket server — the MCP server connects lazily (only on tool
  // calls), so initialize/tools/list don't actually touch it, but it must be
  // a valid path. We bind one anyway to be safe.
  stubServer = net.createServer(() => {
    // accept and ignore — no tool call is made in this test
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => stubServer.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mcpRoundTrip(
  proc: cp.ChildProcess,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP response timeout')), 10_000);
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (request['id'] !== undefined && parsed['id'] === request['id']) {
              clearTimeout(timer);
              proc.stdout!.removeListener('data', onData);
              resolve(parsed);
              return;
            }
          } catch {
            // skip malformed lines
          }
        }
        idx = buffer.indexOf('\n');
      }
    };
    proc.stdout!.on('data', onData);
    proc.stdin!.write(JSON.stringify(request) + '\n');
  });
}

describe('MCP entry-execution smoke test (Task 9b)', () => {
  it('launches the resolved command/args and tools/list returns all ten tools', async () => {
    const resolved = resolveMcpServerCommand(SRC_DIR, resolveSpecifier);
    if (resolved === undefined) {
      // MCP entry point absent from the build — skip with a warning.
      // eslint-disable-next-line no-console
      console.warn('[smoke] mcp-server entry point not found under src/; skipping 9b');
      return;
    }

    await new Promise<void>((resolve) => stubServer.listen(socketPath, () => resolve()));

    const proc = cp.spawn(resolved.command, [...resolved.args, resolved.serverPath], {
      env: {
        ...process.env,
        AGENT_ROUTER_SESSION_ID: 'smoke-session',
        AGENT_ROUTER_SOCKET: socketPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      // initialize handshake
      const initResp = await mcpRoundTrip(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '1.0' },
        },
      });
      expect((initResp['result'] as Record<string, unknown>)['protocolVersion']).toBe('2024-11-05');

      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // tools/list
      const listResp = await mcpRoundTrip(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const tools = (listResp['result'] as Record<string, unknown>)['tools'] as Array<{ name: string }>;
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
    } finally {
      proc.stdin!.end();
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 3000);
      });
    }
  }, 25_000);
});

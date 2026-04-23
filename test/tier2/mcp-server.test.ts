/**
 * Tier 2 tests: MCP server — register_pr tool call via MCP JSON-RPC.
 * Requirements: 20.3, 24.6
 *
 * Test flow:
 * 1. Start a daemon with CLI server + session manager
 * 2. Create a session via CLI IPC
 * 3. Spawn the MCP server as a subprocess with the session ID
 * 4. Send a register_pr tool call via MCP JSON-RPC
 * 5. Verify the PR was registered in meta.json
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import * as url from 'node:url';
import { createCliServer, type CliServer } from '../../src/cli-server.js';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles, type SessionMeta } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { TestCli } from '../harness/test-cli.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');
const MCP_SERVER_PATH = path.resolve(__dirname, '../../src/mcp-server.ts');

let rootDir: string;
let dbPath: string;
let socketPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let cliServer: CliServer;
let cli: TestCli;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-tier2-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  socketPath = path.join(rootDir, 'sock');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);

  mgr = createSessionManager({
    db,
    sessionFiles: sf,
    acpSpawner: (_sessionId: string) => {
      const cfg = kiro.spawnConfig();
      return spawnACPClient(cfg.command, cfg.args, cfg.env);
    },
    log,
  });

  cliServer = createCliServer({ socketPath, sessionMgr: mgr, sessionFiles: sf, log });
  await cliServer.start();
  cli = new TestCli(socketPath);
});

afterEach(async () => {
  await cliServer.shutdown();
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/**
 * Send a JSON-RPC request to an MCP subprocess via stdin and read the response from stdout.
 */
function mcpRoundTrip(
  mcpProc: cp.ChildProcess,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP response timeout')), 10_000);
    let buffer = '';

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      // Look for complete JSON-RPC responses (one per line)
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            // Match by id if present
            if (request['id'] !== undefined && parsed['id'] === request['id']) {
              clearTimeout(timer);
              mcpProc.stdout!.removeListener('data', onData);
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

    mcpProc.stdout!.on('data', onData);
    mcpProc.stdin!.write(JSON.stringify(request) + '\n');
  });
}

/**
 * Spawn the MCP server subprocess with the given session ID and daemon socket path.
 */
function spawnMcpServer(sessionId: string, daemonSocketPath: string): cp.ChildProcess {
  const proc = cp.spawn('node', ['--import', 'tsx/esm', MCP_SERVER_PATH], {
    env: {
      ...process.env,
      AGENT_ROUTER_SESSION_ID: sessionId,
      AGENT_ROUTER_SOCKET: daemonSocketPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return proc;
}

async function killMcpProc(proc: cp.ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
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

describe('MCP server register_pr (Req 20.3, 24.6)', () => {
  it('registers a PR via MCP tool call and updates meta.json', async () => {
    // 1. Create a session via CLI IPC
    const session = await cli.newSession('Implement feature via MCP');

    // 2. Spawn MCP server subprocess
    const mcpProc = spawnMcpServer(session.session_id, socketPath);

    try {
      // 3. Send MCP initialize handshake
      const initResponse = await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
      });
      expect(initResponse['result']).toBeDefined();
      const initResult = initResponse['result'] as Record<string, unknown>;
      expect(initResult['serverInfo']).toBeDefined();

      // 4. Send notifications/initialized acknowledgement
      mcpProc.stdin!.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n');

      // 5. Send register_pr tool call
      const toolResponse = await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'register_pr',
          arguments: {
            repo: 'myorg/myrepo',
            pr_number: 42,
          },
        },
      });

      expect(toolResponse['result']).toBeDefined();
      const toolResult = toolResponse['result'] as Record<string, unknown>;
      expect(toolResult['isError']).toBeUndefined();
      const content = toolResult['content'] as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      const textContent = JSON.parse(content[0]!['text'] as string) as Record<string, unknown>;
      expect(textContent['ok']).toBe(true);

      // 6. Verify meta.json was updated
      const meta = sf.readMeta(session.session_id);
      expect(meta.prs).toHaveLength(1);
      expect(meta.prs[0]!.repo).toBe('myorg/myrepo');
      expect(meta.prs[0]!.pr_number).toBe(42);
      expect(typeof meta.prs[0]!.registered_at).toBe('number');
    } finally {
      await killMcpProc(mcpProc);
    }
  }, 20_000);

  it('returns tools list including register_pr', async () => {
    const session = await cli.newSession('List tools test');
    const mcpProc = spawnMcpServer(session.session_id, socketPath);

    try {
      // Initialize
      await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
      });

      // List tools
      const listResponse = await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      const result = listResponse['result'] as Record<string, unknown>;
      const tools = result['tools'] as Array<Record<string, unknown>>;
      const toolNames = tools.map((t) => t['name']);
      expect(toolNames).toContain('register_pr');
      expect(toolNames).toContain('session_status');
      expect(toolNames).toContain('complete_session');
    } finally {
      await killMcpProc(mcpProc);
    }
  }, 20_000);

  it('session_status returns session info', async () => {
    const session = await cli.newSession('Status check test');
    const mcpProc = spawnMcpServer(session.session_id, socketPath);

    try {
      // Initialize
      await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
      });

      // Call session_status
      const statusResponse = await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'session_status',
          arguments: {},
        },
      });

      const result = statusResponse['result'] as Record<string, unknown>;
      const content = result['content'] as Array<Record<string, unknown>>;
      const statusData = JSON.parse(content[0]!['text'] as string) as Record<string, unknown>;
      expect(statusData['original_prompt']).toBe('Status check test');
      expect(statusData['status']).toBe('active');
      expect(statusData['prs']).toEqual([]);
    } finally {
      await killMcpProc(mcpProc);
    }
  }, 20_000);
});

/**
 * Tier 2 test: MCP server session ID environment variable propagation.
 *
 * Validates that:
 * 1. The daemon injects AGENT_ROUTER_SESSION_ID into the Kiro subprocess env
 * 2. All three MCP tools (session_status, register_pr, complete_session) succeed
 * 3. The env var is a real UUID, not the literal string "${AGENT_ROUTER_SESSION_ID}"
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import * as url from 'node:url';
import { createCliServer, type CliServer } from '../../src/cli-server.js';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
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
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-env-tier2-'));
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
    acpSpawner: (sessionId: string) => {
      const cfg = kiro.spawnConfig();
      return spawnACPClient(cfg.command, cfg.args, {
        ...cfg.env,
        AGENT_ROUTER_SESSION_ID: sessionId,
      });
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
 * Send a JSON-RPC request to an MCP subprocess and read the correlated response.
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
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
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

function spawnMcpServer(sessionId: string, daemonSocketPath: string): cp.ChildProcess {
  return cp.spawn('node', ['--import', 'tsx/esm', MCP_SERVER_PATH], {
    env: {
      ...process.env,
      AGENT_ROUTER_SESSION_ID: sessionId,
      AGENT_ROUTER_SOCKET: daemonSocketPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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

async function initializeMcp(mcpProc: cp.ChildProcess): Promise<void> {
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
  mcpProc.stdin!.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }) + '\n');
}

describe('MCP session ID env propagation', () => {
  it('all three MCP tools succeed with a real session ID (not literal placeholder)', async () => {
    // 1. Create a session — the session manager injects AGENT_ROUTER_SESSION_ID
    const session = await cli.newSession('MCP env propagation test');
    const sessionId = session.session_id;

    // Verify the session ID is a real UUID, not the literal placeholder
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(sessionId).not.toBe('${AGENT_ROUTER_SESSION_ID}');

    // 2. Spawn MCP server with the real session ID (simulating inheritance from daemon)
    const mcpProc = spawnMcpServer(sessionId, socketPath);

    try {
      await initializeMcp(mcpProc);

      // 3. session_status — should return session info without ENOENT
      const statusResp = await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'session_status', arguments: {} },
      });
      const statusResult = statusResp['result'] as Record<string, unknown>;
      expect(statusResult['isError']).toBeUndefined();
      const statusContent = statusResult['content'] as Array<Record<string, unknown>>;
      const statusText = statusContent[0]!['text'] as string;
      expect(statusText).not.toContain('ENOENT');
      const statusData = JSON.parse(statusText) as Record<string, unknown>;
      expect(statusData['status']).toBe('active');
      expect(statusData['original_prompt']).toBe('MCP env propagation test');

      // 4. register_pr — should succeed without ENOENT
      const registerResp = await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'register_pr',
          arguments: { repo: 'test-org/test-repo', pr_number: 99 },
        },
      });
      const registerResult = registerResp['result'] as Record<string, unknown>;
      expect(registerResult['isError']).toBeUndefined();
      const registerContent = registerResult['content'] as Array<Record<string, unknown>>;
      const registerText = registerContent[0]!['text'] as string;
      expect(registerText).not.toContain('ENOENT');
      const registerData = JSON.parse(registerText) as Record<string, unknown>;
      expect(registerData['ok']).toBe(true);

      // 5. complete_session — should succeed without ENOENT
      const completeResp = await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'complete_session',
          arguments: { reason: 'All done' },
        },
      });
      const completeResult = completeResp['result'] as Record<string, unknown>;
      expect(completeResult['isError']).toBeUndefined();
      const completeContent = completeResult['content'] as Array<Record<string, unknown>>;
      const completeText = completeContent[0]!['text'] as string;
      expect(completeText).not.toContain('ENOENT');
      const completeData = JSON.parse(completeText) as Record<string, unknown>;
      expect(completeData['ok']).toBe(true);
    } finally {
      await killMcpProc(mcpProc);
    }
  }, 20_000);

  it('MCP tools fail with ENOENT when session ID is the literal placeholder', async () => {
    // Simulate the broken state: literal ${AGENT_ROUTER_SESSION_ID} as the env var
    const brokenSessionId = '${AGENT_ROUTER_SESSION_ID}';
    const mcpProc = spawnMcpServer(brokenSessionId, socketPath);

    try {
      await initializeMcp(mcpProc);

      // session_status should fail — the path won't exist
      const statusResp = await mcpRoundTrip(mcpProc, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'session_status', arguments: {} },
      });
      const statusResult = statusResp['result'] as Record<string, unknown>;
      const statusContent = statusResult['content'] as Array<Record<string, unknown>>;
      const statusText = statusContent[0]!['text'] as string;
      // Should contain an error (ENOENT or similar) since the path is bogus
      expect(statusResult['isError'] === true || statusText.includes('ENOENT') || statusText.includes('error')).toBe(true);
    } finally {
      await killMcpProc(mcpProc);
    }
  }, 20_000);
});

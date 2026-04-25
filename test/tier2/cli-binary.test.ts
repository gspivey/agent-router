/**
 * Tier 2 tests: CLI binary invoked as subprocess.
 * Requirements: 21.3, 21.4, 21.5, 24.6
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

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');
const CLI_BIN = path.resolve(__dirname, '../../bin/agent-router.ts');

let rootDir: string;
let dbPath: string;
let socketPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let cliServer: CliServer;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-binary-tier2-'));
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
});

afterEach(async () => {
  await cliServer.shutdown();
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/**
 * Run the CLI binary as a subprocess and return stdout, stderr, and exit code.
 */
function runCli(
  args: string[],
  opts?: { input?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const timeout = opts?.timeoutMs ?? 15_000;
    const child = cp.spawn('node', ['--import', 'tsx/esm', CLI_BIN, ...args], {
      env: {
        ...process.env,
        AGENT_ROUTER_HOME: rootDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (opts?.input !== undefined) {
      child.stdin!.write(opts.input);
      child.stdin!.end();
    } else {
      child.stdin!.end();
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('prompt --new --quiet (Req 21.12)', () => {
  it('creates a session and prints session_id to stdout', async () => {
    const result = await runCli(['prompt', '--new', '--quiet'], {
      input: 'Build the feature',
    });

    expect(result.code).toBe(0);
    const sessionId = result.stdout.trim();
    // UUID format
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Session directory should exist
    const sessionDir = path.join(rootDir, 'sessions', sessionId);
    expect(fs.existsSync(sessionDir)).toBe(true);
  }, 20_000);

  it('reads prompt from --file', async () => {
    const promptFile = path.join(rootDir, 'prompt.txt');
    fs.writeFileSync(promptFile, 'Task from file');

    const result = await runCli(['prompt', '--new', '--quiet', '--file', promptFile]);

    expect(result.code).toBe(0);
    const sessionId = result.stdout.trim();
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Verify the prompt was stored in meta.json
    const metaPath = path.join(rootDir, 'sessions', sessionId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['original_prompt']).toBe('Task from file');
  }, 20_000);
});

describe('ls (Req 21.11)', () => {
  it('shows "No sessions" when empty', async () => {
    const result = await runCli(['ls']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No sessions');
  }, 20_000);

  it('lists sessions after creating one', async () => {
    // Create a session first
    const createResult = await runCli(['prompt', '--new', '--quiet'], {
      input: 'Test prompt for ls',
    });
    expect(createResult.code).toBe(0);
    const sessionId = createResult.stdout.trim();

    // Now list
    const lsResult = await runCli(['ls']);
    expect(lsResult.code).toBe(0);
    // Should contain the session ID (truncated to 8 chars)
    expect(lsResult.stdout).toContain(sessionId.slice(0, 8));
    // Should contain column headers
    expect(lsResult.stdout).toContain('ID');
    expect(lsResult.stdout).toContain('Status');
  }, 20_000);
});

describe('terminate (Req 21.5)', () => {
  it('terminates an active session', async () => {
    // Create a session
    const createResult = await runCli(['prompt', '--new', '--quiet'], {
      input: 'Session to terminate',
    });
    expect(createResult.code).toBe(0);
    const sessionId = createResult.stdout.trim();

    // Terminate it
    const termResult = await runCli(['terminate', sessionId]);
    expect(termResult.code).toBe(0);
    expect(termResult.stderr).toContain('terminated');

    // Verify meta.json shows abandoned
    const metaPath = path.join(rootDir, 'sessions', sessionId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['status']).toBe('abandoned');
  }, 20_000);
});

describe('error handling', () => {
  it('exits with code 1 for unknown command', async () => {
    const result = await runCli(['unknown']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown command');
  }, 20_000);

  it('exits with code 1 for prompt without flags', async () => {
    const result = await runCli(['prompt']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage');
  }, 20_000);

  it('exits with code 1 for terminate without session_id', async () => {
    const result = await runCli(['terminate']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage');
  }, 20_000);
});

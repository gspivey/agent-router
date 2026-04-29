/**
 * Tier 2 tests: CLI IPC server — socket listener, NDJSON framing, all ops.
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.7, 24.6
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
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
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-server-tier2-'));
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

describe('list_sessions (Req 21.4)', () => {
  it('returns empty array when no sessions exist', async () => {
    const result = await cli.listSessions();
    expect(result.sessions).toEqual([]);
  });

  it('returns sessions sorted by created_at descending', async () => {
    await cli.newSession('First session');
    // created_at is in seconds, so wait >1s for a different timestamp
    await new Promise((r) => setTimeout(r, 1100));
    await cli.newSession('Second session');

    const result = await cli.listSessions();
    expect(result.sessions).toHaveLength(2);
    // Most recent first
    expect(result.sessions[0]!.original_prompt).toBe('Second session');
    expect(result.sessions[1]!.original_prompt).toBe('First session');
  }, 15_000);
});

describe('new_session (Req 21.3)', () => {
  it('creates a session and returns session_id and paths', async () => {
    const result = await cli.newSession('Build the feature');

    expect(result.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.stream_path).toContain(result.session_id);
    expect(result.stream_path).toContain('stream.log');
    expect(result.prompts_path).toContain(result.session_id);
    expect(result.prompts_path).toContain('prompts.log');

    // Session files should exist on disk
    expect(fs.existsSync(result.stream_path)).toBe(true);
    expect(fs.existsSync(result.prompts_path)).toBe(true);
  }, 15_000);

  it('returns error for missing prompt', async () => {
    const result = await sendRaw(socketPath, { op: 'new_session' });
    expect(result['error']).toMatch(/prompt/i);
  });
});

describe('inject_prompt (Req 21.7)', () => {
  it('injects a prompt into an active session', async () => {
    const session = await cli.newSession('Initial task');
    const result = await cli.injectPrompt(session.session_id, 'Follow-up');

    expect(result.ok).toBe(true);

    // Verify prompt was appended to prompts.log
    const promptsContent = fs.readFileSync(session.prompts_path, 'utf-8').trim();
    const lines = promptsContent.split('\n').filter((l) => l.length > 0);
    const lastPrompt = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(lastPrompt['prompt']).toBe('Follow-up');
    expect(lastPrompt['source']).toBe('cli');
  }, 15_000);

  it('returns error for missing session_id', async () => {
    const result = await sendRaw(socketPath, { op: 'inject_prompt', prompt: 'hello' });
    expect(result['error']).toMatch(/session_id/i);
  });

  it('returns error for nonexistent session', async () => {
    const result = await sendRaw(socketPath, {
      op: 'inject_prompt',
      session_id: 'nonexistent',
      prompt: 'hello',
    });
    expect(result['error']).toBeDefined();
  });
});

describe('terminate_session (Req 21.5)', () => {
  it('terminates an active session', async () => {
    const session = await cli.newSession('Task to terminate');
    const result = await cli.terminateSession(session.session_id);

    expect(result.ok).toBe(true);

    // meta.json should show abandoned
    const metaPath = path.join(rootDir, 'sessions', session.session_id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['status']).toBe('abandoned');
  }, 15_000);

  it('returns error for missing session_id', async () => {
    const result = await sendRaw(socketPath, { op: 'terminate_session' });
    expect(result['error']).toMatch(/session_id/i);
  });

  it('returns error for nonexistent session', async () => {
    const result = await sendRaw(socketPath, {
      op: 'terminate_session',
      session_id: 'nonexistent',
    });
    expect(result['error']).toBeDefined();
  });
});

describe('complete_session (P0.1)', () => {
  it('completes an active session with reason merged', async () => {
    const session = await cli.newSession('Task to merge');
    const result = await cli.completeSession(session.session_id, 'merged');

    expect(result.ok).toBe(true);

    // meta.json should show completed with termination_reason merged
    const metaPath = path.join(rootDir, 'sessions', session.session_id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['status']).toBe('completed');
    expect(meta['termination_reason']).toBe('merged');
    expect(meta['completed_at']).toBeTypeOf('number');
  }, 15_000);

  it('completes an active session with reason completed', async () => {
    const session = await cli.newSession('Task to complete');
    const result = await cli.completeSession(session.session_id, 'completed');

    expect(result.ok).toBe(true);

    const metaPath = path.join(rootDir, 'sessions', session.session_id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['status']).toBe('completed');
    expect(meta['termination_reason']).toBe('completed');
  }, 15_000);

  it('writes session_ended stream entry with reason', async () => {
    const session = await cli.newSession('Task to merge');
    await cli.completeSession(session.session_id, 'merged');

    // Check stream.log for session_ended entry
    const streamContent = fs.readFileSync(session.stream_path, 'utf-8').trim();
    const lines = streamContent.split('\n').filter((l) => l.length > 0);
    const endedEntries = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e['type'] === 'session_ended');

    expect(endedEntries.length).toBeGreaterThanOrEqual(1);
    const lastEnded = endedEntries[endedEntries.length - 1]!;
    expect(lastEnded['reason']).toBe('merged');
    expect(lastEnded['source']).toBe('router');
  }, 15_000);

  it('returns error for missing session_id', async () => {
    const result = await sendRaw(socketPath, { op: 'complete_session', reason: 'merged' });
    expect(result['error']).toMatch(/session_id/i);
  });

  it('returns error for missing reason', async () => {
    const result = await sendRaw(socketPath, { op: 'complete_session', session_id: 'some-id' });
    expect(result['error']).toMatch(/reason/i);
  });

  it('returns error for nonexistent session', async () => {
    const result = await sendRaw(socketPath, {
      op: 'complete_session',
      session_id: 'nonexistent',
      reason: 'merged',
    });
    expect(result['error']).toBeDefined();
  });
});

describe('error handling (Req 21.2)', () => {
  it('returns error for unknown op', async () => {
    const result = await sendRaw(socketPath, { op: 'unknown_op' });
    expect(result['error']).toMatch(/unknown op/i);
  });

  it('returns error for missing op field', async () => {
    const result = await sendRaw(socketPath, { foo: 'bar' });
    expect(result['error']).toMatch(/op/i);
  });

  it('returns error for invalid JSON', async () => {
    const result = await sendRawString(socketPath, 'not valid json\n');
    expect(result['error']).toMatch(/json/i);
  });
});

// --- Helpers ---

/** Send a raw JSON object to the socket and parse the response. */
function sendRaw(sock: string, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return sendRawString(sock, JSON.stringify(msg) + '\n');
}

/** Send a raw string to the socket and parse the response. */
function sendRawString(sock: string, data: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(data);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        socket.destroy();
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch (e) {
          reject(e);
        }
      }
    });

    socket.on('error', reject);

    socket.on('close', () => {
      if (buffer.trim()) {
        try {
          resolve(JSON.parse(buffer.trim()) as Record<string, unknown>);
        } catch {
          reject(new Error('Socket closed without valid response'));
        }
      }
    });
  });
}

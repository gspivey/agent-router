/**
 * Tier 2 tests: `kill` subcommand — IPC handler ends live session with
 * killed_by_operator termination_reason.
 * Spec: BACKLOG.md § P2.5
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-session-tier2-'));
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

describe('kill_session (BACKLOG P2.5)', () => {
  it('kills an active session with default reason killed_by_operator', async () => {
    const session = await cli.newSession('Test session for kill');
    const sessionId = session.session_id;

    const result = await cli.killSession(sessionId);
    expect(result.ok).toBe(true);

    // Verify meta.json reflects termination
    const meta = sf.readMeta(sessionId);
    expect(meta.status).toBe('abandoned');
    expect(meta.termination_reason).toBe('killed_by_operator');
    expect(meta.completed_at).toBeTypeOf('number');
  });

  it('kills a session with a custom reason string in actor field', async () => {
    const session = await cli.newSession('Test session custom reason');
    const sessionId = session.session_id;

    const result = await cli.killSession(sessionId, 'stuck on CI');
    expect(result.ok).toBe(true);

    const meta = sf.readMeta(sessionId);
    expect(meta.status).toBe('abandoned');
    expect(meta.termination_reason).toBe('killed_by_operator');
  });

  it('returns error when session is not active', async () => {
    const session = await cli.newSession('Session to terminate first');
    const sessionId = session.session_id;

    // Terminate it first
    await cli.terminateSession(sessionId);

    // Now try to kill it — should error
    const result = await cli.killSession(sessionId);
    expect(result.error).toBeDefined();
    expect(result.error).toContain(sessionId);
  });

  it('returns error for non-existent session', async () => {
    const result = await cli.killSession('00000000-0000-0000-0000-000000000000');
    expect(result.error).toBeDefined();
  });

  it('writes session_ended entry to stream.log', async () => {
    const session = await cli.newSession('Test session stream entry');
    const sessionId = session.session_id;

    await cli.killSession(sessionId);

    // Read stream.log and find the session_ended entry
    const streamPath = path.join(rootDir, 'sessions', sessionId, 'stream.log');
    const lines = fs.readFileSync(streamPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const ended = entries.find((e) => e['type'] === 'session_ended');
    expect(ended).toBeDefined();
    expect(ended!['reason']).toBe('killed_by_operator');
  });
});

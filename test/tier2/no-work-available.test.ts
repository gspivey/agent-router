/**
 * Tier 2 tests: complete_session with no_work_available reason via IPC
 * produces correct meta state (status: completed, termination_reason: no_work_available).
 * Spec: BACKLOG.md § P1.2
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
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-work-available-tier2-'));
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

describe('complete_session with no_work_available (BACKLOG P1.2)', () => {
  it('completes session with status completed and termination_reason no_work_available', async () => {
    const session = await cli.newSession('Check roadmap for work');
    const sessionId = session.session_id;

    const result = await cli.completeSession(sessionId, 'no_work_available');
    expect(result.ok).toBe(true);

    const meta = sf.readMeta(sessionId);
    expect(meta.status).toBe('completed');
    expect(meta.termination_reason).toBe('no_work_available');
    expect(meta.completed_at).toBeTypeOf('number');
  });

  it('writes session_ended entry with reason no_work_available to stream.log', async () => {
    const session = await cli.newSession('No roadmap items left');
    const sessionId = session.session_id;

    await cli.completeSession(sessionId, 'no_work_available');

    const streamPath = path.join(rootDir, 'sessions', sessionId, 'stream.log');
    const lines = fs.readFileSync(streamPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const ended = entries.find((e) => e['type'] === 'session_ended');
    expect(ended).toBeDefined();
    expect(ended!['reason']).toBe('no_work_available');
  });
});

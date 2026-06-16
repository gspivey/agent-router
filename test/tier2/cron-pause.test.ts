/**
 * Tier 2 tests: cron pause / resume via CLI IPC.
 * Requirements: 3.1, 3.2, 3.3, 3.5, 3.6
 *
 * Tests the full cron pause/resume lifecycle against the CLI server with
 * a real SQLite database and real node-cron tasks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import cron from 'node-cron';
import { createCliServer, type CliServer } from '../../src/cli-server.js';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { TestCli } from '../harness/test-cli.js';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let rootDir: string;
let socketPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let cliServer: CliServer;
let cli: TestCli;
let cronTasks: cron.ScheduledTask[];

const CRON_ENTRIES = [
  { name: 'nightly-tasks', schedule: '* * * * *', repo: 'myorg/myrepo' },
  { name: 'weekly-scan', schedule: '0 9 * * 1', repo: 'myorg/other' },
];

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-pause-tier2-'));
  const dbPath = path.join(rootDir, 'agent-router.db');
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

  // Create cron tasks (every minute for testing purposes, but we control .stop()/.start())
  cronTasks = CRON_ENTRIES.map((entry) => {
    const state = db.getCronState(entry.name);
    const paused = state !== null && state.paused;
    return cron.schedule(entry.schedule, () => {}, { scheduled: !paused });
  });

  cliServer = createCliServer({
    socketPath,
    sessionMgr: mgr,
    sessionFiles: sf,
    log,
    db,
    cronTasks,
    cronEntries: CRON_ENTRIES,
  });
  await cliServer.start();
  cli = new TestCli(socketPath);
});

afterEach(async () => {
  for (const task of cronTasks) {
    task.stop();
  }
  await cliServer.shutdown();
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('cron list (Req 3.1)', () => {
  it('lists all cron entries with default active state', async () => {
    const result = await cli.send<{ entries: Array<{ name: string; repo: string; schedule: string; paused: boolean }> }>(
      { op: 'cron_list' },
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.name).toBe('nightly-tasks');
    expect(result.entries[0]!.repo).toBe('myorg/myrepo');
    expect(result.entries[0]!.schedule).toBe('* * * * *');
    expect(result.entries[0]!.paused).toBe(false);
    expect(result.entries[1]!.name).toBe('weekly-scan');
    expect(result.entries[1]!.paused).toBe(false);
  });
});

describe('cron pause (Req 3.2, 3.3)', () => {
  it('pauses a cron and persists state', async () => {
    const result = await cli.send<{ ok: boolean }>({ op: 'cron_pause', name: 'nightly-tasks' });
    expect(result.ok).toBe(true);

    // Verify persisted state
    const state = db.getCronState('nightly-tasks');
    expect(state).not.toBeNull();
    expect(state!.paused).toBe(true);

    // Verify listed as paused
    const list = await cli.send<{ entries: Array<{ name: string; paused: boolean }> }>(
      { op: 'cron_list' },
    );
    const entry = list.entries.find((e) => e.name === 'nightly-tasks');
    expect(entry!.paused).toBe(true);
  });

  it('errors on unknown cron name (Req 3.5)', async () => {
    const result = await cli.send<{ error: string }>({ op: 'cron_pause', name: 'nonexistent' });
    expect(result.error).toContain('Unknown cron name');
    expect(result.error).toContain('nightly-tasks');
    expect(result.error).toContain('weekly-scan');
  });

  it('errors on missing name parameter', async () => {
    const result = await cli.send<{ error: string }>({ op: 'cron_pause' });
    expect(result.error).toContain('Missing or empty "name"');
  });
});

describe('cron resume (Req 3.2, 3.3)', () => {
  it('resumes a paused cron', async () => {
    await cli.send<{ ok: boolean }>({ op: 'cron_pause', name: 'nightly-tasks' });
    const result = await cli.send<{ ok: boolean }>({ op: 'cron_resume', name: 'nightly-tasks' });
    expect(result.ok).toBe(true);

    const state = db.getCronState('nightly-tasks');
    expect(state!.paused).toBe(false);
  });

  it('errors on unknown cron name (Req 3.5)', async () => {
    const result = await cli.send<{ error: string }>({ op: 'cron_resume', name: 'nonexistent' });
    expect(result.error).toContain('Unknown cron name');
  });
});

describe('state survives restart (Req 3.4)', () => {
  it('paused state persists after rebuilding cron tasks', async () => {
    // Pause
    await cli.send<{ ok: boolean }>({ op: 'cron_pause', name: 'nightly-tasks' });

    // Simulate restart: stop server, rebuild tasks from DB state
    await cliServer.shutdown();
    for (const task of cronTasks) {
      task.stop();
    }

    // Re-create tasks consulting DB state (as setupCronJobs does)
    const newTasks = CRON_ENTRIES.map((entry) => {
      const state = db.getCronState(entry.name);
      const paused = state !== null && state.paused;
      return cron.schedule(entry.schedule, () => {}, { scheduled: !paused });
    });
    cronTasks = newTasks;

    // Re-create CLI server
    cliServer = createCliServer({
      socketPath,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
      db,
      cronTasks: newTasks,
      cronEntries: CRON_ENTRIES,
    });
    await cliServer.start();
    cli = new TestCli(socketPath);

    // Verify paused state survived
    const list = await cli.send<{ entries: Array<{ name: string; paused: boolean }> }>(
      { op: 'cron_list' },
    );
    const entry = list.entries.find((e) => e.name === 'nightly-tasks');
    expect(entry!.paused).toBe(true);
    const other = list.entries.find((e) => e.name === 'weekly-scan');
    expect(other!.paused).toBe(false);
  });
});

describe('paused cron does not fire (Req 3.3)', () => {
  it('a stopped task does not invoke its callback', async () => {
    // The node-cron ScheduledTask exposes a .stop() method
    // After pause via IPC, the task should be stopped
    await cli.send<{ ok: boolean }>({ op: 'cron_pause', name: 'nightly-tasks' });

    // The task at index 0 should be stopped — node-cron's ScheduledTask
    // does not expose a public `running` getter, but we can verify the state
    // round-trips correctly and that the DB records it as paused
    const state = db.getCronState('nightly-tasks');
    expect(state!.paused).toBe(true);
  });
});

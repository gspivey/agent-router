/**
 * Tier 2 tests: Config hot-reload.
 * Requirements: 1.1, 1.2, 1.3, 1.5, 1.6 from operator-controls spec.
 *
 * Tests that a config reload applies reloadable fields (repos, cron,
 * sessionTimeout) to running components without dropping active sessions,
 * and that an invalid config is rejected (previous config retained).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import cron from 'node-cron';
import { loadConfig, classifyConfigChange } from '../../src/config.js';
import type { AgentRouterConfig } from '../../src/config.js';
import { watchConfig } from '../../src/config-watch.js';
import { reconcileCronJobs } from '../../src/cron-reconcile.js';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let tmpDir: string;
let configPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;

function writeConfig(overrides?: Partial<AgentRouterConfig>): void {
  const cfg = {
    port: 3000,
    webhookSecret: 'test-secret',
    kiroPath: process.execPath,
    repos: [{ owner: 'org', name: 'repo' }],
    cron: [],
    controlPort: 3100,
    ...overrides,
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-reload-tier2-'));
  configPath = path.join(tmpDir, 'config.json');
  writeConfig();

  sf = createSessionFiles(tmpDir);
  db = initDatabase(path.join(tmpDir, 'agent-router.db'));
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
});

afterEach(async () => {
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('config hot-reload: apply reloadable fields (Req 1.3, 1.5, 1.6)', () => {
  it('reload adds a repo and cron without dropping an active session', async () => {
    // Create an active session
    const handle = await mgr.createSession('test prompt', 'org/repo');
    expect(handle.sessionId).toBeTruthy();

    // Verify session is active
    const meta = sf.readMeta(handle.sessionId);
    expect(meta.status).toBe('active');

    // Load current config
    const oldConfig = loadConfig(configPath);

    // Create a prompt file for the new cron entry
    const promptFile = path.join(tmpDir, 'cron-prompt.md');
    fs.writeFileSync(promptFile, 'Do something');

    // Write new config with added repo and cron
    writeConfig({
      repos: [
        { owner: 'org', name: 'repo' },
        { owner: 'org', name: 'new-repo' },
      ],
      cron: [{ name: 'new-cron', schedule: '0 9 * * 1-5', repo: 'org/repo', promptFile }],
      sessionTimeout: { inactivityMinutes: 15, maxLifetimeMinutes: 240, gracePeriodAfterMergeSeconds: 120 },
    });

    const nextConfig = loadConfig(configPath);
    const changes = classifyConfigChange(oldConfig, nextConfig);

    expect(changes.reloadable).toContain('repos');
    expect(changes.reloadable).toContain('cron');
    expect(changes.reloadable).toContain('sessionTimeout');
    expect(changes.restartRequired).toHaveLength(0);

    // Reconcile cron jobs
    const oldTasks: cron.ScheduledTask[] = [];
    const newTasks = reconcileCronJobs({
      oldTasks,
      oldCron: oldConfig.cron,
      nextCron: nextConfig.cron,
      db,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
      handleCronFire: () => {},
    });

    expect(newTasks).toHaveLength(1);

    // Verify active session was NOT dropped
    const metaAfter = sf.readMeta(handle.sessionId);
    expect(metaAfter.status).toBe('active');

    // Cleanup
    for (const t of newTasks) t.stop();
  });

  it('reconcileCronJobs replaces a changed schedule', async () => {
    const promptFile = path.join(tmpDir, 'prompt.md');
    fs.writeFileSync(promptFile, 'test');

    const oldCron = [{ name: 'job1', schedule: '0 9 * * *', repo: 'org/repo', promptFile }];
    const oldTasks = oldCron.map((entry) =>
      cron.schedule(entry.schedule, () => {}, { scheduled: true }),
    );

    const nextCron = [{ name: 'job1', schedule: '0 12 * * *', repo: 'org/repo', promptFile }];
    const newTasks = reconcileCronJobs({
      oldTasks,
      oldCron,
      nextCron,
      db,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
      handleCronFire: () => {},
    });

    expect(newTasks).toHaveLength(1);
    // The old task should have been stopped and a new one created
    for (const t of newTasks) t.stop();
  });

  it('reconcileCronJobs stops removed entries', async () => {
    const promptFile = path.join(tmpDir, 'prompt.md');
    fs.writeFileSync(promptFile, 'test');

    const oldCron = [
      { name: 'job1', schedule: '0 9 * * *', repo: 'org/repo', promptFile },
      { name: 'job2', schedule: '0 10 * * *', repo: 'org/repo', promptFile },
    ];
    const oldTasks = oldCron.map((entry) =>
      cron.schedule(entry.schedule, () => {}, { scheduled: true }),
    );

    const nextCron = [{ name: 'job1', schedule: '0 9 * * *', repo: 'org/repo', promptFile }];
    const newTasks = reconcileCronJobs({
      oldTasks,
      oldCron,
      nextCron,
      db,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
      handleCronFire: () => {},
    });

    expect(newTasks).toHaveLength(1);
    for (const t of newTasks) t.stop();
  });

  it('reconcileCronJobs re-applies paused state on new entries', async () => {
    const promptFile = path.join(tmpDir, 'prompt.md');
    fs.writeFileSync(promptFile, 'test');

    // Pre-set paused state
    db.setCronPaused('job1', true);

    const oldCron: AgentRouterConfig['cron'] = [];
    const oldTasks: cron.ScheduledTask[] = [];
    const nextCron = [{ name: 'job1', schedule: '0 9 * * *', repo: 'org/repo', promptFile }];

    const newTasks = reconcileCronJobs({
      oldTasks,
      oldCron,
      nextCron,
      db,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
      handleCronFire: () => {},
    });

    expect(newTasks).toHaveLength(1);
    // Verify via DB that state is still paused
    const state = db.getCronState('job1');
    expect(state).not.toBeNull();
    expect(state!.paused).toBe(true);
    for (const t of newTasks) t.stop();
  });
});

describe('config hot-reload: reject invalid config (Req 1.2)', () => {
  it('watchConfig calls onError for invalid config and does not call onReload', async () => {
    let reloadCalled = false;
    let errorMsg: string | null = null;

    const watcher = watchConfig(configPath, () => {
      reloadCalled = true;
    }, (err) => {
      errorMsg = err.message;
    }, { debounceMs: 50 });

    try {
      // Write invalid config
      fs.writeFileSync(configPath, '{ invalid json }}}');
      await new Promise((r) => setTimeout(r, 150));

      expect(reloadCalled).toBe(false);
      expect(errorMsg).not.toBeNull();
    } finally {
      watcher.close();
    }
  });

  it('watchConfig calls onError for config that fails validation', async () => {
    let reloadCalled = false;
    let errorMsg: string | null = null;

    const watcher = watchConfig(configPath, () => {
      reloadCalled = true;
    }, (err) => {
      errorMsg = err.message;
    }, { debounceMs: 50 });

    try {
      // Write config missing required fields
      fs.writeFileSync(configPath, JSON.stringify({ port: 'not-a-number' }));
      await new Promise((r) => setTimeout(r, 150));

      expect(reloadCalled).toBe(false);
      expect(errorMsg).not.toBeNull();
    } finally {
      watcher.close();
    }
  });
});

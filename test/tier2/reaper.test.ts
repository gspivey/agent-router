/**
 * Tier 2 tests: Session reaper integration — full daemon lifecycle with fake backends.
 * Spec: .kiro/specs/session-reaper/ tasks 7.1–7.6
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionFiles } from '../../src/session-files.js';
import type { SessionFiles, SessionMeta } from '../../src/session-files.js';
import { createSessionManager } from '../../src/session-mgr.js';
import type { SessionManager } from '../../src/session-mgr.js';
import { createReaper } from '../../src/reaper.js';
import type { Reaper, ReaperConfig } from '../../src/reaper.js';
import { initDatabase } from '../../src/db.js';
import type { Database } from '../../src/db.js';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { spawnACPClient } from '../../src/acp.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let rootDir: string;
let agentRunsDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let reaper: Reaper;

function setupEnv(): void {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-tier2-'));
  agentRunsDir = path.join(rootDir, 'agent-runs');
  fs.mkdirSync(agentRunsDir);
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
}

async function setupKiro(): Promise<void> {
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
}

function createMgr(reaperInst?: Reaper): SessionManager {
  const mgrDeps: Parameters<typeof createSessionManager>[0] = {
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
  };
  if (reaperInst !== undefined) {
    (mgrDeps as Record<string, unknown>)['reaper'] = reaperInst;
  }
  return createSessionManager(mgrDeps);
}

describe('session reaper integration', () => {
  beforeEach(async () => {
    setupEnv();
    await setupKiro();
  });

  afterEach(async () => {
    if (reaper) reaper.shutdown();
    if (mgr) await mgr.shutdown();
    if (db) await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('event-driven: reaps worktree after grace period (task 7.1)', async () => {
    const config: ReaperConfig = {
      enabled: true,
      gracePeriodMinutes: 0, // immediate for test
      retentionDays: 30,
      agentRunsDir,
      sweepIntervalMinutes: 9999, // disable periodic sweep
    };

    reaper = createReaper({
      config,
      sessionFiles: sf,
      isActive: (id) => mgr.getActiveSession(id) !== null,
      log,
    });

    mgr = createMgr(reaper);

    // Create session
    const handle = await mgr.createSession('test reaper');

    // Register a worktree
    const wtPath = path.join(agentRunsDir, '20260101-120000-myrepo');
    fs.mkdirSync(wtPath);
    fs.writeFileSync(path.join(wtPath, 'file.txt'), 'content');
    sf.updateMeta(handle.sessionId, { worktree_path: wtPath });

    // Terminate session (marks terminal and notifies reaper)
    await mgr.terminateSession(handle.sessionId, 'killed_by_operator');

    // Wait for grace timer (0 min = immediate setTimeout)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Worktree should be deleted
    expect(fs.existsSync(wtPath)).toBe(false);

    // Meta should have worktree_reaped_at
    const meta = sf.readMeta(handle.sessionId);
    expect(meta.worktree_reaped_at).toBeDefined();
    expect(meta.terminal_at).toBeDefined();
  });

  it('active session protection (task 7.2)', async () => {
    const config: ReaperConfig = {
      enabled: true,
      gracePeriodMinutes: 0,
      retentionDays: 30,
      agentRunsDir,
      sweepIntervalMinutes: 9999,
    };

    mgr = createMgr();

    // Create two sessions
    const handle1 = await mgr.createSession('session 1');
    const handle2 = await mgr.createSession('session 2');

    // Register worktrees for both
    const wt1 = path.join(agentRunsDir, 'wt1');
    const wt2 = path.join(agentRunsDir, 'wt2');
    fs.mkdirSync(wt1);
    fs.mkdirSync(wt2);
    sf.updateMeta(handle1.sessionId, { worktree_path: wt1 });
    sf.updateMeta(handle2.sessionId, { worktree_path: wt2 });

    // Terminate only session 1
    await mgr.terminateSession(handle1.sessionId, 'killed_by_operator');

    // Now create reaper and run sweep
    reaper = createReaper({
      config,
      sessionFiles: sf,
      isActive: (id) => mgr.getActiveSession(id) !== null,
      log,
      now: () => Date.now() + 7200000, // Far future for grace period
    });
    reaper.start();

    // Only session 1's worktree should be deleted
    expect(fs.existsSync(wt1)).toBe(false);
    // Session 2 is still active — worktree must be preserved
    expect(fs.existsSync(wt2)).toBe(true);
  });

  it('metadata sweep removes old session directories (task 7.3)', async () => {
    const config: ReaperConfig = {
      enabled: true,
      gracePeriodMinutes: 0,
      retentionDays: 1, // 1 day
      agentRunsDir,
      sweepIntervalMinutes: 9999,
    };

    // Create a session directly (without ACP) and mark it terminal
    sf.createSession('old-session', 'old prompt');
    sf.updateMeta('old-session', {
      status: 'completed',
      completed_at: 100,
      termination_reason: 'completed',
      terminal_at: 100,
      worktree_reaped_at: 200,
    });

    // Set now far enough that retention is exceeded (> 1 day after terminal_at=100)
    const farFutureMs = (100 + 2 * 86400) * 1000;

    mgr = createMgr();
    reaper = createReaper({
      config,
      sessionFiles: sf,
      isActive: () => false,
      log,
      now: () => farFutureMs,
    });
    reaper.start();

    // Session metadata dir should be removed
    expect(sf.sessionExists('old-session')).toBe(false);
  });

  it('handles missing worktree on disk gracefully (task 7.4)', async () => {
    const config: ReaperConfig = {
      enabled: true,
      gracePeriodMinutes: 0,
      retentionDays: 30,
      agentRunsDir,
      sweepIntervalMinutes: 9999,
    };

    mgr = createMgr();
    const handle = await mgr.createSession('test');

    // Register a worktree path that doesn't exist on disk
    sf.updateMeta(handle.sessionId, { worktree_path: path.join(agentRunsDir, 'nonexistent') });

    // Terminate
    await mgr.terminateSession(handle.sessionId, 'killed_by_operator');

    reaper = createReaper({
      config,
      sessionFiles: sf,
      isActive: () => false,
      log,
    });

    // This should not throw
    reaper.onSessionTerminal(handle.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // No crash — test passes
  });

  it('does nothing when reaper is disabled (task 7.5)', async () => {
    const config: ReaperConfig = {
      enabled: false,
      gracePeriodMinutes: 0,
      retentionDays: 0,
      agentRunsDir,
      sweepIntervalMinutes: 1,
    };

    mgr = createMgr();
    const handle = await mgr.createSession('test');

    const wtPath = path.join(agentRunsDir, 'should-survive');
    fs.mkdirSync(wtPath);
    sf.updateMeta(handle.sessionId, { worktree_path: wtPath });

    await mgr.terminateSession(handle.sessionId, 'killed_by_operator');

    reaper = createReaper({
      config,
      sessionFiles: sf,
      isActive: () => false,
      log,
      now: () => Date.now() + 100000000,
    });

    // onSessionTerminal should do nothing when disabled
    reaper.onSessionTerminal(handle.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it('startup backfill discovers worktree paths (task 8.4)', async () => {
    // Create a terminal session without worktree_path
    sf.createSession('legacy-session', 'legacy prompt');
    const createdAt = Math.floor(Date.now() / 1000);
    sf.updateMeta('legacy-session', {
      repo: 'org/myrepo',
      status: 'completed',
      completed_at: createdAt + 100,
      termination_reason: 'completed',
      terminal_at: createdAt + 100,
    });

    // Re-write created_at to known value (read-update-write)
    const paths = sf.getSessionPaths('legacy-session');
    const raw = JSON.parse(fs.readFileSync(paths.meta, 'utf-8'));
    raw.created_at = createdAt;
    fs.writeFileSync(paths.meta, JSON.stringify(raw, null, 2) + '\n');

    // Create a matching directory in agentRunsDir
    const d = new Date(createdAt * 1000);
    const y = d.getUTCFullYear().toString();
    const mo = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = d.getUTCDate().toString().padStart(2, '0');
    const h = d.getUTCHours().toString().padStart(2, '0');
    const mi = d.getUTCMinutes().toString().padStart(2, '0');
    const s = d.getUTCSeconds().toString().padStart(2, '0');
    const dirName = `${y}${mo}${day}-${h}${mi}${s}-myrepo`;
    const wtPath = path.join(agentRunsDir, dirName);
    fs.mkdirSync(wtPath);

    mgr = createMgr();
    reaper = createReaper({
      config: {
        enabled: true,
        gracePeriodMinutes: 9999,
        retentionDays: 30,
        agentRunsDir,
        sweepIntervalMinutes: 9999,
      },
      sessionFiles: sf,
      isActive: () => false,
      log,
    });
    reaper.start(); // triggers backfill

    // Read meta and verify worktree_path was discovered
    const meta = sf.readMeta('legacy-session');
    expect(meta.worktree_path).toBe(wtPath);
  });
});

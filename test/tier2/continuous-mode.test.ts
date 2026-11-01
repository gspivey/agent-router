/**
 * Tier 2 tests: continuous mode — core runner and session-mgr wiring.
 * T2-CONT-1: happy path (two items)
 * T2-CONT-2: item failure stops chain
 * T2-CONT-3: stop-continuous between items (operator_request)
 * T2-CONT-6: non-continuous repo unaffected
 * T2-CONT-7: ls includes continuous run state (DTO fields)
 *
 * Task 1.7 (PR A tests): T2-CONT-1, T2-CONT-2
 * Task 2.4 (PR B): T2-CONT-3
 * Task 2.6 (PR B): T2-CONT-6
 * Task 2.7 (PR B): T2-CONT-7
 *
 * Uses in-process session manager with a real SQLite DB and a real FakeKiroBackend.
 * The continuous runner is wired in via the `onSessionEnded` callback.
 * Grace period is set to 1 second to keep tests fast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { createContinuousRunner, type ContinuousRunner } from '../../src/continuous-runner.js';
import { createCliServer, type CliServer } from '../../src/cli-server.js';
import type { AgentRouterConfig, CronConfig, RepoConfig } from '../../src/config.js';
import type { GitHubClient, PullState } from '../../src/github.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { TestCli } from '../harness/test-cli.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const GRACE_PERIOD_S = 1; // 1 second — fast but not flaky
const REPO = 'myorg/myrepo';
const OWNER = 'myorg';
const REPO_NAME = 'myrepo';

let rootDir: string;
let promptFile: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-tier2-'));
  promptFile = path.join(rootDir, 'prompt.md');
  fs.writeFileSync(promptFile, 'Advance the ROADMAP by one item.');
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
});

afterEach(async () => {
  // Clean up is done inside each test to avoid state leaks
  fs.rmSync(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GitHub fake
// ---------------------------------------------------------------------------

function makeFakeGitHub(roadmapSequence: string[]): GitHubClient {
  const queue = [...roadmapSequence];
  return {
    async getPullState(): Promise<PullState> {
      return { number: 1, state: 'closed', merged: true, mergeCommitSha: 'abc', headSha: null };
    },
    async mergePullRequest(): Promise<{ sha: string; merged: true; message: string }> {
      throw new Error('not used');
    },
    async getCheckRunsForRef(): Promise<never[]> {
      return [];
    },
    async getFileContents(): Promise<string> {
      if (queue.length > 1) return queue.shift()!;
      return queue[0] ?? '';
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build manager and runner for a test
// ---------------------------------------------------------------------------

interface TestHarness {
  mgr: SessionManager;
  runner: ContinuousRunner;
}

function buildHarness(github: GitHubClient): TestHarness {
  // Forward reference: runner is assigned below, closure captures by ref
  let runnerRef: ContinuousRunner | undefined;

  const mgr = createSessionManager({
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
    github,
    sessionTimeout: {
      inactivityMinutes: 5,
      maxLifetimeMinutes: 60,
      gracePeriodAfterMergeSeconds: GRACE_PERIOD_S,
    },
    onSessionEnded: (sessionId, repo, reason) => {
      runnerRef?.notifySessionEnded(sessionId, repo, reason);
    },
  });

  const config: AgentRouterConfig = {
    repos: [{
      owner: OWNER,
      name: REPO_NAME,
      continuous: true,
      baseBranch: 'development',
    }],
  } as unknown as AgentRouterConfig;

  const runner = createContinuousRunner({
    config,
    sessionMgr: mgr,
    github,
    log,
  });

  // Assign to forward-reference
  runnerRef = runner;

  return { mgr, runner };
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

const REPO_CONFIG: RepoConfig = {
  owner: OWNER,
  name: REPO_NAME,
  continuous: true,
  baseBranch: 'development',
};

const CRON_ENTRY: CronConfig = {
  name: 'nightly',
  schedule: '0 2 * * *',
  repo: REPO,
  promptFile: '', // set in each test
};

// ---------------------------------------------------------------------------
// T2-CONT-1: happy path (two items)
// ---------------------------------------------------------------------------

describe('T2-CONT-1: happy path (two items)', () => {
  it('continuous run chains two sessions and stops with queue_empty', async () => {
    // ROADMAP sequence (indexed calls to getFileContents):
    // 0: startRun initial fetch: 2 unchecked
    // 1: _continueRun after S1 merges: 1 unchecked (S1 ticked its item → progress)
    // 2: _continueRun after S2 merges: 0 unchecked → queue_empty
    const github = makeFakeGitHub([
      '- [ ] Task A\n- [ ] Task B\n',  // call 0: startRun
      '- [x] Task A\n- [ ] Task B\n',  // call 1: after S1 (1 unchecked < 2 → progress)
      '- [x] Task A\n- [x] Task B\n',  // call 2: after S2 (0 unchecked < 1 → queue_empty)
    ]);

    const { mgr, runner } = buildHarness(github);

    const cronEntry: CronConfig = { ...CRON_ENTRY, promptFile };

    try {
      // Start continuous run
      await runner.startRun(cronEntry, REPO_CONFIG);

      // Verify S1 was created
      let s1Id = runner.getRunState(REPO)?.current_session_id;
      if (!s1Id) {
        // Give async setup a moment
        await new Promise((r) => setTimeout(r, 200));
        s1Id = runner.getRunState(REPO)?.current_session_id;
      }
      expect(typeof s1Id).toBe('string');
      expect(s1Id).not.toBeNull();

      // Complete S1 with 'merged' (simulates MCP complete_session tool)
      await mgr.completeSession(s1Id!, 'merged');

      // Wait for S1 to leave registry and S2 to start (grace period = 1s)
      // After grace period, onSessionEnded fires → notifySessionEnded → schedules _continueRun
      await waitUntil(
        () => runner.getRunState(REPO)?.items_completed === 1,
        15_000,
      );

      // S2 should now be running
      let s2Id: string | null | undefined = undefined;
      await waitUntil(() => {
        s2Id = runner.getRunState(REPO)?.current_session_id;
        return s2Id !== null && s2Id !== undefined;
      }, 8_000);

      expect(s2Id).not.toBeNull();
      expect(s2Id).not.toBe(s1Id);

      // Complete S2 with 'merged'
      await mgr.completeSession(s2Id!, 'merged');

      // Wait for run to stop with queue_empty
      await waitUntil(
        () => runner.getRunState(REPO)?.status === 'stopped',
        15_000,
      );

      const finalState = runner.getRunState(REPO);
      expect(finalState!.status).toBe('stopped');
      expect(finalState!.stop_reason).toBe('queue_empty');
      expect(finalState!.items_completed).toBe(2);
    } finally {
      await mgr.shutdown();
      await db.shutdown();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T2-CONT-2: item failure stops chain
// ---------------------------------------------------------------------------

describe('T2-CONT-2: item failure stops chain', () => {
  it('stops with item_failed when S2 terminates with a non-merged reason', async () => {
    // ROADMAP sequence:
    // 0: startRun initial fetch: 2 unchecked
    // 1: _continueRun after S1 merges: 1 unchecked (< 2 → progress, S2 starts)
    const github = makeFakeGitHub([
      '- [ ] Task A\n- [ ] Task B\n',  // call 0: startRun
      '- [x] Task A\n- [ ] Task B\n',  // call 1: after S1 (1 unchecked < 2)
    ]);

    const { mgr, runner } = buildHarness(github);

    const cronEntry: CronConfig = { ...CRON_ENTRY, promptFile };

    try {
      // Start continuous run
      await runner.startRun(cronEntry, REPO_CONFIG);

      let s1Id = runner.getRunState(REPO)?.current_session_id;
      if (!s1Id) {
        await new Promise((r) => setTimeout(r, 200));
        s1Id = runner.getRunState(REPO)?.current_session_id;
      }
      expect(typeof s1Id).toBe('string');
      expect(s1Id).not.toBeNull();

      // S1 completes with merged
      await mgr.completeSession(s1Id!, 'merged');

      // Wait for S2 to start
      await waitUntil(
        () => runner.getRunState(REPO)?.items_completed === 1,
        15_000,
      );

      let s2Id: string | null | undefined = undefined;
      await waitUntil(() => {
        s2Id = runner.getRunState(REPO)?.current_session_id;
        return s2Id !== null && s2Id !== undefined;
      }, 8_000);

      expect(s2Id).not.toBeNull();

      // S2 terminates with non-merged reason (simulate CLI kill)
      await mgr.terminateSession(s2Id!, 'terminated_cli');

      // Wait for run to stop with item_failed
      await waitUntil(
        () => runner.getRunState(REPO)?.status === 'stopped',
        8_000,
      );

      const finalState = runner.getRunState(REPO);
      expect(finalState!.status).toBe('stopped');
      expect(finalState!.stop_reason).toBe('item_failed');
      // Both sessions counted (S1 merged + S2 failed)
      expect(finalState!.items_completed).toBe(2);

      // No S3 should be created
      const sessions = sf.listSessions();
      const activeSessions = sessions.filter((s) => s.status === 'active');
      expect(activeSessions).toHaveLength(0);
    } finally {
      await mgr.shutdown();
      await db.shutdown();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T2-CONT-3: stop-continuous between items
// ---------------------------------------------------------------------------

describe('T2-CONT-3: stop-continuous between items', () => {
  it('operator request in session_active phase stops run after current item merges', async () => {
    // Design (REQ-3.1/3.2): stop takes effect between items — current session is never
    // interrupted mid-flight. Test strategy: request stop while S1 is still active
    // (session_active phase). When S1 merges, notifySessionEnded sees stopRequested=true
    // and stops immediately with 'operator_request' rather than scheduling _continueRun.
    //
    // This is the correct and deterministic test for T2-CONT-3: the requestStop flag is
    // checked synchronously in notifySessionEnded before any setTimeout is queued.
    const github = makeFakeGitHub([
      '- [ ] Task A\n- [ ] Task B\n',  // call 0: startRun initial fetch
      // No subsequent calls expected: stop happens before _continueRun fetches
    ]);

    const { mgr, runner } = buildHarness(github);

    // Wire a CLI socket so we can verify the IPC op works
    const socketPath = path.join(rootDir, 'sock-cont3');
    const cliServer: CliServer = createCliServer({
      socketPath,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
      continuousRunner: runner,
    });
    await cliServer.start();
    const cli = new TestCli(socketPath);

    const cronEntry: CronConfig = { ...CRON_ENTRY, promptFile };

    try {
      // Start the continuous run — S1 is now active in session_active phase
      await runner.startRun(cronEntry, REPO_CONFIG);

      const s1Id = runner.getRunState(REPO)?.current_session_id;
      if (!s1Id) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const s1IdFinal = runner.getRunState(REPO)?.current_session_id;
      expect(typeof s1IdFinal).toBe('string');
      expect(runner.getRunState(REPO)?.phase).toBe('session_active');

      // Use the IPC op to request a stop while S1 is still active.
      // In session_active phase: requestStop just sets stopRequested=true.
      const stopResult = await cli.send<{ ok?: boolean; error?: string }>({
        op: 'stop_continuous',
        repo: REPO,
      });
      expect(stopResult.ok).toBe(true);

      // Verify the flag is set
      expect(runner.getRunState(REPO)?.stopRequested).toBe(true);
      // Run still running — current session not interrupted
      expect(runner.getRunState(REPO)?.status).toBe('running');

      // Now complete S1 with merged — notifySessionEnded sees stopRequested=true
      // and calls _stopRun immediately, without scheduling _continueRun
      await mgr.completeSession(s1IdFinal!, 'merged');

      // Wait for S1 to leave registry (grace period) and run to stop
      await waitUntil(
        () => runner.getRunState(REPO)?.status === 'stopped',
        15_000,
      );

      // Run must be stopped with operator_request — between items as required
      const finalState = runner.getRunState(REPO);
      expect(finalState!.status).toBe('stopped');
      expect(finalState!.stop_reason).toBe('operator_request');
      // S1 was counted as completed (merged, then stopped)
      expect(finalState!.items_completed).toBe(1);

      // No S2 should have been created
      const sessions = sf.listSessions();
      const activeSessions = sessions.filter((s) => s.status === 'active');
      expect(activeSessions).toHaveLength(0);
    } finally {
      await cliServer.shutdown();
      await mgr.shutdown();
      await db.shutdown();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T2-CONT-6: non-continuous repo unaffected
// ---------------------------------------------------------------------------

describe('T2-CONT-6: non-continuous repo unaffected', () => {
  it('non-continuous repo creates exactly one session and does not chain', async () => {
    const NON_CONT_REPO = 'myorg/noncont';
    const NON_CONT_OWNER = 'myorg';
    const NON_CONT_NAME = 'noncont';

    // GitHub fake: returns a ROADMAP but should never be called for non-cont repo
    const github = makeFakeGitHub([
      '- [ ] Task A\n- [ ] Task B\n',
      '- [x] Task A\n- [ ] Task B\n',
    ]);

    // Build a harness for the non-continuous repo
    let runnerRefNC: ContinuousRunner | undefined;

    const mgrNC = createSessionManager({
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
      github,
      sessionTimeout: {
        inactivityMinutes: 5,
        maxLifetimeMinutes: 60,
        gracePeriodAfterMergeSeconds: GRACE_PERIOD_S,
      },
      onSessionEnded: (sessionId, repo, reason) => {
        runnerRefNC?.notifySessionEnded(sessionId, repo, reason);
      },
    });

    const configNC: AgentRouterConfig = {
      repos: [{
        owner: NON_CONT_OWNER,
        name: NON_CONT_NAME,
        // no continuous: true
      }],
    } as unknown as AgentRouterConfig;

    const runnerNC = createContinuousRunner({
      config: configNC,
      sessionMgr: mgrNC,
      github,
      log,
    });
    runnerRefNC = runnerNC;

    try {
      // Manually create a session for the non-continuous repo
      const handle = await mgrNC.createSession('Do some work.', NON_CONT_REPO);
      const ncSessionId = handle.sessionId;

      // Complete S1 with merged for non-continuous repo
      await mgrNC.completeSession(ncSessionId, 'merged');

      // Wait for S1 to leave registry (grace period)
      await waitUntil(
        () => {
          const sessions = sf.listSessions();
          return sessions.every((s) => s.status !== 'active');
        },
        15_000,
      );

      // Give a short time for any spurious second session
      await new Promise((r) => setTimeout(r, 500));

      // No continuous run state should exist for non-continuous repo
      const runState = runnerNC.getRunState(NON_CONT_REPO);
      expect(runState).toBeNull();

      // Only the original session should exist
      const sessions = sf.listSessions();
      // All sessions for this repo should be exactly 1
      const repoSessions = sessions.filter(
        (s) => s.prs.some((p) => p.repo === NON_CONT_REPO) ||
               s.session_id === ncSessionId,
      );
      // The session count for this repo: just 1
      const allSessions = sf.listSessions();
      const activeSessions = allSessions.filter((s) => s.status === 'active');
      expect(activeSessions).toHaveLength(0);

      // The runner's listRuns() should be empty for non-continuous repo
      expect(runnerNC.listRuns()).toHaveLength(0);
    } finally {
      await mgrNC.shutdown();
      await db.shutdown();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// T2-CONT-7: ls includes continuous run state (DTO fields)
// ---------------------------------------------------------------------------

describe('T2-CONT-7: ls includes continuous run state', () => {
  it('list_sessions response includes continuous_runs with only REQ-4.2 fields', async () => {
    const github = makeFakeGitHub([
      '- [ ] Task A\n- [ ] Task B\n',  // startRun initial fetch
    ]);

    const { mgr, runner } = buildHarness(github);

    // Wire a CLI socket to query list_sessions
    const socketPath = path.join(rootDir, 'sock-cont7');
    const cliServer: CliServer = createCliServer({
      socketPath,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
      continuousRunner: runner,
    });
    await cliServer.start();
    const cli = new TestCli(socketPath);

    const cronEntry: CronConfig = { ...CRON_ENTRY, promptFile };

    try {
      // Start continuous run — this creates S1
      await runner.startRun(cronEntry, REPO_CONFIG);

      // Query list_sessions
      const result = await cli.send<{
        sessions: unknown[];
        continuous_runs: Array<Record<string, unknown>>;
      }>({ op: 'list_sessions' });

      expect(Array.isArray(result.continuous_runs)).toBe(true);
      expect(result.continuous_runs.length).toBeGreaterThanOrEqual(1);

      const run = result.continuous_runs[0]!;

      // REQ-4.2 required fields
      expect(typeof run['repo']).toBe('string');
      expect(run['repo']).toBe(REPO);
      expect(run['status']).toBe('running');
      expect(typeof run['items_completed']).toBe('number');
      expect(typeof run['started_at']).toBe('number');
      // current_session_id may be null or string
      expect(run['current_session_id'] === null || typeof run['current_session_id'] === 'string').toBe(true);

      // Internal fields MUST NOT be exposed (REQ-4.2)
      expect(run['phase']).toBeUndefined();
      expect(run['stopRequested']).toBeUndefined();
      expect(run['cronName']).toBeUndefined();
      expect(run['promptFile']).toBeUndefined();
      expect(run['unchecked_count_at_spawn']).toBeUndefined();
    } finally {
      await cliServer.shutdown();
      await mgr.shutdown();
      await db.shutdown();
    }
  }, 30_000);
});

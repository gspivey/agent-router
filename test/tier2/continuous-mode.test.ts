/**
 * Tier 2 tests: continuous mode — core runner and session-mgr wiring.
 * T2-CONT-1: happy path (two items)
 * T2-CONT-2: item failure stops chain
 *
 * Task 1.7 (PR A tests)
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
import type { AgentRouterConfig, CronConfig, RepoConfig } from '../../src/config.js';
import type { GitHubClient, PullState } from '../../src/github.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

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

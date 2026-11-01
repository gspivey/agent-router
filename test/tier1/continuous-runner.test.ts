/**
 * Tier 1 tests: ContinuousRunner unit tests.
 * Task 1.6 (runner portion)
 *
 * Uses minimal stubs for SessionManager, GitHubClient, and Logger.
 * Uses vitest fake timers to control setTimeout(0) calls deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createContinuousRunner } from '../../src/continuous-runner.js';
import type { ContinuousRunner } from '../../src/continuous-runner.js';
import type { SessionManager } from '../../src/session-mgr.js';
import type { GitHubClient } from '../../src/github.js';
import type { Logger } from '../../src/log.js';
import type { AgentRouterConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  const log: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
  return log;
}

function makeGitHub(roadmapContent: string | Error = '- [ ] Task A\n- [ ] Task B\n'): GitHubClient {
  return {
    getPullState: vi.fn().mockRejectedValue(new Error('not used')),
    mergePullRequest: vi.fn().mockRejectedValue(new Error('not used')),
    getCheckRunsForRef: vi.fn().mockResolvedValue([]),
    getFileContents: vi.fn().mockImplementation(async () => {
      if (roadmapContent instanceof Error) throw roadmapContent;
      return roadmapContent;
    }),
  };
}

function makeSessionMgr(): SessionManager & {
  createSessionCalls: Array<{ prompt: string; repo: string }>;
  hasActiveFor: Set<string>;
} {
  const createSessionCalls: Array<{ prompt: string; repo: string }> = [];
  const hasActiveFor = new Set<string>();

  const mgr: SessionManager & { createSessionCalls: typeof createSessionCalls; hasActiveFor: typeof hasActiveFor } = {
    createSessionCalls,
    hasActiveFor,
    async createSession(prompt: string, repo?: string) {
      createSessionCalls.push({ prompt, repo: repo ?? '' });
      return { sessionId: `sess-${createSessionCalls.length}` } as import('../../src/session-mgr.js').SessionHandle;
    },
    hasActiveSessionForRepo(repo: string): boolean {
      return hasActiveFor.has(repo);
    },
    // Stub out other methods (not used by runner)
    getActiveSession: vi.fn().mockReturnValue(null),
    injectPrompt: vi.fn().mockResolvedValue(undefined),
    terminateSession: vi.fn().mockResolvedValue(undefined),
    registerPR: vi.fn().mockReturnValue(undefined),
    completeSession: vi.fn().mockResolvedValue(undefined),
    mergePR: vi.fn().mockResolvedValue(undefined),
    getSessionRepo: vi.fn().mockReturnValue(undefined),
    getSessionReadRepos: vi.fn().mockReturnValue([]),
    getWorktreePath: vi.fn().mockReturnValue(undefined),
    getActiveWorkerSessionCount: vi.fn().mockReturnValue(0),
    resumeSessions: vi.fn().mockResolvedValue({ resumed: 0, terminated: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    validateCapToken: vi.fn().mockReturnValue(false),
    setCapToken: vi.fn(),
  } as unknown as SessionManager & { createSessionCalls: typeof createSessionCalls; hasActiveFor: typeof hasActiveFor };

  return mgr;
}

function makeConfig(overrides: Partial<AgentRouterConfig['repos'][0]> = {}): AgentRouterConfig {
  return {
    repos: [{
      owner: 'myorg',
      name: 'myrepo',
      continuous: true,
      baseBranch: 'development',
      ...overrides,
    }],
  } as unknown as AgentRouterConfig;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let promptFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-runner-test-'));
  promptFile = path.join(tmpDir, 'prompt.md');
  fs.writeFileSync(promptFile, 'Advance the ROADMAP by one item.');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CRON_ENTRY = {
  name: 'nightly',
  schedule: '0 2 * * *',
  repo: 'myorg/myrepo',
  promptFile: '',
};

// ---------------------------------------------------------------------------
// startRun tests
// ---------------------------------------------------------------------------

describe('startRun', () => {
  it('creates a session and transitions to session_active phase', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    expect(mgr.createSessionCalls).toHaveLength(1);
    const state = runner.getRunState('myorg/myrepo');
    expect(state).not.toBeNull();
    expect(state!.status).toBe('running');
    expect(state!.phase).toBe('session_active');
    expect(state!.items_completed).toBe(0);
    expect(state!.current_session_id).toBe('sess-1');
  });

  it('skips a second startRun for the same repo when already running', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    // Second startRun should be skipped
    expect(mgr.createSessionCalls).toHaveLength(1);
  });

  it('stops with item_failed and re-throws when createSession throws', async () => {
    const mgr = makeSessionMgr();
    vi.spyOn(mgr, 'createSession').mockRejectedValue(new Error('spawn failed'));

    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });

    const entry = { ...CRON_ENTRY, promptFile };
    await expect(
      runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' })
    ).rejects.toThrow('spawn failed');

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.status).toBe('stopped');
    expect(state!.stop_reason).toBe('item_failed');
  });
});

// ---------------------------------------------------------------------------
// notifySessionEnded tests
// ---------------------------------------------------------------------------

describe('notifySessionEnded', () => {
  it('increments items_completed on merged notification and schedules continuation', async () => {
    const mgr = makeSessionMgr();
    // startRun initial fetch: 2 unchecked; continuation fetch: 1 unchecked (one was ticked)
    const github = makeGitHub();
    let callCount = 0;
    vi.spyOn(github, 'getFileContents').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '- [ ] Task A\n- [ ] Task B\n'; // initial: 2 unchecked
      return '- [x] Task A\n- [ ] Task B\n'; // continuation: 1 unchecked (decreased!)
    });
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    // Notify that sess-1 ended with merged
    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.items_completed).toBe(1);
    expect(state!.phase).toBe('pending');

    // Advance timers to fire the setTimeout(0)
    await vi.runAllTimersAsync();

    // A second session should have been created
    expect(mgr.createSessionCalls).toHaveLength(2);
  });

  it('stops with item_failed on non-merged termination', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'timeout_inactivity');

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.status).toBe('stopped');
    expect(state!.stop_reason).toBe('item_failed');
    expect(state!.items_completed).toBe(1);
  });

  it('still increments items_completed on non-merged termination', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'failed');
    const state = runner.getRunState('myorg/myrepo');
    expect(state!.items_completed).toBe(1);
  });

  it('is a no-op for an unknown repo', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });

    // Should not throw
    expect(() => runner.notifySessionEnded('sess-x', 'unknown/repo', 'merged')).not.toThrow();
  });

  it('is a no-op for a session_id not matching current_session_id', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    // Notify with a stale/different session ID
    runner.notifySessionEnded('stale-sess', 'myorg/myrepo', 'merged');

    // Should not increment or schedule anything
    const state = runner.getRunState('myorg/myrepo');
    expect(state!.items_completed).toBe(0);
    expect(state!.phase).toBe('session_active');
  });

  it('stops with operator_request when stopRequested is set before merged notification', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    runner.requestStop('myorg/myrepo');
    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.status).toBe('stopped');
    expect(state!.stop_reason).toBe('operator_request');
  });
});

// ---------------------------------------------------------------------------
// requestStop tests
// ---------------------------------------------------------------------------

describe('requestStop', () => {
  it('sets stopRequested flag for a running run', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });
    runner.requestStop('myorg/myrepo');

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.stopRequested).toBe(true);
  });

  it('clears pending timer and stops immediately when in pending phase', async () => {
    const mgr = makeSessionMgr();
    // Return a ROADMAP with one item ticked after start so continuation can proceed
    const github = makeGitHub('- [x] Task A\n- [ ] Task B\n');
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    // Trigger merged → pending phase (timer is queued but not yet fired)
    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');
    const stateAfterNotify = runner.getRunState('myorg/myrepo');
    expect(stateAfterNotify!.phase).toBe('pending');

    // requestStop during pending phase should clear timer and stop immediately
    runner.requestStop('myorg/myrepo');

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.status).toBe('stopped');
    expect(state!.stop_reason).toBe('operator_request');

    // Advance timers — no second session should be created
    await vi.runAllTimersAsync();
    expect(mgr.createSessionCalls).toHaveLength(1); // Only the initial session
  });

  it('throws for unknown repo', () => {
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: makeSessionMgr() as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    expect(() => runner.requestStop('nonexistent/repo')).toThrow();
  });

  it('throws when run is already stopped', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    // Stop the run by having the session fail
    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'failed');
    expect(runner.getRunState('myorg/myrepo')!.status).toBe('stopped');

    // requestStop on an already-stopped run should throw
    expect(() => runner.requestStop('myorg/myrepo')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// _continueRun: various stop conditions
// ---------------------------------------------------------------------------

describe('_continueRun internal stop conditions', () => {
  it('stops with queue_empty when ROADMAP has no unchecked items', async () => {
    const mgr = makeSessionMgr();
    // First call: 2 items unchecked (so no-progress check passes on second spawn)
    // After first session: ROADMAP is fully checked
    const github = makeGitHub();
    let callCount = 0;
    vi.spyOn(github, 'getFileContents').mockImplementation(async () => {
      callCount++;
      // startRun initial fetch: 1 unchecked; continuation fetch: 0 unchecked
      if (callCount === 1) return '- [ ] Task A\n'; // initial fetch in startRun
      if (callCount === 2) return '- [x] Task A\n'; // continuation after merged (unchecked: 0, decreased from 1)
      return '- [x] Task A\n';
    });

    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');
    await vi.runAllTimersAsync();

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.status).toBe('stopped');
    expect(state!.stop_reason).toBe('queue_empty');
  });

  it('stops with roadmap_fetch_failed on 429/5xx from GitHub', async () => {
    const mgr = makeSessionMgr();
    const github = makeGitHub();
    let callCount = 0;
    vi.spyOn(github, 'getFileContents').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '- [ ] Task A\n- [ ] Task B\n'; // initial startRun fetch
      const err = Object.assign(new Error('Rate limited'), { status: 429, body: '' });
      Object.setPrototypeOf(err, (await import('../../src/github.js')).GitHubApiError.prototype);
      throw err;
    });

    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');
    await vi.runAllTimersAsync();

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.status).toBe('stopped');
    expect(state!.stop_reason).toBe('roadmap_fetch_failed');
  });

  it('stops with item_failed on non-429/5xx GitHub error', async () => {
    const mgr = makeSessionMgr();
    const github = makeGitHub();
    let callCount = 0;
    vi.spyOn(github, 'getFileContents').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '- [ ] Task A\n- [ ] Task B\n';
      throw new Error('network error');
    });

    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');
    await vi.runAllTimersAsync();

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.status).toBe('stopped');
    expect(state!.stop_reason).toBe('item_failed');
  });

  it('stops with no_progress when unchecked count has not decreased', async () => {
    const mgr = makeSessionMgr();
    const github = makeGitHub();
    // Both calls return 2 unchecked items — the session didn't tick anything
    vi.spyOn(github, 'getFileContents').mockResolvedValue('- [ ] Task A\n- [ ] Task B\n');

    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');
    await vi.runAllTimersAsync();

    const state = runner.getRunState('myorg/myrepo');
    expect(state!.status).toBe('stopped');
    expect(state!.stop_reason).toBe('no_progress');
  });

  it('checks stopRequested after fetch and does not spawn', async () => {
    const mgr = makeSessionMgr();
    const github = makeGitHub();

    // Both fetches return the same unchecked count to trigger no_progress
    // (simulating that stopRequested is already true when _continueRun runs)
    vi.spyOn(github, 'getFileContents').mockImplementation(async () => {
      return '- [ ] Task A\n- [ ] Task B\n';
    });

    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    // Request stop while session is active (phase = session_active)
    runner.requestStop('myorg/myrepo');
    const state = runner.getRunState('myorg/myrepo');
    expect(state!.stopRequested).toBe(true);

    // Notify merged — since stopRequested is true, should stop with operator_request
    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');
    await vi.runAllTimersAsync();

    // Should not have spawned a second session
    expect(mgr.createSessionCalls).toHaveLength(1);

    const finalState = runner.getRunState('myorg/myrepo');
    expect(finalState!.status).toBe('stopped');
    expect(finalState!.stop_reason).toBe('operator_request');
  });
});

// ---------------------------------------------------------------------------
// listRuns tests
// ---------------------------------------------------------------------------

describe('listRuns', () => {
  it('returns all runs mapped to DTO (no internal fields)', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    const runs = runner.listRuns();
    expect(runs).toHaveLength(1);
    const dto = runs[0]!;

    // Should have DTO fields
    expect(dto.repo).toBe('myorg/myrepo');
    expect(dto.status).toBe('running');
    expect(dto.items_completed).toBe(0);
    expect(dto.current_session_id).toBe('sess-1');
    expect(typeof dto.started_at).toBe('number');

    // Should NOT have internal fields
    expect('phase' in dto).toBe(false);
    expect('stopRequested' in dto).toBe(false);
    expect('cronName' in dto).toBe(false);
    expect('promptFile' in dto).toBe(false);
    expect('unchecked_count_at_spawn' in dto).toBe(false);
  });

  it('returns stopped run with stop_reason and stopped_at', async () => {
    const mgr = makeSessionMgr();
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github: makeGitHub(),
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'failed');

    const runs = runner.listRuns();
    const dto = runs[0]!;
    expect(dto.status).toBe('stopped');
    expect(dto.stop_reason).toBe('item_failed');
    expect(typeof dto.stopped_at).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// shutdown tests
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  it('sets shuttingDown and clears pending timers', async () => {
    const mgr = makeSessionMgr();
    const github = makeGitHub('- [x] Task A\n- [ ] Task B\n');
    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };
    await runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });

    // Trigger pending phase
    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');
    const state = runner.getRunState('myorg/myrepo');
    expect(state!.phase).toBe('pending');

    // Shutdown before the timer fires
    await runner.shutdown();

    // After shutdown, run timers — no second session should be created
    await vi.runAllTimersAsync();
    expect(mgr.createSessionCalls).toHaveLength(1);
  });

  it('awaits in-flight continuations before returning', async () => {
    const mgr = makeSessionMgr();
    let resolveFetch!: (value: string) => void;
    const github = makeGitHub();

    vi.spyOn(github, 'getFileContents').mockImplementation(
      async (_owner, _name, _path, _ref) => new Promise<string>((resolve) => {
        resolveFetch = resolve;
      })
    );

    const runner = createContinuousRunner({
      config: makeConfig(),
      sessionMgr: mgr as unknown as SessionManager,
      github,
      log: makeLogger(),
    });
    const entry = { ...CRON_ENTRY, promptFile };

    // startRun calls getFileContents too — resolve that immediately
    let initialResolved = false;
    const startPromise = runner.startRun(entry, { owner: 'myorg', name: 'myrepo', baseBranch: 'development' });
    if (resolveFetch) {
      resolveFetch('- [ ] Task A\n');
      initialResolved = true;
    }
    await startPromise;

    // Trigger continuation
    runner.notifySessionEnded('sess-1', 'myorg/myrepo', 'merged');
    await vi.runAllTimersAsync(); // fires the setTimeout(0), starts _continueRun

    // _continueRun is now awaiting getFileContents — shutdown should wait for it
    let shutdownDone = false;
    const shutdownPromise = runner.shutdown().then(() => { shutdownDone = true; });

    // Not yet done (fetch is pending)
    await Promise.resolve();
    expect(shutdownDone).toBe(false);

    // Resolve the fetch — the continuation should complete and shutdown should resolve
    resolveFetch('- [x] Task A\n- [ ] Task B\n');
    await shutdownPromise;
    expect(shutdownDone).toBe(true);
  });
});

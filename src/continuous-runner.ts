/**
 * Continuous mode runner.
 *
 * When a repo has `continuous: true` in its config, cron fires initiate a
 * _continuous run_ instead of a single one-shot session. After each merged
 * session leaves the registry, the runner fetches the ROADMAP, picks the next
 * unchecked item, and spawns a fresh session — eliminating idle gaps between
 * cron ticks.
 *
 * Spec: .kiro/specs/continuous-mode/ · tasks 1.3
 */

import * as fs from 'node:fs';
import type { Logger } from './log.js';
import type { AgentRouterConfig, CronConfig, RepoConfig } from './config.js';
import type { SessionManager } from './session-mgr.js';
import type { GitHubClient } from './github.js';
import { GitHubApiError } from './github.js';
import { parseRoadmap, findNextTask } from './roadmap.js';
import { composeCronPrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ContinuousRunStopReason =
  | 'operator_request'
  | 'queue_empty'
  | 'item_failed'
  | 'no_progress'
  | 'roadmap_fetch_failed';

/** Internal phase tracking for race-condition-safe stop handling. */
export type ContinuousRunPhase =
  | 'session_active'  // A session is running
  | 'pending'         // setTimeout(0) queued, waiting to fire
  | 'fetching'        // Awaiting GitHub ROADMAP fetch
  | 'spawning';       // Awaiting createSession

export interface ContinuousRunState {
  repo: string;
  cronName: string;
  promptFile: string;
  status: 'running' | 'stopped';
  phase: ContinuousRunPhase;
  stop_reason?: ContinuousRunStopReason;
  /** Set by requestStop; checked throughout _continueRun. */
  stopRequested: boolean;
  items_completed: number;
  current_session_id: string | null;
  /** Number of unchecked items when current session started, for no-progress detection. */
  unchecked_count_at_spawn: number;
  started_at: number;   // Unix seconds
  stopped_at?: number;  // Unix seconds, set on stop
}

/** DTO returned by listRuns() — only REQ-4.2 fields, no internal tracking state. */
export interface ContinuousRunDTO {
  repo: string;
  status: 'running' | 'stopped';
  stop_reason?: ContinuousRunStopReason;
  items_completed: number;
  current_session_id: string | null;
  started_at: number;
  stopped_at?: number;
}

export interface ContinuousRunner {
  /** Called by cron handler to initiate a new run. Async to handle createSession failures. */
  startRun(cronEntry: CronConfig, repoConfig: RepoConfig): Promise<void>;
  /** Called by session-mgr when a session leaves the registry. */
  notifySessionEnded(sessionId: string, repo: string | undefined, reason: string): void;
  /** Request a graceful stop after the current item. */
  requestStop(repo: string): void;
  /** Returns the run state for a repo, or null if no run is active or recorded. */
  getRunState(repo: string): ContinuousRunState | null;
  /** All known runs (active and recently stopped), mapped to DTO for CLI output. */
  listRuns(): ContinuousRunDTO[];
  /** Called during daemon shutdown. Async to wait for in-flight continuations. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ContinuousRunnerDeps {
  config: AgentRouterConfig;
  sessionMgr: SessionManager;
  github: GitHubClient;
  log: Logger;
}

export function createContinuousRunner(deps: ContinuousRunnerDeps): ContinuousRunner {
  const { config, sessionMgr, github, log } = deps;

  const runs = new Map<string, ContinuousRunState>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlightContinuations = new Map<string, Promise<void>>();
  let shuttingDown = false;

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  function _stopRun(repo: string, stopReason: ContinuousRunStopReason): void {
    const state = runs.get(repo);
    if (state === undefined) return;
    state.status = 'stopped';
    state.stop_reason = stopReason;
    state.stopped_at = Math.floor(Date.now() / 1000);

    const logFn =
      stopReason === 'item_failed' ||
      stopReason === 'no_progress' ||
      stopReason === 'roadmap_fetch_failed'
        ? log.warn.bind(log)
        : log.info.bind(log);

    logFn('Continuous run stopped', {
      repo,
      stop_reason: stopReason,
      items_completed: state.items_completed,
    });
  }

  async function _continueRun(repo: string): Promise<void> {
    pendingTimers.delete(repo);

    const state = runs.get(repo);
    if (state === undefined) return;

    // Re-check at entry
    if (state.status !== 'running' || state.stopRequested || shuttingDown) {
      _stopRun(repo, 'operator_request');
      return;
    }

    state.phase = 'fetching';

    // Store the in-flight continuation promise for shutdown to await
    // (we reassign below, so we need a forward reference pattern)
    let resolveInFlight!: () => void;
    const inFlightPromise = new Promise<void>((resolve) => {
      resolveInFlight = resolve;
    });
    inFlightContinuations.set(repo, inFlightPromise);

    try {
      // Find the repo config for this run
      const repoConfig = config.repos.find((r) => `${r.owner}/${r.name}` === repo);
      if (repoConfig === undefined) {
        log.error('Continuous runner: repo config not found', { repo });
        _stopRun(repo, 'item_failed');
        return;
      }

      const owner = repoConfig.owner;
      const name = repoConfig.name;
      const roadmapPath = repoConfig.roadmapPath ?? 'ROADMAP.md';
      const baseBranch = repoConfig.baseBranch ?? 'development';

      // Fetch the ROADMAP from GitHub
      let roadmapContent: string;
      try {
        roadmapContent = await github.getFileContents(owner, name, roadmapPath, baseBranch);
      } catch (err: unknown) {
        const isRateLimitOrServer =
          err instanceof GitHubApiError && (err.status === 429 || err.status >= 500);
        const stopReason: ContinuousRunStopReason = isRateLimitOrServer
          ? 'roadmap_fetch_failed'
          : 'item_failed';
        log.error('Continuous runner: failed to fetch ROADMAP', {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
        _stopRun(repo, stopReason);
        return;
      }

      // Re-check after await
      if (state.stopRequested || shuttingDown) {
        _stopRun(repo, 'operator_request');
        return;
      }

      // Parse ROADMAP and count unchecked items
      const tasks = parseRoadmap(roadmapContent);
      const uncheckedCount = tasks.filter((t) => !t.checked).length;

      // No-progress check: if unchecked count hasn't decreased, the session
      // didn't tick its ROADMAP item
      if (uncheckedCount >= state.unchecked_count_at_spawn) {
        log.warn('Continuous runner: no progress detected (ROADMAP item not ticked)', {
          repo,
          unchecked_count_at_spawn: state.unchecked_count_at_spawn,
          unchecked_count_now: uncheckedCount,
        });
        _stopRun(repo, 'no_progress');
        return;
      }

      const nextTask = findNextTask(tasks);

      if (nextTask === null) {
        // Queue is empty
        _stopRun(repo, 'queue_empty');
        return;
      }

      // Re-check before spawn
      if (state.stopRequested || shuttingDown) {
        _stopRun(repo, 'operator_request');
        return;
      }

      // Collision check (NFR-3)
      if (sessionMgr.hasActiveSessionForRepo(repo)) {
        log.warn('Continuous runner: collision — active session found, stopping chain', { repo });
        _stopRun(repo, 'item_failed');
        return;
      }

      state.phase = 'spawning';
      state.unchecked_count_at_spawn = uncheckedCount;

      // Read the prompt file fresh for this cron entry
      let promptContent: string;
      try {
        promptContent = fs.readFileSync(state.promptFile, 'utf-8');
      } catch (err: unknown) {
        log.error('Continuous runner: failed to read prompt file', {
          repo,
          promptFile: state.promptFile,
          error: err instanceof Error ? err.message : String(err),
        });
        _stopRun(repo, 'item_failed');
        return;
      }

      // Spawn the next session
      try {
        const handle = await sessionMgr.createSession(
          composeCronPrompt(promptContent, repo),
          repo,
        );
        state.phase = 'session_active';
        state.current_session_id = handle.sessionId;
        log.info('Continuous runner: next session started', {
          repo,
          continuous_run_repo: repo,
          items_completed_before_this_item: state.items_completed,
          next_task: nextTask.text,
          session_id: handle.sessionId,
        });
      } catch (err: unknown) {
        log.error('Continuous runner: failed to create next session', {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
        _stopRun(repo, 'item_failed');
      }
    } finally {
      inFlightContinuations.delete(repo);
      resolveInFlight();
    }
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  const runner: ContinuousRunner = {
    async startRun(cronEntry: CronConfig, repoConfig: RepoConfig): Promise<void> {
      const repo = `${repoConfig.owner}/${repoConfig.name}`;
      const existingRun = runs.get(repo);

      // Collision guard: prevent double-start on same repo
      if (existingRun !== undefined && existingRun.status === 'running') {
        log.warn('Continuous runner: run already active for repo, skipping', {
          repo,
          cronName: cronEntry.name,
        });
        return;
      }

      // Read the prompt file
      let promptContent: string;
      try {
        promptContent = fs.readFileSync(cronEntry.promptFile, 'utf-8');
      } catch (err: unknown) {
        log.error('Continuous runner: failed to read prompt file in startRun', {
          repo,
          promptFile: cronEntry.promptFile,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Fetch ROADMAP to get initial unchecked count for no-progress detection
      const owner = repoConfig.owner;
      const name = repoConfig.name;
      const roadmapPath = repoConfig.roadmapPath ?? 'ROADMAP.md';
      const baseBranch = repoConfig.baseBranch ?? 'development';

      let initialUncheckedCount = 0;
      try {
        const roadmapContent = await github.getFileContents(owner, name, roadmapPath, baseBranch);
        const tasks = parseRoadmap(roadmapContent);
        initialUncheckedCount = tasks.filter((t) => !t.checked).length;
      } catch (err: unknown) {
        log.warn('Continuous runner: could not fetch initial ROADMAP count, using 0', {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
        // Non-fatal: we still start the run; no-progress detection may be imprecise
        initialUncheckedCount = 0;
      }

      const state: ContinuousRunState = {
        repo,
        cronName: cronEntry.name,
        promptFile: cronEntry.promptFile,
        status: 'running',
        phase: 'spawning',
        stopRequested: false,
        items_completed: 0,
        current_session_id: null,
        unchecked_count_at_spawn: initialUncheckedCount,
        started_at: Math.floor(Date.now() / 1000),
      };
      runs.set(repo, state);

      // Spawn the first session
      try {
        const handle = await sessionMgr.createSession(
          composeCronPrompt(promptContent, repo),
          repo,
        );
        state.current_session_id = handle.sessionId;
        state.phase = 'session_active';
        log.info('Continuous run started', {
          repo,
          continuous_run_repo: repo,
          items_completed_before_this_item: 0,
          cronName: cronEntry.name,
          session_id: handle.sessionId,
        });
      } catch (err: unknown) {
        log.error('Continuous runner: failed to create initial session', {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
        _stopRun(repo, 'item_failed');
        throw err;
      }
    },

    notifySessionEnded(sessionId: string, repo: string | undefined, reason: string): void {
      if (repo === undefined) return;
      const state = runs.get(repo);
      if (state === undefined || state.status !== 'running') return;

      // Only handle notifications for the current session of this run
      if (state.current_session_id !== sessionId) return;

      // Increment items_completed on every end-notification (before deciding to continue)
      state.items_completed++;
      state.current_session_id = null;

      if (reason === 'merged') {
        // Check stop conditions before scheduling continuation
        if (state.stopRequested || shuttingDown) {
          _stopRun(repo, 'operator_request');
          return;
        }

        // Schedule continuation via setTimeout(0) — ensures session is fully gone from registry first
        state.phase = 'pending';
        const timer = setTimeout(() => {
          void _continueRun(repo);
        }, 0);
        pendingTimers.set(repo, timer);
      } else {
        // Non-merged termination — stop the chain
        _stopRun(repo, 'item_failed');
      }
    },

    requestStop(repo: string): void {
      const state = runs.get(repo);
      if (state === undefined) {
        throw new Error(`No continuous run found for repo: ${repo}`);
      }
      if (state.status !== 'running') {
        throw new Error(`Continuous run for ${repo} is already stopped (reason: ${state.stop_reason ?? 'unknown'})`);
      }

      state.stopRequested = true;
      log.info('Continuous runner: stop requested', { repo });

      // Phase-aware immediate stop: if in pending phase, clear the timer and stop now
      if (state.phase === 'pending') {
        const timer = pendingTimers.get(repo);
        if (timer !== undefined) {
          clearTimeout(timer);
          pendingTimers.delete(repo);
        }
        _stopRun(repo, 'operator_request');
      }
      // For session_active, fetching, spawning: the flag is set; the next check will stop
    },

    getRunState(repo: string): ContinuousRunState | null {
      return runs.get(repo) ?? null;
    },

    listRuns(): ContinuousRunDTO[] {
      return [...runs.values()].map((state) => {
        const dto: ContinuousRunDTO = {
          repo: state.repo,
          status: state.status,
          items_completed: state.items_completed,
          current_session_id: state.current_session_id,
          started_at: state.started_at,
        };
        if (state.stop_reason !== undefined) {
          dto.stop_reason = state.stop_reason;
        }
        if (state.stopped_at !== undefined) {
          dto.stopped_at = state.stopped_at;
        }
        return dto;
      });
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;

      // Clear all pending timers
      for (const [, timer] of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();

      // Await all in-flight continuations to prevent createSession after sessionMgr.shutdown()
      await Promise.all([...inFlightContinuations.values()]);
    },
  };

  return runner;
}

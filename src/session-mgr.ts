import * as crypto from 'node:crypto';
import type { Database } from './db.js';
import type { Logger } from './log.js';
import type { SessionFiles, SessionPaths, PromptSource, StreamEntry, SessionMeta } from './session-files.js';
import type { EventQueue } from './queue.js';
import { createEventQueue } from './queue.js';
import type { ACPClient, ACPNotification } from './acp.js';
import type { SessionTimeoutConfig } from './config.js';
import { isCommentCommand, extractCommentIds } from './comment-tracker.js';
import type { GitHubClient } from './github.js';
import type { VerifySessionFn, VerifyResult } from './verify-session.js';

export interface SessionHandle {
  sessionId: string;
  repo?: string | undefined;
  paths: SessionPaths;
  acp: ACPClient;
  eventQueue: EventQueue;
  kiroPid: number;
}

/** Thrown by completeSession when one or more registered PRs are still open on GitHub. */
export class OpenPRsError extends Error {
  openPRs: Array<{ repo: string; pr_number: number }>;
  constructor(openPRs: Array<{ repo: string; pr_number: number }>) {
    super(
      `Cannot complete session: ${openPRs.length} registered PR(s) still open: ` +
        openPRs.map((p) => `${p.repo}#${p.pr_number}`).join(', '),
    );
    this.name = 'OpenPRsError';
    this.openPRs = openPRs;
  }
}

export interface MergePRResult {
  sha: string;
  message: string;
}

export interface SessionManager {
  createSession(originalPrompt: string, repo?: string): Promise<SessionHandle>;
  hasActiveSessionForRepo(repo: string): boolean;
  injectPrompt(sessionId: string, prompt: string, source: PromptSource): Promise<void>;
  registerPR(sessionId: string, repo: string, prNumber: number): Promise<void>;
  mergePR(sessionId: string, repo: string, prNumber: number): Promise<MergePRResult>;
  completeSession(sessionId: string, reason: string): Promise<void>;
  terminateSession(sessionId: string): Promise<void>;
  getActiveSession(sessionId: string): SessionHandle | null;
  shutdown(): Promise<void>;
}

/** Default session timeout configuration. */
const DEFAULT_SESSION_TIMEOUT: SessionTimeoutConfig = {
  inactivityMinutes: 5,
  maxLifetimeMinutes: 120,
  gracePeriodAfterMergeSeconds: 60,
};

// ---------------------------------------------------------------------------
// Session Registry — in-memory Map<sessionId, SessionHandle>
// ---------------------------------------------------------------------------

interface SessionRegistry {
  add(handle: SessionHandle): void;
  remove(sessionId: string): void;
  get(sessionId: string): SessionHandle | undefined;
  has(sessionId: string): boolean;
  list(): SessionHandle[];
}

function createSessionRegistry(): SessionRegistry {
  const sessions = new Map<string, SessionHandle>();

  return {
    add(handle: SessionHandle): void {
      sessions.set(handle.sessionId, handle);
    },
    remove(sessionId: string): void {
      sessions.delete(sessionId);
    },
    get(sessionId: string): SessionHandle | undefined {
      return sessions.get(sessionId);
    },
    has(sessionId: string): boolean {
      return sessions.has(sessionId);
    },
    list(): SessionHandle[] {
      return [...sessions.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// Notification → StreamEntry translation
// ---------------------------------------------------------------------------

function translateNotification(notification: ACPNotification): StreamEntry {
  const params = notification.params as Record<string, unknown> | undefined;
  const type = (params?.['type'] as string | undefined) ?? notification.method;

  const entry: StreamEntry = {
    ts: new Date().toISOString(),
    source: 'agent',
    type,
  };

  // Copy additional params fields into the entry
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (key !== 'type') {
        entry[key] = value;
      }
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// createSessionManager
// ---------------------------------------------------------------------------

export function createSessionManager(deps: {
  db: Database;
  sessionFiles: SessionFiles;
  acpSpawner: (sessionId: string) => ACPClient;
  log: Logger;
  sessionTimeout?: SessionTimeoutConfig;
  /**
   * GitHub client used by mergePR. Open-PR validation in completeSession
   * is delegated to `verify` when wired. Optional — when omitted, mergePR
   * throws.
   */
  github?: GitHubClient;
  /**
   * Verification fn that determines a session's true terminal state from
   * GitHub. When wired, completeSession defers to it instead of trusting
   * the agent-provided reason for PR-bearing sessions. Optional — when
   * omitted, completeSession falls back to writing the agent's reason
   * directly (preserves prior behavior for tests that don't exercise
   * verification).
   */
  verify?: VerifySessionFn;
}): SessionManager {
  const { db, sessionFiles, acpSpawner, log } = deps;
  const github = deps.github;
  const verify = deps.verify;
  const timeout = deps.sessionTimeout ?? DEFAULT_SESSION_TIMEOUT;
  const inactivityMs = timeout.inactivityMinutes * 60 * 1000;
  const maxLifetimeMs = timeout.maxLifetimeMinutes * 60 * 1000;
  const gracePeriodMs = timeout.gracePeriodAfterMergeSeconds * 1000;
  const registry = createSessionRegistry();

  // Track per-session inactivity timers
  const inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Track per-session max-lifetime timers
  const lifetimeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Track per-session grace period timers (set when auto-completion fires)
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Track per-session completion flags (set when complete_session MCP call is received)
  const completionFlags = new Set<string>();

  /** Clear all timers for a session. */
  function clearSessionTimers(sessionId: string): void {
    const inactTimer = inactivityTimers.get(sessionId);
    if (inactTimer !== undefined) {
      clearTimeout(inactTimer);
      inactivityTimers.delete(sessionId);
    }
    const lifeTimer = lifetimeTimers.get(sessionId);
    if (lifeTimer !== undefined) {
      clearTimeout(lifeTimer);
      lifetimeTimers.delete(sessionId);
    }
    const graceTimer = graceTimers.get(sessionId);
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimers.delete(sessionId);
    }
  }

  /** Reset the inactivity timer for a session (called on every notification). */
  function resetInactivityTimer(sessionId: string, acp: ACPClient): void {
    const existing = inactivityTimers.get(sessionId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      inactivityTimers.delete(sessionId);
      if (!registry.has(sessionId)) return;

      // Run verification first. If the agent finished its work and just
      // went idle, the verifier may transition the session to
      // completed:merged instead of failed:timeout_inactivity.
      //
      // Wrap the async work in an IIFE — setTimeout callbacks can't be async
      // (return value is ignored, and we need clean error handling).
      void (async () => {
        let verifyResult: VerifyResult | null = null;
        if (verify !== undefined) {
          try {
            verifyResult = await verify(sessionId);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Inactivity-watchdog verify threw', { sessionId, error: msg });
            // Fall through with verifyResult=null → treat as no verifier
          }
        }

        // GitHub-outage protection: if verification couldn't talk to GitHub,
        // don't write a false timeout_inactivity — give the session another
        // inactivity window. The watchdog will fire again; if GitHub is back
        // up, verification will either find a terminal state or proceed to
        // the timeout-failed path naturally.
        if (verifyResult !== null && !verifyResult.verified && verifyResult.reason === 'github_error') {
          log.warn('Inactivity watchdog: GitHub error during verify, resetting watchdog', {
            sessionId,
            error: verifyResult.error,
          });
          const stillActiveHandle = registry.get(sessionId);
          if (stillActiveHandle !== undefined) {
            resetInactivityTimer(sessionId, stillActiveHandle.acp);
          }
          return;
        }

        // If verifier wrote a terminal state, do NOT also write timeout_inactivity.
        // Just proceed to kill the subprocess.
        const verifiedTerminal: 'merged' | 'closed_without_merge' | null =
          verifyResult !== null && verifyResult.verified ? verifyResult.termination_reason : null;

        log.warn('Session exceeded inactivity timeout, terminating', {
          sessionId,
          inactivityMinutes: timeout.inactivityMinutes,
          verified_as: verifiedTerminal ?? 'timeout',
        });

        if (verifiedTerminal === null) {
          try {
            sessionFiles.updateMeta(sessionId, {
              status: 'failed',
              completed_at: Math.floor(Date.now() / 1000),
              termination_reason: 'timeout_inactivity',
            });
          } catch {
            // Meta may already be in terminal state
          }

          try {
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'timeout_inactivity',
            });
          } catch {
            // Best effort
          }
        }

        // Remove from registry before kill to prevent monitorSubprocessExit from overwriting
        registry.remove(sessionId);
        clearSessionTimers(sessionId);
        completionFlags.delete(sessionId);

        acp.kill().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Failed to kill inactivity-timed-out session', { sessionId, error: msg });
        });
      })();
    }, inactivityMs);

    inactivityTimers.set(sessionId, timer);
  }

  /**
   * Start a background notification consumer for a session.
   * Iterates over acp.notifications, translates each to a StreamEntry,
   * and writes via sessionFiles.appendStream.
   */
  function startNotificationConsumer(sessionId: string, acp: ACPClient): void {
    const consume = async (): Promise<void> => {
      try {
        for await (const notification of acp.notifications) {
          // Reset inactivity timer on every notification from the agent
          resetInactivityTimer(sessionId, acp);

          const entry = translateNotification(notification);
          try {
            sessionFiles.appendStream(sessionId, entry);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Failed to append stream entry', { sessionId, error: msg });
          }

          // Check if this is a complete_session MCP call
          if (notification.method === 'session/notification') {
            const params = notification.params as Record<string, unknown> | undefined;
            if (params?.['type'] === 'mcp_call' && params?.['tool'] === 'complete_session') {
              completionFlags.add(sessionId);
            }

            // Track outbound comments from tool call results.
            // When the agent runs a shell command that produces a GitHub comment,
            // record the comment ID so the wake policy can filter self-authored webhooks.
            if (params?.['type'] === 'tool_result' || params?.['type'] === 'tool_call_update') {
              const command = params?.['command'] as string | undefined;
              const output = params?.['output'] as string | undefined
                ?? params?.['content'] as string | undefined
                ?? params?.['stdout'] as string | undefined;

              if (typeof command === 'string' && isCommentCommand(command) && typeof output === 'string') {
                const comments = extractCommentIds(output);
                for (const parsed of comments) {
                  try {
                    const repo = parsed.repo || '';
                    const prNumber = parsed.prNumber || 0;
                    db.insertOutboundComment(parsed.commentId, sessionId, repo, prNumber);
                    log.info('Tracked outbound comment', {
                      sessionId,
                      commentId: parsed.commentId,
                      repo,
                      prNumber,
                    });
                  } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    log.warn('Failed to track outbound comment', { sessionId, error: errMsg });
                  }
                }
              }
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Notification consumer error', { sessionId, error: msg });
      }
    };

    // Fire and forget — runs in background
    consume().catch(() => {});
  }

  /**
   * Monitor subprocess exit and update meta.json accordingly.
   */
  function monitorSubprocessExit(sessionId: string, acp: ACPClient): void {
    acp.sessionEnded
      .then(() => {
        // Clear all timers
        clearSessionTimers(sessionId);

        // Only update if session is still in registry (not already terminated)
        if (!registry.has(sessionId)) {
          return;
        }

        try {
          const meta = sessionFiles.readMeta(sessionId);
          if (meta.status !== 'active') {
            // Already in terminal state
            registry.remove(sessionId);
            return;
          }

          if (completionFlags.has(sessionId)) {
            // Agent completed normally
            sessionFiles.updateMeta(sessionId, {
              status: 'completed',
              completed_at: Math.floor(Date.now() / 1000),
              termination_reason: 'completed',
            });
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'completed',
            });
            log.info('Session completed', { sessionId });
          } else {
            // Subprocess exited without completion — treat as failure
            sessionFiles.updateMeta(sessionId, {
              status: 'failed',
              completed_at: Math.floor(Date.now() / 1000),
              termination_reason: 'failed',
            });
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'failed',
            });
            log.warn('Session failed — subprocess exited without completion', { sessionId });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Failed to update meta on subprocess exit', { sessionId, error: msg });
        }

        completionFlags.delete(sessionId);
        registry.remove(sessionId);
      })
      .catch(() => {});
  }

  /**
   * Set up an absolute max-lifetime timer for a session.
   * On expiry, SIGTERM → 5s → SIGKILL regardless of activity.
   */
  function enforceMaxLifetime(sessionId: string, acp: ACPClient): void {
    const timer = setTimeout(() => {
      lifetimeTimers.delete(sessionId);
      if (!registry.has(sessionId)) return;

      log.warn('Session exceeded max lifetime, terminating', {
        sessionId,
        maxLifetimeMinutes: timeout.maxLifetimeMinutes,
      });

      // Record reason in meta before kill
      try {
        sessionFiles.updateMeta(sessionId, {
          status: 'failed',
          completed_at: Math.floor(Date.now() / 1000),
          termination_reason: 'timeout_max_lifetime',
        });
      } catch {
        // Meta may already be in terminal state
      }

      try {
        sessionFiles.appendStream(sessionId, {
          ts: new Date().toISOString(),
          source: 'router',
          type: 'session_ended',
          reason: 'timeout_max_lifetime',
        });
      } catch {
        // Best effort
      }

      // Remove from registry before kill to prevent monitorSubprocessExit from overwriting
      registry.remove(sessionId);
      clearSessionTimers(sessionId);
      completionFlags.delete(sessionId);

      acp.kill().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to kill max-lifetime session', { sessionId, error: msg });
      });
    }, maxLifetimeMs);

    lifetimeTimers.set(sessionId, timer);
  }

  const manager: SessionManager = {
    async createSession(originalPrompt: string, repo?: string): Promise<SessionHandle> {
      const sessionId = crypto.randomUUID();
      const sessionLog = log.child({ sessionId });

      // 1. Create session files on disk
      const paths = sessionFiles.createSession(sessionId, originalPrompt);
      if (repo !== undefined) {
        sessionFiles.updateMeta(sessionId, { repo });
      }
      sessionLog.info('Session files created');

      // 2. Spawn ACP client
      const acp = acpSpawner(sessionId);

      // 3. Initialize ACP handshake
      await acp.initialize();
      sessionLog.info('ACP initialized');

      // 4. Create ACP session and send initial prompt immediately
      //    Kiro exits if no prompt arrives shortly after session/new,
      //    so we pipeline both requests to prevent a gap.
      const acpSessionId = await acp.newSessionWithPrompt(process.cwd(), originalPrompt);
      sessionLog.info('ACP session created with prompt', { acpSessionId });

      // 6. Create per-session event queue + worker
      const eventQueue = createEventQueue();

      // 5. Build handle
      const handle: SessionHandle = {
        sessionId,
        repo,
        paths,
        acp,
        eventQueue,
        kiroPid: 0, // Will be set if available; subprocess PID is internal to ACPClient
      };

      // 6. Insert into registry
      registry.add(handle);

      // 7. Append session_started stream entry
      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'session_started',
        original_prompt: originalPrompt,
      });

      // 7b. Record initial prompt
      sessionFiles.appendPrompt(sessionId, 'cli', originalPrompt);
      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'prompt_injected',
        prompt_source: 'cli',
      });

      // 8. Start background notification consumer
      startNotificationConsumer(sessionId, acp);

      // 9. Monitor subprocess exit for completion/failure detection
      monitorSubprocessExit(sessionId, acp);

      // 10. Start inactivity timer and max-lifetime timer
      resetInactivityTimer(sessionId, acp);
      enforceMaxLifetime(sessionId, acp);

      sessionLog.info('Session created');
      return handle;
    },

    async injectPrompt(sessionId: string, prompt: string, source: PromptSource): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Send prompt to ACP client. The JSON-RPC response to session/prompt
      // resolving IS the protocol-level turn-end signal — there is no
      // separate streaming "turn-end" notification in the current ACP client.
      await handle.acp.sendPrompt(prompt);

      // Append to prompts.log
      sessionFiles.appendPrompt(sessionId, source, prompt);

      // Append prompt_injected stream entry
      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'prompt_injected',
        prompt_source: source,
      });

      log.info('Prompt injected', { sessionId, source });

      // ACP-fallback fast trigger: fire verification now that the agent
      // has finished processing the prompt. Fire-and-forget — single-flight
      // in the verifier handles dedup against any concurrent hook-path call
      // or complete_session MCP call.
      if (verify !== undefined) {
        void verify(sessionId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Post-sendPrompt verify failed', { sessionId, error: msg });
        });
      }
    },

    async registerPR(sessionId: string, repo: string, prNumber: number): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Insert/update session-PR mapping in DB (ignore if already exists)
      try {
        db.insertSession(repo, prNumber, sessionId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('UNIQUE constraint failed')) {
          throw err;
        }
        // Already registered — that's fine
      }

      // Read current meta and append PR entry
      const meta = sessionFiles.readMeta(sessionId);
      const existingPR = meta.prs.find(
        (pr) => pr.repo === repo && pr.pr_number === prNumber,
      );

      if (existingPR === undefined) {
        const updatedPRs = [
          ...meta.prs,
          { repo, pr_number: prNumber, registered_at: Math.floor(Date.now() / 1000) },
        ];
        sessionFiles.updateMeta(sessionId, { prs: updatedPRs });
      }

      // Append pr_registered stream entry
      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'pr_registered',
        repo,
        pr_number: prNumber,
      });

      log.info('PR registered', { sessionId, repo, prNumber });
    },

    async mergePR(sessionId: string, repo: string, prNumber: number): Promise<MergePRResult> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }
      if (github === undefined) {
        throw new Error('GitHub client not configured; cannot merge PR');
      }

      // Security: refuse to merge a PR that wasn't registered with this session.
      const meta = sessionFiles.readMeta(sessionId);
      const registered = meta.prs.some((pr) => pr.repo === repo && pr.pr_number === prNumber);
      if (!registered) {
        throw new Error(
          `PR ${repo}#${prNumber} is not registered with session ${sessionId}; ` +
            `call register_pr first`,
        );
      }

      const slash = repo.indexOf('/');
      if (slash < 1 || slash === repo.length - 1) {
        throw new Error(`Invalid repo "${repo}": expected "owner/name"`);
      }
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);

      const result = await github.mergePullRequest(owner, name, prNumber);

      sessionFiles.appendStream(sessionId, {
        ts: new Date().toISOString(),
        source: 'router',
        type: 'pr_merged',
        repo,
        pr_number: prNumber,
        sha: result.sha,
      });

      log.info('PR merged', { sessionId, repo, prNumber, sha: result.sha });

      return { sha: result.sha, message: result.message };
    },

    async completeSession(sessionId: string, reason: string): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Delegate terminal-state authority to the centralized verifier when
      // wired. The verifier queries GitHub for each registered PR and writes
      // termination_reason from real state — never from the agent's reason
      // argument. This is the structural fix for the bug class where an
      // agent could claim merge while a PR remained open.
      //
      // When no verifier is wired (tests without a GitHub client) or when
      // the verifier reports no_prs/already_verified, fall through to write
      // the agent's reason directly — that's the only signal we have.
      let verifierWroteTerminal = false;
      if (verify !== undefined) {
        const result = await verify(sessionId);
        if (result.verified) {
          verifierWroteTerminal = true;
        } else if (result.reason === 'prs_still_open') {
          throw new OpenPRsError(result.open_prs);
        } else if (result.reason === 'github_error') {
          throw new Error(`GitHub verification failed: ${result.error}`);
        }
        // no_prs / already_verified / unknown_session → fall through
      }

      // Mark completion so monitorSubprocessExit knows this was intentional
      completionFlags.add(sessionId);

      // Write terminal state from the agent's reason only if the verifier
      // didn't already write one.
      if (!verifierWroteTerminal) {
        try {
          const terminationReason = reason as NonNullable<SessionMeta['termination_reason']>;
          sessionFiles.updateMeta(sessionId, {
            status: 'completed',
            completed_at: Math.floor(Date.now() / 1000),
            termination_reason: terminationReason,
          });
        } catch {
          // Meta may already be in terminal state
        }
      }

      // Append stream entry
      try {
        sessionFiles.appendStream(sessionId, {
          ts: new Date().toISOString(),
          source: 'router',
          type: 'session_ended',
          reason,
        });
      } catch {
        // Best effort
      }

      // Suppress inactivity timer — replace with grace period timer
      const inactTimer = inactivityTimers.get(sessionId);
      if (inactTimer !== undefined) {
        clearTimeout(inactTimer);
        inactivityTimers.delete(sessionId);
      }

      log.info('Session auto-completed, starting grace period', {
        sessionId,
        reason,
        gracePeriodSeconds: timeout.gracePeriodAfterMergeSeconds,
      });

      // Start grace period timer — after it expires, kill the subprocess cleanly
      const graceTimer = setTimeout(() => {
        graceTimers.delete(sessionId);
        if (!registry.has(sessionId)) return;

        log.info('Grace period expired, terminating session', { sessionId });

        // Remove from registry before kill to prevent monitorSubprocessExit from overwriting
        registry.remove(sessionId);
        clearSessionTimers(sessionId);
        completionFlags.delete(sessionId);

        handle.acp.kill().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Failed to kill session after grace period', { sessionId, error: msg });
        });
      }, gracePeriodMs);

      graceTimers.set(sessionId, graceTimer);
    },

    async terminateSession(sessionId: string): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Clear all timers
      clearSessionTimers(sessionId);

      // Remove from registry first to prevent monitorSubprocessExit from double-updating
      registry.remove(sessionId);
      completionFlags.delete(sessionId);

      // Kill the subprocess: SIGTERM → 5s → SIGKILL
      await handle.acp.kill();

      // Update meta.json to abandoned
      try {
        sessionFiles.updateMeta(sessionId, {
          status: 'abandoned',
          completed_at: Math.floor(Date.now() / 1000),
          termination_reason: 'terminated_cli',
        });
      } catch {
        // Meta may already be in terminal state if subprocess exited concurrently
      }

      // Append session_ended stream entry
      try {
        sessionFiles.appendStream(sessionId, {
          ts: new Date().toISOString(),
          source: 'router',
          type: 'session_ended',
          reason: 'terminated_cli',
        });
      } catch {
        // Best effort
      }

      // Shutdown the per-session event queue
      await handle.eventQueue.shutdown(5);

      log.info('Session terminated', { sessionId });
    },

    getActiveSession(sessionId: string): SessionHandle | null {
      return registry.get(sessionId) ?? null;
    },

    hasActiveSessionForRepo(repo: string): boolean {
      return registry.list().some((h) => h.repo === repo);
    },

    async shutdown(): Promise<void> {
      const activeSessions = registry.list();
      log.info('Shutting down session manager', { activeCount: activeSessions.length });

      // Clear all timers
      for (const [, timer] of inactivityTimers) {
        clearTimeout(timer);
      }
      inactivityTimers.clear();
      for (const [, timer] of lifetimeTimers) {
        clearTimeout(timer);
      }
      lifetimeTimers.clear();
      for (const [, timer] of graceTimers) {
        clearTimeout(timer);
      }
      graceTimers.clear();

      // Update all active sessions to abandoned and terminate subprocesses
      const terminationPromises: Promise<void>[] = [];

      for (const handle of activeSessions) {
        const { sessionId } = handle;
        registry.remove(sessionId);
        completionFlags.delete(sessionId);

        // Update meta to abandoned
        try {
          sessionFiles.updateMeta(sessionId, {
            status: 'abandoned',
            completed_at: Math.floor(Date.now() / 1000),
            termination_reason: 'shutdown',
          });
        } catch {
          // Meta may already be in terminal state
        }

        // Kill subprocess
        terminationPromises.push(
          handle.acp.kill().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Failed to kill session during shutdown', { sessionId, error: msg });
          }),
        );

        // Shutdown per-session event queue
        terminationPromises.push(
          handle.eventQueue.shutdown(5).catch(() => {}),
        );
      }

      await Promise.all(terminationPromises);
      log.info('Session manager shutdown complete');
    },
  };

  return manager;
}

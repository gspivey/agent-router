import * as crypto from 'node:crypto';
import type { Database } from './db.js';
import type { Logger } from './log.js';
import type { SessionFiles, SessionPaths, PromptSource, StreamEntry, SessionMeta } from './session-files.js';
import type { EventQueue } from './queue.js';
import { createEventQueue } from './queue.js';
import type { ACPClient, ACPNotification } from './acp.js';
import type { SessionTimeoutConfig } from './config.js';

export interface SessionHandle {
  sessionId: string;
  paths: SessionPaths;
  acp: ACPClient;
  eventQueue: EventQueue;
  kiroPid: number;
}

export interface SessionManager {
  createSession(originalPrompt: string): Promise<SessionHandle>;
  injectPrompt(sessionId: string, prompt: string, source: PromptSource): Promise<void>;
  registerPR(sessionId: string, repo: string, prNumber: number): Promise<void>;
  completeSession(sessionId: string, reason: string): void;
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
}): SessionManager {
  const { db, sessionFiles, acpSpawner, log } = deps;
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

      log.warn('Session exceeded inactivity timeout, terminating', {
        sessionId,
        inactivityMinutes: timeout.inactivityMinutes,
      });

      // Record reason in meta before kill
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

      // Remove from registry before kill to prevent monitorSubprocessExit from overwriting
      registry.remove(sessionId);
      clearSessionTimers(sessionId);
      completionFlags.delete(sessionId);

      acp.kill().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to kill inactivity-timed-out session', { sessionId, error: msg });
      });
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
    async createSession(originalPrompt: string): Promise<SessionHandle> {
      const sessionId = crypto.randomUUID();
      const sessionLog = log.child({ sessionId });

      // 1. Create session files on disk
      const paths = sessionFiles.createSession(sessionId, originalPrompt);
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

      // Send prompt to ACP client
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

    completeSession(sessionId: string, reason: string): void {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Mark completion so monitorSubprocessExit knows this was intentional
      completionFlags.add(sessionId);

      // Update meta immediately with the provided reason
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
          termination_reason: 'terminated',
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
          reason: 'terminated',
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

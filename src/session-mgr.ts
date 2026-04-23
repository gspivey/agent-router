import * as crypto from 'node:crypto';
import type { Database } from './db.js';
import type { Logger } from './log.js';
import type { SessionFiles, SessionPaths, PromptSource, StreamEntry } from './session-files.js';
import type { EventQueue } from './queue.js';
import { createEventQueue } from './queue.js';
import type { ACPClient, ACPNotification } from './acp.js';

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
  terminateSession(sessionId: string): Promise<void>;
  getActiveSession(sessionId: string): SessionHandle | null;
  shutdown(): Promise<void>;
}

/** Maximum session duration in milliseconds (10 minutes). */
const MAX_WAKE_DURATION_MS = 10 * 60 * 1000;

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
}): SessionManager {
  const { db, sessionFiles, acpSpawner, log } = deps;
  const registry = createSessionRegistry();

  // Track per-session timeout timers so we can clear them on shutdown
  const timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Track per-session completion flags (set when complete_session MCP call is received)
  const completionFlags = new Set<string>();

  /**
   * Start a background notification consumer for a session.
   * Iterates over acp.notifications, translates each to a StreamEntry,
   * and writes via sessionFiles.appendStream.
   */
  function startNotificationConsumer(sessionId: string, acp: ACPClient): void {
    const consume = async (): Promise<void> => {
      try {
        for await (const notification of acp.notifications) {
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
        // Clear timeout timer
        const timer = timeoutTimers.get(sessionId);
        if (timer !== undefined) {
          clearTimeout(timer);
          timeoutTimers.delete(sessionId);
        }

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
   * Set up a 10-minute timeout for a session. On expiry, SIGTERM → 5s → SIGKILL.
   */
  function enforceTimeout(sessionId: string, acp: ACPClient): void {
    const timer = setTimeout(() => {
      timeoutTimers.delete(sessionId);
      if (!registry.has(sessionId)) return;

      log.warn('Session exceeded max wake duration, terminating', { sessionId });

      acp.kill().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to kill timed-out session', { sessionId, error: msg });
      });
    }, MAX_WAKE_DURATION_MS);

    timeoutTimers.set(sessionId, timer);
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

      // 4. Create per-session event queue + worker
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

      // 8. Start background notification consumer
      startNotificationConsumer(sessionId, acp);

      // 9. Monitor subprocess exit for completion/failure detection
      monitorSubprocessExit(sessionId, acp);

      // 10. Enforce 10-minute timeout
      enforceTimeout(sessionId, acp);

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

    async terminateSession(sessionId: string): Promise<void> {
      const handle = registry.get(sessionId);
      if (handle === undefined) {
        throw new Error(`No active session found: ${sessionId}`);
      }

      // Clear timeout timer
      const timer = timeoutTimers.get(sessionId);
      if (timer !== undefined) {
        clearTimeout(timer);
        timeoutTimers.delete(sessionId);
      }

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

      // Clear all timeout timers
      for (const [, timer] of timeoutTimers) {
        clearTimeout(timer);
      }
      timeoutTimers.clear();

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

import * as path from 'node:path';
import * as fs from 'node:fs';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import type { AgentRouterConfig } from './config.js';
import { createLogger } from './log.js';
import type { Logger } from './log.js';
import { initDatabase } from './db.js';
import type { Database } from './db.js';
import { createSessionFiles } from './session-files.js';
import { createSessionManager } from './session-mgr.js';
import type { SessionManager } from './session-mgr.js';

import { createEventQueue } from './queue.js';
import type { EventQueue, QueuedEvent } from './queue.js';
import { createApp } from './server.js';
import { createCliServer } from './cli-server.js';
import type { CliServer } from './cli-server.js';
import { spawnACPClient } from './acp.js';
import { evaluateWakePolicy } from './router.js';
import {
  composeCheckRunPrompt,
  composeReviewCommentPrompt,
  composeCommandTriggerPrompt,
  composeCronTaskPrompt,
} from './prompt.js';
import type { CheckRunPayload, ReviewCommentPayload, IssueCommentPayload } from './prompt.js';
import { parseRoadmap, findNextTask } from './roadmap.js';
import { FatalError, EventError, WakeError } from './errors.js';

export { FatalError, EventError, WakeError };

// ---------------------------------------------------------------------------
// Resolve root directory and config path
// ---------------------------------------------------------------------------

const rootDir = process.env['AGENT_ROUTER_HOME'] ?? path.join(process.env['HOME'] ?? '.', '.agent-router');
const configPath = path.join(rootDir, 'config.json');

// ---------------------------------------------------------------------------
// Compose prompt from event payload based on event type
// ---------------------------------------------------------------------------

function composePromptFromEvent(event: QueuedEvent): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    return null;
  }

  if (event.eventType === 'check_run') {
    return composeCheckRunPrompt(payload as CheckRunPayload);
  }
  if (event.eventType === 'pull_request_review_comment') {
    return composeReviewCommentPrompt(payload as ReviewCommentPayload);
  }
  if (event.eventType === 'issue_comment') {
    return composeCommandTriggerPrompt(payload as IssueCommentPayload);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webhook event processor — runs for each dequeued event
// ---------------------------------------------------------------------------

function createEventProcessor(deps: {
  db: Database;
  config: AgentRouterConfig;
  sessionMgr: SessionManager;
  log: Logger;
}): (event: QueuedEvent) => Promise<void> {
  const { db, config, sessionMgr, log } = deps;

  return async (event: QueuedEvent): Promise<void> => {
    const eventLog = log.child({ event_id: event.id, event_type: event.eventType, repo: event.repo });

    try {
      // Run wake policy
      const decision = evaluateWakePolicy(event, db, config);
      eventLog.info('Wake policy evaluated', {
        wake: decision.wake,
        reason: decision.reason,
        pr_number: decision.prNumber,
      });

      if (!decision.wake) {
        db.updateEventProcessed(event.id, false);
        return;
      }

      // Compose prompt from event payload
      const prompt = composePromptFromEvent(event);
      if (prompt === null) {
        eventLog.warn('Failed to compose prompt from event payload');
        db.updateEventProcessed(event.id, false);
        return;
      }

      // Inject prompt into the existing session
      const sessionId = decision.sessionId!;
      try {
        await sessionMgr.injectPrompt(sessionId, prompt, 'webhook');
        eventLog.info('Prompt injected into session', { session_id: sessionId, pr_number: decision.prNumber });
        db.updateEventProcessed(event.id, true);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        eventLog.warn('Failed to inject prompt — session may not be active', {
          session_id: sessionId,
          error: msg,
        });
        db.updateEventProcessed(event.id, true);
      }
    } catch (err: unknown) {
      if (err instanceof EventError) {
        eventLog.warn('Event processing error', { error: err.message });
        db.updateEventProcessed(event.id, false);
      } else if (err instanceof WakeError) {
        eventLog.error('Wake error', { error: err.message });
        db.updateEventProcessed(event.id, true);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        eventLog.error('Unexpected error processing event', { error: msg });
        db.updateEventProcessed(event.id, false);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Cron trigger handler
// ---------------------------------------------------------------------------

function setupCronJobs(deps: {
  config: AgentRouterConfig;
  sessionMgr: SessionManager;
  log: Logger;
}): cron.ScheduledTask[] {
  const { config, sessionMgr, log } = deps;
  const tasks: cron.ScheduledTask[] = [];

  for (const cronEntry of config.cron) {
    const repoConfig = config.repos.find(
      (r) => `${r.owner}/${r.name}` === cronEntry.repo,
    );
    if (!repoConfig) {
      log.warn('Cron entry references unknown repo, skipping', {
        cron_name: cronEntry.name,
        repo: cronEntry.repo,
      });
      continue;
    }

    const task = cron.schedule(cronEntry.schedule, () => {
      void handleCronFire(cronEntry, repoConfig, sessionMgr, log);
    });
    tasks.push(task);
    log.info('Cron job registered', { name: cronEntry.name, schedule: cronEntry.schedule, repo: cronEntry.repo });
  }

  return tasks;
}

async function handleCronFire(
  cronEntry: AgentRouterConfig['cron'][number],
  repoConfig: AgentRouterConfig['repos'][number],
  sessionMgr: SessionManager,
  log: Logger,
): Promise<void> {
  const cronLog = log.child({ cron_name: cronEntry.name, repo: cronEntry.repo });

  const roadmapPath = repoConfig.roadmapPath;
  if (!roadmapPath) {
    cronLog.warn('No roadmapPath configured for repo, skipping cron trigger');
    return;
  }

  // Read roadmap file
  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog.error('Failed to read roadmap file', { roadmapPath, error: msg });
    return;
  }

  // Parse and find next task
  const tasks = parseRoadmap(content);
  const nextTask = findNextTask(tasks);
  if (nextTask === null) {
    cronLog.info('All roadmap tasks are complete');
    return;
  }

  // Compose prompt and create a new session
  const prompt = composeCronTaskPrompt(nextTask.text, cronEntry.repo, roadmapPath);
  try {
    const handle = await sessionMgr.createSession(prompt);
    cronLog.info('Cron session created', { session_id: handle.sessionId, task: nextTask.text });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog.error('Failed to create cron session', { error: msg });
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

interface DaemonState {
  httpServer: ServerType | null;
  cliServer: CliServer | null;
  globalQueue: EventQueue | null;
  sessionMgr: SessionManager | null;
  db: Database | null;
  log: Logger;
  cronTasks: cron.ScheduledTask[];
  shuttingDown: boolean;
}

function installShutdownHandlers(state: DaemonState): void {
  let shutdownInProgress = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownInProgress) {
      // Second signal — immediate exit
      state.log.warn('Second signal received, forcing immediate exit', { signal });

      // SIGKILL active sessions if possible
      if (state.sessionMgr) {
        try {
          await state.sessionMgr.shutdown();
        } catch {
          // Best effort
        }
      }

      process.exit(130);
    }

    shutdownInProgress = true;
    state.shuttingDown = true;
    state.log.info('Shutdown initiated', { signal });

    try {
      // 1. Stop cron jobs
      for (const task of state.cronTasks) {
        task.stop();
      }
      state.log.info('Cron jobs stopped');

      // 2. Stop HTTP server (stop accepting new requests)
      if (state.httpServer) {
        await new Promise<void>((resolve) => {
          state.httpServer!.close(() => resolve());
          // Force close after 5s if connections linger
          setTimeout(() => resolve(), 5000);
        });
        state.log.info('HTTP server stopped');
      }

      // 3. Close CLI server socket
      if (state.cliServer) {
        await state.cliServer.shutdown();
        state.log.info('CLI server stopped');
      }

      // 4. Wait up to 30s for in-flight events on the global queue
      if (state.globalQueue) {
        await state.globalQueue.shutdown(30);
        state.log.info('Event queue drained');
      }

      // 5. Shutdown session manager (SIGTERM → 5s → SIGKILL active subprocesses, mark abandoned)
      if (state.sessionMgr) {
        await state.sessionMgr.shutdown();
        state.log.info('Session manager shut down');
      }

      // 6. WAL checkpoint and close database
      if (state.db) {
        await state.db.shutdown();
        state.log.info('Database shut down');
      }

      state.log.info('Shutdown complete');
      process.exit(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.log.error('Error during shutdown', { error: msg });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

// ---------------------------------------------------------------------------
// Main startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ---- Task 19.1a: Foundation startup ----

  // Load config
  const config = loadConfig(configPath);

  // Init logger
  const log = createLogger({
    secrets: [config.webhookSecret],
  });
  log.info('Config loaded', { port: config.port, repos: config.repos.length, cron: config.cron.length });

  // Init database (WAL mode enabled inside initDatabase)
  const dbPath = path.join(rootDir, 'agent-router.db');
  const db = initDatabase(dbPath);
  log.info('Database initialized', { dbPath });

  // Mark stale events (older than 5 minutes)
  db.markStaleEvents(300);
  log.info('Stale events marked');

  // ---- Task 19.1b: Session infrastructure startup ----

  // Create session files root
  const sessionFiles = createSessionFiles(rootDir, log);
  log.info('Session files root created', { rootDir });

  // Create session manager with ACP spawner
  const sessionMgr = createSessionManager({
    db,
    sessionFiles,
    acpSpawner: (_sessionId: string) => {
      return spawnACPClient(config.kiroPath, ['acp']);
    },
    log,
    sessionTimeout: config.sessionTimeout,
  });
  log.info('Session manager initialized');

  // Create global event queue for webhook processing
  const globalQueue = createEventQueue();

  // Wire event processor
  const processEvent = createEventProcessor({ db, config, sessionMgr, log });
  globalQueue.startWorker(processEvent);
  log.info('Event queue worker started');

  // ---- Task 19.1c: Server surfaces startup ----

  // Create and bind Hono HTTP server
  const app = createApp({
    webhookSecret: config.webhookSecret,
    db,
    enqueue: (event: QueuedEvent) => { globalQueue.enqueue(event); },
    log,
  });

  const httpServer = serve({
    fetch: app.fetch,
    port: config.port,
  });
  log.info('HTTP server listening', { port: config.port });

  // Start CLI IPC server on Unix socket
  const socketPath = path.join(rootDir, 'sock');
  const cliServer = createCliServer({
    socketPath,
    sessionMgr,
    sessionFiles,
    log,
  });
  await cliServer.start();
  log.info('CLI IPC server listening', { socketPath });

  // ---- Task 19.3: Register cron jobs ----
  const cronTasks = setupCronJobs({ config, sessionMgr, log });

  // ---- Task 19.4: Install graceful shutdown handlers ----
  const state: DaemonState = {
    httpServer,
    cliServer,
    globalQueue,
    sessionMgr,
    db,
    log,
    cronTasks,
    shuttingDown: false,
  };
  installShutdownHandlers(state);

  log.info('Daemon started', { port: config.port, rootDir });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  if (err instanceof FatalError) {
    process.stderr.write(`FatalError: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

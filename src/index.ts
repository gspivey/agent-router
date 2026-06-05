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
import { createGitHubClient, createTokenResolver } from './github.js';
import { createDaemonTokenStore } from './daemon-token.js';
import { createVerifier } from './verify-session.js';
import { createKiroAdapter } from './adapters/kiro.js';
import { evaluateWakePolicy } from './router.js';
import {
  composeCheckRunPrompt,
  composeReviewCommentPrompt,
  composeCommandTriggerPrompt,
  composeCronPrompt,
} from './prompt.js';
import type { CheckRunPayload, ReviewCommentPayload, IssueCommentPayload } from './prompt.js';
import { createWebApp, startWebServer } from './web-server.js';
import { createSSEBroker } from './sse-broker.js';
import type { SSEBroker } from './sse-broker.js';
import { FatalError, EventError, WakeError } from './errors.js';

export { FatalError, EventError, WakeError };

// ---------------------------------------------------------------------------
// Resolve root directory and config path
// ---------------------------------------------------------------------------

const rootDir = process.env['AGENT_ROUTER_HOME'] ?? path.join(process.env['HOME'] ?? '.', '.agent-router');
const configPath = path.join(rootDir, 'config.json');

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const cliBindPublic = process.argv.includes('--bind-public');

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
        decision_code: decision.decisionCode,
        reason: decision.reason,
        pr_number: decision.prNumber,
        trust_tier: decision.trustTier,
        session_id: decision.sessionId,
        comment_author: decision.commentAuthor,
        comment_id: decision.commentId,
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
  sessionFiles: ReturnType<typeof import('./session-files.js').createSessionFiles>;
  log: Logger;
}): cron.ScheduledTask[] {
  const { config, sessionMgr, sessionFiles, log } = deps;
  const tasks: cron.ScheduledTask[] = [];

  for (const cronEntry of config.cron) {
    const task = cron.schedule(cronEntry.schedule, () => {
      void handleCronFire(cronEntry, sessionMgr, sessionFiles, log);
    });
    tasks.push(task);
    log.info('Cron job registered', { name: cronEntry.name, schedule: cronEntry.schedule, repo: cronEntry.repo });
  }

  return tasks;
}

async function handleCronFire(
  cronEntry: AgentRouterConfig['cron'][number],
  sessionMgr: SessionManager,
  sessionFiles: ReturnType<typeof import('./session-files.js').createSessionFiles>,
  log: Logger,
): Promise<void> {
  const cronLog = log.child({ cron_name: cronEntry.name, repo: cronEntry.repo });

  // Skip if a session for this repo is already running
  if (sessionMgr.hasActiveSessionForRepo(cronEntry.repo)) {
    cronLog.warn('Active session already exists for repo, skipping cron trigger');
    return;
  }

  // Check that the last terminal session ended cleanly — require manual re-trigger otherwise
  const lastTerminal = sessionFiles
    .listSessions()
    .find((s) => s.repo === cronEntry.repo && s.status !== 'active');
  if (lastTerminal !== undefined && lastTerminal.status !== 'completed') {
    cronLog.warn('Last session did not end cleanly, skipping cron trigger — manual re-trigger required', {
      last_session_id: lastTerminal.session_id,
      last_status: lastTerminal.status,
      last_termination_reason: lastTerminal.termination_reason ?? null,
    });
    return;
  }

  // Read the prompt file
  let promptContent: string;
  try {
    promptContent = fs.readFileSync(cronEntry.promptFile, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    cronLog.error('Failed to read prompt file', { promptFile: cronEntry.promptFile, error: msg });
    return;
  }

  if (promptContent.trim().length === 0) {
    cronLog.warn('Prompt file is empty, skipping cron trigger', { promptFile: cronEntry.promptFile });
    return;
  }

  const prompt = composeCronPrompt(promptContent, cronEntry.repo);
  try {
    const handle = await sessionMgr.createSession(prompt, cronEntry.repo);
    cronLog.info('Cron session created', { session_id: handle.sessionId, promptFile: cronEntry.promptFile });
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
  webServer: ServerType | null;
  sseBroker: SSEBroker | null;
  cliServer: CliServer | null;
  globalQueue: EventQueue | null;
  sessionMgr: SessionManager | null;
  db: Database | null;
  log: Logger;
  cronTasks: cron.ScheduledTask[];
  shuttingDown: boolean;
  shuttingDownRef: { value: boolean };
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
    state.shuttingDownRef.value = true;
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

      // 6. Close web server listener and SSE broker
      if (state.sseBroker) {
        state.sseBroker.shutdown();
        state.log.info('SSE broker shut down');
      }
      if (state.webServer) {
        await new Promise<void>((resolve) => {
          state.webServer!.close(() => resolve());
          setTimeout(() => resolve(), 5000);
        });
        state.log.info('Web server stopped');
      }

      // 7. WAL checkpoint and close database
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

  // Prune outbound comments older than 7 days
  const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
  db.pruneOutboundComments(SEVEN_DAYS_SECONDS);
  log.info('Outbound comments pruned');

  // ---- Task 19.1b: Session infrastructure startup ----

  // Create session files root
  const sessionFiles = createSessionFiles(rootDir, log);
  log.info('Session files root created', { rootDir });

  // Daemon hook token — generated on every start, written to $rootDir/daemon-token.
  // Adapters and hand-installed Kiro hooks read it from disk at fire time.
  const tokenStore = createDaemonTokenStore({ rootDir, log });

  // GitHub client + verifySession + agent adapter.
  // The GitHub client is wired in for the verifier (which checks PR state)
  // and for the merge_pr MCP tool. The verifier is the single terminal-state
  // authority for every trigger path (HTTP /hooks/event, ACP fallback,
  // complete_session MCP call). The adapter abstracts the agent harness —
  // today only Kiro; future adapters slot in here.
  const perRepoTokens: Record<string, string> = {};
  for (const r of config.repos) {
    if (r.token !== undefined) perRepoTokens[`${r.owner}/${r.name}`] = r.token;
  }
  const resolverCfg: Parameters<typeof createTokenResolver>[0] = {
    perRepoTokens,
    envFallback: true,
  };
  if (config.defaultGithubToken !== undefined) {
    resolverCfg.defaultToken = config.defaultGithubToken;
  }
  const github = createGitHubClient({ tokenResolver: createTokenResolver(resolverCfg) });
  const verifySession = createVerifier({ sessionFiles, github, log });
  log.info('Verification core initialized');

  const adapter = createKiroAdapter({ kiroPath: config.kiroPath, log });
  log.info('Agent adapter initialized', { adapter: adapter.name });

  const sessionMgr = createSessionManager({
    db,
    sessionFiles,
    acpSpawner: (sessionId: string) => adapter.spawn({ sessionId }),
    log,
    sessionTimeout: config.sessionTimeout,
    github,
    verify: verifySession,
  });
  log.info('Session manager initialized');

  // Create global event queue for webhook processing
  const globalQueue = createEventQueue();

  // Wire event processor
  const processEvent = createEventProcessor({ db, config, sessionMgr, log });
  globalQueue.startWorker(processEvent);
  log.info('Event queue worker started');

  // ---- Task 19.1c: Server surfaces startup ----

  // Create and bind Hono HTTP server (now also serves /hooks/event)
  const app = createApp({
    webhookSecret: config.webhookSecret,
    repos: config.repos,
    db,
    enqueue: (event: QueuedEvent) => { globalQueue.enqueue(event); },
    log,
    tokenStore,
    verifySession,
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

  // ---- Web control plane startup ----

  // CLI --bind-public flag takes precedence over config.bindPublic
  const effectiveConfig = cliBindPublic
    ? { ...config, bindPublic: true }
    : config;

  const sseBroker = createSSEBroker({ sessionFiles, rootDir, log });

  const shuttingDownRef = { value: false };
  const webApp = createWebApp({
    sessionMgr,
    sessionFiles,
    sseBroker,
    tokenStore,
    log,
    rootDir,
    config: effectiveConfig,
    shuttingDown: () => shuttingDownRef.value,
  });

  const webServer = startWebServer(webApp, effectiveConfig, log);

  // ---- Task 19.3: Register cron jobs ----
  const cronTasks = setupCronJobs({ config, sessionMgr, sessionFiles, log });

  // ---- Task 19.4: Install graceful shutdown handlers ----
  const state: DaemonState = {
    httpServer,
    webServer,
    sseBroker,
    cliServer,
    globalQueue,
    sessionMgr,
    db,
    log,
    cronTasks,
    shuttingDown: false,
    shuttingDownRef,
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

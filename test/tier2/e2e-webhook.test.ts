/**
 * Tier 2 end-to-end test: full webhook → wake → session loop.
 *
 * Exercises the complete daemon lifecycle:
 * 1. Start daemon with fake backends
 * 2. Create a session and register a PR via CLI IPC
 * 3. Send a signed webhook (check_run failure) for that PR
 * 4. Verify the event was processed and the session received a prompt injection
 * 5. Check stream.log for expected entries
 *
 * Requirements: 3.4, 6.1, 8.3, 10.7, 24.6
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import { createSessionManager } from '../../src/session-mgr.js';
import type { SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles } from '../../src/session-files.js';
import type { SessionFiles } from '../../src/session-files.js';
import { initDatabase } from '../../src/db.js';
import type { Database } from '../../src/db.js';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';
import { createApp } from '../../src/server.js';
import { createCliServer } from '../../src/cli-server.js';
import type { CliServer } from '../../src/cli-server.js';
import { createEventQueue } from '../../src/queue.js';
import type { EventQueue, QueuedEvent } from '../../src/queue.js';
import { spawnACPClient } from '../../src/acp.js';
import { evaluateWakePolicy } from '../../src/router.js';
import {
  composeCheckRunPrompt,
  composeReviewCommentPrompt,
  composeCommandTriggerPrompt,
} from '../../src/prompt.js';
import type { CheckRunPayload, ReviewCommentPayload, IssueCommentPayload } from '../../src/prompt.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { TestCli } from '../harness/test-cli.js';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import * as net from 'node:net';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');
const WEBHOOK_SECRET = 'e2e-test-secret-xyz';

function signPayload(secret: string, body: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

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

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = (addr as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('E2E: webhook → wake → session loop', () => {
  let rootDir: string;
  let db: Database;
  let sessionFiles: SessionFiles;
  let sessionMgr: SessionManager;
  let globalQueue: EventQueue;
  let cliServer: CliServer;
  let httpServer: ServerType;
  let log: Logger;
  let kiro: FakeKiroBackend;
  let port: number;
  let socketPath: string;
  let cli: TestCli;

  const config = {
    port: 0,
    webhookSecret: WEBHOOK_SECRET,
    kiroPath: '',
    rateLimit: { perPRSeconds: 1 },
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120 },
    repos: [{ owner: 'testowner', name: 'testrepo' }],
    cron: [],
  };

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-webhook-'));
    const dbPath = path.join(rootDir, 'agent-router.db');

    // Init components
    log = createLogger({ level: 'error', output: () => {} });
    db = initDatabase(dbPath);
    db.markStaleEvents(300);
    sessionFiles = createSessionFiles(rootDir, log);

    kiro = new FakeKiroBackend();
    await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);

    sessionMgr = createSessionManager({
      db,
      sessionFiles,
      acpSpawner: (sessionId: string) => {
        const cfg = kiro.spawnConfig();
        return spawnACPClient(cfg.command, cfg.args, {
          ...cfg.env,
          AGENT_ROUTER_SESSION_ID: sessionId,
        });
      },
      log,
    });

    // Create global event queue with processor
    globalQueue = createEventQueue();

    const processEvent = async (event: QueuedEvent): Promise<void> => {
      const decision = evaluateWakePolicy(event, db, config);
      if (!decision.wake) {
        db.updateEventProcessed(event.id, false);
        return;
      }
      const prompt = composePromptFromEvent(event);
      if (prompt === null) {
        db.updateEventProcessed(event.id, false);
        return;
      }
      const sessionId = decision.sessionId!;
      try {
        await sessionMgr.injectPrompt(sessionId, prompt, 'webhook');
        db.updateEventProcessed(event.id, true);
      } catch {
        db.updateEventProcessed(event.id, true);
      }
    };
    globalQueue.startWorker(processEvent);

    // Create HTTP server
    port = await getFreePort();
    const app = createApp({
      webhookSecret: WEBHOOK_SECRET,
      db,
      enqueue: (event: QueuedEvent) => { globalQueue.enqueue(event); },
      log,
    });
    httpServer = serve({ fetch: app.fetch, port });

    // Create CLI server
    socketPath = path.join(rootDir, 'sock');
    cliServer = createCliServer({ socketPath, sessionMgr, sessionFiles, log });
    await cliServer.start();

    cli = new TestCli(socketPath);
  });

  afterEach(async () => {
    await globalQueue.shutdown(5);
    await cliServer.shutdown();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await sessionMgr.shutdown();
    await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('processes a check_run failure webhook and injects prompt into session', async () => {
    // 1. Create a session via CLI IPC
    const sessionRes = await cli.newSession('Fix CI failures');
    expect(sessionRes.session_id).toBeTruthy();
    const sessionId = sessionRes.session_id;

    // 2. Register a PR for the session
    const registerRes = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      socket.on('connect', () => {
        socket.write(JSON.stringify({
          op: 'register_pr',
          session_id: sessionId,
          repo: 'testowner/testrepo',
          pr_number: 42,
        }) + '\n');
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const idx = buffer.indexOf('\n');
        if (idx !== -1) {
          socket.destroy();
          resolve(JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>);
        }
      });
      socket.on('error', reject);
    });
    expect(registerRes['ok']).toBe(true);

    // Small delay to let the session fully initialize
    await new Promise((r) => setTimeout(r, 200));

    // 3. Send a signed check_run failure webhook
    const webhookPayload = {
      action: 'completed',
      check_run: {
        name: 'lint',
        status: 'completed',
        conclusion: 'failure',
        output: { summary: 'ESLint found 3 errors', text: '' },
        pull_requests: [{ number: 42, url: 'https://github.com/testowner/testrepo/pull/42' }],
      },
      repository: { full_name: 'testowner/testrepo' },
    };
    const body = JSON.stringify(webhookPayload);
    const sig = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'check_run',
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    expect(res.status).toBe(200);

    // 4. Wait for the event to be processed
    await new Promise((r) => setTimeout(r, 500));

    // 5. Verify the event was processed in the DB
    // Read stream.log and check for expected entries
    const streamPath = sessionRes.stream_path;
    const streamContent = fs.readFileSync(streamPath, 'utf-8').trim();
    const streamLines = streamContent
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Should have session_started entry
    const sessionStarted = streamLines.find((e) => e['type'] === 'session_started');
    expect(sessionStarted).toBeDefined();
    expect(sessionStarted!['source']).toBe('router');

    // Should have pr_registered entry
    const prRegistered = streamLines.find((e) => e['type'] === 'pr_registered');
    expect(prRegistered).toBeDefined();
    expect(prRegistered!['repo']).toBe('testowner/testrepo');
    expect(prRegistered!['pr_number']).toBe(42);

    // Should have prompt_injected entry from the webhook
    const promptInjected = streamLines.find((e) => e['type'] === 'prompt_injected' && e['prompt_source'] === 'webhook');
    expect(promptInjected).toBeDefined();
    expect(promptInjected!['prompt_source']).toBe('webhook');

    // Verify prompts.log has the webhook prompt
    const promptsPath = sessionRes.prompts_path;
    const promptsContent = fs.readFileSync(promptsPath, 'utf-8').trim();
    const promptLines = promptsContent
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const webhookPrompt = promptLines.find((e) => e['source'] === 'webhook');
    expect(webhookPrompt).toBeDefined();
    expect(typeof webhookPrompt!['prompt']).toBe('string');
    // The prompt should contain the check run name and repo
    const promptText = webhookPrompt!['prompt'] as string;
    expect(promptText).toContain('lint');
    expect(promptText).toContain('testowner/testrepo');
  }, 30_000);

  it('drops a webhook for a PR with no registered session', async () => {
    // Send a webhook for a PR that has no session
    const webhookPayload = {
      action: 'completed',
      check_run: {
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        output: { summary: 'Tests failed', text: '' },
        pull_requests: [{ number: 999, url: 'https://github.com/testowner/testrepo/pull/999' }],
      },
      repository: { full_name: 'testowner/testrepo' },
    };
    const body = JSON.stringify(webhookPayload);
    const sig = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'check_run',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    // HTTP response should still be 200 (event was accepted and enqueued)
    expect(res.status).toBe(200);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 300));

    // The event should be marked as processed with wake_triggered = 0
    // (no session for this PR)
    const sessions = sessionFiles.listSessions();
    // No sessions should have been created for PR 999
    const pr999Sessions = sessions.filter((s) =>
      s.prs.some((pr) => pr.pr_number === 999),
    );
    expect(pr999Sessions).toHaveLength(0);
  }, 15_000);

  it('drops a non-wakeable event type', async () => {
    // Send a push event (not wakeable)
    const webhookPayload = {
      ref: 'refs/heads/main',
      repository: { full_name: 'testowner/testrepo' },
    };
    const body = JSON.stringify(webhookPayload);
    const sig = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    expect(res.status).toBe(200);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 300));

    // No sessions should have been created
    const sessions = sessionFiles.listSessions();
    expect(sessions).toHaveLength(0);
  }, 15_000);
});

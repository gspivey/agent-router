/**
 * Tier 2: Idempotent PR re-registration routing.
 *
 * Verifies that when a second session re-registers a PR already held by a
 * completed/dead first session, webhooks for that PR route to the new session.
 *
 * Spec: BACKLOG.md § P2.13
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
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
import { composeCheckRunPrompt } from '../../src/prompt.js';
import type { CheckRunPayload } from '../../src/prompt.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { TestCli } from '../harness/test-cli.js';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');
const WEBHOOK_SECRET = 'reregistration-test-secret';

function signPayload(secret: string, body: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('PR re-registration: webhook routes to new session', () => {
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
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    repos: [{ owner: 'testowner', name: 'testrepo' }],
    cron: [],
    controlPort: 3100,
    bindPublic: false,
    shutdownDrainSeconds: 60,
  };

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-rereg-'));
    const dbPath = path.join(rootDir, 'agent-router.db');

    log = createLogger({ level: 'error', output: () => {} });
    db = initDatabase(dbPath);
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

    globalQueue = createEventQueue();

    const processEvent = async (event: QueuedEvent): Promise<void> => {
      const decision = evaluateWakePolicy(event, db, config);
      if (!decision.wake) {
        db.updateEventProcessed(event.id, false);
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(event.payload);
      } catch {
        db.updateEventProcessed(event.id, false);
        return;
      }
      const prompt = event.eventType === 'check_run'
        ? composeCheckRunPrompt(payload as CheckRunPayload)
        : null;
      if (prompt === null) {
        db.updateEventProcessed(event.id, false);
        return;
      }
      try {
        await sessionMgr.injectPrompt(decision.sessionId!, prompt, 'webhook');
        db.updateEventProcessed(event.id, true);
      } catch {
        db.updateEventProcessed(event.id, true);
      }
    };
    globalQueue.startWorker(processEvent);

    port = await getFreePort();
    const app = createApp({
      webhookSecret: WEBHOOK_SECRET,
      db,
      enqueue: (event: QueuedEvent) => { globalQueue.enqueue(event); },
      log,
    });
    httpServer = serve({ fetch: app.fetch, port });

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

  it('routes webhook to new session after re-registration from a second session', async () => {
    // 1. Create first session and register PR 42
    const session1 = await cli.newSession('First session');
    const sid1 = session1.session_id;

    await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      socket.on('connect', () => {
        socket.write(JSON.stringify({
          op: 'register_pr',
          session_id: sid1,
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

    // 2. Terminate the first session (simulating a completed/dead session)
    await sessionMgr.terminateSession(sid1);

    // 3. Create a second session and re-register the same PR
    const session2 = await cli.newSession('Second session');
    const sid2 = session2.session_id;

    const regRes = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      socket.on('connect', () => {
        socket.write(JSON.stringify({
          op: 'register_pr',
          session_id: sid2,
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
    expect(regRes['ok']).toBe(true);

    await new Promise((r) => setTimeout(r, 200));

    // 4. Send a webhook for PR 42
    const webhookPayload = {
      action: 'completed',
      check_run: {
        name: 'ci',
        status: 'completed',
        conclusion: 'failure',
        output: { summary: 'Tests failed', text: '' },
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

    // 5. Wait for processing
    await new Promise((r) => setTimeout(r, 500));

    // 6. Verify the prompt was injected into session 2, not session 1
    const stream2Path = session2.stream_path;
    const stream2 = fs.readFileSync(stream2Path, 'utf-8').trim();
    const entries2 = stream2
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const webhookPrompt = entries2.find(
      (e) => e['type'] === 'prompt_injected' && e['prompt_source'] === 'webhook',
    );
    expect(webhookPrompt).toBeDefined();

    // Session 1 should NOT have received the webhook prompt
    const stream1Path = session1.stream_path;
    const stream1 = fs.readFileSync(stream1Path, 'utf-8').trim();
    const entries1 = stream1
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const s1WebhookPrompt = entries1.find(
      (e) => e['type'] === 'prompt_injected' && e['prompt_source'] === 'webhook',
    );
    expect(s1WebhookPrompt).toBeUndefined();
  }, 30_000);
});

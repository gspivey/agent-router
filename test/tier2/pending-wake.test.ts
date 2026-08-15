/**
 * Tier 2: behavioral tests for rate-limit wake deferral.
 *
 * Exercises the full daemon lifecycle:
 * 1. Event during cooldown is delivered after the window (not dropped)
 * 2. Burst of N events during cooldown yields one wake with latest payload
 * 3. Pending wake cleared on session end
 * 4. Deferred wake to dead session dropped without error
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
import { createEventQueue } from '../../src/queue.js';
import type { EventQueue, QueuedEvent } from '../../src/queue.js';
import { spawnACPClient } from '../../src/acp.js';
import { evaluateWakePolicy } from '../../src/router.js';
import type { AgentRouterConfig } from '../../src/config.js';
import {
  composeCheckRunPrompt,
  composeReviewCommentPrompt,
  composeCommandTriggerPrompt,
} from '../../src/prompt.js';
import type { CheckRunPayload, ReviewCommentPayload, IssueCommentPayload } from '../../src/prompt.js';
import { createPendingWakeSweeper } from '../../src/pending-wake-sweeper.js';
import type { PendingWakeSweeper } from '../../src/pending-wake-sweeper.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

function composePromptFromEvent(event: QueuedEvent): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    return null;
  }
  if (event.eventType === 'check_run') return composeCheckRunPrompt(payload as CheckRunPayload);
  if (event.eventType === 'pull_request_review_comment') return composeReviewCommentPrompt(payload as ReviewCommentPayload);
  if (event.eventType === 'issue_comment') return composeCommandTriggerPrompt(payload as IssueCommentPayload);
  return null;
}

function makeCheckRunPayload(conclusion: string, prNumber: number): Record<string, unknown> {
  return {
    action: 'completed',
    check_run: {
      name: 'ci',
      status: 'completed',
      conclusion,
      output: { summary: `CI ${conclusion}`, text: '' },
      pull_requests: [{ number: prNumber, url: `https://github.com/testowner/testrepo/pull/${prNumber}` }],
    },
    repository: { full_name: 'testowner/testrepo' },
  };
}

describe('Tier 2: rate-limit wake deferral', () => {
  let rootDir: string;
  let db: Database;
  let sessionFiles: SessionFiles;
  let sessionMgr: SessionManager;
  let globalQueue: EventQueue;
  let log: Logger;
  let kiro: FakeKiroBackend;
  let sweeper: PendingWakeSweeper;
  let currentTime: number;

  const config: AgentRouterConfig = {
    port: 0,
    webhookSecret: 'test-secret',
    kiroPath: '',
    rateLimit: { perPRSeconds: 60 },
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    repos: [{ owner: 'testowner', name: 'testrepo' }],
    cron: [],
    controlPort: 3100,
    bindPublic: false,
    shutdownDrainSeconds: 60,
    credentialMode: 'env',
    reaper: { enabled: false, gracePeriodMinutes: 60, retentionDays: 30, agentRunsDir: '/tmp/agent-runs', sweepIntervalMinutes: 15 },
  };

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-wake-tier2-'));
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

    currentTime = 1000;
    sweeper = createPendingWakeSweeper({
      db,
      sessionMgr,
      config,
      log,
      now: () => currentTime,
    });

    globalQueue = createEventQueue();

    // Wire event processor that defers rate-limited events
    const processEvent = async (event: QueuedEvent): Promise<void> => {
      const decision = evaluateWakePolicy(event, db, config);
      if (!decision.wake) {
        if (decision.decisionCode === 'rate_limited' && decision.deferUntil !== undefined && decision.prNumber !== undefined) {
          db.upsertPendingWake(event.repo, decision.prNumber, event.id, decision.deferUntil);
        }
        db.updateEventProcessed(event.id, false);
        return;
      }
      const prompt = composePromptFromEvent(event);
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
  });

  afterEach(async () => {
    sweeper.stop();
    await globalQueue.shutdown(5);
    await sessionMgr.shutdown();
    await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('defers a rate-limited event and delivers it after the window', async () => {
    // Create session and register PR
    const handle = await sessionMgr.createSession('Fix CI');
    await sessionMgr.registerPR(handle.sessionId, 'testowner/testrepo', 42);
    await new Promise((r) => setTimeout(r, 200));

    // First event wakes normally (acquires slot at time=1000)
    currentTime = 1000;
    const payload1 = makeCheckRunPayload('failure', 42);
    const event1: QueuedEvent = {
      id: db.insertEvent({
        repo: 'testowner/testrepo',
        prNumber: 42,
        eventType: 'check_run',
        payload: JSON.stringify(payload1),
        receivedAt: currentTime,
      }),
      repo: 'testowner/testrepo',
      eventType: 'check_run',
      payload: JSON.stringify(payload1),
      prNumber: null,
      source: 'webhook',
    };
    globalQueue.enqueue(event1);
    await new Promise((r) => setTimeout(r, 300));

    // Second event arrives at time=1030 — within cooldown — should be deferred
    currentTime = 1030;
    const payload2 = makeCheckRunPayload('success', 42);
    const event2: QueuedEvent = {
      id: db.insertEvent({
        repo: 'testowner/testrepo',
        prNumber: 42,
        eventType: 'check_run',
        payload: JSON.stringify(payload2),
        receivedAt: currentTime,
      }),
      repo: 'testowner/testrepo',
      eventType: 'check_run',
      payload: JSON.stringify(payload2),
      prNumber: null,
      source: 'webhook',
    };
    globalQueue.enqueue(event2);
    await new Promise((r) => setTimeout(r, 300));

    // Verify the pending wake was stored
    const pendingBefore = db.getDuePendingWakes(Math.floor(Date.now() / 1000) + 120);
    expect(pendingBefore.length).toBeGreaterThanOrEqual(1);
    const pending = pendingBefore.find((w) => w.repo === 'testowner/testrepo' && w.prNumber === 42);
    expect(pending).toBeDefined();
    expect(pending!.eventId).toBe(event2.id);

    // Advance time past the cooldown and sweep
    currentTime = Math.floor(Date.now() / 1000) + 120;
    await sweeper.sweep();
    await new Promise((r) => setTimeout(r, 300));

    // Verify the pending wake was cleared
    const pendingAfter = db.getDuePendingWakes(Math.floor(Date.now() / 1000) + 240);
    const remaining = pendingAfter.find((w) => w.repo === 'testowner/testrepo' && w.prNumber === 42);
    expect(remaining).toBeUndefined();

    // Verify the prompt was injected by checking prompts.log
    const promptsPath = path.join(rootDir, 'sessions', handle.sessionId, 'prompts.log');
    const promptLines = fs.readFileSync(promptsPath, 'utf-8').trim().split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const webhookPrompts = promptLines.filter((p) => p['source'] === 'webhook');
    // Should have at least 2: one from event1 (direct) and one from event2 (deferred)
    expect(webhookPrompts.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('burst of events during cooldown yields one wake with latest payload', async () => {
    const handle = await sessionMgr.createSession('Fix CI');
    await sessionMgr.registerPR(handle.sessionId, 'testowner/testrepo', 7);
    await new Promise((r) => setTimeout(r, 200));

    // First event at t=1000 — wakes normally
    currentTime = 1000;
    const payloadFirst = makeCheckRunPayload('failure', 7);
    const eventFirst: QueuedEvent = {
      id: db.insertEvent({
        repo: 'testowner/testrepo',
        prNumber: 7,
        eventType: 'check_run',
        payload: JSON.stringify(payloadFirst),
        receivedAt: currentTime,
      }),
      repo: 'testowner/testrepo',
      eventType: 'check_run',
      payload: JSON.stringify(payloadFirst),
      prNumber: null,
      source: 'webhook',
    };
    globalQueue.enqueue(eventFirst);
    await new Promise((r) => setTimeout(r, 300));

    // Burst of 3 events during cooldown at t=1010, 1020, 1030
    const burstIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      currentTime = 1010 + i * 10;
      const payload = makeCheckRunPayload(i === 2 ? 'success' : 'failure', 7);
      const event: QueuedEvent = {
        id: db.insertEvent({
          repo: 'testowner/testrepo',
          prNumber: 7,
          eventType: 'check_run',
          payload: JSON.stringify(payload),
          receivedAt: currentTime,
        }),
        repo: 'testowner/testrepo',
        eventType: 'check_run',
        payload: JSON.stringify(payload),
        prNumber: null,
      source: 'webhook',
      };
      burstIds.push(event.id);
      globalQueue.enqueue(event);
    }
    await new Promise((r) => setTimeout(r, 500));

    // Should have exactly one pending wake for PR#7, with the last event
    const pending = db.getDuePendingWakes(Math.floor(Date.now() / 1000) + 120)
      .filter((w) => w.repo === 'testowner/testrepo' && w.prNumber === 7);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.eventId).toBe(burstIds[2]);
  }, 30_000);

  it('pending wake cleared on session termination', async () => {
    const handle = await sessionMgr.createSession('Fix CI');
    await sessionMgr.registerPR(handle.sessionId, 'testowner/testrepo', 99);
    await new Promise((r) => setTimeout(r, 200));

    // First event acquires slot
    currentTime = 1000;
    const payload1 = makeCheckRunPayload('failure', 99);
    const ev1: QueuedEvent = {
      id: db.insertEvent({
        repo: 'testowner/testrepo',
        prNumber: 99,
        eventType: 'check_run',
        payload: JSON.stringify(payload1),
        receivedAt: currentTime,
      }),
      repo: 'testowner/testrepo',
      eventType: 'check_run',
      payload: JSON.stringify(payload1),
      prNumber: null,
      source: 'webhook',
    };
    globalQueue.enqueue(ev1);
    await new Promise((r) => setTimeout(r, 300));

    // Second event deferred
    currentTime = 1020;
    const payload2 = makeCheckRunPayload('success', 99);
    const ev2: QueuedEvent = {
      id: db.insertEvent({
        repo: 'testowner/testrepo',
        prNumber: 99,
        eventType: 'check_run',
        payload: JSON.stringify(payload2),
        receivedAt: currentTime,
      }),
      repo: 'testowner/testrepo',
      eventType: 'check_run',
      payload: JSON.stringify(payload2),
      prNumber: null,
      source: 'webhook',
    };
    globalQueue.enqueue(ev2);
    await new Promise((r) => setTimeout(r, 300));

    // Confirm pending wake exists
    const before = db.getDuePendingWakes(Math.floor(Date.now() / 1000) + 120)
      .filter((w) => w.repo === 'testowner/testrepo' && w.prNumber === 99);
    expect(before).toHaveLength(1);

    // Terminate the session
    await sessionMgr.terminateSession(handle.sessionId);
    await new Promise((r) => setTimeout(r, 200));

    // Pending wake should be cleared
    const after = db.getDuePendingWakes(Math.floor(Date.now() / 1000) + 120)
      .filter((w) => w.repo === 'testowner/testrepo' && w.prNumber === 99);
    expect(after).toHaveLength(0);
  }, 30_000);

  it('deferred wake to dead session dropped without error', async () => {
    const handle = await sessionMgr.createSession('Fix CI');
    await sessionMgr.registerPR(handle.sessionId, 'testowner/testrepo', 55);
    await new Promise((r) => setTimeout(r, 200));

    // First event at t=1000
    currentTime = 1000;
    const payload1 = makeCheckRunPayload('failure', 55);
    const ev1: QueuedEvent = {
      id: db.insertEvent({
        repo: 'testowner/testrepo',
        prNumber: 55,
        eventType: 'check_run',
        payload: JSON.stringify(payload1),
        receivedAt: currentTime,
      }),
      repo: 'testowner/testrepo',
      eventType: 'check_run',
      payload: JSON.stringify(payload1),
      prNumber: null,
      source: 'webhook',
    };
    globalQueue.enqueue(ev1);
    await new Promise((r) => setTimeout(r, 300));

    // Second event deferred
    currentTime = 1020;
    const payload2 = makeCheckRunPayload('success', 55);
    const ev2: QueuedEvent = {
      id: db.insertEvent({
        repo: 'testowner/testrepo',
        prNumber: 55,
        eventType: 'check_run',
        payload: JSON.stringify(payload2),
        receivedAt: currentTime,
      }),
      repo: 'testowner/testrepo',
      eventType: 'check_run',
      payload: JSON.stringify(payload2),
      prNumber: null,
      source: 'webhook',
    };
    globalQueue.enqueue(ev2);
    await new Promise((r) => setTimeout(r, 300));

    // Terminate the session — clears the pending wake
    await sessionMgr.terminateSession(handle.sessionId);
    await new Promise((r) => setTimeout(r, 200));

    // Manually re-insert a pending wake to simulate a race where the
    // sweeper hasn't cleaned up yet but the session is already dead
    db.upsertPendingWake('testowner/testrepo', 55, ev2.id, Math.floor(Date.now() / 1000) - 10);

    // Advance time and sweep — should not throw
    currentTime = Math.floor(Date.now() / 1000) + 120;
    await expect(sweeper.sweep()).resolves.not.toThrow();

    // Pending wake should be cleared (dropped cleanly)
    const after = db.getDuePendingWakes(Math.floor(Date.now() / 1000) + 240)
      .filter((w) => w.repo === 'testowner/testrepo' && w.prNumber === 55);
    expect(after).toHaveLength(0);
  }, 30_000);
});

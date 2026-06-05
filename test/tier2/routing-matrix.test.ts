/**
 * Tier 2 routing matrix.
 *
 * Drives a table of webhook payloads through `createApp` (signature verify +
 * enqueue) and then `evaluateWakePolicy`, asserting the resulting
 * `decisionCode` for each scenario. Mocks the DB and rate limiter — every
 * filter step in the wake pipeline gets exercised here.
 *
 * Each row is a self-contained scenario:
 *   - payload: the webhook body
 *   - eventType: X-GitHub-Event header
 *   - dbState: mock DB behavior (findSession, isOutboundComment, tryAcquireWakeSlot)
 *   - expectedCode: the WakeDecisionCode we expect
 *   - expectedWake: whether the decision should be `wake: true`
 *
 * Real captured payloads can be dropped into `test/fixtures/webhooks/*.json`
 * and loaded via `loadFixture`. See `AGENT_ROUTER_CAPTURE_PAYLOADS` in
 * `src/server.ts` for capturing live payloads from a tier 3 run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { createApp } from '../../src/server.js';
import { evaluateWakePolicy } from '../../src/router.js';
import type { WakeDecisionCode } from '../../src/router.js';
import type { Database, NewEvent, Session } from '../../src/db.js';
import type { QueuedEvent } from '../../src/queue.js';
import type { Logger } from '../../src/log.js';
import type { AgentRouterConfig } from '../../src/config.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/webhooks');
const WEBHOOK_SECRET = 'routing-matrix-secret';

function signPayload(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function makeLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => makeLogger() };
}

interface DbState {
  session?: Session | null;
  rateLimitAllow?: boolean;
  outboundCommentIds?: number[];
}

function makeDb(state: DbState = {}): Database {
  let nextId = 1;
  const outbound = new Set(state.outboundCommentIds ?? []);
  return {
    insertEvent: vi.fn((_event: NewEvent) => nextId++),
    updateEventProcessed: vi.fn(),
    markStaleEvents: vi.fn(),
    findSession: vi.fn(() => state.session ?? null),
    tryAcquireWakeSlot: vi.fn(() => state.rateLimitAllow ?? true),
    insertSession: vi.fn(),
    insertOutboundComment: vi.fn(),
    isOutboundComment: vi.fn((id: number) => outbound.has(id)),
    pruneOutboundComments: vi.fn(),
    walCheckpoint: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
  };
}

const config: AgentRouterConfig = {
  port: 3000,
  webhookSecret: WEBHOOK_SECRET,
  kiroPath: '/usr/bin/kiro',
  rateLimit: { perPRSeconds: 60 },
  sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
  repos: [{ owner: 'octo', name: 'demo' }],
  cron: [],
  controlPort: 3100,
  bindPublic: false,
  shutdownDrainSeconds: 60,
};

const SESSION_FOR_PR: Session = {
  sessionId: 'sess-1',
  repo: 'octo/demo',
  prNumber: 42,
  lastWakedAt: null,
};

// ---------------------------------------------------------------------------
// Synthetic payloads — minimum fields each branch of filterEventType reads.
// Real captured payloads (more fields) get loaded via loadFixture below.
// ---------------------------------------------------------------------------

function issueComment(opts: {
  action?: string;
  body?: string;
  login?: string;
  authorAssociation?: string;
  userType?: string;
  commentId?: number;
  prNumber?: number;
  hasPullRequest?: boolean;
  ownerLogin?: string;
}): Record<string, unknown> {
  const {
    action = 'created',
    body = 'hi',
    login = 'octocat',
    authorAssociation = 'OWNER',
    userType = 'User',
    commentId = 1000,
    prNumber = 42,
    hasPullRequest = true,
    ownerLogin = 'octocat',
  } = opts;
  return {
    action,
    comment: {
      id: commentId,
      body,
      user: { login, type: userType },
      author_association: authorAssociation,
    },
    issue: {
      number: prNumber,
      ...(hasPullRequest ? { pull_request: { url: 'https://api.github.com/...' } } : {}),
    },
    repository: { full_name: 'octo/demo', owner: { login: ownerLogin } },
  };
}

function reviewComment(opts: { login?: string; authorAssociation?: string; body?: string; prNumber?: number; ownerLogin?: string } = {}): Record<string, unknown> {
  const {
    login = 'octocat',
    authorAssociation = 'OWNER',
    body = 'nit',
    prNumber = 42,
    ownerLogin = 'octocat',
  } = opts;
  return {
    action: 'created',
    comment: {
      id: 2000,
      body,
      user: { login, type: 'User' },
      author_association: authorAssociation,
    },
    pull_request: { number: prNumber },
    repository: { full_name: 'octo/demo', owner: { login: ownerLogin } },
  };
}

function checkRun(opts: { action?: string; prNumber?: number | null } = {}): Record<string, unknown> {
  const { action = 'completed', prNumber = 42 } = opts;
  return {
    action,
    check_run: {
      conclusion: 'failure',
      pull_requests: prNumber === null ? [] : [{ number: prNumber }],
    },
    repository: { full_name: 'octo/demo', owner: { login: 'octocat' } },
  };
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  eventType: string;
  payload: Record<string, unknown>;
  dbState?: DbState | undefined;
  expectedCode: WakeDecisionCode;
  expectedWake: boolean;
  expectedTier?: string | undefined;
}

const scenarios: Scenario[] = [
  // --- self_authored ---
  {
    name: 'issue_comment from our own bot (outbound id) → self_authored',
    eventType: 'issue_comment',
    payload: issueComment({ commentId: 9999 }),
    dbState: { outboundCommentIds: [9999], session: SESSION_FOR_PR },
    expectedCode: 'self_authored',
    expectedWake: false,
  },

  // --- wrong_event_type ---
  {
    name: 'push event → wrong_event_type',
    eventType: 'push',
    payload: { ref: 'refs/heads/main', repository: { full_name: 'octo/demo', owner: { login: 'octocat' } } },
    expectedCode: 'wrong_event_type',
    expectedWake: false,
  },

  // --- wrong_action ---
  {
    name: 'issue_comment action=deleted → wrong_action',
    eventType: 'issue_comment',
    payload: issueComment({ action: 'deleted' }),
    expectedCode: 'wrong_action',
    expectedWake: false,
  },
  {
    name: 'check_run action=requested → wrong_action',
    eventType: 'check_run',
    payload: checkRun({ action: 'requested' }),
    expectedCode: 'wrong_action',
    expectedWake: false,
  },

  // --- missing_trust_fields ---
  {
    name: 'issue_comment with no comment.user → missing_trust_fields',
    eventType: 'issue_comment',
    payload: {
      action: 'created',
      comment: { id: 1, body: 'hello', author_association: 'OWNER' },
      issue: { number: 42, pull_request: {} },
      repository: { full_name: 'octo/demo', owner: { login: 'octocat' } },
    },
    expectedCode: 'missing_trust_fields',
    expectedWake: false,
  },

  // --- tier_3_blocked ---
  {
    name: 'issue_comment from CONTRIBUTOR even with /agent → tier_3_blocked',
    eventType: 'issue_comment',
    payload: issueComment({
      login: 'stranger',
      authorAssociation: 'CONTRIBUTOR',
      body: '/agent please fix',
    }),
    expectedCode: 'tier_3_blocked',
    expectedWake: false,
    expectedTier: 'tier_3',
  },
  {
    name: 'issue_comment from NONE → tier_3_blocked',
    eventType: 'issue_comment',
    payload: issueComment({ login: 'rando', authorAssociation: 'NONE' }),
    expectedCode: 'tier_3_blocked',
    expectedWake: false,
    expectedTier: 'tier_3',
  },

  // --- tier_2_no_command ---
  {
    name: 'issue_comment from MEMBER without /agent prefix → tier_2_no_command',
    eventType: 'issue_comment',
    payload: issueComment({
      login: 'teammate',
      authorAssociation: 'MEMBER',
      body: 'looks good to me',
    }),
    expectedCode: 'tier_2_no_command',
    expectedWake: false,
    expectedTier: 'tier_2',
  },

  // --- pr_unresolved ---
  {
    name: 'issue_comment on an issue (no pull_request field) → pr_unresolved',
    eventType: 'issue_comment',
    payload: issueComment({ hasPullRequest: false }),
    dbState: { session: SESSION_FOR_PR },
    expectedCode: 'pr_unresolved',
    expectedWake: false,
    expectedTier: 'tier_1',
  },
  {
    name: 'check_run with empty pull_requests array → pr_unresolved',
    eventType: 'check_run',
    payload: checkRun({ prNumber: null }),
    expectedCode: 'pr_unresolved',
    expectedWake: false,
  },

  // --- no_session ---
  {
    name: 'wakeable issue_comment but no session bound to repo/PR → no_session',
    eventType: 'issue_comment',
    payload: issueComment({}),
    dbState: { session: null },
    expectedCode: 'no_session',
    expectedWake: false,
    expectedTier: 'tier_1',
  },
  {
    name: 'wakeable check_run completion but no session → no_session',
    eventType: 'check_run',
    payload: checkRun({}),
    dbState: { session: null },
    expectedCode: 'no_session',
    expectedWake: false,
  },

  // --- rate_limited ---
  {
    name: 'session exists but rate limit blocks → rate_limited',
    eventType: 'issue_comment',
    payload: issueComment({}),
    dbState: { session: SESSION_FOR_PR, rateLimitAllow: false },
    expectedCode: 'rate_limited',
    expectedWake: false,
    expectedTier: 'tier_1',
  },

  // --- wake (happy paths) ---
  {
    name: 'issue_comment from OWNER, session bound → wake (tier_1)',
    eventType: 'issue_comment',
    payload: issueComment({}),
    dbState: { session: SESSION_FOR_PR },
    expectedCode: 'wake',
    expectedWake: true,
    expectedTier: 'tier_1',
  },
  {
    name: 'issue_comment from github-actions[bot] → wake (tier_1)',
    eventType: 'issue_comment',
    payload: issueComment({
      login: 'github-actions[bot]',
      userType: 'Bot',
      authorAssociation: 'NONE',
    }),
    dbState: { session: SESSION_FOR_PR },
    expectedCode: 'wake',
    expectedWake: true,
    expectedTier: 'tier_1',
  },
  {
    name: 'issue_comment from MEMBER with /agent → wake (tier_2)',
    eventType: 'issue_comment',
    payload: issueComment({
      login: 'teammate',
      authorAssociation: 'MEMBER',
      body: '/agent rerun',
    }),
    dbState: { session: SESSION_FOR_PR },
    expectedCode: 'wake',
    expectedWake: true,
    expectedTier: 'tier_2',
  },
  {
    name: 'pull_request_review_comment from OWNER → wake (tier_1)',
    eventType: 'pull_request_review_comment',
    payload: reviewComment({}),
    dbState: { session: SESSION_FOR_PR },
    expectedCode: 'wake',
    expectedWake: true,
    expectedTier: 'tier_1',
  },
  {
    name: 'check_run failure completion → wake (n/a tier)',
    eventType: 'check_run',
    payload: checkRun({}),
    dbState: { session: SESSION_FOR_PR },
    expectedCode: 'wake',
    expectedWake: true,
    expectedTier: 'n/a',
  },
];

// ---------------------------------------------------------------------------
// Fixture loader for real captured payloads
// ---------------------------------------------------------------------------

/**
 * Discover paired `*.json` (payload) + `*.expect.json` (assertion config) in
 * the fixtures directory. The `.expect.json` sidecar has the shape:
 *   { eventType, expectedCode, expectedWake, expectedTier?, dbState? }
 * Fixtures without a sidecar are skipped (they're capture-only).
 */
function loadCapturedFixtures(): Scenario[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  const out: Scenario[] = [];
  for (const file of fs.readdirSync(FIXTURES_DIR)) {
    if (!file.endsWith('.json') || file.endsWith('.expect.json')) continue;
    const base = file.slice(0, -'.json'.length);
    const sidecarPath = path.join(FIXTURES_DIR, `${base}.expect.json`);
    if (!fs.existsSync(sidecarPath)) continue;
    const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'));
    const expect = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as {
      eventType: string;
      expectedCode: WakeDecisionCode;
      expectedWake: boolean;
      expectedTier?: string;
      dbState?: DbState;
    };
    out.push({
      name: `[fixture] ${base}`,
      eventType: expect.eventType,
      payload,
      dbState: expect.dbState,
      expectedCode: expect.expectedCode,
      expectedWake: expect.expectedWake,
      expectedTier: expect.expectedTier,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

describe('Tier 2: routing matrix', () => {
  const allScenarios = [...scenarios, ...loadCapturedFixtures()];

  let db: Database;
  let app: ReturnType<typeof createApp>;
  let enqueued: QueuedEvent[];

  beforeEach(() => {
    db = makeDb();
    enqueued = [];
    app = createApp({
      webhookSecret: WEBHOOK_SECRET,
      db,
      enqueue: (e) => { enqueued.push(e); },
      log: makeLogger(),
    });
  });

  for (const scenario of allScenarios) {
    it(scenario.name, async () => {
      // Re-seed DB for this scenario's state. createApp captured `db` from
      // beforeEach, but evaluateWakePolicy uses whatever db we pass below —
      // so we build a second db just for the wake-policy call.
      const policyDb = makeDb(scenario.dbState);

      const body = JSON.stringify(scenario.payload);
      const sig = signPayload(WEBHOOK_SECRET, body);

      const res = await app.request('/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': scenario.eventType,
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      // Every signed scenario must reach the enqueue path.
      expect(res.status).toBe(200);
      expect(enqueued).toHaveLength(1);

      const event = enqueued[0]!;
      const decision = evaluateWakePolicy(event, policyDb, config);

      expect(decision.decisionCode).toBe(scenario.expectedCode);
      expect(decision.wake).toBe(scenario.expectedWake);
      if (scenario.expectedTier !== undefined) {
        expect(decision.trustTier).toBe(scenario.expectedTier);
      }
    });
  }

  it('invalid JSON payload is rejected by evaluateWakePolicy directly', () => {
    // Server returns 400 before enqueue for invalid JSON, so we can't exercise
    // this path through createApp. We test the decision branch directly.
    const event: QueuedEvent = {
      id: 1,
      repo: 'octo/demo',
      prNumber: 42,
      eventType: 'issue_comment',
      payload: 'not-json{',
      source: 'webhook',
    };
    const decision = evaluateWakePolicy(event, makeDb(), config);
    expect(decision.decisionCode).toBe('invalid_payload');
    expect(decision.wake).toBe(false);
  });
});

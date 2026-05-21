/**
 * Tier 2 tests: ACP-layer fallback triggers for verifySession.
 *
 * Two trigger paths exercised here:
 *   A. Post-`sendPrompt` fast trigger fires when `injectPrompt` resolves.
 *   B. Inactivity watchdog runs verifySession before killing the subprocess,
 *      and respects the GitHub-outage path (does NOT write timeout_inactivity
 *      when verifier returned github_error).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { createVerifier } from '../../src/verify-session.js';
import type { GitHubClient, PullState, MergeResult } from '../../src/github.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

interface FakeGitHubClient extends GitHubClient {
  setPRState(repo: string, prNumber: number, state: PullState): void;
  failNextGetPullState(err: Error): void;
  getPullStateCalls: number;
}

function createFakeGitHubClient(): FakeGitHubClient {
  const states = new Map<string, PullState>();
  let nextError: Error | null = null;
  const self = {
    getPullStateCalls: 0,
    setPRState(repo, prNumber, state) {
      states.set(`${repo}#${prNumber}`, state);
    },
    failNextGetPullState(err) {
      nextError = err;
    },
    async getPullState(owner, repo, prNumber): Promise<PullState> {
      self.getPullStateCalls++;
      if (nextError !== null) {
        const err = nextError;
        nextError = null;
        throw err;
      }
      const key = `${owner}/${repo}#${prNumber}`;
      const found = states.get(key);
      if (!found) throw new Error(`fake: no state for ${key}`);
      return found;
    },
    async mergePullRequest(): Promise<MergeResult> {
      throw new Error('fake: mergePullRequest not used in these tests');
    },
  } satisfies FakeGitHubClient;
  return self;
}

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let github: FakeGitHubClient;
let mgr: SessionManager;

function makeManager(timeoutOverride?: { inactivityMinutes?: number; maxLifetimeMinutes?: number; gracePeriodAfterMergeSeconds?: number }) {
  const verify = createVerifier({ sessionFiles: sf, github, log });
  mgr = createSessionManager({
    db,
    sessionFiles: sf,
    acpSpawner: (sessionId: string) => {
      const cfg = kiro.spawnConfig();
      return spawnACPClient(cfg.command, cfg.args, {
        ...cfg.env,
        AGENT_ROUTER_SESSION_ID: sessionId,
      });
    },
    log,
    github,
    verify,
    sessionTimeout: {
      inactivityMinutes: timeoutOverride?.inactivityMinutes ?? 5,
      maxLifetimeMinutes: timeoutOverride?.maxLifetimeMinutes ?? 120,
      gracePeriodAfterMergeSeconds: timeoutOverride?.gracePeriodAfterMergeSeconds ?? 60,
    },
  });
}

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fallback-tier2-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
  github = createFakeGitHubClient();
});

afterEach(async () => {
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function readStreamEntries(streamPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(streamPath)) return [];
  return fs
    .readFileSync(streamPath, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('post-sendPrompt → verifySession fast trigger (Req 5.1)', () => {
  it('fires verifySession after injectPrompt resolves, writing termination_reason from GitHub state', async () => {
    makeManager();
    const h = await mgr.createSession('Ship feature');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 59);
    github.setPRState('agent-router/repo', 59, { number: 59, state: 'closed', merged: true, mergeCommitSha: 'abc' });

    await mgr.injectPrompt(h.sessionId, 'Final word', 'cli');

    // The verifier fires after sendPrompt resolves, async. Allow a tick.
    await new Promise((r) => setTimeout(r, 50));

    const meta = sf.readMeta(h.sessionId);
    expect(meta.termination_reason).toBe('merged');
    expect(meta.status).toBe('completed');
  }, 15_000);

  it('does not fire injectPrompt verification when no PRs are registered (no_prs)', async () => {
    makeManager();
    const h = await mgr.createSession('Investigate');
    await mgr.injectPrompt(h.sessionId, 'whatever', 'cli');
    await new Promise((r) => setTimeout(r, 50));

    const meta = sf.readMeta(h.sessionId);
    expect(meta.termination_reason).toBeUndefined();
    expect(meta.status).toBe('active');
  }, 15_000);

  it('leaves session active when registered PR is still open', async () => {
    makeManager();
    const h = await mgr.createSession('Open work');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 60);
    github.setPRState('agent-router/repo', 60, { number: 60, state: 'open', merged: false, mergeCommitSha: null });

    await mgr.injectPrompt(h.sessionId, 'check in', 'cli');
    await new Promise((r) => setTimeout(r, 50));

    const meta = sf.readMeta(h.sessionId);
    expect(meta.termination_reason).toBeUndefined();
    expect(meta.status).toBe('active');
  }, 15_000);
});

describe('inactivity watchdog → verifySession-first (Req 5.2)', () => {
  // Use very short inactivity window so tests run fast.
  // 0.05 min = 3 seconds — long enough for session setup, short enough for fast tests.
  const FAST_INACTIVITY = 0.05;

  it('verifies merged before timeout → writes completed:merged, not failed:timeout_inactivity', async () => {
    makeManager({ inactivityMinutes: FAST_INACTIVITY });
    const h = await mgr.createSession('Ship + idle');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 61);
    github.setPRState('agent-router/repo', 61, { number: 61, state: 'closed', merged: true, mergeCommitSha: 'sha' });

    // Wait past the inactivity window
    await new Promise((r) => setTimeout(r, 3500));

    const meta = sf.readMeta(h.sessionId);
    expect(meta.termination_reason).toBe('merged');
    expect(meta.status).toBe('completed');
  }, 15_000);

  it('open PR → watchdog falls through to existing failed:timeout_inactivity behavior', async () => {
    makeManager({ inactivityMinutes: FAST_INACTIVITY });
    const h = await mgr.createSession('Hung work');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 62);
    github.setPRState('agent-router/repo', 62, { number: 62, state: 'open', merged: false, mergeCommitSha: null });

    await new Promise((r) => setTimeout(r, 3500));

    const meta = sf.readMeta(h.sessionId);
    expect(meta.termination_reason).toBe('timeout_inactivity');
    expect(meta.status).toBe('failed');
  }, 15_000);

  it('no registered PRs → watchdog uses existing failed:timeout_inactivity', async () => {
    makeManager({ inactivityMinutes: FAST_INACTIVITY });
    const h = await mgr.createSession('No-PR work');

    await new Promise((r) => setTimeout(r, 3500));

    const meta = sf.readMeta(h.sessionId);
    expect(meta.termination_reason).toBe('timeout_inactivity');
    expect(meta.status).toBe('failed');
  }, 15_000);

  it('GitHub error during watchdog verify → session stays active, NOT marked failed', async () => {
    makeManager({ inactivityMinutes: FAST_INACTIVITY });
    const h = await mgr.createSession('Mid-outage');
    await mgr.registerPR(h.sessionId, 'agent-router/repo', 63);
    // Configure the fake to fail the first getPullState call only (the next watchdog cycle will succeed)
    github.setPRState('agent-router/repo', 63, { number: 63, state: 'open', merged: false, mergeCommitSha: null });
    github.failNextGetPullState(new Error('502 Bad Gateway'));

    await new Promise((r) => setTimeout(r, 3500));

    const meta = sf.readMeta(h.sessionId);
    // Critical assertion: session stays active despite the watchdog firing.
    // The GitHub error caused the watchdog to reset rather than mark failed.
    expect(meta.termination_reason).toBeUndefined();
    expect(meta.status).toBe('active');

    // The verification_failed stream entry should be present
    const entries = readStreamEntries(h.paths.stream);
    const failed = entries.find((e) => e['type'] === 'verification_failed');
    expect(failed).toBeDefined();
    expect(failed!['error']).toMatch(/502/);
  }, 15_000);
});

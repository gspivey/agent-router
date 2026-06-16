/**
 * Tier 2 tests: Check watchdog — nudge delivery on terminal checks,
 * no nudge while in-progress, best-effort on errors.
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
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
import { createGitHubClient, type GitHubClient } from '../../src/github.js';
import { createCheckWatchdog, type CheckWatchdog } from '../../src/check-watchdog.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { FakeGitHubBackend } from '../harness/fake-github.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SLOW_SCENARIO = path.resolve(__dirname, '../scenarios/slow-multi-prompt.json');

const WEBHOOK_SECRET = 'test-secret-watchdog';
const REPO = 'testowner/testrepo';

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let fakeGitHub: FakeGitHubBackend;
let github: GitHubClient;
let mgr: SessionManager;
let watchdog: CheckWatchdog;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-watchdog-tier2-'));
  const dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });

  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SLOW_SCENARIO);

  fakeGitHub = new FakeGitHubBackend(WEBHOOK_SECRET);
  await fakeGitHub.start();

  github = createGitHubClient({
    baseUrl: fakeGitHub.apiBaseUrl(),
    tokenResolver: () => 'fake-token',
    requestTimeoutMs: 3000,
  });

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
    sessionTimeout: {
      inactivityMinutes: 10,
      maxLifetimeMinutes: 120,
      gracePeriodAfterMergeSeconds: 60,
    },
  });

  watchdog = createCheckWatchdog({ github, sessionMgr: mgr, sessionFiles: sf, log });
});

afterEach(async () => {
  watchdog.stop();
  await mgr.shutdown();
  await db.shutdown();
  await fakeGitHub.stop();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('check watchdog — terminal checks deliver one wake (Req 4.1, 4.2, 4.3)', () => {
  it('injects a wake prompt when PR checks are all terminal', async () => {
    // 1. Create a session and register a PR
    const handle = await mgr.createSession('Fix CI', REPO);
    const prNumber = await fakeGitHub.createInitialPR(REPO, 'feat-branch', 'feat', 'body');
    await mgr.registerPR(handle.sessionId, REPO, prNumber);

    // 2. Silently set check runs as completed (simulates missed webhook)
    fakeGitHub.setCheckRunSilent(REPO, prNumber, 'typecheck', 'completed', 'success');
    fakeGitHub.setCheckRunSilent(REPO, prNumber, 'test', 'completed', 'success');

    // 3. Run watchdog poll
    await watchdog.poll();

    // 4. Check that a prompt was injected
    await sleep(100); // give turn queue time to deliver
    const prompts = fs.readFileSync(
      path.join(rootDir, 'sessions', handle.sessionId, 'prompts.log'),
      'utf-8',
    );
    const lines = prompts.trim().split('\n').map((l) => JSON.parse(l));
    // First prompt is the original CLI prompt; the second should be the watchdog nudge
    const nudgePrompt = lines.find((l: { source: string }) => l.source === 'router');
    expect(nudgePrompt).toBeDefined();
    expect(nudgePrompt.prompt).toContain('CI checks are green');
    expect(nudgePrompt.prompt).toContain(`PR #${prNumber}`);
  });

  it('does not inject duplicate wake for same (pr, headSha, conclusion)', async () => {
    const handle = await mgr.createSession('Fix CI', REPO);
    const prNumber = await fakeGitHub.createInitialPR(REPO, 'feat-dup', 'feat', 'body');
    await mgr.registerPR(handle.sessionId, REPO, prNumber);

    fakeGitHub.setCheckRunSilent(REPO, prNumber, 'test', 'completed', 'success');

    // Poll twice — should only nudge once
    await watchdog.poll();
    await sleep(50);
    await watchdog.poll();
    await sleep(50);

    const prompts = fs.readFileSync(
      path.join(rootDir, 'sessions', handle.sessionId, 'prompts.log'),
      'utf-8',
    );
    const lines = prompts.trim().split('\n').map((l) => JSON.parse(l));
    const nudges = lines.filter((l: { source: string }) => l.source === 'router');
    expect(nudges).toHaveLength(1);
  });
});

describe('check watchdog — in-progress checks (Req 4.5)', () => {
  it('does not inject a wake when checks are still in progress', async () => {
    const handle = await mgr.createSession('Fix CI', REPO);
    const prNumber = await fakeGitHub.createInitialPR(REPO, 'feat-inprog', 'in progress', 'body');
    await mgr.registerPR(handle.sessionId, REPO, prNumber);

    fakeGitHub.setCheckRunSilent(REPO, prNumber, 'typecheck', 'completed', 'success');
    fakeGitHub.setCheckRunSilent(REPO, prNumber, 'test', 'in_progress', null);

    await watchdog.poll();
    await sleep(50);

    const prompts = fs.readFileSync(
      path.join(rootDir, 'sessions', handle.sessionId, 'prompts.log'),
      'utf-8',
    );
    const lines = prompts.trim().split('\n').map((l) => JSON.parse(l));
    const nudges = lines.filter((l: { source: string }) => l.source === 'router');
    expect(nudges).toHaveLength(0);
  });
});

describe('check watchdog — GitHub error is best-effort (Req 4.6)', () => {
  it('logs error but does not crash or terminate session on GitHub failure', async () => {
    const handle = await mgr.createSession('Fix CI', REPO);
    await mgr.registerPR(handle.sessionId, REPO, 99);

    // PR 99 doesn't exist in fakeGitHub → will 404
    // The watchdog should log but not crash
    await expect(watchdog.poll()).resolves.toBeUndefined();

    // Session is still active
    expect(mgr.getActiveSession(handle.sessionId)).not.toBeNull();
  });
});

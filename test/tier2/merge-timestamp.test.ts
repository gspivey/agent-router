/**
 * Tier 2 test: merged_at timestamp is populated on PR entries when
 * verifySession determines a session's PRs have all been merged.
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

function createFakeGitHubClient() {
  const states = new Map<string, PullState>();
  return {
    setPRState(repo: string, prNumber: number, state: PullState) {
      states.set(`${repo}#${prNumber}`, state);
    },
    async getPullState(owner: string, repo: string, prNumber: number): Promise<PullState> {
      const key = `${owner}/${repo}#${prNumber}`;
      const found = states.get(key);
      if (!found) throw new Error(`fake: no state for ${key}`);
      return found;
    },
    async mergePullRequest(): Promise<MergeResult> {
      throw new Error('not used');
    },
  } satisfies GitHubClient & { setPRState: (r: string, n: number, s: PullState) => void };
}

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let github: ReturnType<typeof createFakeGitHubClient>;
let mgr: SessionManager;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ts-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
  github = createFakeGitHubClient();

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
  });
});

afterEach(async () => {
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('merged_at population via verifySession (P2.2)', () => {
  it('sets merged_at on all PR entries when all PRs are merged', async () => {
    const h = await mgr.createSession('Ship PR');
    await mgr.registerPR(h.sessionId, 'owner/repo', 42);
    github.setPRState('owner/repo', 42, { number: 42, state: 'closed', merged: true, mergeCommitSha: 'abc' });

    // Trigger verify via injectPrompt (post-sendPrompt fast trigger)
    await mgr.injectPrompt(h.sessionId, 'CI passed', 'webhook');
    await new Promise((r) => setTimeout(r, 100));

    const meta = sf.readMeta(h.sessionId);
    expect(meta.termination_reason).toBe('merged');
    expect(meta.prs[0]!.merged_at).toBeDefined();
    expect(typeof meta.prs[0]!.merged_at).toBe('number');
    expect(meta.prs[0]!.merged_at).toBeGreaterThan(0);
  }, 15_000);

  it('does not set merged_at when PR is closed without merge', async () => {
    const h = await mgr.createSession('Closed PR');
    await mgr.registerPR(h.sessionId, 'owner/repo', 99);
    github.setPRState('owner/repo', 99, { number: 99, state: 'closed', merged: false, mergeCommitSha: null });

    await mgr.injectPrompt(h.sessionId, 'PR closed', 'webhook');
    await new Promise((r) => setTimeout(r, 100));

    const meta = sf.readMeta(h.sessionId);
    expect(meta.termination_reason).toBe('closed_without_merge');
    expect(meta.prs[0]!.merged_at).toBeUndefined();
  }, 15_000);
});

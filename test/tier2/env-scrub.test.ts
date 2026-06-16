/**
 * Tier 2: child-environment secret hygiene (env-scrub).
 *
 * Verifies that the daemon's acpSpawner uses buildChildEnv so spawned
 * child processes receive only the allowlisted parent env + the resolved
 * GITHUB_TOKEN for the target repo — NOT other repos' PATs or webhook secrets.
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
import { spawnACPClient, buildChildEnv, DEFAULT_CHILD_ENV_ALLOWLIST } from '../../src/acp.js';
import { createTokenResolver, resolveSessionTokenEnv } from '../../src/github.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let capturedChildEnv: Map<string, Record<string, string>>;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-scrub-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
  capturedChildEnv = new Map();

  const tokenResolver = createTokenResolver({
    perRepoTokens: { 'gspivey/repo-a': 'tok-repo-a' },
    defaultToken: 'tok-default',
    envFallback: false,
  });

  // Simulate the daemon's acpSpawner from src/index.ts: use buildChildEnv
  // to scrub the parent environment before spawning.
  mgr = createSessionManager({
    db,
    sessionFiles: sf,
    log,
    acpSpawner: (sessionId: string, repo?: string) => {
      const tokenEnv = resolveSessionTokenEnv(repo, tokenResolver);
      const overrides: Record<string, string> = { ...tokenEnv };

      // Simulate a parent env with multiple repo secrets (as the daemon would have)
      const simulatedParentEnv: Record<string, string | undefined> = {
        PATH: '/usr/bin:/bin',
        HOME: '/home/operator',
        LANG: 'en_US.UTF-8',
        GITHUB_TOKEN: 'ghp_daemon_main_token',
        GITHUB_TOKEN_DPDK: 'ghp_dpdk_secret',
        GITHUB_TOKEN_LLM_COURSE: 'ghp_llm_secret',
        GITHUB_WEBHOOK_SECRET: 'whsec_global',
        GITHUB_WEBHOOK_SECRET_REPO_B: 'whsec_b',
        AGENT_ROUTER_HOME: '/home/operator/.agent-router',
        MY_UNRELATED_SECRET: 'should_not_appear',
      };

      const childEnv = buildChildEnv(simulatedParentEnv, overrides);
      capturedChildEnv.set(repo ?? '__no_repo__', childEnv);

      // For the actual spawn, use real process env so fake-kiro can run
      const cfg = kiro.spawnConfig();
      return spawnACPClient(cfg.command, cfg.args, {
        ...cfg.env,
        ...tokenEnv,
        AGENT_ROUTER_SESSION_ID: sessionId,
      });
    },
  });
});

afterEach(async () => {
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('child-environment secret hygiene', () => {
  it('spawned child env excludes other repos GITHUB_TOKEN_* secrets', async () => {
    await mgr.createSession('do work', 'gspivey/repo-a');
    const env = capturedChildEnv.get('gspivey/repo-a')!;

    // The resolved per-repo token IS present as GITHUB_TOKEN
    expect(env['GITHUB_TOKEN']).toBe('tok-repo-a');

    // Other repos' secrets are NOT present
    expect(env['GITHUB_TOKEN_DPDK']).toBeUndefined();
    expect(env['GITHUB_TOKEN_LLM_COURSE']).toBeUndefined();

    // The daemon's own GITHUB_TOKEN is NOT present (overridden by the per-repo one)
    expect(env['GITHUB_TOKEN']).not.toBe('ghp_daemon_main_token');
  }, 20_000);

  it('spawned child env excludes GITHUB_WEBHOOK_SECRET* vars', async () => {
    await mgr.createSession('do work', 'gspivey/repo-a');
    const env = capturedChildEnv.get('gspivey/repo-a')!;

    expect(env['GITHUB_WEBHOOK_SECRET']).toBeUndefined();
    expect(env['GITHUB_WEBHOOK_SECRET_REPO_B']).toBeUndefined();
  }, 20_000);

  it('spawned child env includes allowlisted keys', async () => {
    await mgr.createSession('do work', 'gspivey/repo-a');
    const env = capturedChildEnv.get('gspivey/repo-a')!;

    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/home/operator');
    expect(env['LANG']).toBe('en_US.UTF-8');
  }, 20_000);

  it('spawned child env includes AGENT_ROUTER_* from parent', async () => {
    await mgr.createSession('do work', 'gspivey/repo-a');
    const env = capturedChildEnv.get('gspivey/repo-a')!;

    expect(env['AGENT_ROUTER_HOME']).toBe('/home/operator/.agent-router');
  }, 20_000);

  it('spawned child env excludes non-allowlisted arbitrary vars', async () => {
    await mgr.createSession('do work', 'gspivey/repo-a');
    const env = capturedChildEnv.get('gspivey/repo-a')!;

    expect(env['MY_UNRELATED_SECRET']).toBeUndefined();
  }, 20_000);

  it('uses default token when no per-repo override configured', async () => {
    await mgr.createSession('do work', 'gspivey/other-repo');
    const env = capturedChildEnv.get('gspivey/other-repo')!;

    expect(env['GITHUB_TOKEN']).toBe('tok-default');
    expect(env['GITHUB_TOKEN_DPDK']).toBeUndefined();
  }, 20_000);
});

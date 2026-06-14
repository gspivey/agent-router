/**
 * Tier 2 test: per-repo GitHub token injection into spawned sessions.
 *
 * Regression test for the bug where the daemon resolved per-repo tokens for its
 * own API calls but never injected them into the spawned agent session — the
 * child inherited whatever GITHUB_TOKEN the daemon process held, so a session
 * for repo A ran with repo B's token and hit 403s on push.
 *
 * This reconstructs the daemon's `acpSpawner` wiring from src/index.ts
 * (resolveSessionTokenEnv + spawnACPClient) and asserts the correct per-repo
 * token is composed into the child environment as GITHUB_TOKEN.
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
let capturedTokenEnv: Map<string, Record<string, string>>;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-inject-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
  capturedTokenEnv = new Map();

  // Mirror the daemon's acpSpawner wiring in src/index.ts: resolve the
  // repo-specific token and inject it as GITHUB_TOKEN into the child env.
  const tokenResolver = createTokenResolver({
    perRepoTokens: { 'gspivey/edit-director': 'tok-edit-director' },
    defaultToken: 'tok-default',
    envFallback: false,
  });

  mgr = createSessionManager({
    db,
    sessionFiles: sf,
    log,
    acpSpawner: (sessionId: string, repo?: string) => {
      const tokenEnv = resolveSessionTokenEnv(repo, tokenResolver);
      if (repo !== undefined) capturedTokenEnv.set(repo, tokenEnv);
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

describe('per-repo GitHub token injection into spawned sessions', () => {
  it('injects the configured per-repo token as GITHUB_TOKEN', async () => {
    await mgr.createSession('do work', 'gspivey/edit-director');
    expect(capturedTokenEnv.get('gspivey/edit-director')).toEqual({
      GITHUB_TOKEN: 'tok-edit-director',
    });
  }, 20_000);

  it('injects the default token for a repo with no per-repo override', async () => {
    await mgr.createSession('do work', 'gspivey/agent-router');
    expect(capturedTokenEnv.get('gspivey/agent-router')).toEqual({
      GITHUB_TOKEN: 'tok-default',
    });
  }, 20_000);
});

/**
 * Tier 2: Session read_repos parsing — metadata storage and IPC access.
 *
 * Verifies that:
 * - read_repos parsed from prompt YAML frontmatter is stored in session metadata
 * - read_repos passed as explicit parameter is stored in session metadata
 * - Explicit parameter overrides frontmatter
 * - Invalid repos are filtered out
 * - read_repos is accessible via IPC (new_session with read_repos param)
 * - read_repos from frontmatter works through IPC new_session flow
 *
 * Feature: auth-credential-proxy, Task 11.4
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
import { createCliServer, type CliServer } from '../../src/cli-server.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { TestCli } from '../harness/test-cli.js';
import { Secret } from '../../src/secret.js';
import type { TokenStore, ProjectEntry, TokenMap } from '../../src/token-store.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let rootDir: string;
let socketPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-repos-tier2-'));
  socketPath = path.join(rootDir, 'sock');
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
});

afterEach(async () => {
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function createMockTokenStore(projects: Record<string, { token: string; repos: string[] }>): TokenStore {
  const projectEntries = new Map<string, ProjectEntry>();
  const repoIndex = new Map<string, string>();

  for (const [name, entry] of Object.entries(projects)) {
    projectEntries.set(name, {
      name,
      token: Secret.of(entry.token),
      repos: entry.repos,
      expiresAt: undefined,
    });
    for (const repo of entry.repos) {
      repoIndex.set(repo, name);
    }
  }

  const tokenMap: TokenMap = { projects: projectEntries, repoIndex };

  return {
    getToken(projectName: string) { return projectEntries.get(projectName)?.token; },
    getProject(projectName: string) { return projectEntries.get(projectName); },
    findProjectByRepo(repo: string) { return repoIndex.get(repo); },
    getTokenMap() { return tokenMap; },
    reload() { return false; },
    startWatching() {},
    stopWatching() {},
  };
}

function makeSpawner(kiroBackend: FakeKiroBackend) {
  return (sessionId: string, _repo?: string) => {
    const cfg = kiroBackend.spawnConfig();
    return spawnACPClient(cfg.command, cfg.args, {
      ...cfg.env,
      AGENT_ROUTER_SESSION_ID: sessionId,
    });
  };
}

describe('read_repos stored in session metadata (direct createSession)', () => {
  it('stores read_repos from prompt YAML frontmatter', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    const prompt = '---\nread_repos:\n  - other-org/read-only-repo\n  - another/context-repo\n---\nFix the bug';
    const handle = await mgr.createSession(prompt, 'testowner/testrepo');

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project_read_repos).toEqual([
      'other-org/read-only-repo',
      'another/context-repo',
    ]);

    await mgr.shutdown();
  }, 20_000);

  it('stores read_repos from explicit parameter', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    const handle = await mgr.createSession(
      'Fix the bug',
      'testowner/testrepo',
      ['explicit/read-repo', 'another/explicit'],
    );

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project_read_repos).toEqual([
      'explicit/read-repo',
      'another/explicit',
    ]);

    await mgr.shutdown();
  }, 20_000);

  it('explicit parameter overrides frontmatter', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    const prompt = '---\nread_repos:\n  - frontmatter/repo\n---\nwork';
    const handle = await mgr.createSession(
      prompt,
      'testowner/testrepo',
      ['explicit/wins'],
    );

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project_read_repos).toEqual(['explicit/wins']);

    await mgr.shutdown();
  }, 20_000);

  it('filters out invalid repos and stores only valid ones', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    const prompt = '---\nread_repos:\n  - valid/repo\n  - not a repo\n  - another/good\n---\nwork';
    const handle = await mgr.createSession(prompt, 'testowner/testrepo');

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project_read_repos).toEqual(['valid/repo', 'another/good']);

    await mgr.shutdown();
  }, 20_000);

  it('does not set bound_project_read_repos when no read_repos found', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    const handle = await mgr.createSession('plain prompt', 'testowner/testrepo');

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project_read_repos).toBeUndefined();

    await mgr.shutdown();
  }, 20_000);

  it('stores read_repos even without a bound project (standalone session)', async () => {
    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      // No tokenStore
    });

    const prompt = '---\nread_repos:\n  - org/read-repo\n---\nAnalyze this repo';
    const handle = await mgr.createSession(prompt);

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project).toBeUndefined();
    expect(meta.bound_project_read_repos).toEqual(['org/read-repo']);

    await mgr.shutdown();
  }, 20_000);
});

describe('read_repos via IPC new_session', () => {
  it('stores read_repos passed as IPC parameter', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    const cliServer = createCliServer({
      socketPath,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
    });
    await cliServer.start();

    try {
      const cli = new TestCli(socketPath);
      const result = await cli.send<{ session_id: string }>({
        op: 'new_session',
        prompt: 'fix the bug',
        repo: 'testowner/testrepo',
        read_repos: ['other/read-repo', 'context/repo'],
      });

      expect(result.session_id).toBeDefined();
      const meta = sf.readMeta(result.session_id);
      expect(meta.bound_project_read_repos).toEqual(['other/read-repo', 'context/repo']);
    } finally {
      await cliServer.shutdown();
      await mgr.shutdown();
    }
  }, 20_000);

  it('stores read_repos from prompt frontmatter via IPC', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    const cliServer = createCliServer({
      socketPath,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
    });
    await cliServer.start();

    try {
      const cli = new TestCli(socketPath);
      const prompt = '---\nread_repos:\n  - docs/repo\n---\nReview docs';
      const result = await cli.send<{ session_id: string }>({
        op: 'new_session',
        prompt,
        repo: 'testowner/testrepo',
      });

      expect(result.session_id).toBeDefined();
      const meta = sf.readMeta(result.session_id);
      expect(meta.bound_project_read_repos).toEqual(['docs/repo']);
    } finally {
      await cliServer.shutdown();
      await mgr.shutdown();
    }
  }, 20_000);
});

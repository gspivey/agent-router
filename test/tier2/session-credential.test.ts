/**
 * Tier 2: Session credential injection and Bound_Project resolution.
 *
 * Verifies that createSessionManager's createSession method:
 * - Resolves Bound_Project from Token_Store when tokenStore is provided
 * - Records bound_project, bound_project_repos, credential_mode in session metadata
 * - Rejects session creation for repos not in any project
 * - Provides boundProject/boundProjectRepos on the SessionHandle
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
import { Secret } from '../../src/secret.js';
import type { TokenStore, ProjectEntry, TokenMap } from '../../src/token-store.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-credential-tier2-'));
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

/**
 * Create a mock TokenStore with the given project → repos mapping.
 */
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

  const tokenMap: TokenMap = {
    projects: projectEntries,
    repoIndex,
  };

  return {
    getToken(projectName: string): Secret | undefined {
      return projectEntries.get(projectName)?.token;
    },
    getProject(projectName: string): ProjectEntry | undefined {
      return projectEntries.get(projectName);
    },
    findProjectByRepo(repo: string): string | undefined {
      return repoIndex.get(repo);
    },
    getTokenMap(): TokenMap {
      return tokenMap;
    },
    reload(): boolean {
      return false;
    },
    startWatching(): void {},
    stopWatching(): void {},
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

describe('session credential injection (Bound_Project resolution)', () => {
  it('records bound_project and bound_project_repos in session metadata for env mode', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test123', repos: ['testowner/testrepo', 'testowner/other'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    const handle = await mgr.createSession('fix CI', 'testowner/testrepo');
    expect(handle.boundProject).toBe('my-project');
    expect(handle.boundProjectRepos).toEqual(['testowner/testrepo', 'testowner/other']);

    // Verify metadata on disk
    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project).toBe('my-project');
    expect(meta.bound_project_repos).toEqual(['testowner/testrepo', 'testowner/other']);
    expect(meta.credential_mode).toBe('env');

    await mgr.shutdown();
  }, 20_000);

  it('records credential_mode as mcp when credentialMode is mcp', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test456', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'mcp',
    });

    const handle = await mgr.createSession('fix CI', 'testowner/testrepo');
    expect(handle.boundProject).toBe('my-project');

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.credential_mode).toBe('mcp');

    await mgr.shutdown();
  }, 20_000);

  it('rejects session creation for unknown repo (not in any project)', async () => {
    const tokenStore = createMockTokenStore({
      'my-project': { token: 'ghp_test789', repos: ['testowner/testrepo'] },
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      tokenStore,
      credentialMode: 'env',
    });

    await expect(
      mgr.createSession('fix CI', 'unknown-owner/unknown-repo')
    ).rejects.toThrow(/not present in any project/);

    await mgr.shutdown();
  }, 20_000);

  it('does not set bound_project when tokenStore is not provided', async () => {
    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log,
      acpSpawner: makeSpawner(kiro),
      // No tokenStore
    });

    const handle = await mgr.createSession('fix CI', 'testowner/testrepo');
    expect(handle.boundProject).toBeUndefined();
    expect(handle.boundProjectRepos).toBeUndefined();

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project).toBeUndefined();
    expect(meta.bound_project_repos).toBeUndefined();
    expect(meta.credential_mode).toBeUndefined();

    await mgr.shutdown();
  }, 20_000);

  it('does not resolve bound_project when repo is not provided', async () => {
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

    // No repo — e.g., a standalone prompt session
    const handle = await mgr.createSession('think about architecture');
    expect(handle.boundProject).toBeUndefined();
    expect(handle.boundProjectRepos).toBeUndefined();

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.bound_project).toBeUndefined();

    await mgr.shutdown();
  }, 20_000);
});

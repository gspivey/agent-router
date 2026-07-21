/**
 * Tier 2: IPC contract tests for credential ops.
 *
 * Tests the `get_session_project` and `get_token` IPC operations against a
 * real createCliServer with a real session manager and token store.
 *
 * Validates:
 * - get_session_project returns correct Bound_Project, repos, and read_repos
 * - get_token returns valid token response with expires_at field
 * - get_token's expires_at field reflects tokens.json's expires_at value
 * - Error responses for unknown session/project
 *
 * Requirements: 7.3
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as url from 'node:url';
import { createCliServer, type CliServer } from '../../src/cli-server.js';
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
let socketPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let cliServer: CliServer;
let tokenStore: TokenStore;

const TEST_EXPIRY = new Date('2027-06-15T00:00:00.000Z');

function createMockTokenStore(projects: Record<string, { token: string; repos: string[]; expiresAt?: Date }>): TokenStore {
  const projectEntries = new Map<string, ProjectEntry>();
  const repoIndex = new Map<string, string>();

  for (const [name, entry] of Object.entries(projects)) {
    projectEntries.set(name, {
      name,
      token: Secret.of(entry.token),
      repos: entry.repos,
      expiresAt: entry.expiresAt,
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

function sendRaw(sock: string, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(msg) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        socket.destroy();
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    socket.on('error', reject);
    socket.on('close', () => {
      if (buffer.trim()) {
        try {
          resolve(JSON.parse(buffer.trim()) as Record<string, unknown>);
        } catch {
          reject(new Error('Socket closed without valid response'));
        }
      }
    });
  });
}

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-contract-tier2-'));
  socketPath = path.join(rootDir, 'sock');
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);

  tokenStore = createMockTokenStore({
    'my-project': {
      token: 'ghp_test_token_12345',
      repos: ['org/repo-a', 'org/repo-b'],
      expiresAt: TEST_EXPIRY,
    },
    'other-project': {
      token: 'ghp_other_token_67890',
      repos: ['other/repo-c'],
    },
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
    tokenStore,
    credentialMode: 'mcp',
  });

  cliServer = createCliServer({
    socketPath,
    sessionMgr: mgr,
    sessionFiles: sf,
    log,
    tokenStore,
  });
  await cliServer.start();
});

afterEach(async () => {
  await cliServer.shutdown();
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('get_session_project IPC op', () => {
  it('returns project, repos, and read_repos for an active session', async () => {
    // Create a session bound to org/repo-a (which is in my-project)
    const handle = await mgr.createSession('Fix the bug in org/repo-a', 'org/repo-a');

    const result = await sendRaw(socketPath, {
      op: 'get_session_project',
      session_id: handle.sessionId,
    });

    expect(result['error']).toBeUndefined();
    expect(result['project']).toBe('my-project');
    expect(result['repos']).toEqual(['org/repo-a', 'org/repo-b']);
    expect(result['read_repos']).toEqual([]);
  }, 15_000);

  it('returns read_repos when session has them', async () => {
    // Create session with explicit read_repos
    const prompt = '---\nread_repos:\n  - external/docs\n---\nFix the bug';
    const handle = await mgr.createSession(prompt, 'org/repo-a', ['external/docs']);

    const result = await sendRaw(socketPath, {
      op: 'get_session_project',
      session_id: handle.sessionId,
    });

    expect(result['error']).toBeUndefined();
    expect(result['project']).toBe('my-project');
    expect(result['repos']).toEqual(['org/repo-a', 'org/repo-b']);
    expect(result['read_repos']).toEqual(['external/docs']);
  }, 15_000);

  it('returns error for unknown session_id', async () => {
    const result = await sendRaw(socketPath, {
      op: 'get_session_project',
      session_id: 'non-existent-session-id',
    });

    expect(result['error']).toBeDefined();
    expect(typeof result['error']).toBe('string');
    expect(String(result['error'])).toContain('not found');
  });

  it('returns error when session_id is missing', async () => {
    const result = await sendRaw(socketPath, {
      op: 'get_session_project',
    });

    expect(result['error']).toBeDefined();
    expect(String(result['error'])).toMatch(/session_id/i);
  });

  it('returns error for session without bound project', async () => {
    // Create a session manager without tokenStore so no project is bound
    const mgrNoBound = createSessionManager({
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
    });

    // Create another CLI server with that manager to test the edge case
    const socketPath2 = path.join(rootDir, 'sock2');
    const cliServer2 = createCliServer({
      socketPath: socketPath2,
      sessionMgr: mgrNoBound,
      sessionFiles: sf,
      log,
      tokenStore,
    });
    await cliServer2.start();

    try {
      const handle = await mgrNoBound.createSession('Do something');
      const result = await sendRaw(socketPath2, {
        op: 'get_session_project',
        session_id: handle.sessionId,
      });

      expect(result['error']).toBeDefined();
      expect(String(result['error'])).toContain('no bound project');
    } finally {
      await cliServer2.shutdown();
      await mgrNoBound.shutdown();
    }
  }, 15_000);
});

describe('get_token IPC op', () => {
  it('returns token and expires_at for a known project', async () => {
    const result = await sendRaw(socketPath, {
      op: 'get_token',
      project: 'my-project',
    });

    expect(result['error']).toBeUndefined();
    expect(result['token']).toBe('ghp_test_token_12345');
    expect(result['expires_at']).toBe(TEST_EXPIRY.toISOString());
  });

  it('returns expires_at as null when project has no expiry', async () => {
    const result = await sendRaw(socketPath, {
      op: 'get_token',
      project: 'other-project',
    });

    expect(result['error']).toBeUndefined();
    expect(result['token']).toBe('ghp_other_token_67890');
    expect(result['expires_at']).toBeNull();
  });

  it('returns error for unknown project', async () => {
    const result = await sendRaw(socketPath, {
      op: 'get_token',
      project: 'non-existent-project',
    });

    expect(result['error']).toBeDefined();
    expect(typeof result['error']).toBe('string');
    expect(String(result['error'])).toContain('non-existent-project');
  });

  it('returns error when project param is missing', async () => {
    const result = await sendRaw(socketPath, {
      op: 'get_token',
    });

    expect(result['error']).toBeDefined();
    expect(String(result['error'])).toMatch(/project/i);
  });

  it('returns error when token store is not configured', async () => {
    // Create a CLI server without tokenStore
    const socketPath3 = path.join(rootDir, 'sock3');
    const cliServer3 = createCliServer({
      socketPath: socketPath3,
      sessionMgr: mgr,
      sessionFiles: sf,
      log,
      // no tokenStore
    });
    await cliServer3.start();

    try {
      const result = await sendRaw(socketPath3, {
        op: 'get_token',
        project: 'my-project',
      });

      expect(result['error']).toBeDefined();
      expect(String(result['error'])).toContain('not configured');
    } finally {
      await cliServer3.shutdown();
    }
  });

  it('expires_at reflects the tokens.json value exactly', async () => {
    // This verifies Tier 2 requirement: get_token's expires_at reflects tokens.json's expires_at
    const result = await sendRaw(socketPath, {
      op: 'get_token',
      project: 'my-project',
    });

    // expires_at should be the ISO string of the configured Date
    expect(result['expires_at']).toBe('2027-06-15T00:00:00.000Z');
  });
});

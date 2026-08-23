/**
 * Tier 2 test: GET /repos/sessions and GET /repos/:repo/sessions endpoints.
 * Validates ROADMAP item #51 (tasks 3, 4).
 *
 * Properties tested:
 * - Response shape is { repos: RepoGroup[] }
 * - Grouped response includes all configured repos
 * - Active sessions appear in active_sessions, terminal in terminal_sessions
 * - per_repo_limit is respected
 * - /repos/:repo/sessions returns paginated terminal sessions for a single repo
 * - Unknown repo returns 404
 * - Auth is enforced on both endpoints
 * - Invalid params return 400
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { createSessionFiles } from '../../src/session-files.js';
import type { SessionFiles } from '../../src/session-files.js';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';
import { createDaemonTokenStore } from '../../src/daemon-token.js';
import type { DaemonTokenStore } from '../../src/daemon-token.js';
import { createSSEBroker } from '../../src/sse-broker.js';
import type { SSEBroker } from '../../src/sse-broker.js';
import { createWebApp, startWebServer } from '../../src/web-server.js';
import type { SessionManager } from '../../src/session-mgr.js';
import type { AgentRouterConfig } from '../../src/config.js';
import type { Database, CronState } from '../../src/db.js';
import type { ServerType } from '@hono/node-server';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = (addr as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function stubSessionMgr(): SessionManager {
  return {
    getActiveSession: () => undefined,
    hasActiveSessionForRepo: () => false,
    listActiveSessions: () => [],
    injectPrompt: async () => {},
    terminateSession: async () => {},
    createSession: async () => ({ sessionId: '', sessionDir: '' }),
    registerPR: () => {},
    shutdown: async () => {},
    completeSession: async () => {},
  } as unknown as SessionManager;
}

function stubDb(cronStates: CronState[] = []): Database {
  return {
    getAllCronStates: () => cronStates,
  } as unknown as Database;
}

describe('GET /repos/sessions grouped endpoint (item #51, tasks 3-4)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;
  let token: string;
  let config: AgentRouterConfig;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-repos-tier2-'));
    sessionFiles = createSessionFiles(rootDir);
    log = createLogger({ level: 'error', output: () => {} });
    tokenStore = createDaemonTokenStore({ rootDir, log });
    sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
    controlPort = await getFreePort();
    token = tokenStore.read();

    config = {
      port: 9999,
      controlPort,
      bindPublic: false,
      repos: [
        { owner: 'org', name: 'alpha' },
        { owner: 'org', name: 'beta' },
      ],
      cron: [
        { name: 'nightly-alpha', schedule: '0 3 * * *', repo: 'org/alpha', promptFile: '/tmp/p.md' },
      ],
      sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
      rateLimit: { perPRSeconds: 60 },
    } as AgentRouterConfig;

    const db = stubDb([]);
    const app = createWebApp({
      sessionMgr: stubSessionMgr(),
      sessionFiles,
      sseBroker,
      tokenStore,
      log,
      rootDir,
      config,
      shuttingDown: () => false,
      db,
    });
    webServer = startWebServer(app, config, log);
  });

  afterEach(() => {
    if (webServer) webServer.close();
    sseBroker.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function seedSession(id: string, repo: string, status: 'active' | 'completed' | 'failed', createdAt: number): void {
    sessionFiles.createSession(id, 'test prompt');
    sessionFiles.updateMeta(id, { repo });
    if (status !== 'active') {
      sessionFiles.updateMeta(id, { status, completed_at: createdAt + 100, termination_reason: 'completed' });
    }
    // Patch created_at
    const metaPath = path.join(rootDir, 'sessions', id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.created_at = createdAt;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  }

  async function fetchReposSessions(params = ''): Promise<Response> {
    return fetch(`http://127.0.0.1:${controlPort}/repos/sessions${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function fetchRepoSessions(repo: string, params = ''): Promise<Response> {
    return fetch(`http://127.0.0.1:${controlPort}/repos/${encodeURIComponent(repo)}/sessions${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it('returns grouped response with all configured repos', async () => {
    const res = await fetchReposSessions();
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: Array<{ repo: string }> };
    expect(body.repos.length).toBe(2);
    expect(body.repos[0]!.repo).toBe('org/alpha');
    expect(body.repos[1]!.repo).toBe('org/beta');
  });

  it('response shape includes all RepoGroup fields', async () => {
    seedSession('s1', 'org/alpha', 'active', 2000);
    seedSession('s2', 'org/alpha', 'completed', 1000);

    const res = await fetchReposSessions();
    const body = await res.json() as { repos: Array<Record<string, unknown>> };
    const alpha = body.repos[0]!;

    expect(alpha).toHaveProperty('repo', 'org/alpha');
    expect(alpha).toHaveProperty('active_sessions');
    expect(alpha).toHaveProperty('terminal_sessions');
    expect(alpha).toHaveProperty('terminal_total');
    expect(alpha).toHaveProperty('cron');
    expect(alpha).toHaveProperty('open_pr_count');
    expect(alpha).toHaveProperty('closed_pr_count');

    const activeSessions = alpha['active_sessions'] as Array<Record<string, unknown>>;
    expect(activeSessions.length).toBe(1);
    expect(activeSessions[0]!['session_id']).toBe('s1');

    const terminalSessions = alpha['terminal_sessions'] as Array<Record<string, unknown>>;
    expect(terminalSessions.length).toBe(1);
    expect(terminalSessions[0]!['session_id']).toBe('s2');
    expect(alpha['terminal_total']).toBe(1);
  });

  it('includes cron info for repos with cron entries', async () => {
    const res = await fetchReposSessions();
    const body = await res.json() as { repos: Array<{ repo: string; cron: { name: string; schedule: string; paused: boolean; next_fire: string | null } | null }> };
    const alpha = body.repos.find(r => r.repo === 'org/alpha')!;
    const beta = body.repos.find(r => r.repo === 'org/beta')!;

    expect(alpha.cron).not.toBeNull();
    expect(alpha.cron!.name).toBe('nightly-alpha');
    expect(alpha.cron!.schedule).toBe('0 3 * * *');
    expect(alpha.cron!.paused).toBe(false);
    expect(alpha.cron!.next_fire).not.toBeNull();

    expect(beta.cron).toBeNull();
  });

  it('respects per_repo_limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      seedSession(`c-${i}`, 'org/alpha', 'completed', 1000 - i);
    }

    const res = await fetchReposSessions('?per_repo_limit=3');
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: Array<{ terminal_sessions: unknown[]; terminal_total: number }> };
    const alpha = body.repos[0]!;
    expect(alpha.terminal_sessions.length).toBe(3);
    expect(alpha.terminal_total).toBe(10);
  });

  it('returns 400 for invalid per_repo_limit', async () => {
    const res = await fetchReposSessions('?per_repo_limit=0');
    expect(res.status).toBe(400);

    const res2 = await fetchReposSessions('?per_repo_limit=51');
    expect(res2.status).toBe(400);

    const res3 = await fetchReposSessions('?per_repo_limit=abc');
    expect(res3.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await fetch(`http://127.0.0.1:${controlPort}/repos/sessions`);
    expect(res.status).toBe(401);
  });

  // --- GET /repos/:repo/sessions ---

  it('returns paginated terminal sessions for a specific repo', async () => {
    for (let i = 0; i < 8; i++) {
      seedSession(`t-${i}`, 'org/alpha', 'completed', 1000 - i);
    }
    seedSession('active-1', 'org/alpha', 'active', 2000);

    const res = await fetchRepoSessions('org/alpha', '?limit=3&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json() as { repo: string; sessions: unknown[]; total: number; offset: number; limit: number };
    expect(body.repo).toBe('org/alpha');
    expect(body.sessions.length).toBe(3);
    expect(body.total).toBe(8); // only terminal sessions, not active
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(3);
  });

  it('paginates correctly with offset', async () => {
    for (let i = 0; i < 8; i++) {
      seedSession(`p-${i}`, 'org/alpha', 'completed', 1000 - i);
    }

    const page1 = await fetchRepoSessions('org/alpha', '?limit=3&offset=0');
    const page2 = await fetchRepoSessions('org/alpha', '?limit=3&offset=3');
    const body1 = await page1.json() as { sessions: Array<{ session_id: string }> };
    const body2 = await page2.json() as { sessions: Array<{ session_id: string }> };

    const ids1 = body1.sessions.map(s => s.session_id);
    const ids2 = body2.sessions.map(s => s.session_id);
    const overlap = ids1.filter(id => ids2.includes(id));
    expect(overlap.length).toBe(0);
  });

  it('returns 404 for unknown repo', async () => {
    const res = await fetchRepoSessions('org/unknown');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid limit', async () => {
    const res = await fetchRepoSessions('org/alpha', '?limit=0');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid offset', async () => {
    const res = await fetchRepoSessions('org/alpha', '?offset=-1');
    expect(res.status).toBe(400);
  });

  it('requires auth for per-repo endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${controlPort}/repos/${encodeURIComponent('org/alpha')}/sessions`);
    expect(res.status).toBe(401);
  });

  it('defaults to limit=5 and offset=0', async () => {
    for (let i = 0; i < 8; i++) {
      seedSession(`d-${i}`, 'org/beta', 'completed', 1000 - i);
    }

    const res = await fetchRepoSessions('org/beta');
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[]; total: number; offset: number; limit: number };
    expect(body.sessions.length).toBe(5);
    expect(body.total).toBe(8);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(5);
  });
});

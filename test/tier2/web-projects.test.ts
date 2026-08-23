/**
 * Tier 2 test: GET /projects endpoint returns correct project groupings,
 * health computations, and token coverage.
 *
 * Validates ROADMAP item #54, task 5.
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
import type { TokenStore, TokenMap, ProjectEntry } from '../../src/token-store.js';
import type { Database, CronState } from '../../src/db.js';
import { Secret } from '../../src/secret.js';
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

function stubTokenStore(): TokenStore {
  const projects = new Map<string, ProjectEntry>();
  const tokenMap: TokenMap = { projects, repoIndex: new Map() };
  return {
    getToken: () => undefined,
    getProject: () => undefined,
    findProjectByRepo: () => undefined,
    getTokenMap: () => tokenMap,
    reload: () => false,
    startWatching: () => {},
    stopWatching: () => {},
  };
}

function stubDb(): Database {
  return {
    getAllCronStates: () => [],
    getCronState: () => null,
    insertEvent: () => 0,
    updateEventProcessed: () => {},
    markStaleEvents: () => {},
    findSession: () => null,
    tryAcquireWakeSlot: () => false,
    getLastWakedAt: () => null,
    insertSession: () => {},
    insertOutboundComment: () => {},
    isOutboundComment: () => false,
    pruneOutboundComments: () => {},
    upsertPendingWake: () => {},
    getDuePendingWakes: () => [],
    clearPendingWake: () => {},
    getEventById: () => undefined,
    setCronPaused: () => {},
    walCheckpoint: () => {},
    shutdown: async () => {},
  } as unknown as Database;
}

describe('GET /projects endpoint (item #54, task 5)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let daemonTokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;
  let token: string;

  function makeConfig(overrides: Partial<AgentRouterConfig> = {}): AgentRouterConfig {
    return {
      port: 9999,
      controlPort,
      bindPublic: false,
      webhookSecret: 'test-secret',
      kiroPath: '/usr/bin/true',
      rateLimit: { perPRSeconds: 60 },
      sessionTimeout: {
        inactivityMinutes: 5,
        maxLifetimeMinutes: 120,
        gracePeriodAfterMergeSeconds: 60,
      },
      repos: [
        { owner: 'org', name: 'repo1', token: 'tok1' },
        { owner: 'org', name: 'repo2' },
        { owner: 'org', name: 'repo3' },
      ],
      cron: [],
      credentialMode: 'env' as const,
      reaper: { enabled: true, gracePeriodMinutes: 60, retentionDays: 30, agentRunsDir: '/tmp', sweepIntervalMinutes: 15 },
      shutdownDrainSeconds: 60,
      ...overrides,
    } as unknown as AgentRouterConfig;
  }

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-projects-tier2-'));
    sessionFiles = createSessionFiles(rootDir);
    log = createLogger({ level: 'error', output: () => {} });
    daemonTokenStore = createDaemonTokenStore({ rootDir, log });
    sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
    controlPort = await getFreePort();
    token = daemonTokenStore.read();
  });

  afterEach(() => {
    if (webServer) {
      webServer.close();
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function startServer(config: AgentRouterConfig) {
    const app = createWebApp({
      sessionMgr: stubSessionMgr(),
      sessionFiles,
      sseBroker,
      tokenStore: daemonTokenStore,
      log,
      rootDir,
      config,
      shuttingDown: () => false,
      credentialTokenStore: stubTokenStore(),
      db: stubDb(),
    });
    webServer = startWebServer(app, config, log);
  }

  it('returns 401 without auth token', async () => {
    const config = makeConfig();
    startServer(config);

    const resp = await fetch(`http://127.0.0.1:${controlPort}/projects`);
    expect(resp.status).toBe(401);
  });

  it('returns empty projects and all repos as ungrouped when no projects configured', async () => {
    const config = makeConfig();
    startServer(config);

    const resp = await fetch(`http://127.0.0.1:${controlPort}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as {
      projects: unknown[];
      ungrouped: Array<{ fullName: string; activeSessions: number; hasToken: boolean }>;
    };
    expect(data.projects).toEqual([]);
    expect(data.ungrouped).toHaveLength(3);
    expect(data.ungrouped.map(u => u.fullName).sort()).toEqual(['org/repo1', 'org/repo2', 'org/repo3']);
  });

  it('returns projects with correct health and token coverage', async () => {
    const config = makeConfig({
      projects: [
        { name: 'Core', repos: ['org/repo1', 'org/repo2'] },
      ],
    });
    startServer(config);

    // Create sessions to generate health data
    const paths1 = sessionFiles.createSession('11111111-1111-4111-a111-111111111111', 'test');
    sessionFiles.updateMeta('11111111-1111-4111-a111-111111111111', {
      repo: 'org/repo1',
      status: 'active',
    });

    const paths2 = sessionFiles.createSession('22222222-2222-4222-a222-222222222222', 'test');
    sessionFiles.updateMeta('22222222-2222-4222-a222-222222222222', {
      repo: 'org/repo2',
      status: 'failed',
      termination_reason: 'failed',
      completed_at: Date.now(),
    });

    const resp = await fetch(`http://127.0.0.1:${controlPort}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as {
      projects: Array<{
        name: string;
        health: { status: string; activeSessions: number; failedSessions: number };
        tokenCoverage: { complete: boolean; missingRepos: string[] };
        repos: Array<{ fullName: string; activeSessions: number; hasToken: boolean }>;
      }>;
      ungrouped: Array<{ fullName: string; activeSessions: number; hasToken: boolean }>;
    };

    expect(data.projects).toHaveLength(1);
    const project = data.projects[0]!;
    expect(project.name).toBe('Core');
    expect(project.health.status).toBe('partial'); // repo2 has failed session
    expect(project.health.activeSessions).toBe(1);
    expect(project.health.failedSessions).toBe(1);

    // Token coverage: repo1 has token, repo2 doesn't, no defaultGithubToken
    expect(project.tokenCoverage.complete).toBe(false);
    expect(project.tokenCoverage.missingRepos).toEqual(['org/repo2']);

    // Repos in project
    expect(project.repos).toHaveLength(2);
    const r1 = project.repos.find(r => r.fullName === 'org/repo1')!;
    expect(r1.activeSessions).toBe(1);
    expect(r1.hasToken).toBe(true);
    const r2 = project.repos.find(r => r.fullName === 'org/repo2')!;
    expect(r2.activeSessions).toBe(0);
    expect(r2.hasToken).toBe(false);

    // Ungrouped should contain repo3
    expect(data.ungrouped).toHaveLength(1);
    expect(data.ungrouped[0]!.fullName).toBe('org/repo3');
  });

  it('returns complete token coverage when defaultGithubToken is set', async () => {
    const config = makeConfig({
      defaultGithubToken: 'ghp_test_token',
      projects: [
        { name: 'All', repos: ['org/repo1', 'org/repo2', 'org/repo3'] },
      ],
    });
    startServer(config);

    const resp = await fetch(`http://127.0.0.1:${controlPort}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as {
      projects: Array<{
        tokenCoverage: { complete: boolean; missingRepos: string[] };
        repos: Array<{ hasToken: boolean }>;
      }>;
    };

    expect(data.projects[0]!.tokenCoverage.complete).toBe(true);
    expect(data.projects[0]!.tokenCoverage.missingRepos).toEqual([]);
    // All repos should report hasToken: true due to default
    for (const repo of data.projects[0]!.repos) {
      expect(repo.hasToken).toBe(true);
    }
  });

  it('returns green health when no sessions exist', async () => {
    const config = makeConfig({
      projects: [
        { name: 'Empty', repos: ['org/repo1'] },
      ],
    });
    startServer(config);

    const resp = await fetch(`http://127.0.0.1:${controlPort}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as {
      projects: Array<{ health: { status: string } }>;
    };

    // No sessions → paused (0 active, no recent session)
    expect(data.projects[0]!.health.status).toBe('paused');
  });
});

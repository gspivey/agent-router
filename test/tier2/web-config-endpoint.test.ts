/**
 * Tier 2 test: GET /config endpoint returns expected shape and respects auth.
 * Validates ROADMAP item #49 (task 3).
 *
 * Properties tested:
 * - Returns 401 without auth token
 * - Returns correct shape with session timeouts, rate limits, crons, tokens, repos
 * - No secret values leaked (no webhook secret values, no token values)
 * - Cron pause state is reflected
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

function stubTokenStore(entries: Array<{ name: string; expiresAt?: Date }>): TokenStore {
  const projects = new Map<string, ProjectEntry>();
  const repoIndex = new Map<string, string>();
  for (const e of entries) {
    const entry: ProjectEntry = {
      name: e.name,
      token: Secret.of('ghp_fake_token_' + e.name),
      repos: [`owner/${e.name}`],
      expiresAt: e.expiresAt,
    };
    projects.set(e.name, entry);
    for (const r of entry.repos) {
      repoIndex.set(r, e.name);
    }
  }
  const tokenMap: TokenMap = { projects, repoIndex };

  return {
    getToken: (name: string) => projects.get(name)?.token,
    getProject: (name: string) => projects.get(name),
    findProjectByRepo: (repo: string) => repoIndex.get(repo),
    getTokenMap: () => tokenMap,
    reload: () => false,
    startWatching: () => {},
    stopWatching: () => {},
  };
}

function stubDb(cronStates: CronState[]): Database {
  return {
    getAllCronStates: () => cronStates,
    getCronState: (name: string) => cronStates.find(s => s.name === name) ?? null,
    // Stub out remaining methods
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

describe('GET /config endpoint (item #49, task 3)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let daemonTokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;
  let token: string;

  const testConfig = {
    port: 9999,
    controlPort: 0, // assigned dynamically
    bindPublic: false,
    webhookSecret: 'test-secret',
    kiroPath: '/usr/bin/true',
    rateLimit: { perPRSeconds: 45 },
    sessionTimeout: {
      inactivityMinutes: 10,
      maxLifetimeMinutes: 240,
      gracePeriodAfterMergeSeconds: 120,
    },
    repos: [
      { owner: 'gspivey', name: 'agent-router', webhookSecret: 'ENV:SECRET_AR' },
      { owner: 'gspivey', name: 'other-repo' },
    ],
    cron: [
      { name: 'nightly', schedule: '0 3 * * *', repo: 'gspivey/agent-router', promptFile: '/prompts/ar.md' },
      { name: 'weekday', schedule: '0 9 * * 1-5', repo: 'gspivey/other-repo', promptFile: '/prompts/other.md' },
    ],
    credentialMode: 'env' as const,
    reaper: { enabled: true, gracePeriodMinutes: 60, retentionDays: 30, agentRunsDir: '/tmp', sweepIntervalMinutes: 15 },
    shutdownDrainSeconds: 60,
  } as unknown as AgentRouterConfig;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-config-tier2-'));
    sessionFiles = createSessionFiles(rootDir);
    log = createLogger({ level: 'error', output: () => {} });
    daemonTokenStore = createDaemonTokenStore({ rootDir, log });
    sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
    controlPort = await getFreePort();
    token = daemonTokenStore.read();

    const configWithPort = { ...testConfig, controlPort };

    const credentialTokenStore = stubTokenStore([
      { name: 'agent-router-pat', expiresAt: new Date('2027-06-01T00:00:00Z') },
      { name: 'other-pat' },
    ]);

    const db = stubDb([
      { name: 'weekday', paused: true, updatedAt: 1000 },
    ]);

    const app = createWebApp({
      sessionMgr: stubSessionMgr(),
      sessionFiles,
      sseBroker,
      tokenStore: daemonTokenStore,
      log,
      rootDir,
      config: configWithPort,
      shuttingDown: () => false,
      credentialTokenStore,
      db,
    });

    webServer = startWebServer(app, configWithPort, log);
  });

  afterEach(() => {
    if (webServer) {
      webServer.close();
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns 401 without auth token', async () => {
    const resp = await fetch(`http://127.0.0.1:${controlPort}/config`);
    expect(resp.status).toBe(401);
  });

  it('returns 200 with correct shape when authenticated', async () => {
    const resp = await fetch(`http://127.0.0.1:${controlPort}/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as {
      sessionTimeouts: { inactivityMinutes: number; maxLifetimeMinutes: number; gracePeriodAfterMergeSeconds: number };
      rateLimits: { perPRSeconds: number };
      crons: Array<{ name: string; repo: string; schedule: string; paused: boolean; nextFireTime: string | null }>;
      tokens: Array<{ project: string; tokenName: string; isSet: boolean; health: string; expiry: string | null }>;
      repos: Array<{ name: string; webhookSecretName: string }>;
    };

    // Session timeouts
    expect(data.sessionTimeouts).toEqual({
      inactivityMinutes: 10,
      maxLifetimeMinutes: 240,
      gracePeriodAfterMergeSeconds: 120,
    });

    // Rate limits
    expect(data.rateLimits).toEqual({
      perPRSeconds: 45,
    });

    // Crons
    expect(data.crons).toHaveLength(2);
    expect(data.crons[0]!.name).toBe('nightly');
    expect(data.crons[0]!.repo).toBe('gspivey/agent-router');
    expect(data.crons[0]!.schedule).toBe('0 3 * * *');
    expect(data.crons[0]!.paused).toBe(false);
    expect(data.crons[0]!.nextFireTime).not.toBeNull();

    expect(data.crons[1]!.name).toBe('weekday');
    expect(data.crons[1]!.paused).toBe(true);
    expect(data.crons[1]!.nextFireTime).toBeNull(); // paused → no next fire

    // Tokens
    expect(data.tokens).toHaveLength(2);
    const tokenEntry = data.tokens.find((t) => t.project === 'agent-router-pat');
    expect(tokenEntry).toBeDefined();
    expect(tokenEntry!.isSet).toBe(true);
    expect(tokenEntry!.health).toBe('green');
    expect(tokenEntry!.expiry).toBe('2027-06-01T00:00:00.000Z');

    const otherToken = data.tokens.find((t) => t.project === 'other-pat');
    expect(otherToken).toBeDefined();
    expect(otherToken!.health).toBe('green');
    expect(otherToken!.expiry).toBeNull();

    // Repos
    expect(data.repos).toHaveLength(2);
    expect(data.repos[0]!.name).toBe('gspivey/agent-router');
    expect(data.repos[0]!.webhookSecretName).toBe('[configured]');
    expect(data.repos[1]!.name).toBe('gspivey/other-repo');
    expect(data.repos[1]!.webhookSecretName).toBe('WEBHOOK_SECRET_gspivey_other-repo');
  });

  it('never leaks actual secret values', async () => {
    const resp = await fetch(`http://127.0.0.1:${controlPort}/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await resp.text();

    // Ensure no actual token or secret values appear
    expect(text).not.toContain('ghp_fake_token_');
    expect(text).not.toContain('test-secret');
    expect(text).not.toContain('ENV:SECRET_AR');
  });
});

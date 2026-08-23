/**
 * Tier 2 test: GET /sessions?repo= filter returns only sessions for the specified repo.
 * Validates ROADMAP item #55, task 7.
 *
 * Properties tested:
 * - With repo param: only sessions matching the repo are returned
 * - Without repo param: all sessions returned (existing behavior)
 * - Invalid repo format (no slash) returns 400
 * - Auth requirement still applies
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

describe('GET /sessions?repo= filter (item #55, task 7)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;
  let token: string;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-repo-filter-'));
    sessionFiles = createSessionFiles(rootDir);
    log = createLogger({ level: 'error', output: () => {} });
    tokenStore = createDaemonTokenStore({ rootDir, log });
    sseBroker = createSSEBroker({ sessionFiles, rootDir, log });
    controlPort = await getFreePort();
    token = tokenStore.read();

    const config = { port: 9999, controlPort, bindPublic: false } as AgentRouterConfig;
    const app = createWebApp({
      sessionMgr: stubSessionMgr(),
      sessionFiles,
      sseBroker,
      tokenStore,
      log,
      rootDir,
      config,
      shuttingDown: () => false,
    });
    webServer = startWebServer(app, config, log);
  });

  afterEach(() => {
    if (webServer) webServer.close();
    sseBroker.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function createSessionForRepo(repo: string, status: 'active' | 'completed' = 'completed'): string {
    const crypto = require('node:crypto');
    const id = crypto.randomUUID();
    sessionFiles.createSession(id, 'test prompt');
    sessionFiles.updateMeta(id, { repo, status, ...(status !== 'active' ? { completed_at: Date.now(), termination_reason: 'completed' } : {}) });
    return id;
  }

  it('returns only sessions for the specified repo', async () => {
    createSessionForRepo('org/repo-a');
    createSessionForRepo('org/repo-a');
    createSessionForRepo('org/repo-b');

    const resp = await fetch(`http://127.0.0.1:${controlPort}/sessions?repo=org/repo-a`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as { sessions: Array<{ repo: string }> };
    expect(data.sessions).toHaveLength(2);
    for (const s of data.sessions) {
      expect(s.repo).toBe('org/repo-a');
    }
  });

  it('returns all sessions when repo is not specified', async () => {
    createSessionForRepo('org/repo-a');
    createSessionForRepo('org/repo-b');
    createSessionForRepo('org/repo-c');

    const resp = await fetch(`http://127.0.0.1:${controlPort}/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as { sessions: Array<{ repo: string }> };
    expect(data.sessions).toHaveLength(3);
  });

  it('returns 400 for invalid repo format (no slash)', async () => {
    const resp = await fetch(`http://127.0.0.1:${controlPort}/sessions?repo=noslash`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(400);

    const data = await resp.json() as { error: { code: string } };
    expect(data.error.code).toBe('invalid_param');
  });

  it('returns empty array when no sessions match the repo', async () => {
    createSessionForRepo('org/repo-a');

    const resp = await fetch(`http://127.0.0.1:${controlPort}/sessions?repo=org/no-match`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as { sessions: unknown[] };
    expect(data.sessions).toHaveLength(0);
  });

  it('repo filter works with status filter combined', async () => {
    createSessionForRepo('org/repo-a', 'active');
    createSessionForRepo('org/repo-a', 'completed');
    createSessionForRepo('org/repo-b', 'active');

    const resp = await fetch(`http://127.0.0.1:${controlPort}/sessions?repo=org/repo-a&status=active`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status).toBe(200);

    const data = await resp.json() as { sessions: Array<{ repo: string; status: string }> };
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]!.repo).toBe('org/repo-a');
    expect(data.sessions[0]!.status).toBe('active');
  });

  it('requires auth to use repo filter', async () => {
    const resp = await fetch(`http://127.0.0.1:${controlPort}/sessions?repo=org/repo-a`);
    expect(resp.status).toBe(401);
  });
});

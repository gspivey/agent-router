/**
 * Tier 2 test: /sessions list response includes waiting_for and paginates.
 * Validates ROADMAP item #27 (tasks 2.1).
 *
 * Properties tested:
 * - Response shape is { sessions, total, offset, limit }
 * - Active sessions include a waiting_for field computed from stream.log
 * - Pagination: offset/limit slice non-active; active always included
 * - Default limit is 20 (bounded, not 500)
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

describe('GET /sessions paginated list with waiting_for (item #27, task 2.1)', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let log: Logger;
  let tokenStore: DaemonTokenStore;
  let sseBroker: SSEBroker;
  let webServer: ServerType;
  let controlPort: number;
  let token: string;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-list-tier2-'));
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

  function seedSession(id: string, status: 'active' | 'completed', createdAt: number, streamEntries?: string[]): void {
    sessionFiles.createSession(id, 'test prompt');
    if (streamEntries) {
      for (const type of streamEntries) {
        sessionFiles.appendStream(id, { ts: new Date().toISOString(), source: 'agent', type });
      }
    }
    if (status !== 'active') {
      sessionFiles.updateMeta(id, { status, completed_at: createdAt + 100, termination_reason: 'completed' });
    }
    // Patch created_at by rewriting meta
    const metaPath = path.join(rootDir, 'sessions', id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.created_at = createdAt;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  }

  async function fetchSessions(params = ''): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return await res.json() as Record<string, unknown>;
  }

  it('returns paginated shape with sessions, total, offset, limit', async () => {
    seedSession('s1', 'completed', 1000);
    const body = await fetchSessions();
    expect(body).toHaveProperty('sessions');
    expect(body).toHaveProperty('total', 1);
    expect(body).toHaveProperty('offset', 0);
    expect(body).toHaveProperty('limit', 20);
  });

  it('includes waiting_for for active sessions', async () => {
    seedSession('active-1', 'active', 2000, ['agent_message', 'tool_call']);
    const body = await fetchSessions();
    const sessions = body['sessions'] as Array<Record<string, unknown>>;
    const active = sessions.find(s => s['session_id'] === 'active-1');
    expect(active).toBeDefined();
    expect(active!['waiting_for']).toBe('waiting: tool');
  });

  it('waiting_for is null for completed sessions', async () => {
    seedSession('done-1', 'completed', 1000, ['agent_message', 'tool_call']);
    const body = await fetchSessions();
    const sessions = body['sessions'] as Array<Record<string, unknown>>;
    const done = sessions.find(s => s['session_id'] === 'done-1');
    expect(done).toBeDefined();
    expect(done!['waiting_for']).toBeNull();
  });

  it('active sessions always shown even at high offset', async () => {
    seedSession('active-a', 'active', 5000);
    for (let i = 0; i < 25; i++) {
      seedSession(`done-${i}`, 'completed', 1000 - i);
    }
    // At offset=20, should still see the active session
    const body = await fetchSessions('?offset=20&limit=5');
    const sessions = body['sessions'] as Array<Record<string, unknown>>;
    const hasActive = sessions.some(s => s['session_id'] === 'active-a');
    expect(hasActive).toBe(true);
  });

  it('paginates non-active sessions with offset and limit', async () => {
    for (let i = 0; i < 10; i++) {
      seedSession(`c-${i}`, 'completed', 1000 - i);
    }
    const page1 = await fetchSessions('?limit=3&offset=0');
    const page2 = await fetchSessions('?limit=3&offset=3');
    const s1 = (page1['sessions'] as Array<Record<string, unknown>>).map(s => s['session_id']);
    const s2 = (page2['sessions'] as Array<Record<string, unknown>>).map(s => s['session_id']);
    // No overlap
    const overlap = s1.filter(id => s2.includes(id));
    expect(overlap.length).toBe(0);
    expect(page1['total']).toBe(10);
  });

  it('default limit is 20 (bounded, not 500)', async () => {
    for (let i = 0; i < 25; i++) {
      seedSession(`x-${i}`, 'completed', 1000 - i);
    }
    const body = await fetchSessions();
    const sessions = body['sessions'] as Array<Record<string, unknown>>;
    expect(sessions.length).toBe(20);
    expect(body['limit']).toBe(20);
  });

  it('validates offset parameter', async () => {
    const res = await fetch(`http://127.0.0.1:${controlPort}/sessions?offset=-1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});

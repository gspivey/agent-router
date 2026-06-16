/**
 * Tier 2 tests: Session-end notification webhook.
 * BACKLOG.md § P1.3 — POST to configured URL on session end,
 * best-effort (failed POST does not stall termination).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
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
import { shouldNotify, sendSessionEndNotification } from '../../src/notify.js';
import type { NotifyOnSessionEndConfig, SessionEndPayload } from '../../src/notify.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;
let mockServer: http.Server;
let mockPort: number;
let receivedRequests: Array<{ body: SessionEndPayload }>;

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedRequests.push({ body: JSON.parse(body) as SessionEndPayload });
        res.writeHead(200);
        res.end();
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address();
      if (addr !== null && typeof addr !== 'string') {
        mockPort = addr.port;
      }
      resolve();
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer.close(() => resolve());
  });
}

beforeEach(async () => {
  receivedRequests = [];
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-tier2-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
  await startMockServer();
});

afterEach(async () => {
  await mgr.shutdown();
  await db.shutdown();
  await stopMockServer();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function createMgrWithNotify(notifyConfig: NotifyOnSessionEndConfig): void {
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
    onSessionEnd: (sessionId: string) => {
      const meta = sf.readMeta(sessionId);
      if (shouldNotify(notifyConfig, meta.termination_reason)) {
        void sendSessionEndNotification({ config: notifyConfig, meta, log });
      }
    },
  });
}

describe('session-end notification webhook (P1.3)', () => {
  it('POSTs payload to configured URL on session termination with matching reason', async () => {
    const notifyConfig: NotifyOnSessionEndConfig = {
      url: `http://127.0.0.1:${mockPort}/webhook`,
      events: ['terminated_cli', 'killed_by_operator'],
    };
    createMgrWithNotify(notifyConfig);

    const handle = await mgr.createSession('Test notification');
    await mgr.terminateSession(handle.sessionId);

    // Give the async POST time to complete
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(1);
    const payload = receivedRequests[0]!.body;
    expect(payload.session_id).toBe(handle.sessionId);
    expect(payload.status).toBe('abandoned');
    expect(payload.termination_reason).toBe('terminated_cli');
    expect(payload.started_at).toBeTypeOf('number');
    expect(payload.ended_at).toBeTypeOf('number');
    expect(payload.summary).toBe('Test notification');
  }, 15_000);

  it('does not POST when termination reason is not in events list', async () => {
    const notifyConfig: NotifyOnSessionEndConfig = {
      url: `http://127.0.0.1:${mockPort}/webhook`,
      events: ['merged'], // only notify on merged
    };
    createMgrWithNotify(notifyConfig);

    const handle = await mgr.createSession('Test no-notify');
    await mgr.terminateSession(handle.sessionId);

    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(0);
  }, 15_000);

  it('does not block session termination when POST fails', async () => {
    // Point at a server that will reject
    await stopMockServer();
    const notifyConfig: NotifyOnSessionEndConfig = {
      url: `http://127.0.0.1:${mockPort}/webhook`, // server is down
      events: ['terminated_cli'],
    };
    createMgrWithNotify(notifyConfig);

    const handle = await mgr.createSession('Test failed POST');

    // This should complete quickly without hanging
    const start = Date.now();
    await mgr.terminateSession(handle.sessionId);
    const elapsed = Date.now() - start;

    // Termination should not be blocked by the failed notification
    expect(elapsed).toBeLessThan(5000);

    // Meta should still be properly updated
    const meta = sf.readMeta(handle.sessionId);
    expect(meta.status).toBe('abandoned');
    expect(meta.termination_reason).toBe('terminated_cli');
  }, 15_000);

  it('includes PR data in the notification payload', async () => {
    const notifyConfig: NotifyOnSessionEndConfig = {
      url: `http://127.0.0.1:${mockPort}/webhook`,
      events: ['terminated_cli'],
    };
    createMgrWithNotify(notifyConfig);

    const handle = await mgr.createSession('Test with PR');
    await mgr.registerPR(handle.sessionId, 'org/repo', 99);
    await mgr.terminateSession(handle.sessionId);

    await new Promise((r) => setTimeout(r, 200));

    expect(receivedRequests).toHaveLength(1);
    const payload = receivedRequests[0]!.body;
    expect(payload.prs).toHaveLength(1);
    expect(payload.prs[0]!.repo).toBe('org/repo');
    expect(payload.prs[0]!.pr_number).toBe(99);
  }, 15_000);
});

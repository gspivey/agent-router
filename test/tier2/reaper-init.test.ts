/**
 * Tier 2 test: Reaper initialization — sessionMgr.shutdown() calls the real reaper's shutdown.
 * Spec: BACKLOG.md § P2.15
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionFiles } from '../../src/session-files.js';
import type { SessionFiles } from '../../src/session-files.js';
import { createSessionManager } from '../../src/session-mgr.js';
import type { SessionManager } from '../../src/session-mgr.js';
import type { Reaper } from '../../src/reaper.js';
import { initDatabase } from '../../src/db.js';
import type { Database } from '../../src/db.js';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import { spawnACPClient } from '../../src/acp.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;

function setupEnv(): void {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-init-tier2-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
}

async function setupKiro(): Promise<void> {
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
}

describe('reaper double-initialization fix (P2.15)', () => {
  beforeEach(async () => {
    setupEnv();
    await setupKiro();
  });

  afterEach(async () => {
    if (mgr) await mgr.shutdown();
    if (db) await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('sessionMgr.shutdown() calls the real reaper shutdown exactly once', async () => {
    let shutdownCallCount = 0;
    let onSessionTerminalCallCount = 0;

    const spyReaper: Reaper = {
      onSessionTerminal(_sessionId: string): void {
        onSessionTerminalCallCount++;
      },
      start(): void {
        // no-op for test
      },
      shutdown(): void {
        shutdownCallCount++;
      },
    };

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
      reaper: spyReaper,
    });

    // Shutdown should call reaper.shutdown() exactly once
    await mgr.shutdown();

    expect(shutdownCallCount).toBe(1);

    // Prevent double-shutdown in afterEach (mgr already shut down)
    mgr = null as unknown as SessionManager;
  });

  it('reaper.onSessionTerminal is called when a session terminates', async () => {
    let terminalSessionIds: string[] = [];

    const spyReaper: Reaper = {
      onSessionTerminal(sessionId: string): void {
        terminalSessionIds.push(sessionId);
      },
      start(): void {
        // no-op
      },
      shutdown(): void {
        // no-op
      },
    };

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
      reaper: spyReaper,
    });

    // Create a session and terminate it
    const handle = await mgr.createSession('test prompt');
    await mgr.terminateSession(handle.sessionId, 'killed_by_operator');

    expect(terminalSessionIds).toContain(handle.sessionId);
  });
});

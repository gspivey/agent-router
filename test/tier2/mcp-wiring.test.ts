/**
 * Tier 2 tests: per-session MCP server wiring through the session manager.
 *
 * Spec: .kiro/specs/mcp-server-wiring/ · tasks 9, 10
 * Requirements: 9.3, 9.4, 9.5, 7.2, 2.1
 *
 * Drives the real session manager (createSessionManager) with daemonSocket +
 * mcpServerCommand wired, spawning the fake-kiro subprocess with
 * FAKE_KIRO_RECORD_FILE set so the test can assert the exact JSON-RPC params
 * the daemon sent (session/new and session/load) and the auto-approval
 * response the daemon wrote back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { createRequire } from 'node:module';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles, type SessionMeta } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { resolveMcpServerCommand } from '../../src/mcp-resolver.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../../src');
const FAKE_KIRO = path.resolve(__dirname, '../harness/fake-kiro-process.ts');
const PERMISSION_SCENARIO = path.resolve(__dirname, '../scenarios/mcp-wiring-permission.json');
const LOAD_SCENARIO = path.resolve(__dirname, '../scenarios/mcp-wiring-load.json');

let rootDir: string;
let recordFile: string;
let socketPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;

interface Recorded {
  kind: 'request' | 'response';
  method?: string;
  params?: Record<string, unknown> | null;
  id?: number | string;
  result?: unknown;
  error?: unknown;
}

function readRecords(): Recorded[] {
  if (!fs.existsSync(recordFile)) return [];
  return fs
    .readFileSync(recordFile, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Recorded);
}

/** Poll the record file until `predicate` is satisfied or the deadline passes. */
async function waitForRecords(predicate: (recs: Recorded[]) => boolean, timeoutMs = 8000): Promise<Recorded[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recs = readRecords();
    if (predicate(recs)) return recs;
    await new Promise((r) => setTimeout(r, 50));
  }
  return readRecords();
}

const require = createRequire(import.meta.url);

/** Fixture resolver standing in for import.meta.resolve (unavailable under vmThreads). */
function resolveSpecifier(specifier: string): string {
  return url.pathToFileURL(require.resolve(specifier)).href;
}

function mcpServerCommand(): { command: string; args: string[]; serverPath: string } {
  const resolved = resolveMcpServerCommand(SRC_DIR, resolveSpecifier);
  if (resolved === undefined) throw new Error('resolveMcpServerCommand returned undefined for src dir');
  return resolved;
}

function makeManager(scenarioPath: string): SessionManager {
  return createSessionManager({
    db,
    sessionFiles: sf,
    daemonSocket: socketPath,
    mcpServerCommand: mcpServerCommand(),
    acpSpawner: (sessionId: string, repo?: string) => {
      return spawnACPClient(process.execPath, ['--import', 'tsx/esm', FAKE_KIRO], {
        ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}),
        ...(process.env['HOME'] ? { HOME: process.env['HOME'] } : {}),
        FAKE_KIRO_SCENARIO: scenarioPath,
        FAKE_KIRO_RECORD_FILE: recordFile,
        AGENT_ROUTER_SESSION_ID: sessionId,
      });
    },
    log,
  });
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-wiring-tier2-'));
  recordFile = path.join(rootDir, 'records.ndjson');
  socketPath = path.join(rootDir, 'sock');
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
});

afterEach(async () => {
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function findAgentRouterEntry(recs: Recorded[], method: string): Record<string, unknown> | undefined {
  const req = recs.find((r) => r.kind === 'request' && r.method === method);
  if (req === undefined || req.params == null) return undefined;
  const servers = (req.params as Record<string, unknown>)['mcpServers'];
  if (!Array.isArray(servers)) return undefined;
  return servers.find(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' && s !== null && (s as Record<string, unknown>)['name'] === 'agent-router',
  );
}

describe('MCP wiring — created session (Task 9)', () => {
  it('forwards an agent-router MCP entry via session/new with the session env pairs', async () => {
    const mgr = makeManager(PERMISSION_SCENARIO);
    try {
      const handle = await mgr.createSession('wire the mcp server');
      const sessionId = handle.sessionId;

      const recs = await waitForRecords((r) => findAgentRouterEntry(r, 'session/new') !== undefined);
      const entry = findAgentRouterEntry(recs, 'session/new');
      expect(entry).toBeDefined();
      expect(entry!['name']).toBe('agent-router');
      expect(typeof entry!['command']).toBe('string');
      expect(Array.isArray(entry!['args'])).toBe(true);

      const env = entry!['env'] as Array<{ name: string; value: string }>;
      expect(Array.isArray(env)).toBe(true);
      expect(env).toContainEqual({ name: 'AGENT_ROUTER_SESSION_ID', value: sessionId });
      expect(env).toContainEqual({ name: 'AGENT_ROUTER_SOCKET', value: socketPath });
    } finally {
      await mgr.shutdown();
    }
  }, 20_000);

  it('auto-approves a session/request_permission for an MCP tool (option-based)', async () => {
    const mgr = makeManager(PERMISSION_SCENARIO);
    try {
      await mgr.createSession('wire the mcp server');

      // The scenario makes fake-kiro send a session/request_permission after
      // session/new. The daemon's ACP client must auto-approve it; fake-kiro
      // records the response it receives back on stdin.
      const recs = await waitForRecords((r) =>
        r.some((rec) => rec.kind === 'response' && rec.result != null),
      );
      const approval = recs.find((rec) => rec.kind === 'response' && rec.result != null);
      expect(approval).toBeDefined();
      const outcome = (approval!.result as Record<string, unknown>)['outcome'] as Record<string, unknown>;
      expect(outcome['outcome']).toBe('selected');
      // allow_always is the preferred option in the scenario
      expect(outcome['optionId']).toBe('allow');
    } finally {
      await mgr.shutdown();
    }
  }, 20_000);
});

describe('MCP wiring — resumed session (Task 10)', () => {
  it('forwards an agent-router MCP entry via session/load on resume', async () => {
    // Plant an active session with a kiro_session_id so resumeSessions attempts load.
    const sessionId = 'resume-mcp-001';
    const paths = sf.createSession(sessionId, 'resume prompt');
    const meta: SessionMeta = {
      session_id: sessionId,
      original_prompt: 'resume prompt',
      status: 'active',
      created_at: Math.floor(Date.now() / 1000) - 60,
      completed_at: null,
      prs: [],
      kiro_session_id: 'fake-session-001',
    };
    fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + '\n');

    const mgr = makeManager(LOAD_SCENARIO);
    try {
      const result = await mgr.resumeSessions();
      expect(result.resumed).toBe(1);

      const recs = await waitForRecords((r) => findAgentRouterEntry(r, 'session/load') !== undefined);
      const entry = findAgentRouterEntry(recs, 'session/load');
      expect(entry).toBeDefined();
      expect(entry!['name']).toBe('agent-router');

      const env = entry!['env'] as Array<{ name: string; value: string }>;
      expect(env).toContainEqual({ name: 'AGENT_ROUTER_SESSION_ID', value: sessionId });
      expect(env).toContainEqual({ name: 'AGENT_ROUTER_SOCKET', value: socketPath });

      // session/load params also carry sessionId + cwd (R2.2 schema fix)
      const loadReq = recs.find((r) => r.kind === 'request' && r.method === 'session/load');
      expect((loadReq!.params as Record<string, unknown>)['sessionId']).toBe('fake-session-001');
      expect(typeof (loadReq!.params as Record<string, unknown>)['cwd']).toBe('string');
    } finally {
      await mgr.shutdown();
    }
  }, 20_000);
});

/**
 * Tier 2 tests: Session manager — creation, PR registration, termination.
 * Requirements: 18.3, 20.3, 20.6, 24.6
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { createSessionManager, type SessionManager, type SessionHandle } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles, type SessionMeta } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mgr-tier2-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);

  mgr = createSessionManager({
    db,
    sessionFiles: sf,
    acpSpawner: (_sessionId: string) => {
      const cfg = kiro.spawnConfig();
      return spawnACPClient(cfg.command, cfg.args, cfg.env);
    },
    log,
  });
});

afterEach(async () => {
  await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('session creation (Req 18.3, 20.2)', () => {
  it('creates session files and initializes ACP', async () => {
    const handle = await mgr.createSession('Fix the flaky test');

    // Session ID should be a valid UUID
    expect(handle.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Session files should exist on disk
    expect(fs.existsSync(handle.paths.dir)).toBe(true);
    expect(fs.existsSync(handle.paths.meta)).toBe(true);
    expect(fs.existsSync(handle.paths.stream)).toBe(true);
    expect(fs.existsSync(handle.paths.prompts)).toBe(true);

    // meta.json should have correct initial state
    const meta = JSON.parse(fs.readFileSync(handle.paths.meta, 'utf-8')) as SessionMeta;
    expect(meta.session_id).toBe(handle.sessionId);
    expect(meta.original_prompt).toBe('Fix the flaky test');
    expect(meta.status).toBe('active');
    expect(meta.prs).toEqual([]);
    expect(meta.completed_at).toBeNull();

    // stream.log should contain a session_started entry
    const streamContent = fs.readFileSync(handle.paths.stream, 'utf-8').trim();
    const lines = streamContent.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const firstEntry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(firstEntry['type']).toBe('session_started');
    expect(firstEntry['source']).toBe('router');

    // Session should be retrievable
    const active = mgr.getActiveSession(handle.sessionId);
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe(handle.sessionId);
  }, 15_000);

  it('creates multiple independent sessions', async () => {
    const h1 = await mgr.createSession('Task 1');
    const h2 = await mgr.createSession('Task 2');

    expect(h1.sessionId).not.toBe(h2.sessionId);
    expect(mgr.getActiveSession(h1.sessionId)).not.toBeNull();
    expect(mgr.getActiveSession(h2.sessionId)).not.toBeNull();
  }, 15_000);
});

describe('PR registration (Req 20.3)', () => {
  it('updates meta.json with PR entry', async () => {
    const handle = await mgr.createSession('Implement feature');

    await mgr.registerPR(handle.sessionId, 'org/repo', 42);

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.prs).toHaveLength(1);
    expect(meta.prs[0]!.repo).toBe('org/repo');
    expect(meta.prs[0]!.pr_number).toBe(42);
    expect(typeof meta.prs[0]!.registered_at).toBe('number');
  }, 15_000);

  it('appends pr_registered stream entry', async () => {
    const handle = await mgr.createSession('Implement feature');

    await mgr.registerPR(handle.sessionId, 'org/repo', 42);

    const streamContent = fs.readFileSync(handle.paths.stream, 'utf-8').trim();
    const lines = streamContent.split('\n').filter((l) => l.length > 0);
    const prEntry = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e['type'] === 'pr_registered');

    expect(prEntry).toBeDefined();
    expect(prEntry!['repo']).toBe('org/repo');
    expect(prEntry!['pr_number']).toBe(42);
  }, 15_000);

  it('does not duplicate existing PR entry', async () => {
    const handle = await mgr.createSession('Implement feature');

    await mgr.registerPR(handle.sessionId, 'org/repo', 42);
    await mgr.registerPR(handle.sessionId, 'org/repo', 42);

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.prs).toHaveLength(1);
  }, 15_000);

  it('supports multiple PRs per session', async () => {
    const handle = await mgr.createSession('Implement feature');

    await mgr.registerPR(handle.sessionId, 'org/repo', 42);
    await mgr.registerPR(handle.sessionId, 'org/repo', 43);

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.prs).toHaveLength(2);
  }, 15_000);

  it('throws for unknown session', async () => {
    await expect(
      mgr.registerPR('nonexistent-id', 'org/repo', 1),
    ).rejects.toThrow(/No active session found/);
  });
});

describe('session termination (Req 20.6, 21.5)', () => {
  it('sets meta.json status to abandoned', async () => {
    const handle = await mgr.createSession('Task to abandon');

    await mgr.terminateSession(handle.sessionId);

    const meta = sf.readMeta(handle.sessionId);
    expect(meta.status).toBe('abandoned');
    expect(meta.completed_at).not.toBeNull();
  }, 15_000);

  it('removes session from active registry', async () => {
    const handle = await mgr.createSession('Task to abandon');

    await mgr.terminateSession(handle.sessionId);

    expect(mgr.getActiveSession(handle.sessionId)).toBeNull();
  }, 15_000);

  it('appends session_ended stream entry', async () => {
    const handle = await mgr.createSession('Task to abandon');

    await mgr.terminateSession(handle.sessionId);

    const streamContent = fs.readFileSync(handle.paths.stream, 'utf-8').trim();
    const lines = streamContent.split('\n').filter((l) => l.length > 0);
    const endEntry = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e['type'] === 'session_ended');

    expect(endEntry).toBeDefined();
    expect(endEntry!['reason']).toBe('terminated');
  }, 15_000);

  it('throws for unknown session', async () => {
    await expect(
      mgr.terminateSession('nonexistent-id'),
    ).rejects.toThrow(/No active session found/);
  });
});

describe('shutdown (Req 16.7)', () => {
  it('marks all active sessions as abandoned', async () => {
    const h1 = await mgr.createSession('Task 1');
    const h2 = await mgr.createSession('Task 2');

    await mgr.shutdown();

    const meta1 = sf.readMeta(h1.sessionId);
    const meta2 = sf.readMeta(h2.sessionId);
    expect(meta1.status).toBe('abandoned');
    expect(meta2.status).toBe('abandoned');
  }, 15_000);
});

describe('injectPrompt (Req 10.7, 19.7, 21.7)', () => {
  it('appends to prompts.log and stream.log', async () => {
    const handle = await mgr.createSession('Initial task');

    await mgr.injectPrompt(handle.sessionId, 'Follow-up prompt', 'cli');

    // Check prompts.log
    const promptsContent = fs.readFileSync(handle.paths.prompts, 'utf-8').trim();
    const promptLines = promptsContent.split('\n').filter((l) => l.length > 0);
    expect(promptLines.length).toBeGreaterThanOrEqual(1);
    const lastPrompt = JSON.parse(promptLines[promptLines.length - 1]!) as Record<string, unknown>;
    expect(lastPrompt['source']).toBe('cli');
    expect(lastPrompt['prompt']).toBe('Follow-up prompt');

    // Check stream.log for prompt_injected entry
    const streamContent = fs.readFileSync(handle.paths.stream, 'utf-8').trim();
    const streamLines = streamContent.split('\n').filter((l) => l.length > 0);
    const injectedEntry = streamLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e['type'] === 'prompt_injected');

    expect(injectedEntry).toBeDefined();
    expect(injectedEntry!['prompt_source']).toBe('cli');
  }, 15_000);

  it('throws for unknown session', async () => {
    await expect(
      mgr.injectPrompt('nonexistent-id', 'prompt', 'cli'),
    ).rejects.toThrow(/No active session found/);
  });
});

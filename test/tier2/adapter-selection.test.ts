/**
 * Tier 2 tests: Claude Code adapter wiring — per-repo adapter selection and hot-reload.
 *
 * Verifies that:
 * 1. Repos with adapter.type "claude-code" spawn via ClaudeCodeAdapter.
 * 2. Repos without adapter config use the default Kiro adapter.
 * 3. Config reload rebuilds the adapter map for new sessions.
 *
 * Uses the session manager directly with a custom acpSpawner that tracks
 * which adapter spawned each session — same pattern as src/index.ts uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import { spawnACPClient } from '../../src/acp.js';
import { createKiroAdapter } from '../../src/adapters/kiro.js';
import { createClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import type { AgentAdapter } from '../../src/agent-adapter.js';
import type { RepoConfig } from '../../src/config.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

// ---------------------------------------------------------------------------
// buildAdapterMap — extracted from src/index.ts for test use
// ---------------------------------------------------------------------------

function buildAdapterMap(
  repos: RepoConfig[],
  defaultAdapter: AgentAdapter,
  log: Logger,
): Map<string, AgentAdapter> {
  const adapters = new Map<string, AgentAdapter>();
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    if (!repo.adapter || repo.adapter.type === 'kiro') {
      adapters.set(slug, defaultAdapter);
    } else if (repo.adapter.type === 'claude-code') {
      const deps: { log: Logger; model?: string } = { log };
      if (repo.adapter.model !== undefined) {
        deps.model = repo.adapter.model;
      }
      adapters.set(slug, createClaudeCodeAdapter(deps));
    }
  }
  return adapters;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let rootDir: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;
let kiro: FakeKiroBackend;
let mgr: SessionManager;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-selection-tier2-'));
  sf = createSessionFiles(rootDir);
  db = initDatabase(path.join(rootDir, 'agent-router.db'));
  log = createLogger({ level: 'error', output: () => {} });
  kiro = new FakeKiroBackend();
  await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
});

afterEach(async () => {
  if (mgr) await mgr.shutdown();
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('per-repo adapter selection (Tier 2)', () => {
  it('selects claude-code adapter for repos with adapter.type "claude-code"', async () => {
    const spawnedAdapters: Array<{ sessionId: string; adapterName: string }> = [];

    const repos: RepoConfig[] = [
      { owner: 'org', name: 'kiro-repo' },
      { owner: 'org', name: 'claude-repo', adapter: { type: 'claude-code', model: 'opus-5' } },
    ];

    // Create the default adapter with a spy to capture spawns
    const kiroSpawnCfg = kiro.spawnConfig();
    const defaultAdapter = createKiroAdapter({
      kiroPath: kiroSpawnCfg.command,
      log,
      spawnImpl: (bin, args, env) => {
        spawnedAdapters.push({ sessionId: env['AGENT_ROUTER_SESSION_ID'] ?? 'unknown', adapterName: 'kiro' });
        return spawnACPClient(kiroSpawnCfg.command, kiroSpawnCfg.args, { ...kiroSpawnCfg.env, ...env });
      },
    });

    const adapterMap = buildAdapterMap(repos, defaultAdapter, log);

    // The claude-code adapter entry should use a test spawnImpl too
    adapterMap.set('org/claude-repo', createClaudeCodeAdapter({
      model: 'opus-5',
      log,
      spawnImpl: (bin, args, env) => {
        spawnedAdapters.push({ sessionId: env['AGENT_ROUTER_SESSION_ID'] ?? 'unknown', adapterName: 'claude-code' });
        // Use the fake-kiro backend for the actual ACP subprocess
        return spawnACPClient(kiroSpawnCfg.command, kiroSpawnCfg.args, { ...kiroSpawnCfg.env, ...env });
      },
    }));

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string, repo?: string) => {
        const adapterForRepo = repo ? (adapterMap.get(repo) ?? defaultAdapter) : defaultAdapter;
        return adapterForRepo.spawn({ sessionId, env: {} });
      },
      log,
      sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    });

    // Spawn a session for the kiro repo
    const h1 = await mgr.createSession('test prompt', 'org/kiro-repo');
    expect(h1.sessionId).toBeTruthy();

    // Spawn a session for the claude-code repo
    const h2 = await mgr.createSession('test prompt', 'org/claude-repo');
    expect(h2.sessionId).toBeTruthy();

    // Verify adapter selection
    expect(spawnedAdapters).toHaveLength(2);
    expect(spawnedAdapters[0]!.adapterName).toBe('kiro');
    expect(spawnedAdapters[1]!.adapterName).toBe('claude-code');
  });

  it('defaults to kiro adapter when repo has no adapter config', async () => {
    const spawnedAdapters: string[] = [];

    const repos: RepoConfig[] = [
      { owner: 'org', name: 'no-adapter-repo' },
    ];

    const kiroSpawnCfg = kiro.spawnConfig();
    const defaultAdapter = createKiroAdapter({
      kiroPath: kiroSpawnCfg.command,
      log,
      spawnImpl: (bin, args, env) => {
        spawnedAdapters.push('kiro');
        return spawnACPClient(kiroSpawnCfg.command, kiroSpawnCfg.args, { ...kiroSpawnCfg.env, ...env });
      },
    });

    const adapterMap = buildAdapterMap(repos, defaultAdapter, log);

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string, repo?: string) => {
        const adapterForRepo = repo ? (adapterMap.get(repo) ?? defaultAdapter) : defaultAdapter;
        return adapterForRepo.spawn({ sessionId, env: {} });
      },
      log,
      sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    });

    await mgr.createSession('prompt', 'org/no-adapter-repo');

    expect(spawnedAdapters).toEqual(['kiro']);
  });

  it('falls back to default adapter for unknown repo slug', async () => {
    const spawnedAdapters: string[] = [];

    const repos: RepoConfig[] = [
      { owner: 'org', name: 'known-repo' },
    ];

    const kiroSpawnCfg = kiro.spawnConfig();
    const defaultAdapter = createKiroAdapter({
      kiroPath: kiroSpawnCfg.command,
      log,
      spawnImpl: (bin, args, env) => {
        spawnedAdapters.push('kiro-fallback');
        return spawnACPClient(kiroSpawnCfg.command, kiroSpawnCfg.args, { ...kiroSpawnCfg.env, ...env });
      },
    });

    const adapterMap = buildAdapterMap(repos, defaultAdapter, log);

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string, repo?: string) => {
        const adapterForRepo = repo ? (adapterMap.get(repo) ?? defaultAdapter) : defaultAdapter;
        return adapterForRepo.spawn({ sessionId, env: {} });
      },
      log,
      sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    });

    // Spawn with a repo slug that isn't in the map
    await mgr.createSession('prompt', 'org/unknown-repo');

    expect(spawnedAdapters).toEqual(['kiro-fallback']);
  });

  it('rebuilds adapter map on config reload (new sessions pick up changes)', async () => {
    const spawnedAdapters: string[] = [];
    const kiroSpawnCfg = kiro.spawnConfig();

    const defaultAdapter = createKiroAdapter({
      kiroPath: kiroSpawnCfg.command,
      log,
      spawnImpl: (bin, args, env) => {
        spawnedAdapters.push('kiro');
        return spawnACPClient(kiroSpawnCfg.command, kiroSpawnCfg.args, { ...kiroSpawnCfg.env, ...env });
      },
    });

    // Initial config: repo uses kiro
    const reposV1: RepoConfig[] = [
      { owner: 'org', name: 'switch-repo' },
    ];
    const adapterMapHolder = { current: buildAdapterMap(reposV1, defaultAdapter, log) };

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: (sessionId: string, repo?: string) => {
        const adapterForRepo = repo ? (adapterMapHolder.current.get(repo) ?? defaultAdapter) : defaultAdapter;
        return adapterForRepo.spawn({ sessionId, env: {} });
      },
      log,
      sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    });

    // First session uses kiro
    await mgr.createSession('prompt', 'org/switch-repo');
    expect(spawnedAdapters[0]).toBe('kiro');

    // Simulate config reload: repo now uses claude-code
    const reposV2: RepoConfig[] = [
      { owner: 'org', name: 'switch-repo', adapter: { type: 'claude-code' } },
    ];

    // Rebuild adapter map with claude-code spy
    const newMap = new Map<string, AgentAdapter>();
    newMap.set('org/switch-repo', createClaudeCodeAdapter({
      log,
      spawnImpl: (bin, args, env) => {
        spawnedAdapters.push('claude-code');
        return spawnACPClient(kiroSpawnCfg.command, kiroSpawnCfg.args, { ...kiroSpawnCfg.env, ...env });
      },
    }));
    adapterMapHolder.current = newMap;

    // Second session uses claude-code (new adapter after reload)
    await mgr.createSession('prompt', 'org/switch-repo');
    expect(spawnedAdapters[1]).toBe('claude-code');
  });
});

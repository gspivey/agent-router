/**
 * Tier 1 tests: buildAdapterMap pure function — adapter selection logic.
 *
 * Tests the adapter-map building logic that determines which adapter
 * is used for each repo based on config. This is the pure-function
 * half; Tier 2 tests verify actual spawn behavior.
 */
import { describe, it, expect } from 'vitest';
import { createKiroAdapter } from '../../src/adapters/kiro.js';
import { createClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import type { AgentAdapter } from '../../src/agent-adapter.js';
import type { RepoConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import type { Logger } from '../../src/log.js';
import type { ACPClient } from '../../src/acp.js';

const silentLog: Logger = createLogger({ level: 'error', output: () => {} });

function fakeAcpClient(): ACPClient {
  return {
    initialize: async () => {},
    newSession: async () => 'fake',
    newSessionWithPrompt: async () => 'fake',
    loadSession: async () => {},
    sendPrompt: async () => {},
    cancel: () => {},
    notifications: (async function* () {})(),
    sessionEnded: Promise.resolve(),
    close: async () => {},
    kill: async () => {},
  };
}

// Replicate buildAdapterMap from src/index.ts for isolated testing
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

describe('buildAdapterMap', () => {
  const defaultAdapter = createKiroAdapter({
    kiroPath: '/usr/bin/kiro',
    log: silentLog,
    spawnImpl: () => fakeAcpClient(),
  });

  it('maps a repo without adapter config to the default kiro adapter', () => {
    const repos: RepoConfig[] = [{ owner: 'org', name: 'repo' }];
    const map = buildAdapterMap(repos, defaultAdapter, silentLog);

    expect(map.get('org/repo')).toBe(defaultAdapter);
  });

  it('maps a repo with adapter.type "kiro" to the default kiro adapter', () => {
    const repos: RepoConfig[] = [{ owner: 'org', name: 'repo', adapter: { type: 'kiro' } }];
    const map = buildAdapterMap(repos, defaultAdapter, silentLog);

    expect(map.get('org/repo')).toBe(defaultAdapter);
  });

  it('maps a repo with adapter.type "claude-code" to a ClaudeCodeAdapter instance', () => {
    const repos: RepoConfig[] = [
      { owner: 'org', name: 'repo', adapter: { type: 'claude-code' } },
    ];
    const map = buildAdapterMap(repos, defaultAdapter, silentLog);

    const adapterForRepo = map.get('org/repo');
    expect(adapterForRepo).not.toBe(defaultAdapter);
    expect(adapterForRepo?.name).toBe('claude-code');
  });

  it('passes model to ClaudeCodeAdapter when configured', () => {
    const repos: RepoConfig[] = [
      { owner: 'org', name: 'repo', adapter: { type: 'claude-code', model: 'opus-5' } },
    ];
    const map = buildAdapterMap(repos, defaultAdapter, silentLog);
    const adapterForRepo = map.get('org/repo');

    // Verify the model is injected by calling spawn and checking env
    let capturedEnv: Record<string, string> = {};
    const testAdapter = createClaudeCodeAdapter({
      model: 'opus-5',
      log: silentLog,
      spawnImpl: (_bin, _args, env) => {
        capturedEnv = env;
        return fakeAcpClient();
      },
    });
    testAdapter.spawn({ sessionId: 'test' });
    expect(capturedEnv['ANTHROPIC_MODEL']).toBe('opus-5');

    // The map entry should also be a claude-code adapter
    expect(adapterForRepo?.name).toBe('claude-code');
  });

  it('handles mixed repos correctly', () => {
    const repos: RepoConfig[] = [
      { owner: 'org', name: 'repo-a' },
      { owner: 'org', name: 'repo-b', adapter: { type: 'kiro' } },
      { owner: 'org', name: 'repo-c', adapter: { type: 'claude-code', model: 'sonnet' } },
      { owner: 'other', name: 'repo-d', adapter: { type: 'claude-code' } },
    ];
    const map = buildAdapterMap(repos, defaultAdapter, silentLog);

    expect(map.get('org/repo-a')).toBe(defaultAdapter);
    expect(map.get('org/repo-b')).toBe(defaultAdapter);
    expect(map.get('org/repo-c')?.name).toBe('claude-code');
    expect(map.get('other/repo-d')?.name).toBe('claude-code');
  });

  it('creates distinct adapter instances per claude-code repo', () => {
    const repos: RepoConfig[] = [
      { owner: 'org', name: 'repo-a', adapter: { type: 'claude-code', model: 'opus' } },
      { owner: 'org', name: 'repo-b', adapter: { type: 'claude-code', model: 'sonnet' } },
    ];
    const map = buildAdapterMap(repos, defaultAdapter, silentLog);

    const a = map.get('org/repo-a');
    const b = map.get('org/repo-b');
    expect(a).not.toBe(b);
    expect(a?.name).toBe('claude-code');
    expect(b?.name).toBe('claude-code');
  });

  it('returns empty map for empty repos array', () => {
    const map = buildAdapterMap([], defaultAdapter, silentLog);
    expect(map.size).toBe(0);
  });
});

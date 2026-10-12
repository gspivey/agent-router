/**
 * Tier 1 tests: KiroAdapter spawn under agent process isolation (useWorkerUid).
 *
 * Covers task 84.8 / FR-2.4:
 *  1. useWorkerUid:false → spawnImpl(kiroPath, ['acp'], env)
 *  2. useWorkerUid:true  → spawnImpl('/usr/bin/sudo', ['-u','agentworker',kiroPath,'acp'], env)
 *  3. useWorkerUid:true + GITHUB_TOKEN present → GITHUB_TOKEN removed from child env
 *  4. useWorkerUid:true → env contains a non-empty AGENT_ROUTER_CAP_TOKEN
 */
import { describe, it, expect } from 'vitest';
import { createKiroAdapter } from '../../src/adapters/kiro.js';
import { createLogger } from '../../src/log.js';
import type { ACPClient } from '../../src/acp.js';

const silentLog = () => createLogger({ level: 'error', output: () => {} });

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

interface SpawnCall {
  kiroPath: string;
  args: string[];
  env: Record<string, string>;
}

function captureSpawnCalls(): {
  spawnImpl: (k: string, a: string[], e: Record<string, string>) => ACPClient;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnImpl = (kiroPath: string, args: string[], env: Record<string, string>): ACPClient => {
    calls.push({ kiroPath, args, env });
    return fakeAcpClient();
  };
  return { spawnImpl, calls };
}

describe('KiroAdapter.spawn under useWorkerUid', () => {
  it('useWorkerUid:false → spawnImpl called with (kiroPath, ["acp"], env)', () => {
    const { spawnImpl, calls } = captureSpawnCalls();
    const adapter = createKiroAdapter({ kiroPath: '/usr/local/bin/kiro', log: silentLog(), spawnImpl });

    adapter.spawn({ sessionId: 'sess-1', env: { WORKDIR: '/work' }, useWorkerUid: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.kiroPath).toBe('/usr/local/bin/kiro');
    expect(calls[0]!.args).toEqual(['acp']);
    expect(calls[0]!.env).toEqual({ WORKDIR: '/work', AGENT_ROUTER_SESSION_ID: 'sess-1' });
  });

  it('useWorkerUid:true → spawnImpl called with sudo -u agentworker <kiro> acp', () => {
    const { spawnImpl, calls } = captureSpawnCalls();
    const adapter = createKiroAdapter({ kiroPath: '/usr/local/bin/kiro', log: silentLog(), spawnImpl });

    adapter.spawn({
      sessionId: 'sess-2',
      env: { WORKDIR: '/work' },
      useWorkerUid: true,
      capToken: 'abc123',
      agentSocketPath: '/run/agent-router/agent.sock',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.kiroPath).toBe('/usr/bin/sudo');
    expect(calls[0]!.args).toEqual(['-u', 'agentworker', '/usr/local/bin/kiro', 'acp']);
  });

  it('useWorkerUid:true + GITHUB_TOKEN in env → child env has no GITHUB_TOKEN', () => {
    const { spawnImpl, calls } = captureSpawnCalls();
    const adapter = createKiroAdapter({ kiroPath: '/usr/local/bin/kiro', log: silentLog(), spawnImpl });

    adapter.spawn({
      sessionId: 'sess-3',
      env: { WORKDIR: '/work', GITHUB_TOKEN: 'ghp_secret' },
      useWorkerUid: true,
      capToken: 'tok',
      agentSocketPath: '/run/agent-router/agent.sock',
    });

    expect(calls[0]!.env).not.toHaveProperty('GITHUB_TOKEN');
    // Existing non-secret fields are preserved.
    expect(calls[0]!.env['WORKDIR']).toBe('/work');
    // The isolation env is present.
    expect(calls[0]!.env['AGENT_ROUTER_AGENT_SOCK']).toBe('/run/agent-router/agent.sock');
    expect(calls[0]!.env['HTTPS_PROXY']).toBe('http://127.0.0.1:8080');
    expect(calls[0]!.env['AGENT_ROUTER_SESSION_ID']).toBe('sess-3');
  });

  it('useWorkerUid:true → env contains a non-empty AGENT_ROUTER_CAP_TOKEN', () => {
    const { spawnImpl, calls } = captureSpawnCalls();
    const adapter = createKiroAdapter({ kiroPath: '/usr/local/bin/kiro', log: silentLog(), spawnImpl });

    adapter.spawn({
      sessionId: 'sess-4',
      env: {},
      useWorkerUid: true,
      capToken: 'deadbeefcafe',
      agentSocketPath: '/run/agent-router/agent.sock',
    });

    expect(calls[0]!.env['AGENT_ROUTER_CAP_TOKEN']).toBe('deadbeefcafe');
    expect(calls[0]!.env['AGENT_ROUTER_CAP_TOKEN']!.length).toBeGreaterThan(0);
  });

  it('useWorkerUid:true falls back to deps.agentSocketPath when opts omits it', () => {
    const { spawnImpl, calls } = captureSpawnCalls();
    const adapter = createKiroAdapter({
      kiroPath: '/usr/local/bin/kiro',
      log: silentLog(),
      spawnImpl,
      agentSocketPath: '/run/agent-router/agent.sock',
    });

    adapter.spawn({ sessionId: 'sess-5', env: {}, useWorkerUid: true, capToken: 'x' });

    expect(calls[0]!.env['AGENT_ROUTER_AGENT_SOCK']).toBe('/run/agent-router/agent.sock');
  });
});

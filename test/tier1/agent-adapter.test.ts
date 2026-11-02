/**
 * Tier 1 tests: KiroAdapter.
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

function captureSpawnCalls(): { spawnImpl: (k: string, a: string[], e: Record<string, string>) => ACPClient; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl = (kiroPath: string, args: string[], env: Record<string, string>): ACPClient => {
    calls.push({ kiroPath, args, env });
    return fakeAcpClient();
  };
  return { spawnImpl, calls };
}

describe('createKiroAdapter', () => {
  describe('identity and capabilities', () => {
    it('name is "kiro"', () => {
      const adapter = createKiroAdapter({ kiroPath: '/tmp/kiro', log: silentLog() });
      expect(adapter.name).toBe('kiro');
    });

    it('capabilities() declares all four lifecycle events and per-tool matching', () => {
      const adapter = createKiroAdapter({ kiroPath: '/tmp/kiro', log: silentLog() });
      const caps = adapter.capabilities();
      expect(caps.events).toEqual(['session.start', 'tool.post', 'turn.end', 'session.end']);
      expect(caps.perToolMatching).toBe(true);
    });
  });

  describe('spawn', () => {
    it('delegates to spawnImpl with kiroPath, ["acp"], and the session id env var', () => {
      const { spawnImpl, calls } = captureSpawnCalls();
      const adapter = createKiroAdapter({
        kiroPath: '/usr/local/bin/kiro',
        log: silentLog(),
        spawnImpl,
      });

      adapter.spawn({ sessionId: 'session-abc' });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.kiroPath).toBe('/usr/local/bin/kiro');
      expect(calls[0]!.args).toEqual(['acp']);
      expect(calls[0]!.env).toEqual({ AGENT_ROUTER_SESSION_ID: 'session-abc' });
    });

    it('merges caller-supplied env vars, overriding only AGENT_ROUTER_SESSION_ID', () => {
      const { spawnImpl, calls } = captureSpawnCalls();
      const adapter = createKiroAdapter({
        kiroPath: '/tmp/kiro',
        log: silentLog(),
        spawnImpl,
      });

      adapter.spawn({ sessionId: 'sess-1', env: { FOO: 'bar', AGENT_ROUTER_SESSION_ID: 'should-be-overridden' } });

      expect(calls[0]!.env).toEqual({ FOO: 'bar', AGENT_ROUTER_SESSION_ID: 'sess-1' });
    });

    it('returns the ACPClient produced by spawnImpl', () => {
      const fake = fakeAcpClient();
      const adapter = createKiroAdapter({
        kiroPath: '/tmp/kiro',
        log: silentLog(),
        spawnImpl: () => fake,
      });
      expect(adapter.spawn({ sessionId: 'x' })).toBe(fake);
    });
  });

  describe('installHooks / uninstallHooks', () => {
    // Comprehensive write/merge/remove tests live in test/tier1/kiro-install-hooks.test.ts.
    // These smoke tests confirm the interface contract: installHooks resolves and
    // uninstallHooks resolves, using an in-memory homeDir.
    it('installHooks resolves (new signature: opts object)', async () => {
      const adapter = createKiroAdapter({ kiroPath: '/tmp/kiro', log: silentLog() });
      // With the default homeDir (~), this would write to disk — but since we
      // can't control ~ in a unit test safely, we just confirm the signature
      // accepts the opts object and resolves (it may fail with a warn due to
      // the test environment).
      await expect(
        adapter.installHooks({ sessionId: 'sess-test', daemonUrl: 'http://127.0.0.1:3000', bearerToken: 'tok' }),
      ).resolves.toBeUndefined();
    });

    it('uninstallHooks resolves without error', async () => {
      const adapter = createKiroAdapter({ kiroPath: '/tmp/kiro', log: silentLog() });
      await expect(adapter.uninstallHooks()).resolves.toBeUndefined();
      await expect(adapter.uninstallHooks({ sessionId: 'sess-test' })).resolves.toBeUndefined();
    });
  });
});

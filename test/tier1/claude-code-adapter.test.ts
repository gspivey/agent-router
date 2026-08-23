/**
 * Tier 1 tests: ClaudeCodeAdapter.
 */
import { describe, it, expect } from 'vitest';
import { createClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
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
  bin: string;
  args: string[];
  env: Record<string, string>;
}

function captureSpawnCalls(): { spawnImpl: (bin: string, args: string[], env: Record<string, string>) => ACPClient; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl = (bin: string, args: string[], env: Record<string, string>): ACPClient => {
    calls.push({ bin, args, env });
    return fakeAcpClient();
  };
  return { spawnImpl, calls };
}

describe('createClaudeCodeAdapter', () => {
  describe('identity and capabilities', () => {
    it('name is "claude-code"', () => {
      const adapter = createClaudeCodeAdapter({ log: silentLog() });
      expect(adapter.name).toBe('claude-code');
    });

    it('capabilities() declares all four lifecycle events and per-tool matching', () => {
      const adapter = createClaudeCodeAdapter({ log: silentLog() });
      const caps = adapter.capabilities();
      expect(caps.events).toEqual(['session.start', 'tool.post', 'turn.end', 'session.end']);
      expect(caps.perToolMatching).toBe(true);
    });
  });

  describe('spawn', () => {
    it('delegates to spawnImpl with npx, correct args, and session id env var', () => {
      const { spawnImpl, calls } = captureSpawnCalls();
      const adapter = createClaudeCodeAdapter({
        log: silentLog(),
        spawnImpl,
      });

      adapter.spawn({ sessionId: 'session-abc' });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.bin).toBe('npx');
      expect(calls[0]!.args).toEqual(['@agentclientprotocol/claude-agent-acp@latest', '--acp']);
      expect(calls[0]!.env['AGENT_ROUTER_SESSION_ID']).toBe('session-abc');
    });

    it('sets ANTHROPIC_MODEL when model dep is provided', () => {
      const { spawnImpl, calls } = captureSpawnCalls();
      const adapter = createClaudeCodeAdapter({
        model: 'claude-opus-5',
        log: silentLog(),
        spawnImpl,
      });

      adapter.spawn({ sessionId: 'sess-1' });

      expect(calls[0]!.env['ANTHROPIC_MODEL']).toBe('claude-opus-5');
    });

    it('does NOT set ANTHROPIC_MODEL when model is undefined', () => {
      const { spawnImpl, calls } = captureSpawnCalls();
      const adapter = createClaudeCodeAdapter({
        log: silentLog(),
        spawnImpl,
      });

      adapter.spawn({ sessionId: 'sess-2' });

      expect(calls[0]!.env).not.toHaveProperty('ANTHROPIC_MODEL');
    });

    it('merges caller-supplied env vars', () => {
      const { spawnImpl, calls } = captureSpawnCalls();
      const adapter = createClaudeCodeAdapter({
        log: silentLog(),
        spawnImpl,
      });

      adapter.spawn({ sessionId: 'sess-3', env: { FOO: 'bar', WORKDIR: '/tmp/work' } });

      expect(calls[0]!.env['FOO']).toBe('bar');
      expect(calls[0]!.env['WORKDIR']).toBe('/tmp/work');
      expect(calls[0]!.env['AGENT_ROUTER_SESSION_ID']).toBe('sess-3');
    });

    it('AGENT_ROUTER_SESSION_ID overrides any caller-supplied value', () => {
      const { spawnImpl, calls } = captureSpawnCalls();
      const adapter = createClaudeCodeAdapter({
        log: silentLog(),
        spawnImpl,
      });

      adapter.spawn({ sessionId: 'correct-id', env: { AGENT_ROUTER_SESSION_ID: 'should-be-overridden' } });

      expect(calls[0]!.env['AGENT_ROUTER_SESSION_ID']).toBe('correct-id');
    });

    it('returns the ACPClient produced by spawnImpl', () => {
      const fake = fakeAcpClient();
      const adapter = createClaudeCodeAdapter({
        log: silentLog(),
        spawnImpl: () => fake,
      });
      expect(adapter.spawn({ sessionId: 'x' })).toBe(fake);
    });
  });

  describe('installHooks / uninstallHooks (stubs)', () => {
    it('installHooks resolves and logs a stub message', async () => {
      const logs: string[] = [];
      const log = createLogger({
        level: 'info',
        output: (line) => { logs.push(line); },
      });
      const adapter = createClaudeCodeAdapter({ log });
      await expect(adapter.installHooks('http://daemon.local', 'token-xyz')).resolves.toBeUndefined();
      expect(logs.some((line) => line.includes('stub'))).toBe(true);
    });

    it('uninstallHooks resolves without error', async () => {
      const adapter = createClaudeCodeAdapter({ log: silentLog() });
      await expect(adapter.uninstallHooks()).resolves.toBeUndefined();
    });
  });
});

/**
 * Tier 1 tests: buildMcpServerEntry pure helper.
 *
 * Spec: .kiro/specs/mcp-server-wiring/ · tasks 3, 4
 * Requirements: 3.5, 3.6, 9.2, 9.5
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildMcpServerEntry } from '../../src/session-mgr.js';

const SERVER_PATH = '/abs/src/mcp-server.ts';
const COMMAND = '/usr/bin/node';
const COMMAND_ARGS = ['--import', 'tsx/esm'];

describe('buildMcpServerEntry', () => {
  it('returns undefined when daemonSocket is undefined', () => {
    const entry = buildMcpServerEntry('sess-1', undefined, SERVER_PATH, COMMAND, COMMAND_ARGS);
    expect(entry).toBeUndefined();
  });

  it('uses the stable name "agent-router"', () => {
    const entry = buildMcpServerEntry('sess-1', '/tmp/sock', SERVER_PATH, COMMAND, COMMAND_ARGS);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('agent-router');
  });

  it('sets command and args = [...commandArgs, serverPath]', () => {
    const entry = buildMcpServerEntry('sess-1', '/tmp/sock', SERVER_PATH, COMMAND, COMMAND_ARGS);
    expect(entry!.command).toBe(COMMAND);
    expect(entry!.args).toEqual(['--import', 'tsx/esm', SERVER_PATH]);
  });

  it('env is an array containing both session id and socket pairs', () => {
    const entry = buildMcpServerEntry('sess-abc', '/tmp/sock', SERVER_PATH, COMMAND, COMMAND_ARGS);
    expect(Array.isArray(entry!.env)).toBe(true);
    expect(entry!.env).toContainEqual({ name: 'AGENT_ROUTER_SESSION_ID', value: 'sess-abc' });
    expect(entry!.env).toContainEqual({ name: 'AGENT_ROUTER_SOCKET', value: '/tmp/sock' });
  });

  it('appends extraEnv pairs after the two required ones', () => {
    const entry = buildMcpServerEntry('sess-1', '/tmp/sock', SERVER_PATH, COMMAND, COMMAND_ARGS, [
      { name: 'GITHUB_API_BASE_URL', value: 'https://example.test' },
    ]);
    expect(entry!.env).toContainEqual({ name: 'GITHUB_API_BASE_URL', value: 'https://example.test' });
    // required pairs come first
    expect(entry!.env[0]).toEqual({ name: 'AGENT_ROUTER_SESSION_ID', value: 'sess-1' });
    expect(entry!.env[1]).toEqual({ name: 'AGENT_ROUTER_SOCKET', value: '/tmp/sock' });
  });

  it('property: round-trips session id and socket into env array (never a Record)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (sessionId, socket) => {
          const entry = buildMcpServerEntry(sessionId, socket, SERVER_PATH, COMMAND, COMMAND_ARGS);
          if (entry === undefined) return false;
          // env must be an array, not a Record
          if (!Array.isArray(entry.env)) return false;
          const idPair = entry.env.find((e) => e.name === 'AGENT_ROUTER_SESSION_ID');
          const sockPair = entry.env.find((e) => e.name === 'AGENT_ROUTER_SOCKET');
          return idPair?.value === sessionId && sockPair?.value === socket;
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * Tier 1: buildChildEnv pure function tests.
 *
 * Verifies the allowlist-based environment scrubbing:
 * - Only allowlisted keys + AGENT_ROUTER_* from parent are forwarded
 * - Secrets like GITHUB_TOKEN_*, GITHUB_WEBHOOK_SECRET* are excluded
 * - Explicit overrides (e.g. GITHUB_TOKEN) are applied on top
 * - Custom allowlist extends coverage
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { buildChildEnv, DEFAULT_CHILD_ENV_ALLOWLIST } from '../../src/acp.js';

describe('buildChildEnv', () => {
  const parentEnv: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/operator',
    LANG: 'en_US.UTF-8',
    USER: 'operator',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    GITHUB_TOKEN: 'ghp_daemon_token',
    GITHUB_TOKEN_DPDK: 'ghp_dpdk_secret',
    GITHUB_TOKEN_LLM_COURSE: 'ghp_llm_secret',
    GITHUB_WEBHOOK_SECRET: 'whsec_global',
    GITHUB_WEBHOOK_SECRET_REPO_A: 'whsec_a',
    AGENT_ROUTER_SESSION_ID: 'old-session-id',
    AGENT_ROUTER_HOME: '/home/operator/.agent-router',
    MY_CUSTOM_VAR: 'custom_value',
    SECRET_KEY: 'super_secret',
  };

  it('forwards only allowlisted keys from parent env', () => {
    const result = buildChildEnv(parentEnv, {});
    expect(result['PATH']).toBe('/usr/bin:/bin');
    expect(result['HOME']).toBe('/home/operator');
    expect(result['LANG']).toBe('en_US.UTF-8');
    expect(result['USER']).toBe('operator');
  });

  it('excludes GITHUB_TOKEN_* secrets from parent', () => {
    const result = buildChildEnv(parentEnv, {});
    expect(result['GITHUB_TOKEN']).toBeUndefined();
    expect(result['GITHUB_TOKEN_DPDK']).toBeUndefined();
    expect(result['GITHUB_TOKEN_LLM_COURSE']).toBeUndefined();
  });

  it('excludes GITHUB_WEBHOOK_SECRET* from parent', () => {
    const result = buildChildEnv(parentEnv, {});
    expect(result['GITHUB_WEBHOOK_SECRET']).toBeUndefined();
    expect(result['GITHUB_WEBHOOK_SECRET_REPO_A']).toBeUndefined();
  });

  it('excludes non-allowlisted vars from parent', () => {
    const result = buildChildEnv(parentEnv, {});
    expect(result['MY_CUSTOM_VAR']).toBeUndefined();
    expect(result['SECRET_KEY']).toBeUndefined();
  });

  it('always forwards AGENT_ROUTER_* keys from parent', () => {
    const result = buildChildEnv(parentEnv, {});
    expect(result['AGENT_ROUTER_SESSION_ID']).toBe('old-session-id');
    expect(result['AGENT_ROUTER_HOME']).toBe('/home/operator/.agent-router');
  });

  it('applies overrides on top of allowlisted keys', () => {
    const result = buildChildEnv(parentEnv, { GITHUB_TOKEN: 'ghp_repo_specific' });
    expect(result['GITHUB_TOKEN']).toBe('ghp_repo_specific');
    // The daemon's own GITHUB_TOKEN from parent should NOT leak
    expect(result['GITHUB_TOKEN']).not.toBe('ghp_daemon_token');
  });

  it('overrides take precedence over AGENT_ROUTER_* from parent', () => {
    const result = buildChildEnv(parentEnv, { AGENT_ROUTER_SESSION_ID: 'new-session-id' });
    expect(result['AGENT_ROUTER_SESSION_ID']).toBe('new-session-id');
  });

  it('handles missing parent keys gracefully', () => {
    const result = buildChildEnv({ PATH: '/bin' }, {});
    expect(result['PATH']).toBe('/bin');
    expect(result['HOME']).toBeUndefined();
  });

  it('respects custom allowlist', () => {
    const result = buildChildEnv(parentEnv, {}, [...DEFAULT_CHILD_ENV_ALLOWLIST, 'MY_CUSTOM_VAR']);
    expect(result['MY_CUSTOM_VAR']).toBe('custom_value');
    expect(result['SECRET_KEY']).toBeUndefined();
  });

  it('custom allowlist does not override the AGENT_ROUTER_* auto-forward', () => {
    const result = buildChildEnv(parentEnv, {}, ['PATH']);
    expect(result['AGENT_ROUTER_HOME']).toBe('/home/operator/.agent-router');
  });

  it('returns empty result from empty parent and empty overrides', () => {
    const result = buildChildEnv({}, {});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('handles undefined values in parent env', () => {
    const parent: Record<string, string | undefined> = {
      PATH: '/bin',
      HOME: undefined,
    };
    const result = buildChildEnv(parent, {});
    expect(result['PATH']).toBe('/bin');
    expect('HOME' in result).toBe(false);
  });

  // Property-based tests
  describe('property tests', () => {
    it('output never contains GITHUB_TOKEN_* from parent (only via overrides)', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,30}$/),
            fc.string({ minLength: 1, maxLength: 50 }),
          ),
          (parent) => {
            const result = buildChildEnv(parent, {});
            for (const key of Object.keys(result)) {
              if (key.startsWith('GITHUB_TOKEN')) {
                // Only allowed if it's also AGENT_ROUTER_*
                expect(key.startsWith('AGENT_ROUTER_')).toBe(true);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('output never contains GITHUB_WEBHOOK_SECRET* from parent', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,30}$/),
            fc.string({ minLength: 1, maxLength: 50 }),
          ),
          (parent) => {
            const result = buildChildEnv(parent, {});
            for (const key of Object.keys(result)) {
              expect(key.startsWith('GITHUB_WEBHOOK_SECRET')).toBe(false);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('every override key appears in the output with its override value', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,20}$/),
            fc.string({ minLength: 1, maxLength: 50 }),
          ),
          fc.dictionary(
            fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,20}$/),
            fc.string({ minLength: 1, maxLength: 50 }),
          ),
          (parent, overrides) => {
            const result = buildChildEnv(parent, overrides);
            for (const [key, value] of Object.entries(overrides)) {
              expect(result[key]).toBe(value);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('every AGENT_ROUTER_* key from parent appears in output (unless overridden)', () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.constantFrom('AGENT_ROUTER_A', 'AGENT_ROUTER_B', 'AGENT_ROUTER_SESSION_ID', 'PATH', 'SECRET'),
            fc.string({ minLength: 1, maxLength: 50 }),
          ),
          (parent) => {
            const result = buildChildEnv(parent, {});
            for (const key of Object.keys(parent)) {
              if (key.startsWith('AGENT_ROUTER_') && parent[key] !== undefined) {
                expect(result[key]).toBe(parent[key]);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

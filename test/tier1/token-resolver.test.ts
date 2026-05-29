/**
 * Tier 1 tests: createTokenResolver.
 *
 * Pure unit tests for the per-repo → default → env hierarchy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTokenResolver } from '../../src/github.js';

const ORIG_TOKEN = process.env['GITHUB_TOKEN'];

beforeEach(() => {
  delete process.env['GITHUB_TOKEN'];
});

afterEach(() => {
  if (ORIG_TOKEN === undefined) {
    delete process.env['GITHUB_TOKEN'];
  } else {
    process.env['GITHUB_TOKEN'] = ORIG_TOKEN;
  }
});

describe('createTokenResolver', () => {
  it('returns per-repo token when one is configured', () => {
    const resolve = createTokenResolver({
      perRepoTokens: { 'gspivey/dpdk-stdlib-rust': 'tok-dpdk' },
      defaultToken: 'tok-default',
    });
    expect(resolve('gspivey', 'dpdk-stdlib-rust')).toBe('tok-dpdk');
  });

  it('falls back to defaultToken when no per-repo entry', () => {
    const resolve = createTokenResolver({
      perRepoTokens: { 'gspivey/other': 'tok-other' },
      defaultToken: 'tok-default',
    });
    expect(resolve('gspivey', 'agent-router')).toBe('tok-default');
  });

  it('falls back to process.env.GITHUB_TOKEN when envFallback=true and no other source', () => {
    process.env['GITHUB_TOKEN'] = 'tok-env';
    const resolve = createTokenResolver({ envFallback: true });
    expect(resolve('gspivey', 'agent-router')).toBe('tok-env');
  });

  it('reads env freshly on each call when envFallback=true (supports rotation)', () => {
    process.env['GITHUB_TOKEN'] = 'tok-env-1';
    const resolve = createTokenResolver({ envFallback: true });
    expect(resolve('o', 'r')).toBe('tok-env-1');
    process.env['GITHUB_TOKEN'] = 'tok-env-2';
    expect(resolve('o', 'r')).toBe('tok-env-2');
  });

  it('throws when nothing is configured and envFallback=false', () => {
    process.env['GITHUB_TOKEN'] = 'tok-env-should-be-ignored';
    const resolve = createTokenResolver({});
    expect(() => resolve('o', 'r')).toThrow(/No GitHub token/);
  });

  it('throws when envFallback=true but env is also unset', () => {
    const resolve = createTokenResolver({ envFallback: true });
    expect(() => resolve('o', 'r')).toThrow(/No GitHub token/);
  });

  it('treats empty-string per-repo token as missing (falls through to default)', () => {
    const resolve = createTokenResolver({
      perRepoTokens: { 'o/r': '' },
      defaultToken: 'tok-default',
    });
    expect(resolve('o', 'r')).toBe('tok-default');
  });

  it('is case-sensitive on owner/repo lookup', () => {
    const resolve = createTokenResolver({
      perRepoTokens: { 'gspivey/agent-router': 'tok-lower' },
      defaultToken: 'tok-default',
    });
    expect(resolve('GSPIVEY', 'agent-router')).toBe('tok-default');
  });

  it('per-repo wins over default even when default is set', () => {
    const resolve = createTokenResolver({
      perRepoTokens: { 'o/r': 'tok-repo' },
      defaultToken: 'tok-default',
      envFallback: true,
    });
    process.env['GITHUB_TOKEN'] = 'tok-env';
    expect(resolve('o', 'r')).toBe('tok-repo');
  });

  it('default wins over env when both are set', () => {
    const resolve = createTokenResolver({
      defaultToken: 'tok-default',
      envFallback: true,
    });
    process.env['GITHUB_TOKEN'] = 'tok-env';
    expect(resolve('o', 'r')).toBe('tok-default');
  });
});

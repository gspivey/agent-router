import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { classifyConfigChange } from '../../src/config.js';
import type { AgentRouterConfig } from '../../src/config.js';

function baseConfig(overrides?: Partial<AgentRouterConfig>): AgentRouterConfig {
  return {
    port: 3000,
    webhookSecret: 'secret',
    kiroPath: '/usr/bin/kiro',
    rateLimit: { perPRSeconds: 60 },
    sessionTimeout: { inactivityMinutes: 5, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 },
    repos: [{ owner: 'org', name: 'repo' }],
    cron: [],
    controlPort: 3100,
    bindPublic: false,
    shutdownDrainSeconds: 60,
    credentialMode: 'env',
    ...overrides,
  };
}

describe('classifyConfigChange', () => {
  it('returns empty lists when configs are identical', () => {
    const cfg = baseConfig();
    const result = classifyConfigChange(cfg, cfg);
    expect(result.reloadable).toEqual([]);
    expect(result.restartRequired).toEqual([]);
  });

  it('classifies port as restart-required', () => {
    const old = baseConfig();
    const next = baseConfig({ port: 4000 });
    const result = classifyConfigChange(old, next);
    expect(result.restartRequired).toContain('port');
    expect(result.reloadable).not.toContain('port');
  });

  it('classifies controlPort as restart-required', () => {
    const old = baseConfig();
    const next = baseConfig({ controlPort: 4100 });
    const result = classifyConfigChange(old, next);
    expect(result.restartRequired).toContain('controlPort');
  });

  it('classifies bindPublic as restart-required', () => {
    const old = baseConfig();
    const next = baseConfig({ bindPublic: true });
    const result = classifyConfigChange(old, next);
    expect(result.restartRequired).toContain('bindPublic');
  });

  it('classifies kiroPath as restart-required', () => {
    const old = baseConfig();
    const next = baseConfig({ kiroPath: '/other/kiro' });
    const result = classifyConfigChange(old, next);
    expect(result.restartRequired).toContain('kiroPath');
  });

  it('classifies trustedProxy as restart-required', () => {
    const old = baseConfig();
    const next = baseConfig({ trustedProxy: { identityHeader: 'X-Id', proofHeader: 'X-Proof', proofSecret: '/tmp/s' } });
    const result = classifyConfigChange(old, next);
    expect(result.restartRequired).toContain('trustedProxy');
  });

  it('classifies repos as reloadable', () => {
    const old = baseConfig();
    const next = baseConfig({ repos: [{ owner: 'org', name: 'repo' }, { owner: 'org', name: 'new' }] });
    const result = classifyConfigChange(old, next);
    expect(result.reloadable).toContain('repos');
    expect(result.restartRequired).not.toContain('repos');
  });

  it('classifies cron as reloadable', () => {
    const old = baseConfig();
    const next = baseConfig({ cron: [{ name: 'test', schedule: '* * * * *', repo: 'org/repo', promptFile: '/tmp/p' }] });
    const result = classifyConfigChange(old, next);
    expect(result.reloadable).toContain('cron');
  });

  it('classifies rateLimit as reloadable', () => {
    const old = baseConfig();
    const next = baseConfig({ rateLimit: { perPRSeconds: 120 } });
    const result = classifyConfigChange(old, next);
    expect(result.reloadable).toContain('rateLimit');
  });

  it('classifies sessionTimeout as reloadable', () => {
    const old = baseConfig();
    const next = baseConfig({ sessionTimeout: { inactivityMinutes: 10, maxLifetimeMinutes: 120, gracePeriodAfterMergeSeconds: 60 } });
    const result = classifyConfigChange(old, next);
    expect(result.reloadable).toContain('sessionTimeout');
  });

  it('classifies defaultGithubToken as reloadable', () => {
    const old = baseConfig();
    const next = baseConfig({ defaultGithubToken: 'ghp_new' });
    const result = classifyConfigChange(old, next);
    expect(result.reloadable).toContain('defaultGithubToken');
  });

  it('classifies allowedEmails as reloadable', () => {
    const old = baseConfig();
    const next = baseConfig({ allowedEmails: ['a@b.com'] });
    const result = classifyConfigChange(old, next);
    expect(result.reloadable).toContain('allowedEmails');
  });

  it('handles multiple changes at once', () => {
    const old = baseConfig();
    const next = baseConfig({ port: 9000, repos: [{ owner: 'x', name: 'y' }], rateLimit: { perPRSeconds: 30 } });
    const result = classifyConfigChange(old, next);
    expect(result.restartRequired).toContain('port');
    expect(result.reloadable).toContain('repos');
    expect(result.reloadable).toContain('rateLimit');
  });

  it('property: identical configs always produce empty lists', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }),
        fc.integer({ min: 1, max: 300 }),
        (port, rateLimit) => {
          const cfg = baseConfig({ port, rateLimit: { perPRSeconds: rateLimit } });
          const result = classifyConfigChange(cfg, cfg);
          return result.reloadable.length === 0 && result.restartRequired.length === 0;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: a field appears in exactly one list when changed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65534 }),
        fc.integer({ min: 2, max: 65535 }),
        (oldPort, nextPort) => {
          if (oldPort === nextPort) return true;
          const old = baseConfig({ port: oldPort });
          const next = baseConfig({ port: nextPort });
          const result = classifyConfigChange(old, next);
          const inReloadable = result.reloadable.includes('port');
          const inRestart = result.restartRequired.includes('port');
          return !inReloadable && inRestart;
        },
      ),
      { numRuns: 100 },
    );
  });
});

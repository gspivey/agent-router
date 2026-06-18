import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeRestartRequiredFields, createRestartRequiredState } from '../../src/restart-required.js';
import { buildHealthResponse } from '../../src/health.js';
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
    ...overrides,
  };
}

describe('computeRestartRequiredFields', () => {
  it('returns empty array when configs are identical', () => {
    const cfg = baseConfig();
    expect(computeRestartRequiredFields(cfg, cfg)).toEqual([]);
  });

  it('detects changed port', () => {
    expect(computeRestartRequiredFields(baseConfig(), baseConfig({ port: 4000 }))).toContain('port');
  });

  it('detects changed controlPort', () => {
    expect(computeRestartRequiredFields(baseConfig(), baseConfig({ controlPort: 4100 }))).toContain('controlPort');
  });

  it('detects changed bindPublic', () => {
    expect(computeRestartRequiredFields(baseConfig(), baseConfig({ bindPublic: true }))).toContain('bindPublic');
  });

  it('detects changed kiroPath', () => {
    expect(computeRestartRequiredFields(baseConfig(), baseConfig({ kiroPath: '/other' }))).toContain('kiroPath');
  });

  it('detects changed trustedProxy', () => {
    const next = baseConfig({ trustedProxy: { identityHeader: 'X-Id', proofHeader: 'X-P', proofSecret: '/s' } });
    expect(computeRestartRequiredFields(baseConfig(), next)).toContain('trustedProxy');
  });

  it('ignores reloadable fields', () => {
    const next = baseConfig({ repos: [{ owner: 'a', name: 'b' }] });
    expect(computeRestartRequiredFields(baseConfig(), next)).toEqual([]);
  });

  it('property: identical configs always yield empty', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }),
        fc.integer({ min: 1, max: 65535 }),
        (port, controlPort) => {
          if (port === controlPort) return; // skip invalid
          const cfg = baseConfig({ port, controlPort });
          expect(computeRestartRequiredFields(cfg, cfg)).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('createRestartRequiredState', () => {
  it('starts as null', () => {
    const state = createRestartRequiredState();
    expect(state.get()).toBeNull();
  });

  it('sets condition when restart-required field changes', () => {
    const state = createRestartRequiredState();
    const startup = baseConfig();
    const current = baseConfig({ port: 4000 });
    state.update(startup, current, 1000);
    const cond = state.get();
    expect(cond).not.toBeNull();
    expect(cond!.fields).toContain('port');
    expect(cond!.since).toBe(1000);
  });

  it('clears condition when config reverts to startup values', () => {
    const state = createRestartRequiredState();
    const startup = baseConfig();
    state.update(startup, baseConfig({ port: 4000 }), 1000);
    expect(state.get()).not.toBeNull();

    state.update(startup, startup, 2000);
    expect(state.get()).toBeNull();
  });

  it('preserves original since timestamp across subsequent updates', () => {
    const state = createRestartRequiredState();
    const startup = baseConfig();
    state.update(startup, baseConfig({ port: 4000 }), 1000);
    state.update(startup, baseConfig({ port: 5000 }), 2000);
    expect(state.get()!.since).toBe(1000);
  });

  it('resets since when condition clears and re-appears', () => {
    const state = createRestartRequiredState();
    const startup = baseConfig();
    state.update(startup, baseConfig({ port: 4000 }), 1000);
    state.update(startup, startup, 2000);
    state.update(startup, baseConfig({ port: 5000 }), 3000);
    expect(state.get()!.since).toBe(3000);
  });

  it('tracks multiple fields', () => {
    const state = createRestartRequiredState();
    const startup = baseConfig();
    state.update(startup, baseConfig({ port: 4000, bindPublic: true }), 1000);
    const cond = state.get()!;
    expect(cond.fields).toContain('port');
    expect(cond.fields).toContain('bindPublic');
  });
});

describe('buildHealthResponse with restart_required', () => {
  const baseState = {
    startedAtMs: 1000,
    nowMs: 61_000,
    activeSessionCount: 1,
    dbOk: true,
  };

  it('omits restart_required when null', () => {
    const result = buildHealthResponse({ ...baseState, restartRequired: null });
    expect(result.body).not.toHaveProperty('restart_required');
  });

  it('omits restart_required when undefined', () => {
    const result = buildHealthResponse(baseState);
    expect(result.body).not.toHaveProperty('restart_required');
  });

  it('includes restart_required when condition is present', () => {
    const result = buildHealthResponse({
      ...baseState,
      restartRequired: { fields: ['port'], since: 1718712000000 },
    });
    expect(result.body.restart_required).toEqual({
      fields: ['port'],
      since: '2024-06-18T12:00:00.000Z',
    });
  });

  it('still returns 200 when restart_required is present but db is ok', () => {
    const result = buildHealthResponse({
      ...baseState,
      restartRequired: { fields: ['port'], since: 1000 },
    });
    expect(result.status).toBe(200);
  });
});

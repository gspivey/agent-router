/**
 * Tier 1 tests: config validation for continuous and baseBranch fields.
 * Task 1.6 (config portion)
 */
import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config.js';
import { FatalError } from '../../src/errors.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Create a minimal valid config object for testing.
// We need a real executable for kiroPath validation.
const KIRO_PATH = process.execPath; // node executable is guaranteed to exist

const VALID_BASE = {
  port: 3000,
  webhookSecret: 'secret',
  kiroPath: KIRO_PATH,
  repos: [{ owner: 'myorg', name: 'myrepo' }],
  cron: [],
};

describe('validateConfig: continuous field', () => {
  it('accepts continuous: true', () => {
    const cfg = validateConfig({
      ...VALID_BASE,
      repos: [{ owner: 'myorg', name: 'myrepo', continuous: true }],
    });
    expect(cfg.repos[0]!.continuous).toBe(true);
  });

  it('accepts continuous: false', () => {
    const cfg = validateConfig({
      ...VALID_BASE,
      repos: [{ owner: 'myorg', name: 'myrepo', continuous: false }],
    });
    expect(cfg.repos[0]!.continuous).toBe(false);
  });

  it('throws FatalError on continuous: 42', () => {
    expect(() =>
      validateConfig({
        ...VALID_BASE,
        repos: [{ owner: 'myorg', name: 'myrepo', continuous: 42 }],
      })
    ).toThrowError(FatalError);
  });

  it('throws FatalError on continuous: "true" (string)', () => {
    expect(() =>
      validateConfig({
        ...VALID_BASE,
        repos: [{ owner: 'myorg', name: 'myrepo', continuous: 'true' }],
      })
    ).toThrowError(FatalError);
  });

  it('leaves continuous undefined when absent', () => {
    const cfg = validateConfig({
      ...VALID_BASE,
      repos: [{ owner: 'myorg', name: 'myrepo' }],
    });
    expect(cfg.repos[0]!.continuous).toBeUndefined();
  });
});

describe('validateConfig: baseBranch field', () => {
  it('accepts baseBranch: "development"', () => {
    const cfg = validateConfig({
      ...VALID_BASE,
      repos: [{ owner: 'myorg', name: 'myrepo', baseBranch: 'development' }],
    });
    expect(cfg.repos[0]!.baseBranch).toBe('development');
  });

  it('accepts baseBranch: "main"', () => {
    const cfg = validateConfig({
      ...VALID_BASE,
      repos: [{ owner: 'myorg', name: 'myrepo', baseBranch: 'main' }],
    });
    expect(cfg.repos[0]!.baseBranch).toBe('main');
  });

  it('throws FatalError on baseBranch: "" (empty string)', () => {
    expect(() =>
      validateConfig({
        ...VALID_BASE,
        repos: [{ owner: 'myorg', name: 'myrepo', baseBranch: '' }],
      })
    ).toThrowError(FatalError);
  });

  it('throws FatalError on baseBranch: 123 (number)', () => {
    expect(() =>
      validateConfig({
        ...VALID_BASE,
        repos: [{ owner: 'myorg', name: 'myrepo', baseBranch: 123 }],
      })
    ).toThrowError(FatalError);
  });

  it('leaves baseBranch undefined when absent', () => {
    const cfg = validateConfig({
      ...VALID_BASE,
      repos: [{ owner: 'myorg', name: 'myrepo' }],
    });
    expect(cfg.repos[0]!.baseBranch).toBeUndefined();
  });
});

describe('validateConfig: both fields together', () => {
  it('accepts continuous: true and baseBranch: "development"', () => {
    const cfg = validateConfig({
      ...VALID_BASE,
      repos: [{ owner: 'myorg', name: 'myrepo', continuous: true, baseBranch: 'development' }],
    });
    expect(cfg.repos[0]!.continuous).toBe(true);
    expect(cfg.repos[0]!.baseBranch).toBe('development');
  });

  it('absence of both leaves them undefined', () => {
    const cfg = validateConfig({
      ...VALID_BASE,
      repos: [{ owner: 'myorg', name: 'myrepo' }],
    });
    expect(cfg.repos[0]!.continuous).toBeUndefined();
    expect(cfg.repos[0]!.baseBranch).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../../src/config.js';
import { FatalError } from '../../src/errors.js';

/**
 * Helper: create a temp file that is executable, returning its path.
 * Cleaned up in afterEach via the tempFiles array.
 */
const tempFiles: string[] = [];

function createExecutable(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-config-'));
  const filePath = path.join(dir, 'fake-kiro');
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
  tempFiles.push(dir);
  return filePath;
}

afterEach(() => {
  for (const dir of tempFiles) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempFiles.length = 0;
});

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    port: 3000,
    webhookSecret: 'test-secret',
    kiroPath: createExecutable(),
    rateLimit: { perPRSeconds: 60 },
    repos: [{ owner: 'myorg', name: 'myrepo' }],
    cron: [],
    ...overrides,
  };
}

describe('validateConfig', () => {
  // --- Happy path ---

  it('accepts a valid minimal config', () => {
    const cfg = validConfig();
    const result = validateConfig(cfg);
    expect(result.port).toBe(3000);
    expect(result.webhookSecret).toBe('test-secret');
    expect(result.repos).toHaveLength(1);
    expect(result.cron).toHaveLength(0);
  });

  it('accepts a config with cron entries matching repos', () => {
    const cfg = validConfig({
      cron: [{ name: 'sweep', schedule: '0 */2 * * *', repo: 'myorg/myrepo' }],
    });
    const result = validateConfig(cfg);
    expect(result.cron).toHaveLength(1);
    expect(result.cron[0]!.name).toBe('sweep');
  });

  it('accepts port at lower bound (1)', () => {
    const result = validateConfig(validConfig({ port: 1 }));
    expect(result.port).toBe(1);
  });

  it('accepts port at upper bound (65535)', () => {
    const result = validateConfig(validConfig({ port: 65535 }));
    expect(result.port).toBe(65535);
  });

  it('defaults rateLimit.perPRSeconds to 60 when rateLimit is omitted', () => {
    const cfg = validConfig();
    delete cfg['rateLimit'];
    const result = validateConfig(cfg);
    expect(result.rateLimit.perPRSeconds).toBe(60);
  });

  it('preserves roadmapPath on repos when provided', () => {
    const cfg = validConfig({
      repos: [{ owner: 'org', name: 'repo', roadmapPath: './ROADMAP.md' }],
    });
    const result = validateConfig(cfg);
    expect(result.repos[0]!.roadmapPath).toBe('./ROADMAP.md');
  });

  // --- Non-object config ---

  it('throws FatalError when config is null', () => {
    expect(() => validateConfig(null)).toThrow(FatalError);
  });

  it('throws FatalError when config is a string', () => {
    expect(() => validateConfig('bad')).toThrow(FatalError);
  });

  it('throws FatalError when config is an array', () => {
    expect(() => validateConfig([])).toThrow(FatalError);
  });

  // --- Port validation ---

  it('throws FatalError when port is missing', () => {
    const cfg = validConfig();
    delete cfg['port'];
    expect(() => validateConfig(cfg)).toThrow(FatalError);
    expect(() => validateConfig(cfg)).toThrow(/port/i);
  });

  it('throws FatalError when port is 0', () => {
    expect(() => validateConfig(validConfig({ port: 0 }))).toThrow(FatalError);
  });

  it('throws FatalError when port is 65536', () => {
    expect(() => validateConfig(validConfig({ port: 65536 }))).toThrow(FatalError);
  });

  it('throws FatalError when port is a float', () => {
    expect(() => validateConfig(validConfig({ port: 3000.5 }))).toThrow(FatalError);
  });

  it('throws FatalError when port is negative', () => {
    expect(() => validateConfig(validConfig({ port: -1 }))).toThrow(FatalError);
  });

  it('throws FatalError when port is a string', () => {
    expect(() => validateConfig(validConfig({ port: '3000' }))).toThrow(FatalError);
  });

  // --- webhookSecret validation ---

  it('throws FatalError when webhookSecret is missing', () => {
    const cfg = validConfig();
    delete cfg['webhookSecret'];
    expect(() => validateConfig(cfg)).toThrow(FatalError);
    expect(() => validateConfig(cfg)).toThrow(/webhookSecret/i);
  });

  it('throws FatalError when webhookSecret is empty string', () => {
    expect(() => validateConfig(validConfig({ webhookSecret: '' }))).toThrow(FatalError);
  });

  it('throws FatalError when webhookSecret is a number', () => {
    expect(() => validateConfig(validConfig({ webhookSecret: 123 }))).toThrow(FatalError);
  });

  // --- kiroPath validation ---

  it('throws FatalError when kiroPath is missing', () => {
    const cfg = validConfig();
    delete cfg['kiroPath'];
    expect(() => validateConfig(cfg)).toThrow(FatalError);
    expect(() => validateConfig(cfg)).toThrow(/kiroPath/i);
  });

  it('throws FatalError when kiroPath is empty string', () => {
    expect(() => validateConfig(validConfig({ kiroPath: '' }))).toThrow(FatalError);
  });

  it('throws FatalError when kiroPath points to a non-existent file', () => {
    expect(() => validateConfig(validConfig({ kiroPath: '/no/such/file' }))).toThrow(FatalError);
    expect(() => validateConfig(validConfig({ kiroPath: '/no/such/file' }))).toThrow(/kiroPath/i);
  });

  it('throws FatalError when kiroPath points to a non-executable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-config-'));
    const filePath = path.join(dir, 'not-exec');
    fs.writeFileSync(filePath, 'data');
    fs.chmodSync(filePath, 0o644);
    tempFiles.push(dir);
    expect(() => validateConfig(validConfig({ kiroPath: filePath }))).toThrow(FatalError);
  });

  // --- repos validation ---

  it('throws FatalError when repos is missing', () => {
    const cfg = validConfig();
    delete cfg['repos'];
    expect(() => validateConfig(cfg)).toThrow(FatalError);
    expect(() => validateConfig(cfg)).toThrow(/repos/i);
  });

  it('throws FatalError when repos is not an array', () => {
    expect(() => validateConfig(validConfig({ repos: 'bad' }))).toThrow(FatalError);
  });

  it('throws FatalError when a repo has empty owner', () => {
    expect(() =>
      validateConfig(validConfig({ repos: [{ owner: '', name: 'repo' }] }))
    ).toThrow(FatalError);
    expect(() =>
      validateConfig(validConfig({ repos: [{ owner: '', name: 'repo' }] }))
    ).toThrow(/owner/i);
  });

  it('throws FatalError when a repo has empty name', () => {
    expect(() =>
      validateConfig(validConfig({ repos: [{ owner: 'org', name: '' }] }))
    ).toThrow(FatalError);
    expect(() =>
      validateConfig(validConfig({ repos: [{ owner: 'org', name: '' }] }))
    ).toThrow(/name/i);
  });

  it('throws FatalError when a repo is missing owner', () => {
    expect(() =>
      validateConfig(validConfig({ repos: [{ name: 'repo' }] }))
    ).toThrow(FatalError);
  });

  it('throws FatalError when a repo is missing name', () => {
    expect(() =>
      validateConfig(validConfig({ repos: [{ owner: 'org' }] }))
    ).toThrow(FatalError);
  });

  // --- cron validation ---

  it('throws FatalError when cron is missing', () => {
    const cfg = validConfig();
    delete cfg['cron'];
    expect(() => validateConfig(cfg)).toThrow(FatalError);
    expect(() => validateConfig(cfg)).toThrow(/cron/i);
  });

  it('throws FatalError when cron is not an array', () => {
    expect(() => validateConfig(validConfig({ cron: 'bad' }))).toThrow(FatalError);
  });

  it('throws FatalError when a cron entry has empty name', () => {
    expect(() =>
      validateConfig(validConfig({
        cron: [{ name: '', schedule: '* * * * *', repo: 'myorg/myrepo' }],
      }))
    ).toThrow(FatalError);
    expect(() =>
      validateConfig(validConfig({
        cron: [{ name: '', schedule: '* * * * *', repo: 'myorg/myrepo' }],
      }))
    ).toThrow(/name/i);
  });

  it('throws FatalError when a cron entry has invalid schedule', () => {
    expect(() =>
      validateConfig(validConfig({
        cron: [{ name: 'job', schedule: 'not-a-cron', repo: 'myorg/myrepo' }],
      }))
    ).toThrow(FatalError);
    expect(() =>
      validateConfig(validConfig({
        cron: [{ name: 'job', schedule: 'not-a-cron', repo: 'myorg/myrepo' }],
      }))
    ).toThrow(/schedule/i);
  });

  it('throws FatalError when a cron entry repo does not match any repos entry', () => {
    expect(() =>
      validateConfig(validConfig({
        cron: [{ name: 'job', schedule: '* * * * *', repo: 'unknown/repo' }],
      }))
    ).toThrow(FatalError);
    expect(() =>
      validateConfig(validConfig({
        cron: [{ name: 'job', schedule: '* * * * *', repo: 'unknown/repo' }],
      }))
    ).toThrow(/does not match/i);
  });

  it('throws FatalError when a cron entry has empty schedule', () => {
    expect(() =>
      validateConfig(validConfig({
        cron: [{ name: 'job', schedule: '', repo: 'myorg/myrepo' }],
      }))
    ).toThrow(FatalError);
  });

  it('throws FatalError when a cron entry has empty repo', () => {
    expect(() =>
      validateConfig(validConfig({
        cron: [{ name: 'job', schedule: '* * * * *', repo: '' }],
      }))
    ).toThrow(FatalError);
  });

  it('accepts valid 5-field cron expressions', () => {
    const expressions = ['* * * * *', '0 */2 * * *', '30 9 * * 1-5', '0 0 1 * *'];
    for (const schedule of expressions) {
      const cfg = validConfig({
        cron: [{ name: 'job', schedule, repo: 'myorg/myrepo' }],
      });
      expect(() => validateConfig(cfg)).not.toThrow();
    }
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { FatalError } from '../../src/errors.js';

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-config-'));
  tempDirs.push(dir);
  return dir;
}

function createExecutable(dir: string): string {
  const filePath = path.join(dir, 'fake-kiro');
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeConfig(dir: string, content: string): string {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function deleteEnv(key: string): void {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('loadConfig', () => {
  it('throws FatalError when config file does not exist', () => {
    const dir = makeTempDir();
    const missingPath = path.join(dir, 'nonexistent.json');
    expect(() => loadConfig(missingPath)).toThrow(FatalError);
    expect(() => loadConfig(missingPath)).toThrow(/not found/i);
  });

  it('throws FatalError when config file contains invalid JSON', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, '{ bad json !!!');
    expect(() => loadConfig(configPath)).toThrow(FatalError);
    expect(() => loadConfig(configPath)).toThrow(/invalid json/i);
  });

  it('throws FatalError when config file contains a JSON array', () => {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, '[]');
    expect(() => loadConfig(configPath)).toThrow(FatalError);
    expect(() => loadConfig(configPath)).toThrow(/object/i);
  });

  it('returns typed AgentRouterConfig for a valid config file', () => {
    const dir = makeTempDir();
    const kiroPath = createExecutable(dir);
    const config = {
      port: 4000,
      webhookSecret: 'my-secret',
      kiroPath,
      rateLimit: { perPRSeconds: 120 },
      repos: [{ owner: 'org', name: 'repo' }],
      cron: [],
    };
    const configPath = writeConfig(dir, JSON.stringify(config));
    const result = loadConfig(configPath);

    expect(result.port).toBe(4000);
    expect(result.webhookSecret).toBe('my-secret');
    expect(result.kiroPath).toBe(kiroPath);
    expect(result.rateLimit.perPRSeconds).toBe(120);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]!.owner).toBe('org');
    expect(result.repos[0]!.name).toBe('repo');
    expect(result.cron).toHaveLength(0);
    expect(result.sessionTimeout.inactivityMinutes).toBe(5);
    expect(result.sessionTimeout.maxLifetimeMinutes).toBe(120);
  });

  it('resolves ENV: values before validation', () => {
    const dir = makeTempDir();
    const kiroPath = createExecutable(dir);
    setEnv('TEST_WEBHOOK_SECRET', 'resolved-secret');
    const config = {
      port: 3000,
      webhookSecret: 'ENV:TEST_WEBHOOK_SECRET',
      kiroPath,
      repos: [{ owner: 'org', name: 'repo' }],
      cron: [],
    };
    const configPath = writeConfig(dir, JSON.stringify(config));
    const result = loadConfig(configPath);

    expect(result.webhookSecret).toBe('resolved-secret');
  });

  it('throws FatalError when ENV: references an unset variable', () => {
    const dir = makeTempDir();
    const kiroPath = createExecutable(dir);
    deleteEnv('UNSET_VAR_FOR_TEST');
    const config = {
      port: 3000,
      webhookSecret: 'ENV:UNSET_VAR_FOR_TEST',
      kiroPath,
      repos: [{ owner: 'org', name: 'repo' }],
      cron: [],
    };
    const configPath = writeConfig(dir, JSON.stringify(config));
    expect(() => loadConfig(configPath)).toThrow(FatalError);
    expect(() => loadConfig(configPath)).toThrow(/UNSET_VAR_FOR_TEST/);
  });

  it('throws FatalError when validation fails after parsing', () => {
    const dir = makeTempDir();
    const config = {
      port: -1,
      webhookSecret: 'secret',
      kiroPath: '/no/such/file',
      repos: [],
      cron: [],
    };
    const configPath = writeConfig(dir, JSON.stringify(config));
    expect(() => loadConfig(configPath)).toThrow(FatalError);
  });
});

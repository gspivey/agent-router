import fs from 'node:fs';
import cron from 'node-cron';
import { FatalError } from './errors.js';

export interface AgentRouterConfig {
  port: number;
  webhookSecret: string;
  kiroPath: string;
  rateLimit: {
    perPRSeconds: number;
  };
  repos: RepoConfig[];
  cron: CronConfig[];
}

export interface RepoConfig {
  owner: string;
  name: string;
  roadmapPath?: string;
}

export interface CronConfig {
  name: string;
  schedule: string;
  repo: string;
}

export function resolveEnvValues(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === 'string' && value.startsWith('ENV:')) {
      const varName = value.slice(4);
      const envValue = process.env[varName];
      if (envValue === undefined) {
        throw new FatalError(`Environment variable "${varName}" is not set (referenced by config key "${key}")`);
      }
      result[key] = envValue;
    } else if (Array.isArray(value)) {
      result[key] = value.map((item: unknown) =>
        isRecord(item) ? resolveEnvValues(item) : item
      );
    } else if (isRecord(value)) {
      result[key] = resolveEnvValues(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateConfig(config: unknown): AgentRouterConfig {
  if (!isRecord(config)) {
    throw new FatalError('Config must be a non-null object');
  }

  // port: integer in [1, 65535]
  const { port } = config;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FatalError(`Invalid "port": must be an integer between 1 and 65535, got ${JSON.stringify(port)}`);
  }

  // webhookSecret: non-empty string
  const { webhookSecret } = config;
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
    throw new FatalError('Invalid "webhookSecret": must be a non-empty string');
  }

  // kiroPath: must point to an executable file on disk
  const { kiroPath } = config;
  if (typeof kiroPath !== 'string' || kiroPath.length === 0) {
    throw new FatalError('Invalid "kiroPath": must be a non-empty string');
  }
  try {
    fs.accessSync(kiroPath, fs.constants.X_OK);
  } catch {
    throw new FatalError(`Invalid "kiroPath": "${kiroPath}" is not an executable file`);
  }

  // rateLimit (optional with defaults)
  const rawRateLimit = config['rateLimit'];
  let perPRSeconds = 60;
  if (rawRateLimit !== undefined) {
    if (!isRecord(rawRateLimit)) {
      throw new FatalError('Invalid "rateLimit": must be an object');
    }
    if (rawRateLimit['perPRSeconds'] !== undefined) {
      const val = rawRateLimit['perPRSeconds'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
        throw new FatalError('Invalid "rateLimit.perPRSeconds": must be a non-negative integer');
      }
      perPRSeconds = val;
    }
  }

  // repos: array of { owner: string, name: string }
  const rawRepos = config['repos'];
  if (!Array.isArray(rawRepos)) {
    throw new FatalError('Invalid "repos": must be an array');
  }
  const repos: RepoConfig[] = [];
  for (let i = 0; i < rawRepos.length; i++) {
    const repo = rawRepos[i] as unknown;
    if (!isRecord(repo)) {
      throw new FatalError(`Invalid "repos[${i}]": must be an object`);
    }
    const { owner, name } = repo;
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new FatalError(`Invalid "repos[${i}].owner": must be a non-empty string`);
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new FatalError(`Invalid "repos[${i}].name": must be a non-empty string`);
    }
    const entry: RepoConfig = { owner, name };
    if (repo['roadmapPath'] !== undefined) {
      if (typeof repo['roadmapPath'] !== 'string') {
        throw new FatalError(`Invalid "repos[${i}].roadmapPath": must be a string`);
      }
      entry.roadmapPath = repo['roadmapPath'];
    }
    repos.push(entry);
  }

  // Build set of known "owner/name" for cron repo matching
  const repoKeys = new Set(repos.map(r => `${r.owner}/${r.name}`));

  // cron: array of { name: string, schedule: string, repo: string }
  const rawCron = config['cron'];
  if (!Array.isArray(rawCron)) {
    throw new FatalError('Invalid "cron": must be an array');
  }
  const cronEntries: CronConfig[] = [];
  for (let i = 0; i < rawCron.length; i++) {
    const entry = rawCron[i] as unknown;
    if (!isRecord(entry)) {
      throw new FatalError(`Invalid "cron[${i}]": must be an object`);
    }
    const cronName = entry['name'];
    if (typeof cronName !== 'string' || cronName.length === 0) {
      throw new FatalError(`Invalid "cron[${i}].name": must be a non-empty string`);
    }
    const schedule = entry['schedule'];
    if (typeof schedule !== 'string' || schedule.length === 0) {
      throw new FatalError(`Invalid "cron[${i}].schedule": must be a non-empty string`);
    }
    if (!cron.validate(schedule)) {
      throw new FatalError(`Invalid "cron[${i}].schedule": "${schedule}" is not a valid cron expression`);
    }
    const repo = entry['repo'];
    if (typeof repo !== 'string' || repo.length === 0) {
      throw new FatalError(`Invalid "cron[${i}].repo": must be a non-empty string`);
    }
    if (!repoKeys.has(repo)) {
      throw new FatalError(`Invalid "cron[${i}].repo": "${repo}" does not match any entry in "repos"`);
    }
    cronEntries.push({ name: cronName, schedule, repo });
  }

  return {
    port,
    webhookSecret,
    kiroPath,
    rateLimit: { perPRSeconds },
    repos,
    cron: cronEntries,
  };
}

export function loadConfig(configPath: string): AgentRouterConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new FatalError(`Config file not found: ${configPath}`);
    }
    throw new FatalError(`Failed to read config file "${configPath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FatalError(`Invalid JSON in config file "${configPath}"`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FatalError(`Config file "${configPath}" must contain a JSON object`);
  }

  const resolved = resolveEnvValues(parsed as Record<string, unknown>);
  return validateConfig(resolved);
}

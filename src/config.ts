import fs from 'node:fs';
import cron from 'node-cron';
import { FatalError } from './errors.js';

export interface SessionTimeoutConfig {
  inactivityMinutes: number;
  maxLifetimeMinutes: number;
  gracePeriodAfterMergeSeconds: number;
}

export interface TrustedProxyConfig {
  identityHeader: string;
  proofHeader: string;
  proofSecret: string;
}

export interface AgentRouterConfig {
  port: number;
  webhookSecret: string;
  kiroPath: string;
  rateLimit: {
    perPRSeconds: number;
  };
  sessionTimeout: SessionTimeoutConfig;
  repos: RepoConfig[];
  cron: CronConfig[];
  /** Optional default GitHub token used when a repo has no `token` override. Typically "ENV:GITHUB_TOKEN". */
  defaultGithubToken?: string;
  /** Port for the web control plane (default 3100, must not equal `port`). */
  controlPort: number;
  /** Bind to 0.0.0.0 instead of 127.0.0.1 (default false). */
  bindPublic: boolean;
  /** Seconds to wait for active sessions to drain on shutdown (default 60). */
  shutdownDrainSeconds: number;
  /** Trusted reverse proxy authentication config. */
  trustedProxy?: TrustedProxyConfig;
  /** Email allowlist for write operations (case-insensitive). */
  allowedEmails?: string[];
}

export interface RepoConfig {
  owner: string;
  name: string;
  roadmapPath?: string;
  /** Optional per-repo GitHub token. Overrides `defaultGithubToken`. Typically "ENV:GH_TOKEN_<NAME>". */
  token?: string;
  /** Optional per-repo webhook secret for HMAC verification. Overrides the global `webhookSecret`. */
  webhookSecret?: string;
}

export interface CronConfig {
  name: string;
  schedule: string;
  repo: string;
  /** Path to a file whose contents are used verbatim as the session prompt on each cron fire. */
  promptFile: string;
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
      result[key] = envValue.trim();
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

  // sessionTimeout (optional with defaults)
  const rawSessionTimeout = config['sessionTimeout'];
  let inactivityMinutes = 5;
  let maxLifetimeMinutes = 120;
  let gracePeriodAfterMergeSeconds = 60;
  if (rawSessionTimeout !== undefined) {
    if (!isRecord(rawSessionTimeout)) {
      throw new FatalError('Invalid "sessionTimeout": must be an object');
    }
    if (rawSessionTimeout['inactivityMinutes'] !== undefined) {
      const val = rawSessionTimeout['inactivityMinutes'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "sessionTimeout.inactivityMinutes": must be a positive integer');
      }
      inactivityMinutes = val;
    }
    if (rawSessionTimeout['maxLifetimeMinutes'] !== undefined) {
      const val = rawSessionTimeout['maxLifetimeMinutes'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "sessionTimeout.maxLifetimeMinutes": must be a positive integer');
      }
      maxLifetimeMinutes = val;
    }
    if (inactivityMinutes > maxLifetimeMinutes) {
      throw new FatalError(
        `Invalid "sessionTimeout": inactivityMinutes (${inactivityMinutes}) must not exceed maxLifetimeMinutes (${maxLifetimeMinutes})`
      );
    }
    if (rawSessionTimeout['gracePeriodAfterMergeSeconds'] !== undefined) {
      const val = rawSessionTimeout['gracePeriodAfterMergeSeconds'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
        throw new FatalError('Invalid "sessionTimeout.gracePeriodAfterMergeSeconds": must be a non-negative integer');
      }
      gracePeriodAfterMergeSeconds = val;
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
    if (repo['token'] !== undefined) {
      if (typeof repo['token'] !== 'string' || repo['token'].length === 0) {
        throw new FatalError(`Invalid "repos[${i}].token": must be a non-empty string`);
      }
      entry.token = repo['token'];
    }
    if (repo['webhookSecret'] !== undefined) {
      if (typeof repo['webhookSecret'] !== 'string' || repo['webhookSecret'].length === 0) {
        throw new FatalError(`Invalid "repos[${i}].webhookSecret": must be a non-empty string`);
      }
      entry.webhookSecret = repo['webhookSecret'];
    }
    repos.push(entry);
  }

  // defaultGithubToken (optional)
  let defaultGithubToken: string | undefined;
  if (config['defaultGithubToken'] !== undefined) {
    if (typeof config['defaultGithubToken'] !== 'string' || config['defaultGithubToken'].length === 0) {
      throw new FatalError('Invalid "defaultGithubToken": must be a non-empty string');
    }
    defaultGithubToken = config['defaultGithubToken'];
  }

  // controlPort (optional, default 3100)
  let controlPort = 3100;
  if (config['controlPort'] !== undefined) {
    const val = config['controlPort'];
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 65535) {
      throw new FatalError(`Invalid "controlPort": must be an integer between 1 and 65535, got ${JSON.stringify(val)}`);
    }
    controlPort = val;
  }
  if (controlPort === port) {
    throw new FatalError(`Invalid "controlPort": must not equal "port" (both are ${port})`);
  }

  // bindPublic (optional, default false)
  let bindPublic = false;
  if (config['bindPublic'] !== undefined) {
    const val = config['bindPublic'];
    if (typeof val !== 'boolean') {
      throw new FatalError(`Invalid "bindPublic": must be a boolean, got ${JSON.stringify(val)}`);
    }
    bindPublic = val;
  }

  // shutdownDrainSeconds (optional, default 60)
  let shutdownDrainSeconds = 60;
  if (config['shutdownDrainSeconds'] !== undefined) {
    const val = config['shutdownDrainSeconds'];
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
      throw new FatalError(`Invalid "shutdownDrainSeconds": must be a positive integer, got ${JSON.stringify(val)}`);
    }
    shutdownDrainSeconds = val;
  }

  // trustedProxy (optional, but all three fields required if present)
  let trustedProxy: TrustedProxyConfig | undefined;
  if (config['trustedProxy'] !== undefined) {
    const raw = config['trustedProxy'];
    if (!isRecord(raw)) {
      throw new FatalError('Invalid "trustedProxy": must be an object');
    }
    const identityHeader = raw['identityHeader'];
    const proofHeader = raw['proofHeader'];
    const proofSecret = raw['proofSecret'];

    if (typeof identityHeader !== 'string' || identityHeader.length === 0) {
      throw new FatalError('Invalid "trustedProxy": missing or empty "identityHeader"');
    }
    if (typeof proofHeader !== 'string' || proofHeader.length === 0) {
      throw new FatalError('Invalid "trustedProxy": missing or empty "proofHeader"');
    }
    if (typeof proofSecret !== 'string' || proofSecret.length === 0) {
      throw new FatalError('Invalid "trustedProxy": missing or empty "proofSecret"');
    }

    // Validate proofSecret file exists and is readable
    try {
      fs.accessSync(proofSecret, fs.constants.R_OK);
    } catch {
      throw new FatalError(`Invalid "trustedProxy.proofSecret": file "${proofSecret}" does not exist or is not readable`);
    }

    // Warn if file permissions are more permissive than 0600
    try {
      const stats = fs.statSync(proofSecret);
      const mode = stats.mode & 0o777;
      if (mode > 0o600) {
        // Log warning but continue — we don't have a logger here, so use process.stderr
        process.stderr.write(`Warning: "trustedProxy.proofSecret" file "${proofSecret}" has permissions ${mode.toString(8)}, recommended 0600 or stricter\n`);
      }
    } catch {
      // If we can't stat, we already verified read access above, so continue
    }

    trustedProxy = { identityHeader, proofHeader, proofSecret };
  }

  // allowedEmails (optional)
  let allowedEmails: string[] | undefined;
  if (config['allowedEmails'] !== undefined) {
    const raw = config['allowedEmails'];
    if (!Array.isArray(raw)) {
      throw new FatalError('Invalid "allowedEmails": must be an array');
    }
    allowedEmails = [];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i] as unknown;
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new FatalError(`Invalid "allowedEmails[${i}]": must be a non-empty string`);
      }
      if (entry.length > 254) {
        throw new FatalError(`Invalid "allowedEmails[${i}]": must be at most 254 characters`);
      }
      allowedEmails.push(entry);
    }
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
    const promptFile = entry['promptFile'];
    if (typeof promptFile !== 'string' || promptFile.length === 0) {
      throw new FatalError(`Invalid "cron[${i}].promptFile": must be a non-empty string path`);
    }
    cronEntries.push({ name: cronName, schedule, repo, promptFile });
  }

  const result: AgentRouterConfig = {
    port,
    webhookSecret,
    kiroPath,
    rateLimit: { perPRSeconds },
    sessionTimeout: { inactivityMinutes, maxLifetimeMinutes, gracePeriodAfterMergeSeconds },
    repos,
    cron: cronEntries,
    controlPort,
    bindPublic,
    shutdownDrainSeconds,
  };
  if (defaultGithubToken !== undefined) {
    result.defaultGithubToken = defaultGithubToken;
  }
  if (trustedProxy !== undefined) {
    result.trustedProxy = trustedProxy;
  }
  if (allowedEmails !== undefined) {
    result.allowedEmails = allowedEmails;
  }
  return result;
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

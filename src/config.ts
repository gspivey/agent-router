import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import cron from 'node-cron';
import { FatalError } from './errors.js';
import type { NotifyOnSessionEndConfig } from './notify.js';
import type { ReaperConfig } from './reaper.js';
import type { ProjectConfig } from './projects.js';
import { validateProjects } from './projects.js';

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

/** One entry in the `github_forward` allowlist (agent process isolation). */
export interface GithubForwardAllowEntry {
  /** HTTP methods this entry permits (e.g. ["GET"], ["POST"]). */
  methods: string[];
  /** Path pattern this entry permits (e.g. "/repos/{o}/{r}/pulls"). */
  pathPattern: string;
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
  /** Optional webhook notification on session end. */
  notifyOnSessionEnd?: NotifyOnSessionEndConfig;
  /** Optional ISO 8601 date when the GitHub PAT expires. Enables expiry alerting. */
  tokenExpiresAt?: string;
  /** Optional extra env var names to forward to child processes (on top of the built-in allowlist). */
  childEnvAllowlist?: string[];
  /** Credential delivery mode: 'env' injects GITHUB_TOKEN into agent env, 'mcp' relies on MCP tools. Default: 'env'. */
  credentialMode: 'env' | 'mcp';
  /** Session reaper configuration for automatic disk reclamation. */
  reaper: ReaperConfig;
  /** Optional project groupings for multi-repo visibility. */
  projects?: ProjectConfig[];
  /**
   * Stuck-agent idle timeout in seconds for task attempts (default 900). An
   * attempt whose agent has produced no activity for this long is ended
   * `timed_out` (task-attempt-outcome Requirement 17.6).
   */
  idleTimeoutSeconds: number;
  /**
   * Bounds the attempt setup phase (worktree creation through agent spawn) in
   * seconds (default 120). A hung setup can never pin a repo slot forever
   * (task-attempt-outcome Requirement 4.1c).
   */
  setupTimeoutSeconds: number;
  /** Two-phase transcript retention for task attempts. */
  taskTranscript: TaskTranscriptConfig;
  /** ROADMAP intake-adapter scan cadence. */
  roadmap: RoadmapConfig;
  /**
   * Agent process isolation (opt-in, Linux-only). When true, agent
   * subprocesses are launched as the unprivileged `agentworker` user via sudo
   * and the daemon withholds `GITHUB_TOKEN` from the child env. Default false.
   */
  useWorkerUid?: boolean;
  /**
   * Base directory for per-session standalone clones used by the isolation
   * substrate. Default `/srv/agent-router/worktrees`.
   */
  worktreeBase?: string;
  /**
   * Unix socket path for the agent-only socket. Default
   * `/run/agent-router/agent.sock`. Falls back to `<rootDir>/agent.sock` when
   * the isolation substrate was never installed (NFR-4.3) — resolved by the
   * caller.
   */
  agentSocketPath?: string;
  /**
   * Optional override of the `github_forward` allowlist. When absent the
   * agent server uses its built-in default allowlist (FR-5.4).
   */
  githubForwardAllowList?: GithubForwardAllowEntry[];
}

/** Per-repo circuit-breaker configuration (task-attempt-outcome Requirement 12.4/12.7/12.11). */
export interface RepoCircuitBreakerConfig {
  /** Consecutive infra failures that open the breaker (default 3). */
  failureThreshold: number;
  /** Seconds before an open breaker may half-open for a probe (default 3600). */
  timeoutSeconds: number;
}

/** Two-phase transcript retention config (task-attempt-outcome Requirement 11). */
export interface TaskTranscriptConfig {
  /** active → archived grace in minutes (default 60). */
  archiveGraceMinutes: number;
  /** archived → deleted TTL in days (default 90). */
  retentionDays: number;
  /** sweep cadence in minutes (default 30). */
  sweepIntervalMinutes: number;
}

/** ROADMAP importer config (task-attempt-outcome Requirement 20.1). */
export interface RoadmapConfig {
  /** cron-tick scan cadence in minutes (default 15). */
  scanIntervalMinutes: number;
}

export interface RepoAdapterConfig {
  type: 'kiro' | 'claude-code';
  /** Model override for Claude Code (e.g. "claude-opus-5"). Ignored for kiro. */
  model?: string;
}

export interface RepoConfig {
  owner: string;
  name: string;
  roadmapPath?: string;
  /** Optional per-repo GitHub token. Overrides `defaultGithubToken`. Typically "ENV:GH_TOKEN_<NAME>". */
  token?: string;
  /** Optional per-repo webhook secret for HMAC verification. Overrides the global `webhookSecret`. */
  webhookSecret?: string;
  /** Optional adapter override. Defaults to kiro when absent. */
  adapter?: RepoAdapterConfig;
  /**
   * Concurrent running task attempts for this repo (default 1)
   * (task-attempt-outcome Requirement 12.1).
   */
  concurrency?: number;
  /** Optional per-repo circuit-breaker configuration (task-attempt-outcome Requirement 12.4). */
  circuitBreaker?: RepoCircuitBreakerConfig;
  /**
   * Enable continuous mode: on merge, immediately start the next ROADMAP item.
   * Default: false.
   */
  continuous?: boolean;
  /**
   * Branch the daemon reads the ROADMAP from when picking the next item in
   * continuous mode. Default: "development".
   */
  baseBranch?: string;
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
    if (repo['adapter'] !== undefined) {
      const rawAdapter = repo['adapter'];
      if (!isRecord(rawAdapter)) {
        throw new FatalError(`Invalid "repos[${i}].adapter": must be an object`);
      }
      const adapterType = rawAdapter['type'];
      if (adapterType !== 'kiro' && adapterType !== 'claude-code') {
        throw new FatalError(
          `Invalid "repos[${i}].adapter.type": must be "kiro" or "claude-code", got ${JSON.stringify(adapterType)}`
        );
      }
      if (rawAdapter['model'] !== undefined) {
        if (typeof rawAdapter['model'] !== 'string' || rawAdapter['model'].length === 0) {
          throw new FatalError(`Invalid "repos[${i}].adapter.model": must be a non-empty string`);
        }
      }
      entry.adapter = {
        type: adapterType,
        ...(rawAdapter['model'] !== undefined ? { model: rawAdapter['model'] as string } : {}),
      };
    }
    if (repo['concurrency'] !== undefined) {
      const val = repo['concurrency'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError(`Invalid "repos[${i}].concurrency": must be a positive integer`);
      }
      entry.concurrency = val;
    }
    if (repo['circuitBreaker'] !== undefined) {
      const rawBreaker = repo['circuitBreaker'];
      if (!isRecord(rawBreaker)) {
        throw new FatalError(`Invalid "repos[${i}].circuitBreaker": must be an object`);
      }
      const failureThreshold = rawBreaker['failureThreshold'];
      if (
        typeof failureThreshold !== 'number' ||
        !Number.isInteger(failureThreshold) ||
        failureThreshold < 1
      ) {
        throw new FatalError(
          `Invalid "repos[${i}].circuitBreaker.failureThreshold": must be a positive integer`
        );
      }
      let timeoutSeconds = 3600;
      if (rawBreaker['timeoutSeconds'] !== undefined) {
        const val = rawBreaker['timeoutSeconds'];
        if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
          throw new FatalError(
            `Invalid "repos[${i}].circuitBreaker.timeoutSeconds": must be a positive integer`
          );
        }
        timeoutSeconds = val;
      }
      entry.circuitBreaker = { failureThreshold, timeoutSeconds };
    }
    if (repo['continuous'] !== undefined) {
      if (typeof repo['continuous'] !== 'boolean') {
        throw new FatalError(
          `Invalid "repos[${i}].continuous": must be a boolean, got ${JSON.stringify(repo['continuous'])}`
        );
      }
      entry.continuous = repo['continuous'];
    }
    if (repo['baseBranch'] !== undefined) {
      if (typeof repo['baseBranch'] !== 'string' || repo['baseBranch'].length === 0) {
        throw new FatalError(`Invalid "repos[${i}].baseBranch": must be a non-empty string`);
      }
      entry.baseBranch = repo['baseBranch'];
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

  // notifyOnSessionEnd (optional)
  let notifyOnSessionEnd: NotifyOnSessionEndConfig | undefined;
  if (config['notifyOnSessionEnd'] !== undefined) {
    const raw = config['notifyOnSessionEnd'];
    if (!isRecord(raw)) {
      throw new FatalError('Invalid "notifyOnSessionEnd": must be an object');
    }
    const url = raw['url'];
    if (typeof url !== 'string' || url.length === 0) {
      throw new FatalError('Invalid "notifyOnSessionEnd.url": must be a non-empty string');
    }
    const events = raw['events'];
    if (!Array.isArray(events)) {
      throw new FatalError('Invalid "notifyOnSessionEnd.events": must be an array');
    }
    for (let i = 0; i < events.length; i++) {
      if (typeof events[i] !== 'string' || (events[i] as string).length === 0) {
        throw new FatalError(`Invalid "notifyOnSessionEnd.events[${i}]": must be a non-empty string`);
      }
    }
    notifyOnSessionEnd = { url, events: events as string[] };
  }

  // tokenExpiresAt (optional ISO 8601 date)
  let tokenExpiresAt: string | undefined;
  if (config['tokenExpiresAt'] !== undefined) {
    const val = config['tokenExpiresAt'];
    if (typeof val !== 'string' || val.length === 0) {
      throw new FatalError('Invalid "tokenExpiresAt": must be a non-empty string');
    }
    if (isNaN(new Date(val).getTime())) {
      throw new FatalError(`Invalid "tokenExpiresAt": "${val}" is not a valid ISO 8601 date`);
    }
    tokenExpiresAt = val;
  }

  // childEnvAllowlist (optional)
  let childEnvAllowlist: string[] | undefined;
  if (config['childEnvAllowlist'] !== undefined) {
    const raw = config['childEnvAllowlist'];
    if (!Array.isArray(raw)) {
      throw new FatalError('Invalid "childEnvAllowlist": must be an array');
    }
    childEnvAllowlist = [];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i] as unknown;
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new FatalError(`Invalid "childEnvAllowlist[${i}]": must be a non-empty string`);
      }
      childEnvAllowlist.push(entry);
    }
  }

  // credentialMode (optional, default 'env')
  let credentialMode: 'env' | 'mcp' = 'env';
  if (config['credentialMode'] !== undefined) {
    const val = config['credentialMode'];
    if (val !== 'env' && val !== 'mcp') {
      throw new FatalError(`Invalid "credentialMode": must be "env" or "mcp", got ${JSON.stringify(val)}`);
    }
    credentialMode = val;
  }

  // idleTimeoutSeconds (optional, default 900) — stuck-agent idle timeout (Req 17.6)
  let idleTimeoutSeconds = 900;
  if (config['idleTimeoutSeconds'] !== undefined) {
    const val = config['idleTimeoutSeconds'];
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
      throw new FatalError('Invalid "idleTimeoutSeconds": must be a positive integer');
    }
    idleTimeoutSeconds = val;
  }

  // setupTimeoutSeconds (optional, default 120) — bounds the attempt setup phase (Req 4.1c)
  let setupTimeoutSeconds = 120;
  if (config['setupTimeoutSeconds'] !== undefined) {
    const val = config['setupTimeoutSeconds'];
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
      throw new FatalError('Invalid "setupTimeoutSeconds": must be a positive integer');
    }
    setupTimeoutSeconds = val;
  }

  // taskTranscript (optional with defaults) — two-phase retention (Req 11)
  let archiveGraceMinutes = 60;
  let taskRetentionDays = 90;
  let transcriptSweepIntervalMinutes = 30;
  if (config['taskTranscript'] !== undefined) {
    const raw = config['taskTranscript'];
    if (!isRecord(raw)) {
      throw new FatalError('Invalid "taskTranscript": must be an object');
    }
    if (raw['archiveGraceMinutes'] !== undefined) {
      const val = raw['archiveGraceMinutes'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "taskTranscript.archiveGraceMinutes": must be a positive integer');
      }
      archiveGraceMinutes = val;
    }
    if (raw['retentionDays'] !== undefined) {
      const val = raw['retentionDays'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "taskTranscript.retentionDays": must be a positive integer');
      }
      taskRetentionDays = val;
    }
    if (raw['sweepIntervalMinutes'] !== undefined) {
      const val = raw['sweepIntervalMinutes'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "taskTranscript.sweepIntervalMinutes": must be a positive integer');
      }
      transcriptSweepIntervalMinutes = val;
    }
  }
  const taskTranscript: TaskTranscriptConfig = {
    archiveGraceMinutes,
    retentionDays: taskRetentionDays,
    sweepIntervalMinutes: transcriptSweepIntervalMinutes,
  };

  // roadmap (optional with defaults) — scan cadence (Req 20.1)
  let scanIntervalMinutes = 15;
  if (config['roadmap'] !== undefined) {
    const raw = config['roadmap'];
    if (!isRecord(raw)) {
      throw new FatalError('Invalid "roadmap": must be an object');
    }
    if (raw['scanIntervalMinutes'] !== undefined) {
      const val = raw['scanIntervalMinutes'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "roadmap.scanIntervalMinutes": must be a positive integer');
      }
      scanIntervalMinutes = val;
    }
  }
  const roadmap: RoadmapConfig = { scanIntervalMinutes };

  // useWorkerUid (optional, default false) — agent process isolation (FR-1, FR-2)
  let useWorkerUid: boolean | undefined;
  if (config['useWorkerUid'] !== undefined) {
    const val = config['useWorkerUid'];
    if (typeof val !== 'boolean') {
      throw new FatalError(`Invalid "useWorkerUid": must be a boolean, got ${JSON.stringify(val)}`);
    }
    useWorkerUid = val;
  }

  // worktreeBase (optional) — base dir for per-session clones (FR-3.4)
  let worktreeBase: string | undefined;
  if (config['worktreeBase'] !== undefined) {
    const val = config['worktreeBase'];
    if (typeof val !== 'string' || val.length === 0) {
      throw new FatalError('Invalid "worktreeBase": must be a non-empty string');
    }
    worktreeBase = val;
  }

  // agentSocketPath (optional) — agent-only socket path (FR-4.2)
  let agentSocketPath: string | undefined;
  if (config['agentSocketPath'] !== undefined) {
    const val = config['agentSocketPath'];
    if (typeof val !== 'string' || val.length === 0) {
      throw new FatalError('Invalid "agentSocketPath": must be a non-empty string');
    }
    agentSocketPath = val;
  }

  // githubForwardAllowList (optional) — override of the github_forward allowlist (FR-5.4)
  let githubForwardAllowList: GithubForwardAllowEntry[] | undefined;
  if (config['githubForwardAllowList'] !== undefined) {
    const raw = config['githubForwardAllowList'];
    if (!Array.isArray(raw)) {
      throw new FatalError('Invalid "githubForwardAllowList": must be an array');
    }
    githubForwardAllowList = [];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i] as unknown;
      if (!isRecord(entry)) {
        throw new FatalError(`Invalid "githubForwardAllowList[${i}]": must be an object`);
      }
      const methods = entry['methods'];
      if (!Array.isArray(methods) || methods.length === 0) {
        throw new FatalError(`Invalid "githubForwardAllowList[${i}].methods": must be a non-empty array`);
      }
      for (let j = 0; j < methods.length; j++) {
        if (typeof methods[j] !== 'string' || (methods[j] as string).length === 0) {
          throw new FatalError(`Invalid "githubForwardAllowList[${i}].methods[${j}]": must be a non-empty string`);
        }
      }
      const pathPattern = entry['pathPattern'];
      if (typeof pathPattern !== 'string' || pathPattern.length === 0) {
        throw new FatalError(`Invalid "githubForwardAllowList[${i}].pathPattern": must be a non-empty string`);
      }
      githubForwardAllowList.push({ methods: methods as string[], pathPattern });
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

  // reaper (optional with defaults)
  const rawReaper = config['reaper'];
  let reaperEnabled = true;
  let gracePeriodMinutes = 60;
  let retentionDays = 30;
  let agentRunsDir = path.join(os.homedir(), 'agent-runs');
  let sweepIntervalMinutes = 15;
  if (rawReaper !== undefined) {
    if (!isRecord(rawReaper)) {
      throw new FatalError('Invalid "reaper": must be an object');
    }
    if (rawReaper['enabled'] !== undefined) {
      if (typeof rawReaper['enabled'] !== 'boolean') {
        throw new FatalError(`Invalid "reaper.enabled": must be a boolean, got ${JSON.stringify(rawReaper['enabled'])}`);
      }
      reaperEnabled = rawReaper['enabled'];
    }
    if (rawReaper['gracePeriodMinutes'] !== undefined) {
      const val = rawReaper['gracePeriodMinutes'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "reaper.gracePeriodMinutes": must be a positive integer');
      }
      gracePeriodMinutes = val;
    }
    if (rawReaper['retentionDays'] !== undefined) {
      const val = rawReaper['retentionDays'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "reaper.retentionDays": must be a positive integer');
      }
      retentionDays = val;
    }
    if (rawReaper['agentRunsDir'] !== undefined) {
      const val = rawReaper['agentRunsDir'];
      if (typeof val !== 'string' || val.length === 0) {
        throw new FatalError('Invalid "reaper.agentRunsDir": must be a non-empty string');
      }
      agentRunsDir = val;
    }
    if (rawReaper['sweepIntervalMinutes'] !== undefined) {
      const val = rawReaper['sweepIntervalMinutes'];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
        throw new FatalError('Invalid "reaper.sweepIntervalMinutes": must be a positive integer');
      }
      sweepIntervalMinutes = val;
    }
  }
  // Expand leading ~ in agentRunsDir
  if (agentRunsDir.startsWith('~')) {
    agentRunsDir = path.join(os.homedir(), agentRunsDir.slice(1));
  }

  const reaperConfig: ReaperConfig = {
    enabled: reaperEnabled,
    gracePeriodMinutes,
    retentionDays,
    agentRunsDir,
    sweepIntervalMinutes,
  };

  // projects (optional)
  let projects: ProjectConfig[] | undefined;
  if (config['projects'] !== undefined) {
    const rawProjects = config['projects'];
    if (!Array.isArray(rawProjects)) {
      throw new FatalError('Invalid "projects": must be an array');
    }
    projects = [];
    for (let i = 0; i < rawProjects.length; i++) {
      const proj = rawProjects[i] as unknown;
      if (!isRecord(proj)) {
        throw new FatalError(`Invalid "projects[${i}]": must be an object`);
      }
      const projName = proj['name'];
      if (typeof projName !== 'string' || projName.length === 0) {
        throw new FatalError(`Invalid "projects[${i}].name": must be a non-empty string`);
      }
      const projRepos = proj['repos'];
      if (!Array.isArray(projRepos) || projRepos.length === 0) {
        throw new FatalError(`Invalid "projects[${i}].repos": must be a non-empty array`);
      }
      const repoStrings: string[] = [];
      for (let j = 0; j < projRepos.length; j++) {
        const r = projRepos[j] as unknown;
        if (typeof r !== 'string' || r.length === 0) {
          throw new FatalError(`Invalid "projects[${i}].repos[${j}]": must be a non-empty string`);
        }
        repoStrings.push(r);
      }
      projects.push({ name: projName, repos: repoStrings });
    }

    // Validate cross-project constraints using the pure validation function
    const knownRepoNames = repos.map(r => `${r.owner}/${r.name}`);
    const validation = validateProjects(projects, knownRepoNames);
    if (!validation.valid) {
      throw new FatalError(`Invalid "projects": ${validation.errors.join('; ')}`);
    }
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
    credentialMode,
    reaper: reaperConfig,
    idleTimeoutSeconds,
    setupTimeoutSeconds,
    taskTranscript,
    roadmap,
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
  if (notifyOnSessionEnd !== undefined) {
    result.notifyOnSessionEnd = notifyOnSessionEnd;
  }
  if (tokenExpiresAt !== undefined) {
    result.tokenExpiresAt = tokenExpiresAt;
  }
  if (childEnvAllowlist !== undefined) {
    result.childEnvAllowlist = childEnvAllowlist;
  }
  if (projects !== undefined) {
    result.projects = projects;
  }
  if (useWorkerUid !== undefined) {
    result.useWorkerUid = useWorkerUid;
  }
  if (worktreeBase !== undefined) {
    result.worktreeBase = worktreeBase;
  }
  if (agentSocketPath !== undefined) {
    result.agentSocketPath = agentSocketPath;
  }
  if (githubForwardAllowList !== undefined) {
    result.githubForwardAllowList = githubForwardAllowList;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Config change classification (pure)
// ---------------------------------------------------------------------------

export interface ConfigChangeResult {
  reloadable: string[];
  restartRequired: string[];
}

const RESTART_REQUIRED_FIELDS = new Set([
  'port',
  'controlPort',
  'bindPublic',
  'kiroPath',
  'trustedProxy',
]);

export function classifyConfigChange(
  old: AgentRouterConfig,
  next: AgentRouterConfig,
): ConfigChangeResult {
  const reloadable: string[] = [];
  const restartRequired: string[] = [];

  const allKeys = new Set([
    ...Object.keys(old) as (keyof AgentRouterConfig)[],
    ...Object.keys(next) as (keyof AgentRouterConfig)[],
  ]);

  for (const key of allKeys) {
    if (JSON.stringify(old[key]) !== JSON.stringify(next[key])) {
      if (RESTART_REQUIRED_FIELDS.has(key)) {
        restartRequired.push(key);
      } else {
        reloadable.push(key);
      }
    }
  }

  return { reloadable, restartRequired };
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

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

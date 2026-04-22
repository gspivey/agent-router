import { FatalError } from './errors';

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
  throw new FatalError('Not implemented');
}

export function loadConfig(path: string): AgentRouterConfig {
  throw new FatalError('Not implemented');
}

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
  throw new FatalError('Not implemented');
}

export function validateConfig(config: unknown): AgentRouterConfig {
  throw new FatalError('Not implemented');
}

export function loadConfig(path: string): AgentRouterConfig {
  throw new FatalError('Not implemented');
}

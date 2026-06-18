import type { AgentRouterConfig } from './config.js';

export interface RestartRequiredCondition {
  fields: string[];
  since: number;
}

export interface RestartRequiredState {
  get(): RestartRequiredCondition | null;
  update(startupConfig: AgentRouterConfig, currentConfig: AgentRouterConfig, nowMs?: number): void;
}

const RESTART_REQUIRED_FIELDS: (keyof AgentRouterConfig)[] = [
  'port',
  'controlPort',
  'bindPublic',
  'kiroPath',
  'trustedProxy',
];

/**
 * Compute which restart-required fields in `currentConfig` differ from `startupConfig`.
 * Pure function — no side effects.
 */
export function computeRestartRequiredFields(
  startupConfig: AgentRouterConfig,
  currentConfig: AgentRouterConfig,
): string[] {
  const changed: string[] = [];
  for (const key of RESTART_REQUIRED_FIELDS) {
    if (JSON.stringify(startupConfig[key]) !== JSON.stringify(currentConfig[key])) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Create a mutable RestartRequiredState holder.
 * Records which restart-required fields differ from the startup value.
 * The condition clears only on daemon restart (when startup value matches).
 */
export function createRestartRequiredState(): RestartRequiredState {
  let condition: RestartRequiredCondition | null = null;

  return {
    get(): RestartRequiredCondition | null {
      return condition;
    },
    update(startupConfig: AgentRouterConfig, currentConfig: AgentRouterConfig, nowMs?: number): void {
      const fields = computeRestartRequiredFields(startupConfig, currentConfig);
      if (fields.length > 0) {
        condition = {
          fields,
          since: condition?.since ?? (nowMs ?? Date.now()),
        };
      } else {
        condition = null;
      }
    },
  };
}

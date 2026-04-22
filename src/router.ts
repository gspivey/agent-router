import type { Database } from './db';
import type { AgentRouterConfig } from './config';
import type { QueuedEvent } from './queue';

export interface WakeDecision {
  wake: boolean;
  reason: string;
  sessionId?: string;
  prNumber?: number;
}

export function filterEventType(eventType: string, payload: unknown): boolean {
  throw new Error('Not implemented');
}

export function resolvePRNumber(eventType: string, payload: unknown): number | null {
  throw new Error('Not implemented');
}

export function isCommandTrigger(commentBody: string): boolean {
  throw new Error('Not implemented');
}

export function evaluateWakePolicy(
  event: QueuedEvent,
  db: Database,
  config: AgentRouterConfig
): WakeDecision {
  throw new Error('Not implemented');
}

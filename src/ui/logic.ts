/**
 * Pure logic for the web UI — importable by both browser and Node.
 * No DOM or fetch dependencies.
 */

export type SessionStatus = 'active' | 'completed' | 'abandoned' | 'failed';

export type BadgeColor = 'green' | 'gray' | 'yellow' | 'red';

export interface SSEEvent {
  id: number;
  data: string;
}

export interface HashRouteList {
  view: 'list';
}

export interface HashRouteDetail {
  view: 'detail';
  sessionId: string;
}

export type HashRoute = HashRouteList | HashRouteDetail;

/**
 * Merge SSE events into an existing list, deduplicating by id.
 * Returns a new array with unique events sorted by id ascending.
 */
export function mergeEvents(existing: readonly SSEEvent[], incoming: readonly SSEEvent[]): SSEEvent[] {
  const seen = new Map<number, SSEEvent>();
  for (const e of existing) {
    seen.set(e.id, e);
  }
  for (const e of incoming) {
    seen.set(e.id, e);
  }
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

/**
 * Track the highest event ID seen. Returns the max of the current
 * highest and the new ID.
 */
export function trackLastEventId(current: number, newId: number): number {
  return newId > current ? newId : current;
}

/**
 * Compute the reconnection delay using exponential backoff.
 * Initial: 1000ms, doubles each attempt, capped at 30000ms.
 */
export function computeBackoff(attempt: number): number {
  const delay = 1000 * Math.pow(2, attempt);
  return Math.min(delay, 30000);
}

/**
 * Map a session status to its badge color.
 */
export function statusToBadge(status: SessionStatus): BadgeColor {
  switch (status) {
    case 'active': return 'green';
    case 'completed': return 'gray';
    case 'abandoned': return 'yellow';
    case 'failed': return 'red';
  }
}

/**
 * Derive a "waiting for" summary from the last stream entry type.
 */
export function deriveWaitingFor(lastEntryType: string | undefined): string | undefined {
  if (lastEntryType === undefined) return undefined;
  switch (lastEntryType) {
    case 'tool_call': return 'waiting: tool';
    case 'tool_result': return 'waiting: turn complete';
    case 'prompt_injected': return 'waiting: turn complete';
    case 'prompt_injection_failed': return 'waiting: retry';
    case 'web_interrupt': return 'waiting: next prompt';
    case 'session_ended': return undefined;
    case 'agent_message': return 'waiting: tool';
    default: return `waiting: ${lastEntryType}`;
  }
}

/**
 * Parse a hash-based route string.
 * `#/` or empty → list view
 * `#/sessions/<id>` → detail view
 * Anything else → list view
 */
export function parseHashRoute(hash: string): HashRoute {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  const match = /^\/sessions\/([^/]+)$/.exec(trimmed);
  if (match?.[1]) {
    return { view: 'detail', sessionId: match[1] };
  }
  return { view: 'list' };
}

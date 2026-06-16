import type { Logger } from './log.js';
import type { SessionMeta } from './session-files.js';

export interface NotifyOnSessionEndConfig {
  url: string;
  events: string[];
}

export interface SessionEndPayload {
  session_id: string;
  status: SessionMeta['status'];
  termination_reason: string;
  prs: SessionMeta['prs'];
  started_at: number;
  ended_at: number | null;
  summary: string;
}

/**
 * Determines if a notification should be sent for a given termination reason.
 */
export function shouldNotify(
  config: NotifyOnSessionEndConfig | undefined,
  terminationReason: string | undefined,
): boolean {
  if (config === undefined || terminationReason === undefined) return false;
  return config.events.includes(terminationReason);
}

/**
 * Builds the session-end payload from session metadata.
 */
export function buildPayload(meta: SessionMeta): SessionEndPayload {
  return {
    session_id: meta.session_id,
    status: meta.status,
    termination_reason: meta.termination_reason ?? 'unknown',
    prs: meta.prs,
    started_at: meta.created_at,
    ended_at: meta.completed_at,
    summary: meta.original_prompt,
  };
}

/**
 * Sends a session-end notification. Best-effort: logs warning on failure,
 * never throws, never retries, never blocks cleanup.
 */
export async function sendSessionEndNotification(deps: {
  config: NotifyOnSessionEndConfig;
  meta: SessionMeta;
  log: Logger;
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const { config, meta, log } = deps;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const payload = buildPayload(meta);

  try {
    const response = await fetchFn(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.warn('Session-end notification failed', {
        session_id: meta.session_id,
        url: config.url,
        status: response.status,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Session-end notification error', {
      session_id: meta.session_id,
      url: config.url,
      error: msg,
    });
  }
}

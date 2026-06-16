import type { Logger } from './log.js';
import type { NotifyOnSessionEndConfig } from './notify.js';

export type ExpirySeverity = 'ok' | 'warn' | 'error';

/**
 * Pure function: maps days until token expiry to a log severity level.
 * - <= 0 days (expired): 'error'
 * - <= 2 days: 'error'
 * - <= 7 days: 'warn'
 * - <= 14 days: 'warn'
 * - > 14 days: 'ok'
 */
export function daysToSeverity(daysRemaining: number): ExpirySeverity {
  if (daysRemaining <= 2) return 'error';
  if (daysRemaining <= 14) return 'warn';
  return 'ok';
}

/**
 * Computes whole days remaining from now to expiresAt.
 * Returns negative values if already expired.
 */
export function computeDaysRemaining(now: Date, expiresAt: Date): number {
  const msPerDay = 86_400_000;
  return Math.floor((expiresAt.getTime() - now.getTime()) / msPerDay);
}

export interface TokenExpiryCheckerDeps {
  tokenExpiresAt: string;
  log: Logger;
  notifyConfig?: NotifyOnSessionEndConfig;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/**
 * Checks token expiry and logs/notifies at the appropriate severity.
 * Called on startup and every 24 hours.
 */
export function checkTokenExpiry(deps: TokenExpiryCheckerDeps): void {
  const { tokenExpiresAt, log, notifyConfig } = deps;
  const nowFn = deps.now ?? (() => new Date());

  const expiresAt = new Date(tokenExpiresAt);
  if (isNaN(expiresAt.getTime())) {
    log.error('Invalid token_expires_at value', { token_expires_at: tokenExpiresAt });
    return;
  }

  const days = computeDaysRemaining(nowFn(), expiresAt);
  const severity = daysToSeverity(days);

  if (severity === 'ok') return;

  const fields = { days_remaining: days, expires_at: tokenExpiresAt };
  if (severity === 'warn') {
    log.warn('GitHub token approaching expiry', fields);
  } else {
    log.error('GitHub token expired or expiring imminently', fields);
  }

  // Surface via notification webhook if configured
  if (notifyConfig !== undefined) {
    const fetchFn = deps.fetch ?? globalThis.fetch;
    const payload = {
      type: 'token_expiry',
      severity,
      days_remaining: days,
      expires_at: tokenExpiresAt,
    };
    void fetchFn(notifyConfig.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      // Best-effort: never block on notification failure
    });
  }
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Starts the token expiry checker: runs immediately on startup and every 24h.
 * Returns a stop function to clear the interval.
 */
export function startTokenExpiryChecker(deps: TokenExpiryCheckerDeps): { stop: () => void } {
  checkTokenExpiry(deps);
  const interval = setInterval(() => checkTokenExpiry(deps), TWENTY_FOUR_HOURS_MS);
  return { stop: () => clearInterval(interval) };
}

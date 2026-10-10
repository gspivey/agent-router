/**
 * Global SPA state (Svelte 5 runes) plus the authentication lifecycle.
 *
 * Owns:
 *  - `auth`         — the resolved bearer token and the auth-error state.
 *  - `sessionList`  — the session-list view model.
 *  - `createChatState(id)` — per chat-view reactive state.
 *  - `resolveToken()` — the Requirement 3.1 precedence resolution.
 *  - `enterExpiredState()` — the Requirement 3.4 401/403 lockout.
 *
 * The lockout must be able to abort every live SSE stream. SSE handles register
 * an abort callback via `registerAbortHandler` and deregister it on close;
 * `enterExpiredState` invokes all of them.
 */

import type { SessionStatus, SessionSummary } from './types.js';

/** localStorage key holding the persisted bearer token. */
export const TOKEN_STORAGE_KEY = 'ar_token';

/** Server-injected token sentinel on `window`. */
declare global {
  interface Window {
    __DAEMON_TOKEN?: unknown;
  }
}

export type AuthError = 'none' | 'missing' | 'expired';

/** Resolved bearer token + current auth-error state. */
export const auth = $state<{ token: string | null; error: AuthError }>({
  token: null,
  error: 'none',
});

/** Session-list view model (one `GET /sessions` populates it). */
export const sessionList = $state<{
  loading: boolean;
  items: SessionSummary[];
  total: number;
  error: string | null;
}>({ loading: false, items: [], total: 0, error: null });

// ---------------------------------------------------------------------------
// SSE abort registry — lets the lockout abort every live stream (Req 3.4, 4.6)
// ---------------------------------------------------------------------------

const abortHandlers = new Set<() => void>();

/**
 * Register an SSE stream's abort callback so the 401/403 lockout can tear it
 * down. Returns a deregister function to call when the stream closes normally.
 */
export function registerAbortHandler(abort: () => void): () => void {
  abortHandlers.add(abort);
  return () => {
    abortHandlers.delete(abort);
  };
}

/** Abort every registered SSE stream and clear the registry. */
function abortAllStreams(): void {
  for (const abort of [...abortHandlers]) {
    try {
      abort();
    } catch {
      // Best-effort: one failing abort must not block the others.
    }
    abortHandlers.delete(abort);
  }
}

// ---------------------------------------------------------------------------
// Storage helpers (guarded so a disabled localStorage never throws)
// ---------------------------------------------------------------------------

function readStored(): string | null {
  try {
    const v = localStorage.getItem(TOKEN_STORAGE_KEY);
    return v !== null && v !== '' ? v : null;
  } catch {
    return null;
  }
}

function writeStored(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Private-mode / disabled storage — the in-memory token still works.
  }
}

function clearStored(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

/** Read `window.__DAEMON_TOKEN` as a non-empty string, else null. */
function readInjected(): string | null {
  const v = typeof window !== 'undefined' ? window.__DAEMON_TOKEN : undefined;
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Read the `?token=` query parameter as a non-empty string, else null. */
function readUrlToken(): string | null {
  try {
    const v = new URLSearchParams(location.search).get('token');
    return v !== null && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/** Strip the `token` query parameter from the address bar without reloading. */
function stripUrlToken(): void {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('token');
    // Preserve the hash route; drop a now-empty `?`.
    const search = url.searchParams.toString();
    const next = url.pathname + (search ? `?${search}` : '') + location.hash;
    history.replaceState({}, '', next);
  } catch {
    // Ignore — leaving the param in the bar is a cosmetic issue, not fatal.
  }
}

// ---------------------------------------------------------------------------
// Token resolution — Requirement 3.1, 3.2, 3.5, 3.7
// ---------------------------------------------------------------------------

/**
 * Resolve the bearer token in the exact precedence order of Requirement 3.1 and
 * write it into the `auth` store:
 *
 *   1. URL `?token=` — persist to localStorage AND `window.__DAEMON_TOKEN`,
 *      then strip the param from the address bar.
 *   2. `window.__DAEMON_TOKEN` — persist to localStorage (overwriting stale).
 *   3. `localStorage['ar_token']` — used only when 1 and 2 produced nothing.
 *
 * A fresh token from step 1 or 2 always overwrites a stale stored one (3.2).
 * When no token is available, `auth.error` becomes `'missing'` (3.5).
 *
 * Returns the resolved token, or null when none is available.
 */
export function resolveToken(): string | null {
  const urlToken = readUrlToken();
  if (urlToken !== null) {
    writeStored(urlToken);
    if (typeof window !== 'undefined') window.__DAEMON_TOKEN = urlToken;
    stripUrlToken();
    auth.token = urlToken;
    auth.error = 'none';
    return urlToken;
  }

  const injected = readInjected();
  if (injected !== null) {
    writeStored(injected);
    auth.token = injected;
    auth.error = 'none';
    return injected;
  }

  const stored = readStored();
  if (stored !== null) {
    auth.token = stored;
    auth.error = 'none';
    return stored;
  }

  auth.token = null;
  auth.error = 'missing';
  return null;
}

// ---------------------------------------------------------------------------
// 401/403 lockout — Requirement 3.4
// ---------------------------------------------------------------------------

/**
 * Enter the "Session expired — reload the page" lockout state (Requirement
 * 3.4): clear the stored token, abort every active SSE stream, and set
 * `auth.error = 'expired'`. Idempotent and performs NO automatic retry.
 */
export function enterExpiredState(): void {
  clearStored();
  auth.token = null;
  auth.error = 'expired';
  abortAllStreams();
}

// ---------------------------------------------------------------------------
// Per chat-view state — Requirement 4 / 6 / 7 (consumed by later items)
// ---------------------------------------------------------------------------

/** Connection phase for the chat view's SSE stream. */
export type ChatConnection = 'loading' | 'live' | 'reconnecting' | 'ended';

/** A raw stream entry paired with its SSE id, kept ordered for dedup. */
export interface ChatEntry {
  id: number;
  data: unknown;
}

/**
 * Per chat-view reactive state. Entries are merged by SSE id so a reconnect
 * replay never double-renders a line (dedup is done by the caller via
 * `mergeEvents` from `@shared/logic`).
 */
export function createChatState(sessionId: string) {
  const state = $state<{
    sessionId: string;
    entries: ChatEntry[];
    firstEventId: number | null;
    lastEventId: number | null;
    status: SessionStatus;
    connection: ChatConnection;
  }>({
    sessionId,
    entries: [],
    firstEventId: null,
    lastEventId: null,
    status: 'active',
    connection: 'loading',
  });

  return state;
}

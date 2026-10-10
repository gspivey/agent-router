import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  auth,
  sessionList,
  TOKEN_STORAGE_KEY,
  resolveToken,
  enterExpiredState,
  registerAbortHandler,
} from './stores.svelte.js';

/**
 * Reset the shared singletons and the DOM environment between tests. The stores
 * are module-level `$state`, so each test must restore a clean baseline.
 */
function resetEnv(): void {
  localStorage.clear();
  delete (window as { __DAEMON_TOKEN?: unknown }).__DAEMON_TOKEN;
  // Reset the address bar to a plain /app with no query / hash.
  history.replaceState({}, '', '/app');
  auth.token = null;
  auth.error = 'none';
  sessionList.loading = false;
  sessionList.items = [];
  sessionList.total = 0;
  sessionList.error = null;
}

describe('resolveToken — precedence (Req 3.1, 3.2)', () => {
  beforeEach(resetEnv);

  it('uses the URL ?token, persists it, strips it from the address bar', () => {
    history.replaceState({}, '', '/app?token=url-tok#/sessions/abc');

    const resolved = resolveToken();

    expect(resolved).toBe('url-tok');
    expect(auth.token).toBe('url-tok');
    expect(auth.error).toBe('none');
    // Persisted to localStorage AND window.__DAEMON_TOKEN.
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('url-tok');
    expect((window as { __DAEMON_TOKEN?: unknown }).__DAEMON_TOKEN).toBe('url-tok');
    // ?token removed from the address bar, hash route preserved.
    expect(location.search).toBe('');
    expect(location.hash).toBe('#/sessions/abc');
  });

  it('a fresh URL ?token overwrites a stale stored token (Req 3.2)', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'stale');
    history.replaceState({}, '', '/app?token=fresh');

    const resolved = resolveToken();

    expect(resolved).toBe('fresh');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('fresh');
  });

  it('falls back to window.__DAEMON_TOKEN when no URL token, persisting it (Req 3.1.2)', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'stale');
    (window as { __DAEMON_TOKEN?: unknown }).__DAEMON_TOKEN = 'injected';

    const resolved = resolveToken();

    expect(resolved).toBe('injected');
    expect(auth.token).toBe('injected');
    // A fresh injected token overwrites a stale stored one (Req 3.2).
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('injected');
  });

  it('ignores an empty-string window.__DAEMON_TOKEN and falls through to storage', () => {
    (window as { __DAEMON_TOKEN?: unknown }).__DAEMON_TOKEN = '';
    localStorage.setItem(TOKEN_STORAGE_KEY, 'stored');

    const resolved = resolveToken();

    expect(resolved).toBe('stored');
    expect(auth.token).toBe('stored');
  });

  it('uses the stored token when neither URL nor injected is present (Req 3.1.3, 3.7)', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'stored-tok');

    const resolved = resolveToken();

    expect(resolved).toBe('stored-tok');
    expect(auth.token).toBe('stored-tok');
    expect(auth.error).toBe('none');
  });

  it('enters the "missing" error state when no token is available (Req 3.5)', () => {
    const resolved = resolveToken();

    expect(resolved).toBeNull();
    expect(auth.token).toBeNull();
    expect(auth.error).toBe('missing');
  });

  it('precedence order is URL > injected > stored', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    (window as { __DAEMON_TOKEN?: unknown }).__DAEMON_TOKEN = 'injected';
    history.replaceState({}, '', '/app?token=url');

    expect(resolveToken()).toBe('url');
  });
});

describe('enterExpiredState — 401/403 lockout (Req 3.4)', () => {
  beforeEach(resetEnv);

  it('clears the stored token, sets error=expired, and does not retry', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'tok');
    auth.token = 'tok';
    auth.error = 'none';

    enterExpiredState();

    expect(auth.error).toBe('expired');
    expect(auth.token).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('aborts every registered SSE stream', () => {
    const abortA = vi.fn();
    const abortB = vi.fn();
    registerAbortHandler(abortA);
    registerAbortHandler(abortB);

    enterExpiredState();

    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it('is idempotent and clears the abort registry (no double-abort)', () => {
    const abort = vi.fn();
    registerAbortHandler(abort);

    enterExpiredState();
    enterExpiredState();

    // Registry was cleared after the first call, so still exactly one abort.
    expect(abort).toHaveBeenCalledTimes(1);
    expect(auth.error).toBe('expired');
  });

  it('deregistering an abort handler removes it from the lockout set', () => {
    const abort = vi.fn();
    const deregister = registerAbortHandler(abort);
    deregister();

    enterExpiredState();

    expect(abort).not.toHaveBeenCalled();
  });
});

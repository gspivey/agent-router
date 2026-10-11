/**
 * Hash-based router for the SPA (spa-overhaul Task 4 / ROADMAP 74).
 *
 * There is NO external routing library (HIGH-4): routing is hand-rolled on top
 * of the native `hashchange` event plus `parseHashRoute()` from the shared logic
 * module. Three routes exist:
 *
 *   - `#/` or empty       → the session list view
 *   - `#/sessions/<id>`   → the chat (detail) view
 *   - `#/config`          → the operator config view (spa-operator-restoration)
 *
 * The route is exposed as a Svelte 5 rune so `App.svelte` re-renders the matching
 * view whenever the hash changes. `startRouter()` wires the `hashchange`
 * listener and returns a disposer for symmetry (the SPA lives for the page
 * lifetime, so the disposer is mainly for tests).
 */

import { parseHashRoute, type HashRoute } from '../lib/logic.js';

/** The current parsed route, updated on every `hashchange`. */
export const route = $state<{ current: HashRoute }>({
  current: parseHashRoute(typeof location !== 'undefined' ? location.hash : ''),
});

/** Re-read `location.hash` and update the reactive route. */
export function syncRoute(): void {
  route.current = parseHashRoute(typeof location !== 'undefined' ? location.hash : '');
}

/**
 * Subscribe to `hashchange` and keep `route.current` in sync. Returns a disposer
 * that removes the listener. Safe to call once at startup.
 */
export function startRouter(): () => void {
  syncRoute();
  const handler = (): void => syncRoute();
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}

/** Navigate to the session list (`#/`). */
export function goToList(): void {
  location.hash = '#/';
}

/** Navigate to a session's chat/detail view (`#/sessions/<id>`). */
export function goToSession(sessionId: string): void {
  location.hash = `#/sessions/${sessionId}`;
}

/** Navigate to the config view (`#/config`). */
export function goToConfig(): void {
  location.hash = '#/config';
}

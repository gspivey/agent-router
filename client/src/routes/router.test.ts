import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { route, syncRoute, startRouter, goToList, goToSession } from './router.svelte.js';

/**
 * Router unit tests (spa-overhaul Task 4 / ROADMAP 74).
 *
 * The router is a thin reactive wrapper over `parseHashRoute` from the shared
 * logic module. These tests assert the two-route contract (list + detail only,
 * no Repos/Config routes) and that the reactive `route.current` tracks
 * `location.hash`.
 */
describe('router — hash routing (Req 5.6, 5.8)', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app');
    location.hash = '';
    syncRoute();
  });

  it('maps empty hash to the list view', () => {
    location.hash = '';
    syncRoute();
    expect(route.current.view).toBe('list');
  });

  it('maps #/ to the list view', () => {
    location.hash = '#/';
    syncRoute();
    expect(route.current.view).toBe('list');
  });

  it('maps #/sessions/<id> to the detail view with the session id', () => {
    location.hash = '#/sessions/abc-123';
    syncRoute();
    expect(route.current.view).toBe('detail');
    if (route.current.view === 'detail') {
      expect(route.current.sessionId).toBe('abc-123');
    }
  });

  it('treats an unknown hash (e.g. #/repos) as the list view — no Repos route (Req 5.8)', () => {
    location.hash = '#/repos';
    syncRoute();
    expect(route.current.view).toBe('list');
  });

  it('maps #/config to the config view', () => {
    location.hash = '#/config';
    syncRoute();
    expect(route.current.view).toBe('config');
  });

  it('treats #/config/ (trailing slash) as the list view', () => {
    location.hash = '#/config/';
    syncRoute();
    expect(route.current.view).toBe('list');
  });

  it('goToSession navigates to the detail hash', () => {
    goToSession('sess-9');
    expect(location.hash).toBe('#/sessions/sess-9');
  });

  it('goToList navigates to the list hash', () => {
    location.hash = '#/sessions/sess-9';
    goToList();
    expect(location.hash).toBe('#/');
  });
});

describe('router — hashchange subscription', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    history.replaceState({}, '', '/app');
    location.hash = '';
  });

  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('startRouter syncs the current route and updates on hashchange', async () => {
    location.hash = '#/sessions/initial';
    stop = startRouter();
    // startRouter() syncs immediately.
    expect(route.current.view).toBe('detail');

    // A hashchange event updates the reactive route.
    location.hash = '#/';
    // jsdom dispatches hashchange synchronously after the hash assignment task;
    // force it deterministically.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(route.current.view).toBe('list');
  });

  it('the disposer removes the hashchange listener', () => {
    stop = startRouter();
    stop();
    stop = null;

    location.hash = '#/sessions/after-dispose';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // Route was NOT updated by the (removed) listener.
    expect(route.current.view).toBe('list');
  });
});

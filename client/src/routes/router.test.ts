import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  route,
  syncRoute,
  startRouter,
  goToList,
  goToOverview,
  goToSession,
} from './router.svelte.js';

/**
 * Router unit tests (spa-overhaul Task 4 / ROADMAP 74; overview route added in
 * spa-polish ROADMAP 88, Req 9).
 *
 * The router is a thin reactive wrapper over `parseHashRoute` from the shared
 * logic module. These tests assert the four-route contract (overview, list,
 * detail, config), that `route.current` tracks `location.hash`, and that
 * `syncRoute()` sets `document.title` per view (Req 9.5).
 */
describe('router — hash routing (spa-polish Req 9)', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app');
    location.hash = '';
    syncRoute();
  });

  it('maps empty hash to the overview view', () => {
    location.hash = '';
    syncRoute();
    expect(route.current.view).toBe('overview');
  });

  it('maps #/ to the overview view', () => {
    location.hash = '#/';
    syncRoute();
    expect(route.current.view).toBe('overview');
  });

  it('maps bare #/sessions to the list view', () => {
    location.hash = '#/sessions';
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

  it('treats an unknown hash (e.g. #/repos) as the overview view (Req 9.1 fallback)', () => {
    location.hash = '#/repos';
    syncRoute();
    expect(route.current.view).toBe('overview');
  });

  it('maps #/config to the config view', () => {
    location.hash = '#/config';
    syncRoute();
    expect(route.current.view).toBe('config');
  });

  it('treats #/config/ (trailing slash) as the overview view', () => {
    location.hash = '#/config/';
    syncRoute();
    expect(route.current.view).toBe('overview');
  });

  it('sets document.title per view (Req 9.5)', () => {
    location.hash = '#/';
    syncRoute();
    expect(document.title).toBe('Agent Router');
    location.hash = '#/sessions';
    syncRoute();
    expect(document.title).toBe('Sessions · Agent Router');
    location.hash = '#/config';
    syncRoute();
    expect(document.title).toBe('Config · Agent Router');
    location.hash = '#/sessions/x';
    syncRoute();
    expect(document.title).toBe('Session · Agent Router');
  });

  it('goToSession navigates to the detail hash', () => {
    goToSession('sess-9');
    expect(location.hash).toBe('#/sessions/sess-9');
  });

  it('goToOverview navigates to #/', () => {
    location.hash = '#/sessions';
    goToOverview();
    expect(location.hash).toBe('#/');
  });

  it('goToList navigates to the #/sessions hash (Req 9.3)', () => {
    location.hash = '#/sessions/sess-9';
    goToList();
    expect(location.hash).toBe('#/sessions');
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

  it('startRouter syncs the current route and updates on hashchange', () => {
    location.hash = '#/sessions/initial';
    stop = startRouter();
    // startRouter() syncs immediately.
    expect(route.current.view).toBe('detail');

    // A hashchange event updates the reactive route.
    location.hash = '#/';
    // jsdom dispatches hashchange synchronously after the hash assignment task;
    // force it deterministically.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(route.current.view).toBe('overview');
  });

  it('the disposer removes the hashchange listener', () => {
    location.hash = '#/';
    stop = startRouter();
    stop();
    stop = null;

    location.hash = '#/sessions/after-dispose';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // Route was NOT updated by the (removed) listener.
    expect(route.current.view).toBe('overview');
  });
});

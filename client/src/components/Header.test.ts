import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Header from './Header.svelte';
import { syncRoute } from '../routes/router.svelte.js';

/**
 * Header unit tests (spa-operator-restoration ROADMAP 80, Task A-8).
 *
 * Asserts the two-item nav bar (Sessions + Config) and active-item styling
 * driven by the current hash route (FR-7.1).
 */

describe('Header — navigation (FR-7.1)', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app');
    location.hash = '';
    syncRoute();
  });
  afterEach(cleanup);

  it('renders a Sessions link to #/ and a Config link to #/config', () => {
    const { getByTestId } = render(Header);
    const sessions = getByTestId('nav-sessions');
    const config = getByTestId('nav-config');
    expect(sessions.getAttribute('href')).toBe('#/');
    expect(sessions.textContent).toContain('Sessions');
    expect(config.getAttribute('href')).toBe('#/config');
    expect(config.textContent).toContain('Config');
  });

  it('applies the active style to Sessions when the route is the list view', () => {
    location.hash = '#/';
    syncRoute();
    const { getByTestId } = render(Header);
    expect(getByTestId('nav-sessions').className).toContain('bg-[var(--system-pill-bg)]');
    expect(getByTestId('nav-config').className).not.toContain('bg-[var(--system-pill-bg)]');
  });

  it('applies the active style to Config when the route is the config view', () => {
    location.hash = '#/config';
    syncRoute();
    const { getByTestId } = render(Header);
    expect(getByTestId('nav-config').className).toContain('bg-[var(--system-pill-bg)]');
    expect(getByTestId('nav-sessions').className).not.toContain('bg-[var(--system-pill-bg)]');
  });
});

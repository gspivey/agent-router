import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Header from './Header.svelte';
import { syncRoute } from '../routes/router.svelte.js';

/**
 * Header unit tests (spa-polish ROADMAP 88, Req 10).
 *
 * Asserts the branding block ("Agent Router" + version), the three nav tabs
 * (Overview / Sessions / Config), the accent-underline active style with
 * `aria-current="page"`, the focus ring, and the backdrop-blur translucent
 * header background.
 */
describe('Header — branding and navigation (Req 10)', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app');
    location.hash = '';
    syncRoute();
  });
  afterEach(cleanup);

  it('renders the branding glyph, "Agent Router" text, and version (Req 10.1, 10.2)', () => {
    const { getByTestId } = render(Header);
    const brand = getByTestId('brand-link');
    expect(brand.getAttribute('href')).toBe('#/');
    expect(brand.textContent).toContain('Agent Router');
    expect(getByTestId('brand-glyph')).toBeTruthy();
    // The version define is `v<version>`; assert the leading `v` is present.
    expect(getByTestId('app-version').textContent).toMatch(/^v/);
  });

  it('renders three nav tabs in order Overview / Sessions / Config (Req 10.3)', () => {
    const { getByTestId } = render(Header);
    const overview = getByTestId('nav-overview');
    const sessions = getByTestId('nav-sessions');
    const config = getByTestId('nav-config');
    expect(overview.getAttribute('href')).toBe('#/');
    expect(overview.textContent).toContain('Overview');
    expect(sessions.getAttribute('href')).toBe('#/sessions');
    expect(sessions.textContent).toContain('Sessions');
    expect(config.getAttribute('href')).toBe('#/config');
    expect(config.textContent).toContain('Config');
  });

  it('uses the accent underline + aria-current for the active Overview tab (Req 10.4, 10.5)', () => {
    location.hash = '#/';
    syncRoute();
    const { getByTestId } = render(Header);
    const overview = getByTestId('nav-overview');
    expect(overview.className).toContain('border-b-2');
    expect(overview.className).toContain('border-[var(--accent)]');
    expect(overview.getAttribute('aria-current')).toBe('page');
    // Inactive tabs do not carry the active underline or aria-current.
    expect(getByTestId('nav-sessions').getAttribute('aria-current')).toBeNull();
    // The old system-pill-bg active style is gone.
    expect(overview.className).not.toContain('bg-[var(--system-pill-bg)]');
  });

  it('marks Sessions active on both the list and detail views (Req 10.3)', () => {
    location.hash = '#/sessions';
    syncRoute();
    const list = render(Header);
    expect(list.getByTestId('nav-sessions').getAttribute('aria-current')).toBe('page');
    cleanup();

    location.hash = '#/sessions/abc';
    syncRoute();
    const detail = render(Header);
    expect(detail.getByTestId('nav-sessions').getAttribute('aria-current')).toBe('page');
  });

  it('marks Config active on the config view (Req 10.3)', () => {
    location.hash = '#/config';
    syncRoute();
    const { getByTestId } = render(Header);
    expect(getByTestId('nav-config').getAttribute('aria-current')).toBe('page');
    expect(getByTestId('nav-overview').getAttribute('aria-current')).toBeNull();
  });

  it('exposes a focus ring on interactive nav elements (Req 10.5)', () => {
    const { getByTestId } = render(Header);
    expect(getByTestId('nav-overview').className).toContain('focus-visible:ring-[var(--accent)]');
    expect(getByTestId('brand-link').className).toContain('focus-visible:ring-[var(--accent)]');
  });

  it('uses the backdrop-blur translucent header background (Req 10.6)', () => {
    const { getByTestId } = render(Header);
    const header = getByTestId('app-header');
    expect(header.className).toContain('backdrop-blur-sm');
    expect(header.className).toContain('bg-[var(--header-bg)]');
    expect(header.className).toContain('sticky');
    expect(header.className).toContain('h-14');
  });
});

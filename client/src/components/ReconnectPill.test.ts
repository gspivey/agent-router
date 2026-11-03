import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ReconnectPill from './ReconnectPill.svelte';

/**
 * ReconnectPill unit tests (BACKLOG.md § P2.58 / ROADMAP item 142).
 *
 * The ReconnectPill is a transient, purely presentational indicator shown by
 * ChatView while the SSE connection status is "reconnecting" (Req 7.4 / 4.9).
 * It accepts no props and has a fixed "Reconnecting…" text.
 *
 * Tests verify:
 *   1. Outer container renders with data-testid="reconnect-pill".
 *   2. Inner span has role="status" for screen reader announcement.
 *   3. Inner span has aria-live="polite".
 *   4. Text content is "Reconnecting…".
 *   5. Uses CSS custom property colors (no hardcoded hex — Req 8.3).
 */

afterEach(() => cleanup());

describe('ReconnectPill', () => {
  it('renders with data-testid="reconnect-pill"', () => {
    const { getByTestId } = render(ReconnectPill);
    expect(getByTestId('reconnect-pill')).toBeTruthy();
  });

  it('inner span has role="status" for screen reader announcement', () => {
    const { getByTestId } = render(ReconnectPill);
    const pill = getByTestId('reconnect-pill');
    const span = pill.querySelector('span[role="status"]');
    expect(span).not.toBeNull();
  });

  it('inner span has aria-live="polite"', () => {
    const { getByTestId } = render(ReconnectPill);
    const pill = getByTestId('reconnect-pill');
    const span = pill.querySelector('span');
    expect(span).not.toBeNull();
    expect(span!.getAttribute('aria-live')).toBe('polite');
  });

  it('shows the "Reconnecting…" text', () => {
    const { getByTestId } = render(ReconnectPill);
    const pill = getByTestId('reconnect-pill');
    expect(pill.textContent?.trim()).toBe('Reconnecting…');
  });

  it('is horizontally centered — outer div has flex justify-center', () => {
    const { getByTestId } = render(ReconnectPill);
    const pill = getByTestId('reconnect-pill');
    expect(pill.className).toContain('justify-center');
  });

  it('uses CSS custom property colors — no hardcoded hex (Req 8.3)', () => {
    const { getByTestId } = render(ReconnectPill);
    const pill = getByTestId('reconnect-pill');
    const span = pill.querySelector('span');
    // Inline style check: the span uses border-[var(--warning)] via Tailwind
    // arbitrary-value class — no hex literals in class or style attributes
    const classStr = span!.className;
    expect(classStr).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});

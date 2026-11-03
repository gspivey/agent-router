import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import SystemPill from './SystemPill.svelte';

/**
 * SystemPill unit tests (BACKLOG.md § P2.58 / ROADMAP item 142).
 *
 * SystemPill renders a centered pill for `system` parsed entries. When the entry
 * carries a `badge`, the text color maps to a palette token. Without a badge it
 * uses muted system-pill tokens. All colors reference Req 1.7 custom properties.
 *
 * Tests verify:
 *   1. Outer container renders with data-testid="system-pill".
 *   2. data-badge attribute reflects the badge prop (or "none" when absent).
 *   3. No badge → inner span uses var(--system-pill-text) color.
 *   4. badge="green" → inner span uses var(--success) color.
 *   5. badge="yellow" → inner span uses var(--warning) color.
 *   6. badge="red" → inner span uses var(--error) color.
 *   7. text prop appears as the inner span text content.
 */

afterEach(() => cleanup());

describe('SystemPill', () => {
  it('renders with data-testid="system-pill"', () => {
    const { getByTestId } = render(SystemPill, { text: 'Session started' });
    expect(getByTestId('system-pill')).toBeTruthy();
  });

  it('sets data-badge="none" when no badge prop is provided', () => {
    const { getByTestId } = render(SystemPill, { text: 'event' });
    expect(getByTestId('system-pill').getAttribute('data-badge')).toBe('none');
  });

  it('sets data-badge="green" when badge="green"', () => {
    const { getByTestId } = render(SystemPill, { text: 'success', badge: 'green' });
    expect(getByTestId('system-pill').getAttribute('data-badge')).toBe('green');
  });

  it('sets data-badge="yellow" when badge="yellow"', () => {
    const { getByTestId } = render(SystemPill, { text: 'warning', badge: 'yellow' });
    expect(getByTestId('system-pill').getAttribute('data-badge')).toBe('yellow');
  });

  it('sets data-badge="red" when badge="red"', () => {
    const { getByTestId } = render(SystemPill, { text: 'error', badge: 'red' });
    expect(getByTestId('system-pill').getAttribute('data-badge')).toBe('red');
  });

  it('uses var(--system-pill-text) color when no badge is provided', () => {
    const { getByTestId } = render(SystemPill, { text: 'no badge' });
    const pill = getByTestId('system-pill');
    const span = pill.querySelector('span');
    expect(span).not.toBeNull();
    expect(span!.getAttribute('style')).toContain('var(--system-pill-text)');
  });

  it('uses var(--success) color for badge="green"', () => {
    const { getByTestId } = render(SystemPill, { text: 'green', badge: 'green' });
    const pill = getByTestId('system-pill');
    const span = pill.querySelector('span');
    expect(span!.getAttribute('style')).toContain('var(--success)');
  });

  it('uses var(--warning) color for badge="yellow"', () => {
    const { getByTestId } = render(SystemPill, { text: 'yellow', badge: 'yellow' });
    const pill = getByTestId('system-pill');
    const span = pill.querySelector('span');
    expect(span!.getAttribute('style')).toContain('var(--warning)');
  });

  it('uses var(--error) color for badge="red"', () => {
    const { getByTestId } = render(SystemPill, { text: 'red', badge: 'red' });
    const pill = getByTestId('system-pill');
    const span = pill.querySelector('span');
    expect(span!.getAttribute('style')).toContain('var(--error)');
  });

  it('renders the text prop as the span text content', () => {
    const { getByTestId } = render(SystemPill, { text: 'Agent session started' });
    const pill = getByTestId('system-pill');
    expect(pill.textContent).toContain('Agent session started');
  });

  it('uses no hardcoded hex color values — only CSS custom properties', () => {
    const { getByTestId } = render(SystemPill, { text: 'test', badge: 'green' });
    const pill = getByTestId('system-pill');
    const span = pill.querySelector('span');
    // Requirement 8.3: all color references use custom properties, not hex
    expect(span!.getAttribute('style')).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});

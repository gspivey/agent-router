import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import InternalPill from './InternalPill.svelte';

/**
 * InternalPill unit tests (BACKLOG.md § P2.58 / ROADMAP item 142).
 *
 * The InternalPill shows a minimized metadata pill for `internal` parsed entries.
 * It toggles between a collapsed (truncated) and expanded (full text) view.
 *
 * Tests verify:
 *   1. Outer container renders with data-testid="internal-pill".
 *   2. Toggle button renders with data-testid="internal-pill-toggle".
 *   3. Default state: aria-expanded="false", text in truncate mode.
 *   4. After click: aria-expanded="true", text in expanded (break-words) mode.
 *   5. Second click collapses back to aria-expanded="false".
 */

afterEach(() => cleanup());

describe('InternalPill', () => {
  it('renders with data-testid="internal-pill"', () => {
    const { getByTestId } = render(InternalPill, { text: 'session started' });
    expect(getByTestId('internal-pill')).toBeTruthy();
  });

  it('renders the toggle button with data-testid="internal-pill-toggle"', () => {
    const { getByTestId } = render(InternalPill, { text: 'session started' });
    expect(getByTestId('internal-pill-toggle')).toBeTruthy();
  });

  it('is collapsed by default — aria-expanded="false"', () => {
    const { getByTestId } = render(InternalPill, { text: 'some metadata' });
    const btn = getByTestId('internal-pill-toggle');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('default collapsed state uses truncate styling', () => {
    const { getByTestId } = render(InternalPill, { text: 'a very long metadata text value' });
    const btn = getByTestId('internal-pill-toggle');
    // In collapsed mode the inner span has class "truncate"
    const spans = btn.querySelectorAll('span');
    const truncatedSpan = Array.from(spans).find((s) => s.classList.contains('truncate'));
    expect(truncatedSpan).toBeTruthy();
  });

  it('expands when the toggle button is clicked — aria-expanded="true"', async () => {
    const { getByTestId } = render(InternalPill, { text: 'expand me' });
    const btn = getByTestId('internal-pill-toggle');

    await fireEvent.click(btn);

    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('expanded state uses break-words styling', async () => {
    const { getByTestId } = render(InternalPill, { text: 'expand me please' });
    const btn = getByTestId('internal-pill-toggle');

    await fireEvent.click(btn);

    // In expanded mode the inner span has class "break-words"
    const spans = btn.querySelectorAll('span');
    const expandedSpan = Array.from(spans).find(
      (s) => s.classList.contains('break-words') || s.classList.contains('text-left'),
    );
    expect(expandedSpan).toBeTruthy();
  });

  it('collapses back after a second click — aria-expanded="false"', async () => {
    const { getByTestId } = render(InternalPill, { text: 'toggle me' });
    const btn = getByTestId('internal-pill-toggle');

    await fireEvent.click(btn); // expand
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    await fireEvent.click(btn); // collapse
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the text prop in the button content', () => {
    const { getByTestId } = render(InternalPill, { text: 'tool call completed' });
    const btn = getByTestId('internal-pill-toggle');
    expect(btn.textContent).toContain('tool call completed');
  });
});

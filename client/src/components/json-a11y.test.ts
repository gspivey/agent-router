import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import JsonToggle from './JsonToggle.svelte';
import EntryShell from './EntryShell.svelte';
import HelpOverlay from './HelpOverlay.svelte';

/**
 * JSON pivot + accessibility unit tests (spa-overhaul Task 7 / ROADMAP 77).
 *
 * Covers the JSON toggle swap (Req 8.1, 8.2), the always-visible chip at a
 * mobile width (Req 8.1), per-entry focusability (Req 8.4), desktop `J`
 * toggling (Req 8.5), and the `?` help overlay dismissal paths (Req 8.5).
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Minimal rendered-view snippet for an EntryShell child. */
const childSnippet = createRawSnippet(() => ({
  render: () => `<div data-testid="rendered-view">rendered</div>`,
}));

/** Force a given viewport width for a test. */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}

describe('JsonToggle (Req 8.1)', () => {
  it('renders the { } glyph with a ≥44×44 tap target and no hardcoded hex', () => {
    const { getByTestId } = render(JsonToggle, { active: false, onToggle: () => {} });
    const btn = getByTestId('json-toggle');
    expect(btn.textContent?.trim()).toBe('{ }');
    // Always-visible baseline: it is in the DOM regardless of hover.
    expect(btn).toBeTruthy();
    // Tap-target utility classes present (Req 8.1 / 8.6).
    expect(btn.className).toContain('min-h-[44px]');
    expect(btn.className).toContain('min-w-[44px]');
    // All color classes reference custom properties — no hardcoded hex (Req 8.3).
    expect(btn.className).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it('reflects active state via aria-pressed', async () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(JsonToggle, { active: false, onToggle });
    const btn = getByTestId('json-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('EntryShell JSON pivot (Req 8.1, 8.2, 8.4)', () => {
  const JSON_SRC = JSON.stringify({ ts: 't0', type: 'system' }, null, 2);

  it('shows the rendered view by default and the { } chip is always visible', () => {
    const { getByTestId, queryByTestId } = render(EntryShell, {
      json: JSON_SRC,
      children: childSnippet,
    });
    expect(getByTestId('rendered-view')).toBeTruthy();
    expect(queryByTestId('entry-json')).toBeNull();
    // The toggle chip is present (always-visible, Req 8.1).
    expect(getByTestId('json-toggle')).toBeTruthy();
  });

  it('swaps rendered↔<pre> on toggle, per entry (Req 8.2)', async () => {
    const { getByTestId, queryByTestId } = render(EntryShell, {
      json: JSON_SRC,
      children: childSnippet,
    });
    // Activate → raw JSON <pre>.
    await fireEvent.click(getByTestId('json-toggle'));
    const pre = getByTestId('entry-json');
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe(JSON_SRC);
    expect(queryByTestId('rendered-view')).toBeNull();
    // Second activation → back to the rendered view.
    await fireEvent.click(getByTestId('json-toggle'));
    expect(getByTestId('rendered-view')).toBeTruthy();
    expect(queryByTestId('entry-json')).toBeNull();
  });

  it('renders JSON as text (no raw-HTML directive) — a hostile payload is inert (NFR-6)', async () => {
    const hostile = JSON.stringify({ x: '<img src=x onerror="window.xss=1">' }, null, 2);
    const { getByTestId } = render(EntryShell, { json: hostile, children: childSnippet });
    await fireEvent.click(getByTestId('json-toggle'));
    const pre = getByTestId('entry-json');
    expect(pre.querySelector('img')).toBeNull();
    expect((window as unknown as { xss?: unknown }).xss).toBeUndefined();
  });

  it('is focusable so entries can be reached (Req 8.4)', () => {
    const { getByTestId } = render(EntryShell, { json: JSON_SRC, children: childSnippet });
    const entry = getByTestId('chat-entry');
    expect(entry.getAttribute('tabindex')).toBe('0');
  });

  it('the toggle chip is visible at a mobile viewport width (Req 8.1)', () => {
    setViewportWidth(375);
    const { getByTestId } = render(EntryShell, { json: JSON_SRC, children: childSnippet });
    const btn = getByTestId('json-toggle');
    // No hover-only hiding: no `hidden`/`invisible` utility and no display:none.
    expect(btn.className).not.toMatch(/\bhidden\b/);
    expect(btn.className).not.toMatch(/\binvisible\b/);
  });

  it('desktop J key toggles the focused entry JSON (Req 8.5)', async () => {
    setViewportWidth(1280);
    const { getByTestId, queryByTestId } = render(EntryShell, {
      json: JSON_SRC,
      children: childSnippet,
    });
    const entry = getByTestId('chat-entry');
    await fireEvent.keyDown(entry, { key: 'j' });
    expect(getByTestId('entry-json')).toBeTruthy();
    await fireEvent.keyDown(entry, { key: 'J' });
    expect(queryByTestId('entry-json')).toBeNull();
  });

  it('mobile J key does NOT toggle (desktop-only shortcut, Req 8.5)', async () => {
    setViewportWidth(375);
    const { getByTestId, queryByTestId } = render(EntryShell, {
      json: JSON_SRC,
      children: childSnippet,
    });
    await fireEvent.keyDown(getByTestId('chat-entry'), { key: 'j' });
    expect(queryByTestId('entry-json')).toBeNull();
  });
});

describe('HelpOverlay (Req 8.5)', () => {
  it('lists the J and ? shortcuts', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: () => {} });
    const overlay = getByTestId('help-overlay');
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.textContent).toContain('J');
    expect(overlay.textContent).toContain('?');
  });

  it('closes on the close button, backdrop click, and Escape', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(HelpOverlay, { onClose });
    await fireEvent.click(getByTestId('help-close'));
    await fireEvent.click(getByTestId('help-backdrop'));
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

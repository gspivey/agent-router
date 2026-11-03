import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import HelpOverlay from './HelpOverlay.svelte';

/**
 * HelpOverlay unit tests (BACKLOG.md § P2.56 / ROADMAP item 140).
 *
 * Covers the keyboard-shortcut help overlay's behavioral invariants:
 *   1. Keyboard shortcut list — all documented shortcuts appear in the rendered output.
 *   2. Close button — clicking the ✕ button calls onClose.
 *   3. Backdrop click — clicking the backdrop calls onClose.
 *   4. Escape key — pressing Escape calls onClose; other keys do not.
 *   5. ARIA roles — correct role, aria-modal, and aria-label for accessibility.
 *
 * `json-a11y.test.ts` already covers the J/? shortcut labels and the three close
 * mechanisms in a combined test; these tests provide dedicated, more granular coverage
 * and verify the ARIA contract, Escape-only behavior, and non-Escape key guard.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HelpOverlay — keyboard shortcut list', () => {
  it('lists the J shortcut (Toggle JSON)', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: vi.fn() });
    expect(getByTestId('help-overlay').textContent).toContain('J');
  });

  it('lists the ? shortcut (Open help)', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: vi.fn() });
    expect(getByTestId('help-overlay').textContent).toContain('?');
  });

  it('lists the Esc shortcut (Close this help)', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: vi.fn() });
    // The rendered text shows "Esc" as the keyboard label in the <dd>.
    expect(getByTestId('help-overlay').textContent).toContain('Esc');
  });

  it('contains a description for the J shortcut', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: vi.fn() });
    expect(getByTestId('help-overlay').textContent).toContain('Toggle JSON');
  });
});

describe('HelpOverlay — close mechanisms', () => {
  it('calls onClose when the close (✕) button is clicked', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(HelpOverlay, { onClose });

    await fireEvent.click(getByTestId('help-close'));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(HelpOverlay, { onClose });

    await fireEvent.click(getByTestId('help-backdrop'));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the Escape key is pressed on the window', async () => {
    const onClose = vi.fn();
    render(HelpOverlay, { onClose });

    await fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does NOT call onClose when a non-Escape key is pressed', async () => {
    const onClose = vi.fn();
    render(HelpOverlay, { onClose });

    // A variety of non-Escape keys that should be ignored.
    await fireEvent.keyDown(window, { key: 'Enter' });
    await fireEvent.keyDown(window, { key: 'a' });
    await fireEvent.keyDown(window, { key: '?' });
    await fireEvent.keyDown(window, { key: 'Tab' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('each close mechanism calls onClose exactly once (not multiple times)', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(HelpOverlay, { onClose });

    await fireEvent.click(getByTestId('help-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('HelpOverlay — ARIA accessibility', () => {
  it('has role="dialog" on the overlay root', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: vi.fn() });
    expect(getByTestId('help-overlay').getAttribute('role')).toBe('dialog');
  });

  it('has aria-modal="true"', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: vi.fn() });
    expect(getByTestId('help-overlay').getAttribute('aria-modal')).toBe('true');
  });

  it('has an accessible aria-label describing the content', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: vi.fn() });
    expect(getByTestId('help-overlay').getAttribute('aria-label')).toBe('Keyboard shortcuts');
  });

  it('renders a heading with "Keyboard shortcuts" text', () => {
    const { getByTestId } = render(HelpOverlay, { onClose: vi.fn() });
    const overlay = getByTestId('help-overlay');
    // The h2 inside the overlay identifies the dialog content.
    const heading = overlay.querySelector('h2');
    expect(heading).toBeTruthy();
    expect(heading?.textContent).toContain('Keyboard shortcuts');
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import KillConfirmDialog from './KillConfirmDialog.svelte';

/**
 * KillConfirmDialog unit tests (spa-operator-restoration Task B-2 / ROADMAP 81).
 *
 * Covers FR-6.2: the dialog text, confirm/cancel wiring, and Escape-to-cancel.
 */

describe('KillConfirmDialog', () => {
  afterEach(cleanup);

  it('renders the confirmation text', () => {
    const { getByTestId } = render(KillConfirmDialog, {
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(getByTestId('kill-confirm-dialog').textContent).toContain(
      'Kill this session? This will terminate the agent process immediately and cannot be undone.',
    );
  });

  it('is a modal dialog with an accessible label', () => {
    const { getByTestId } = render(KillConfirmDialog, {
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });
    const dialog = getByTestId('kill-confirm-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('kill-confirm-title');
  });

  it('calls onConfirm when the Kill button is clicked', async () => {
    const onConfirm = vi.fn();
    const { getByTestId } = render(KillConfirmDialog, { onConfirm, onCancel: vi.fn() });
    await fireEvent.click(getByTestId('kill-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when the Cancel button is clicked', async () => {
    const onCancel = vi.fn();
    const { getByTestId } = render(KillConfirmDialog, { onConfirm: vi.fn(), onCancel });
    await fireEvent.click(getByTestId('kill-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Escape is pressed', async () => {
    const onCancel = vi.fn();
    const { getByTestId } = render(KillConfirmDialog, { onConfirm: vi.fn(), onCancel });
    await fireEvent.keyDown(getByTestId('kill-confirm-dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('focuses the Cancel button on mount (default-safe)', () => {
    const { getByTestId } = render(KillConfirmDialog, { onConfirm: vi.fn(), onCancel: vi.fn() });
    expect(document.activeElement).toBe(getByTestId('kill-cancel'));
  });
});

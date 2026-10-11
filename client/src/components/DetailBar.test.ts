import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import DetailBar from './DetailBar.svelte';
import { api } from '../lib/api.js';

/**
 * DetailBar Kill-action unit tests (spa-operator-restoration Task B-3 /
 * ROADMAP 81).
 *
 * Covers FR-6.1 (Kill shown only for active sessions), FR-6.2 (confirm dialog
 * gating the API call), FR-6.2c (confirm issues `api.kill`), and FR-6.2e (inline
 * error on failure).
 */

describe('DetailBar — Kill action (FR-6)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the Kill button for an active session', () => {
    const { getByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's1',
      status: 'active',
      onInterrupt: vi.fn(),
    });
    expect(getByTestId('kill-button')).toBeTruthy();
  });

  it('does not render the Kill button for a non-active session', () => {
    const { queryByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's1',
      status: 'completed',
      onInterrupt: vi.fn(),
    });
    expect(queryByTestId('kill-button')).toBeNull();
  });

  it('clicking Kill opens the confirmation dialog without an API call', async () => {
    const killSpy = vi.spyOn(api, 'kill').mockResolvedValue({ ok: true });
    const { getByTestId, queryByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's1',
      status: 'active',
      onInterrupt: vi.fn(),
    });
    expect(queryByTestId('kill-confirm-dialog')).toBeNull();
    await fireEvent.click(getByTestId('kill-button'));
    expect(getByTestId('kill-confirm-dialog')).toBeTruthy();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('cancel dismisses the dialog without calling api.kill', async () => {
    const killSpy = vi.spyOn(api, 'kill').mockResolvedValue({ ok: true });
    const { getByTestId, queryByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's1',
      status: 'active',
      onInterrupt: vi.fn(),
    });
    await fireEvent.click(getByTestId('kill-button'));
    await fireEvent.click(getByTestId('kill-cancel'));
    expect(queryByTestId('kill-confirm-dialog')).toBeNull();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('confirming Kill calls api.kill with the session id', async () => {
    const killSpy = vi.spyOn(api, 'kill').mockResolvedValue({ ok: true });
    const { getByTestId, queryByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's1',
      status: 'active',
      onInterrupt: vi.fn(),
    });
    await fireEvent.click(getByTestId('kill-button'));
    await fireEvent.click(getByTestId('kill-confirm'));
    expect(killSpy).toHaveBeenCalledWith('s1');
    expect(queryByTestId('kill-confirm-dialog')).toBeNull();
  });

  it('renders an inline error when api.kill rejects', async () => {
    vi.spyOn(api, 'kill').mockRejectedValue(new Error('boom'));
    const { getByTestId, findByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's1',
      status: 'active',
      onInterrupt: vi.fn(),
    });
    await fireEvent.click(getByTestId('kill-button'));
    await fireEvent.click(getByTestId('kill-confirm'));
    const err = await findByTestId('kill-error');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain('Failed to kill session.');
  });

  it('clears a prior error on a subsequent Kill attempt', async () => {
    const killSpy = vi
      .spyOn(api, 'kill')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });
    const { getByTestId, findByTestId, queryByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's1',
      status: 'active',
      onInterrupt: vi.fn(),
    });
    await fireEvent.click(getByTestId('kill-button'));
    await fireEvent.click(getByTestId('kill-confirm'));
    await findByTestId('kill-error');
    // Reopening the dialog clears the error (FR-6.2e).
    await fireEvent.click(getByTestId('kill-button'));
    expect(queryByTestId('kill-error')).toBeNull();
    expect(killSpy).toHaveBeenCalledOnce();
  });
});

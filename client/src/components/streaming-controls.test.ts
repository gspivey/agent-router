import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import ReconnectPill from './ReconnectPill.svelte';
import SkeletonBubble from './SkeletonBubble.svelte';
import Composer from './Composer.svelte';
import DetailBar from './DetailBar.svelte';
import MessageBubble from './MessageBubble.svelte';
import ToolCallCard from './ToolCallCard.svelte';

/**
 * Task 6 component unit tests (spa-overhaul / ROADMAP 76).
 *
 * Covers the new streaming-state and operator-control components:
 * ReconnectPill (7.4), SkeletonBubble (7.5), Composer (7.6, 7.8),
 * DetailBar + Interrupt confirm (7.7), and the cursor/spinner props on
 * MessageBubble (7.2) and ToolCallCard (7.3).
 */

afterEach(cleanup);

describe('ReconnectPill (Req 7.4)', () => {
  it('renders the Reconnecting… text', () => {
    const { getByTestId } = render(ReconnectPill);
    expect(getByTestId('reconnect-pill').textContent).toContain('Reconnecting…');
  });
});

describe('SkeletonBubble (Req 7.5)', () => {
  it('renders a right-aligned placeholder with the given width', () => {
    const { getByTestId } = render(SkeletonBubble, { width: '40%' });
    const el = getByTestId('skeleton-bubble');
    expect(el.className).toContain('justify-end');
    expect(el.innerHTML).toContain('40%');
  });
});

describe('Composer (Req 7.6, 7.8)', () => {
  it('is always visible with an input and a Send button', () => {
    const { getByTestId } = render(Composer, { onSend: vi.fn().mockResolvedValue(undefined) });
    expect(getByTestId('composer')).toBeTruthy();
    expect(getByTestId('composer-input')).toBeTruthy();
    expect(getByTestId('composer-send')).toBeTruthy();
  });

  it('uses a ≥16px font input to avoid iOS zoom (Req 8.7)', () => {
    const { getByTestId } = render(Composer, { onSend: vi.fn().mockResolvedValue(undefined) });
    // text-base = 1rem = 16px in the Tailwind scale.
    expect(getByTestId('composer-input').className).toContain('text-base');
  });

  it('calls onSend with the trimmed prompt and clears the input on success', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(Composer, { onSend });
    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '  do a thing  ' } });
    await fireEvent.click(getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith('do a thing');
    // Cleared after a successful send.
    expect(input.value).toBe('');
  });

  it('does not clear the input when onSend rejects', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('boom'));
    const { getByTestId } = render(Composer, { onSend });
    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'keep me' } });
    await fireEvent.click(getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalled();
    expect(input.value).toBe('keep me');
  });

  it('is visible but inert when disabled (Req 7.8)', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(Composer, { onSend, disabled: true });
    const input = getByTestId('composer-input') as HTMLInputElement;
    const send = getByTestId('composer-send') as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    // Still rendered (visible).
    expect(getByTestId('composer')).toBeTruthy();
  });
});

describe('DetailBar + Interrupt (Req 7.7)', () => {
  it('renders back, title, and an "Interrupt" (not "Kill") button', () => {
    const { getByTestId, queryByTestId } = render(DetailBar, {
      title: 'sess-1',
      sessionId: 'sess-1',
      status: 'completed',
      onInterrupt: vi.fn(),
    });
    expect(getByTestId('detail-back')).toBeTruthy();
    expect(getByTestId('detail-bar').textContent).toContain('sess-1');
    const btn = getByTestId('interrupt-button');
    expect(btn.textContent).toContain('Interrupt');
    expect(btn.textContent).not.toContain('Kill');
    // A non-active session shows no Kill button (FR-6.1).
    expect(queryByTestId('kill-button')).toBeNull();
  });

  it('shows the confirmation dialog and only calls onInterrupt on confirm', async () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, queryByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's',
      status: 'active',
      onInterrupt,
    });
    // No dialog initially.
    expect(queryByTestId('interrupt-confirm')).toBeNull();
    await fireEvent.click(getByTestId('interrupt-button'));
    // Dialog appears with the exact required copy.
    expect(getByTestId('interrupt-confirm').textContent).toContain(
      'Interrupt the current agent turn?',
    );
    expect(onInterrupt).not.toHaveBeenCalled();
    // Confirming runs the callback.
    await fireEvent.click(getByTestId('interrupt-confirm-button'));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('cancel dismisses the dialog without calling onInterrupt', async () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, queryByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's',
      status: 'active',
      onInterrupt,
    });
    await fireEvent.click(getByTestId('interrupt-button'));
    await fireEvent.click(getByTestId('interrupt-cancel'));
    expect(queryByTestId('interrupt-confirm')).toBeNull();
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('the Interrupt button is inert when disabled (Req 7.8)', async () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    const { getByTestId, queryByTestId } = render(DetailBar, {
      title: 's',
      sessionId: 's',
      status: 'active',
      onInterrupt,
      disabled: true,
    });
    const btn = getByTestId('interrupt-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await fireEvent.click(btn);
    // No dialog opens while disabled.
    expect(queryByTestId('interrupt-confirm')).toBeNull();
  });
});

describe('MessageBubble cursor (Req 7.2)', () => {
  it('renders the ▌ glyph only when cursor is true', () => {
    const { getByTestId, queryByTestId } = render(MessageBubble, { text: 'typing', cursor: true });
    expect(getByTestId('stream-cursor').textContent).toContain('▌');
    cleanup();
    const r2 = render(MessageBubble, { text: 'done', cursor: false });
    expect(r2.queryByTestId('stream-cursor')).toBeNull();
    expect(queryByTestId).toBeTruthy();
  });
});

describe('ToolCallCard spinner (Req 7.3)', () => {
  it('shows the spinner and suppresses expand while spinning', () => {
    const { getByTestId, queryByTestId } = render(ToolCallCard, {
      title: 'run',
      updates: 'output',
      collapsed: false,
      spinner: true,
    });
    expect(getByTestId('tool-call-spinner')).toBeTruthy();
    // Body suppressed while spinning even though updates + open.
    expect(queryByTestId('tool-call-body')).toBeNull();
    expect(getByTestId('tool-call-header').getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking the header does not expand while spinning', async () => {
    const { getByTestId, queryByTestId } = render(ToolCallCard, {
      title: 'run',
      updates: 'output',
      collapsed: true,
      spinner: true,
    });
    await fireEvent.click(getByTestId('tool-call-header'));
    expect(queryByTestId('tool-call-body')).toBeNull();
  });

  it('shows the expand arrow and body once the spinner clears', () => {
    const { getByTestId, queryByTestId } = render(ToolCallCard, {
      title: 'run',
      updates: 'output',
      collapsed: false,
      spinner: false,
    });
    expect(queryByTestId('tool-call-spinner')).toBeNull();
    expect(getByTestId('tool-call-body').textContent).toContain('output');
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import Composer from './Composer.svelte';

/**
 * Composer unit tests (BACKLOG.md § P2.56 / ROADMAP item 140).
 *
 * Covers the prompt-injection input bar's behavioral invariants:
 *   1. Send path (happy path) — onSend called with trimmed text; input cleared on success.
 *   2. Disabled state — input and button are inert when `disabled` prop is true.
 *   3. Sending guard — double-submit prevention while onSend is in flight.
 *   4. Error path — input value retained on onSend rejection (so operator can retry).
 *   5. Empty-input guard — Send button disabled and onSend not called for blank input.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Composer — send path', () => {
  it('calls onSend with the trimmed prompt text when Send is clicked', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '  hello world  ' } });
    await fireEvent.click(getByTestId('composer-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith('hello world');
  });

  it('clears the input after onSend resolves successfully', async () => {
    let resolvePromise!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePromise = resolve;
        }),
    );
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'a prompt' } });
    await fireEvent.click(getByTestId('composer-send'));

    // Input not cleared yet — still in flight.
    expect(input.value).toBe('a prompt');

    // Resolve the send.
    resolvePromise();
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('submits on form Enter (pressing Enter inside the input)', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'enter prompt' } });
    // Submitting the form (pressing Enter on the input submits the form element)
    await fireEvent.submit(getByTestId('composer'));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('enter prompt'));
  });
});

describe('Composer — disabled state', () => {
  it('renders the input and Send button when disabled (still visible)', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(Composer, { onSend, disabled: true });

    expect(getByTestId('composer-input')).toBeTruthy();
    expect(getByTestId('composer-send')).toBeTruthy();
  });

  it('the input is disabled when disabled prop is true', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(Composer, { onSend, disabled: true });

    const input = getByTestId('composer-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('the Send button is disabled when disabled prop is true', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(Composer, { onSend, disabled: true });

    const btn = getByTestId('composer-send') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('does not call onSend when the form is submitted with disabled=true', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(Composer, { onSend, disabled: true });

    // Type something then try to submit — the textarea is disabled so no real
    // keyboard input in jsdom; test directly via the form submit event.
    await fireEvent.submit(getByTestId('composer'));
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('Composer — sending guard (double-submit prevention)', () => {
  it('does not call onSend a second time while first call is in flight', async () => {
    let resolveFirst!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'prompt' } });

    // First click — starts the in-flight send.
    await fireEvent.click(getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledTimes(1);

    // Second click while still in flight — should be no-op.
    await fireEvent.click(getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledTimes(1);

    // Cleanup.
    resolveFirst();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it('retains the input value while sending is in flight', async () => {
    let resolvePromise!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePromise = resolve;
        }),
    );
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'in-flight prompt' } });
    await fireEvent.click(getByTestId('composer-send'));

    // Still in flight — input should still show the original text.
    expect(input.value).toBe('in-flight prompt');

    resolvePromise();
    await waitFor(() => expect(input.value).toBe(''));
  });
});

describe('Composer — error path', () => {
  it('retains the input value when onSend rejects (so operator can retry)', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('network failure'));
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'retry me' } });
    await fireEvent.click(getByTestId('composer-send'));

    // onSend rejected — value must be preserved.
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(input.value).toBe('retry me');
  });

  it('does not throw or crash when onSend rejects', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('API error'));
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'crash test' } });

    // Should not throw.
    await expect(
      fireEvent.click(getByTestId('composer-send')).then(() =>
        waitFor(() => expect(onSend).toHaveBeenCalledOnce()),
      ),
    ).resolves.not.toThrow();
  });
});

describe('Composer — empty-input guard', () => {
  it('Send button is disabled when the input is empty', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(Composer, { onSend });

    const btn = getByTestId('composer-send') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Send button is disabled when the input contains only whitespace', async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '   ' } });

    const btn = getByTestId('composer-send') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Send button is enabled once the input contains non-whitespace text', async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(Composer, { onSend });

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'hello' } });

    const btn = getByTestId('composer-send') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('does not call onSend when form submitted with empty input', async () => {
    const onSend = vi.fn();
    const { getByTestId } = render(Composer, { onSend });

    // Input starts empty — form submit should be a no-op.
    await fireEvent.submit(getByTestId('composer'));
    expect(onSend).not.toHaveBeenCalled();
  });
});

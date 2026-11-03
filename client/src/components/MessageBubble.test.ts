import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import MessageBubble from './MessageBubble.svelte';

/**
 * MessageBubble unit tests (BACKLOG.md § P2.58 / ROADMAP item 142).
 *
 * Covers the two rendering modes and cursor affordance:
 *   1. Default mode (bare=false) — right-aligned wrapper, plain text.
 *   2. Bare mode (bare=true) — no outer wrapper, markdown via renderMarkdown.
 *   3. Streaming cursor glyph (cursor=true / false).
 *   4. Empty text renders without error.
 */

afterEach(() => cleanup());

describe('MessageBubble — default mode (bare=false)', () => {
  it('renders the outer bubble container with data-testid="message-bubble"', () => {
    const { getByTestId } = render(MessageBubble, { text: 'hello' });
    expect(getByTestId('message-bubble')).toBeTruthy();
  });

  it('is right-aligned — container has flex w-full justify-end', () => {
    const { getByTestId } = render(MessageBubble, { text: 'hello' });
    const el = getByTestId('message-bubble');
    expect(el.className).toContain('flex');
    expect(el.className).toContain('w-full');
    expect(el.className).toContain('justify-end');
  });

  it('renders the text content as plain text (not parsed as HTML)', () => {
    const { getByTestId } = render(MessageBubble, { text: '<b>bold</b>' });
    const el = getByTestId('message-bubble');
    // In plain-text mode the inner text should appear literally, not as a bold element.
    // The inner div carries the text directly.
    expect(el.textContent).toContain('<b>bold</b>');
  });

  it('does not show the streaming cursor when cursor=false (default)', () => {
    const { queryByTestId } = render(MessageBubble, { text: 'hello' });
    expect(queryByTestId('stream-cursor')).toBeNull();
  });

  it('shows the streaming cursor with aria-hidden when cursor=true', () => {
    const { getByTestId } = render(MessageBubble, { text: 'typing…', cursor: true });
    const cursor = getByTestId('stream-cursor');
    expect(cursor).toBeTruthy();
    expect(cursor.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders without error when text is empty', () => {
    // Just verify it renders without throwing.
    const { getByTestId } = render(MessageBubble, { text: '' });
    expect(getByTestId('message-bubble')).toBeTruthy();
  });
});

describe('MessageBubble — bare mode (bare=true)', () => {
  it('renders the bubble container with data-testid="message-bubble"', () => {
    const { getByTestId } = render(MessageBubble, { text: 'hello', bare: true });
    expect(getByTestId('message-bubble')).toBeTruthy();
  });

  it('does NOT have the right-aligning flex wrapper in bare mode', () => {
    const { getByTestId } = render(MessageBubble, { text: 'hello', bare: true });
    const el = getByTestId('message-bubble');
    // bare mode: no outer justify-end alignment; the wrapper is the message-bubble itself
    expect(el.className).not.toContain('justify-end');
  });

  it('renders markdown — **bold** produces a <strong> element', () => {
    const { getByTestId } = render(MessageBubble, { text: '**bold text**', bare: true });
    const el = getByTestId('message-bubble');
    // renderMarkdown converts **bold** to <strong>; should be in the DOM
    const strong = el.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toContain('bold text');
  });

  it('shows the streaming cursor when cursor=true in bare mode', () => {
    const { getByTestId } = render(MessageBubble, { text: 'typing', cursor: true, bare: true });
    const cursor = getByTestId('stream-cursor');
    expect(cursor).toBeTruthy();
    expect(cursor.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not show the cursor when cursor=false in bare mode', () => {
    const { queryByTestId } = render(MessageBubble, { text: 'hello', bare: true });
    expect(queryByTestId('stream-cursor')).toBeNull();
  });
});

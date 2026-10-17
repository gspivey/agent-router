import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import MessageRow from './MessageRow.svelte';

/**
 * MessageRow unit tests (spa-polish ROADMAP 88, Req 11).
 *
 * Asserts the per-kind grammar: agent RIGHT with agent-bubble tokens and
 * rendered via the sanitized MessageBubble sink; prompt LEFT; system CENTER with
 * no bubble; error RIGHT with the Tailwind red palette classes; the agent row is
 * never centered; the label line + relative time appear per `showLabel`; and no
 * raw-HTML directive leaks hostile markup.
 */
describe('MessageRow (Req 11)', () => {
  afterEach(cleanup);

  it('renders the agent kind RIGHT with agent-bubble tokens (Req 11.2, 11.6)', () => {
    const { getByTestId } = render(MessageRow, { kind: 'agent', text: 'hello' });
    const row = getByTestId('message-row');
    expect(row.getAttribute('data-kind')).toBe('agent');
    // Column cross-axis end = right-aligned; never centered.
    expect(row.className).toContain('items-end');
    expect(row.className).not.toContain('items-center');
    // The agent bubble carries the agent-bubble background token.
    expect(row.innerHTML).toContain('bg-[var(--agent-bubble-bg)]');
    // Agent text is rendered through the MessageBubble sink.
    expect(getByTestId('message-bubble')).toBeTruthy();
    expect(row.textContent).toContain('hello');
  });

  it('renders the prompt kind LEFT with the surface bubble (Req 11.2)', () => {
    const { getByTestId } = render(MessageRow, { kind: 'prompt', text: 'do it' });
    const row = getByTestId('message-row');
    expect(row.getAttribute('data-kind')).toBe('prompt');
    expect(row.className).toContain('items-start');
    expect(row.innerHTML).toContain('bg-[var(--surface)]');
    expect(row.textContent).toContain('do it');
  });

  it('renders the system kind CENTERED with no bubble and no label (Req 11.2)', () => {
    const { getByTestId, queryByTestId } = render(MessageRow, {
      kind: 'system',
      text: 'Session started',
    });
    const row = getByTestId('message-row');
    expect(row.getAttribute('data-kind')).toBe('system');
    expect(row.className).toContain('items-center');
    expect(row.textContent).toContain('Session started');
    // System rows never carry a label line.
    expect(queryByTestId('message-row-label')).toBeNull();
    // No agent-bubble sink for a system row.
    expect(queryByTestId('message-bubble')).toBeNull();
  });

  it('renders the error kind RIGHT with the Tailwind red palette (Req 11.2, NFR-2 exception)', () => {
    const { getByTestId } = render(MessageRow, { kind: 'error', text: 'boom' });
    const row = getByTestId('message-row');
    expect(row.getAttribute('data-kind')).toBe('error');
    expect(row.className).toContain('items-end');
    expect(row.innerHTML).toContain('bg-red-900/30');
    expect(row.innerHTML).toContain('border-red-700');
    expect(row.innerHTML).toContain('text-red-300');
  });

  it('shows the label line + default label when showLabel is true (Req 11.3)', () => {
    const { getByTestId } = render(MessageRow, { kind: 'agent', text: 'x', showLabel: true });
    expect(getByTestId('message-row-label').textContent).toContain('Agent');
  });

  it('hides the label line when showLabel is false (Req 11.4)', () => {
    const { queryByTestId } = render(MessageRow, { kind: 'agent', text: 'x', showLabel: false });
    expect(queryByTestId('message-row-label')).toBeNull();
  });

  it('exposes the timestamp as title and a relative string (Req 11.3)', () => {
    const iso = new Date(Date.now() - 3 * 60_000).toISOString();
    const { getByTestId } = render(MessageRow, {
      kind: 'agent',
      text: 'x',
      timestamp: iso,
      showLabel: true,
    });
    expect(getByTestId('message-row').getAttribute('title')).toBe(iso);
    expect(getByTestId('message-row-time').textContent).toBe('3m ago');
  });

  it('uses a label override (e.g. "You") when provided (Req 11.2)', () => {
    const { getByTestId } = render(MessageRow, { kind: 'prompt', text: 'x', label: 'You' });
    expect(getByTestId('message-row-label').textContent).toContain('You');
  });

  it('renders hostile agent content as escaped text — no raw-HTML sink (Req 11.7)', () => {
    const { getByTestId } = render(MessageRow, {
      kind: 'agent',
      text: '<img src="x" onerror="window.xss=1">',
    });
    const row = getByTestId('message-row');
    expect(row.querySelector('img')).toBeNull();
    expect((window as unknown as { xss?: unknown }).xss).toBeUndefined();
    expect(row.textContent).toContain('onerror');
  });
});

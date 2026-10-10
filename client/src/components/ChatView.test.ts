import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import ChatView from './ChatView.svelte';
import { auth } from '../lib/stores.svelte.js';
import type { StreamEntry } from '../lib/types.js';

/**
 * ChatView unit tests (spa-overhaul Task 5 / ROADMAP 75).
 *
 * Renders a stubbed history (via mocked `fetch`) and asserts each `ParsedEntry`
 * kind renders its component in ascending id order (Req 6.1, 6.9); a completed
 * session shows no streaming cursor or spinner (Req 7.2, 7.3 — historical only);
 * agent content is rendered as plain text (NFR-6.3).
 */

function detailResponse(entries: StreamEntry[], firstEventId: number | null): Response {
  const body = {
    meta: {
      session_id: 's1',
      status: 'completed',
      created_at: 1,
      completed_at: 2,
      prs: [],
    },
    entries,
    skipped_lines: 0,
    first_event_id: firstEventId,
    last_event_id: firstEventId === null ? null : firstEventId + entries.length - 1,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
  auth.token = 'tok';
  auth.error = 'none';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChatView — historical render', () => {
  it('renders each entry kind with its component in id order (Req 6.1, 6.9)', async () => {
    const entries: StreamEntry[] = [
      { ts: '2026-01-01T00:00:00Z', source: 'router', type: 'session_started' },
      {
        ts: '2026-01-01T00:00:01Z',
        source: 'agent',
        type: 'session/update',
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hi ' } },
      },
      {
        ts: '2026-01-01T00:00:02Z',
        source: 'agent',
        type: 'session/update',
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 'there' } },
      },
      {
        ts: '2026-01-01T00:00:03Z',
        source: 'agent',
        type: 'session/update',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read_file' },
      },
      {
        ts: '2026-01-01T00:00:04Z',
        source: 'agent',
        type: 'session/update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc1',
          content: [{ content: { text: 'result' } }],
        },
      },
      {
        ts: '2026-01-01T00:00:05Z',
        source: 'agent',
        type: 'session/request_permission',
        toolCall: { title: 'approve' },
      },
      { ts: '2026-01-01T00:00:06Z', source: 'agent', type: '_kiro.dev/metadata', content: 'ctx' },
      { ts: '2026-01-01T00:00:07Z', source: 'agent', type: 'bizarre' },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detailResponse(entries, 1));

    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });

    await waitFor(() => expect(queryByTestId('chat-loading')).toBeNull());

    // One reassembled agent bubble ("Hi there").
    expect(getByTestId('message-bubble').textContent).toContain('Hi there');
    // System pill, tool card, permission card, internal pill, unknown pill.
    expect(getByTestId('system-pill').textContent).toContain('Session started');
    expect(getByTestId('tool-call-header').textContent).toContain('read_file');
    expect(getByTestId('permission-card').textContent).toContain('approve');
    expect(getByTestId('internal-pill').textContent).toBeTruthy();
    expect(getByTestId('unknown-pill').textContent?.trim()).toBe('bizarre');

    // Historical completed load: no streaming cursor glyph anywhere.
    expect(getByTestId('chat-log').textContent).not.toContain('▌');
  });

  it('renders an empty-state when there are no entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detailResponse([], null));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-loading')).toBeNull());
    expect(getByTestId('chat-empty')).toBeTruthy();
  });

  it('surfaces a retriable error on a non-auth failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-loading')).toBeNull());
    expect(getByTestId('chat-error')).toBeTruthy();
    expect(getByTestId('chat-retry')).toBeTruthy();
  });

  it('renders hostile agent content as plain text (NFR-6.3)', async () => {
    const entries: StreamEntry[] = [
      {
        ts: '2026-01-01T00:00:00Z',
        source: 'agent',
        type: 'agent_message',
        content: '<img src="x" onerror="window.xss=1">',
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detailResponse(entries, 1));

    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-loading')).toBeNull());

    const log = getByTestId('chat-log');
    expect(log.querySelector('img')).toBeNull();
    expect((window as unknown as { xss?: unknown }).xss).toBeUndefined();
    expect(getByTestId('message-bubble').textContent).toContain('onerror');
  });
});

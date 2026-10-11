import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import ChatView from './ChatView.svelte';
import { auth } from '../lib/stores.svelte.js';
import type { StreamEntry } from '../lib/types.js';

/**
 * ChatView "Show internals" toggle tests (spa-operator-restoration Task B-7 /
 * ROADMAP 81).
 *
 * Covers FR-4.1 (filter entries whose raw `source` starts with `_kiro.dev/`
 * when OFF; render them when ON) and FR-4.2 (`ar-show-internals` localStorage
 * persistence + restore on mount).
 */

function detailResponse(entries: StreamEntry[], firstEventId: number | null): Response {
  const body = {
    meta: { session_id: 's1', status: 'completed', created_at: 1, completed_at: 2, prs: [] },
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

// An entry whose `source` field (not type) begins with `_kiro.dev/`. The SPA
// filters on `source` per FR-4.1; such an entry renders as an unknown pill whose
// label is its `type` (the parser only interprets source 'agent'/'router').
const internalEntry: StreamEntry = {
  ts: '2026-01-01T00:00:00Z',
  source: '_kiro.dev/metadata' as unknown as 'agent',
  type: 'internal-marker-type',
};

const normalEntry: StreamEntry = {
  ts: '2026-01-01T00:00:01Z',
  source: 'agent',
  type: 'session/update',
  update: { sessionUpdate: 'agent_message_chunk', content: { text: 'visible text' } },
};

beforeEach(() => {
  localStorage.clear();
  auth.token = 'tok';
  auth.error = 'none';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChatView — Show internals toggle (FR-4)', () => {
  it('hides _kiro.dev/* source entries by default (toggle OFF)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detailResponse([internalEntry, normalEntry], 1));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());

    const toggle = getByTestId('show-internals-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const log = getByTestId('chat-log');
    expect(log.textContent).toContain('visible text');
    expect(log.textContent).not.toContain('internal-marker-type');
  });

  it('renders _kiro.dev/* source entries when the toggle is turned ON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detailResponse([internalEntry, normalEntry], 1));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());

    await fireEvent.click(getByTestId('show-internals-toggle'));

    const log = getByTestId('chat-log');
    await waitFor(() => expect(log.textContent).toContain('internal-marker-type'));
    expect(log.textContent).toContain('visible text');
  });

  it('restores the toggle to ON when ar-show-internals is "1" on mount (FR-4.2)', async () => {
    localStorage.setItem('ar-show-internals', '1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detailResponse([internalEntry], 1));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());

    const toggle = getByTestId('show-internals-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(getByTestId('chat-log').textContent).toContain('internal-marker-type');
  });

  it('persists the toggle state to ar-show-internals on change', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detailResponse([normalEntry], 1));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());

    await fireEvent.click(getByTestId('show-internals-toggle'));
    expect(localStorage.getItem('ar-show-internals')).toBe('1');

    await fireEvent.click(getByTestId('show-internals-toggle'));
    expect(localStorage.getItem('ar-show-internals')).toBe('');
  });
});

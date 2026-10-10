import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { auth } from '../lib/stores.svelte.js';
import type { SseHandle } from '../lib/sse.js';
import type { StreamEntry } from '../lib/types.js';

/**
 * ChatView live-streaming unit tests (spa-overhaul Task 6 / ROADMAP 76; Req
 * 6.10). The SSE client (`connectStream`) is MOCKED so the test drives the
 * stream deterministically with no live network; the REST client is stubbed via
 * `fetch`. Asserts:
 *   - the cursor shows only on active + incomplete, never on a history load (7.2);
 *   - the tool-call spinner shows only on active + incomplete (7.3);
 *   - `session_ended` disables (but keeps visible) the Composer + Interrupt (7.8).
 */

// --- Mock the SSE client; capture the callbacks so the test drives frames. ---
interface Captured {
  onEntry: (id: number, data: unknown) => void;
  onEnded: () => void;
  onStatus: (s: 'live' | 'reconnecting') => void;
  onFatal: (k: 'not_found' | 'ended' | 'expired') => void;
  firstEventId: number | null;
  closed: boolean;
}
let captured: Captured | null = null;

vi.mock('../lib/sse.js', () => ({
  connectStream: (opts: {
    firstEventId: number | null;
    onEntry: (id: number, data: unknown) => void;
    onEnded: () => void;
    onStatus: (s: 'live' | 'reconnecting') => void;
    onFatal: (k: 'not_found' | 'ended' | 'expired') => void;
  }): SseHandle => {
    const c: Captured = {
      onEntry: opts.onEntry,
      onEnded: opts.onEnded,
      onStatus: opts.onStatus,
      onFatal: opts.onFatal,
      firstEventId: opts.firstEventId,
      closed: false,
    };
    captured = c;
    return {
      close(): void {
        c.closed = true;
      },
    };
  },
}));

// Import AFTER the mock so ChatView picks up the mocked module.
const { default: ChatView } = await import('./ChatView.svelte');

function detail(
  entries: StreamEntry[],
  status: 'active' | 'completed',
  firstEventId: number | null,
): Response {
  const body = {
    meta: { session_id: 's1', status, created_at: 1, completed_at: null, prs: [] },
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

function chunk(text: string): StreamEntry {
  return {
    ts: 't',
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'agent_message_chunk', content: { text } },
  };
}

beforeEach(() => {
  localStorage.clear();
  auth.token = 'tok';
  auth.error = 'none';
  captured = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChatView — cursor (Req 7.2)', () => {
  it('shows the cursor on an active session that is streaming', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detail([chunk('Hi')], 'active', 1));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());
    // The active bubble carries the streaming cursor glyph.
    expect(getByTestId('stream-cursor')).toBeTruthy();
  });

  it('shows NO cursor on a completed history load (Req 7.2)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detail([chunk('done')], 'completed', 1));
    const { queryByTestId, getByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());
    expect(queryByTestId('stream-cursor')).toBeNull();
    // A completed load does not open the stream.
    expect(captured).toBeNull();
    expect(getByTestId('message-bubble').textContent).toContain('done');
  });

  it('hides the cursor once a turn-complete marker streams in', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detail([chunk('Hi')], 'active', 1));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());
    expect(queryByTestId('stream-cursor')).toBeTruthy();
    // Stream a router-source prompt_injected AFTER the chunk → turn complete.
    captured!.onEntry(2, {
      ts: 't',
      source: 'router',
      type: 'prompt_injected',
      prompt_source: 'web',
    });
    await waitFor(() => expect(queryByTestId('stream-cursor')).toBeNull());
    expect(getByTestId).toBeTruthy();
  });
});

describe('ChatView — tool spinner (Req 7.3)', () => {
  it('spins an unfinished tool call on an active session, stops when finished streams in', async () => {
    const toolCall: StreamEntry = {
      ts: 't',
      source: 'agent',
      type: 'session/update',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'run' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detail([toolCall], 'active', 1));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());
    expect(getByTestId('tool-call-spinner')).toBeTruthy();

    // Stream a completed tool_call_update → spinner clears.
    captured!.onEntry(2, {
      ts: 't',
      source: 'agent',
      type: 'session/update',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: [] },
    });
    await waitFor(() => expect(queryByTestId('tool-call-spinner')).toBeNull());
  });
});

describe('ChatView — session_ended disables controls (Req 7.8)', () => {
  it('disables Composer and Interrupt (kept visible) on session_ended', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detail([chunk('Hi')], 'active', 1));
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());

    const input = getByTestId('composer-input') as HTMLInputElement;
    const interruptBtn = getByTestId('interrupt-button') as HTMLButtonElement;
    expect(input.disabled).toBe(false);
    expect(interruptBtn.disabled).toBe(false);

    // Fire session_ended through the mocked stream.
    captured!.onEnded();

    await waitFor(() => expect((getByTestId('composer-input') as HTMLInputElement).disabled).toBe(true));
    expect((getByTestId('interrupt-button') as HTMLButtonElement).disabled).toBe(true);
    // Controls remain visible (inert, not removed).
    expect(getByTestId('composer')).toBeTruthy();
    expect(getByTestId('interrupt-button')).toBeTruthy();
    // The ended system pill was appended.
    await waitFor(() => expect(getByTestId('chat-log').textContent).toContain('Session ended'));
    // The stream handle was closed.
    expect(captured!.closed).toBe(true);
  });
});

describe('ChatView — reconnect pill (Req 7.4)', () => {
  it('shows the reconnect pill while reconnecting and removes it when live', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(detail([chunk('Hi')], 'active', 1));
    const { queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());
    expect(queryByTestId('reconnect-pill')).toBeNull();

    captured!.onStatus('reconnecting');
    await waitFor(() => expect(queryByTestId('reconnect-pill')).toBeTruthy());

    captured!.onStatus('live');
    await waitFor(() => expect(queryByTestId('reconnect-pill')).toBeNull());
  });
});

describe('ChatView — Composer inject + Interrupt (Req 7.6, 7.7)', () => {
  it('injects a prompt via the API and clears the input', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(detail([chunk('Hi')], 'active', 1)) // history
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 })); // inject
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());

    const input = getByTestId('composer-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'please fix CI' } });
    await fireEvent.click(getByTestId('composer-send'));

    await waitFor(() => expect(input.value).toBe(''));
    // The inject call targeted the inject endpoint.
    const injectCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/inject'));
    expect(injectCall).toBeTruthy();
  });

  it('interrupt confirm calls the API then re-fetches meta (Req 7.7)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(detail([chunk('Hi')], 'active', 1)) // history
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })) // interrupt
      .mockResolvedValueOnce(detail([chunk('Hi')], 'active', 1)); // re-fetch meta
    const { getByTestId, queryByTestId } = render(ChatView, { sessionId: 's1' });
    await waitFor(() => expect(queryByTestId('chat-skeletons')).toBeNull());

    await fireEvent.click(getByTestId('interrupt-button'));
    expect(getByTestId('interrupt-confirm').textContent).toContain(
      'Interrupt the current agent turn?',
    );
    await fireEvent.click(getByTestId('interrupt-confirm-button'));

    await waitFor(() => {
      const interruptCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/interrupt'));
      expect(interruptCall).toBeTruthy();
    });
    // A meta re-fetch (GET /sessions/:id) followed the interrupt.
    await waitFor(() => {
      const getCalls = fetchMock.mock.calls.filter(
        (c) => String(c[0]).includes('/sessions/s1?') && (c[1] === undefined || c[1]?.method === undefined),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

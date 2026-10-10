import { describe, it, expect, vi } from 'vitest';
import { connectStream, parseFrame } from './sse.js';
import { mergeEvents, type SSEEvent } from './logic.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build an SSE `log` frame exactly as the broker formats it. */
function logFrame(id: number, data: unknown): string {
  return `event: log\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The broker's `session_ended` frame. */
function endedFrame(id: number): string {
  return `event: session_ended\nid: ${id}\ndata: ${JSON.stringify({ type: 'session_ended' })}\n\n`;
}

/**
 * A controllable ReadableStream of UTF-8 encoded SSE text. Call `push` to emit
 * a chunk, `error` to simulate a transport drop, and `close` to end cleanly.
 */
function makeStreamSource() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    error(err?: unknown) {
      controller.error(err ?? new Error('stream drop'));
    },
    close() {
      controller.close();
    },
  };
}

/**
 * A fetch stub that records each call (headers) and returns a configured
 * Response per connect attempt. `responses` is consumed in order; the last one
 * repeats for any further attempts.
 */
function makeFetchStub(
  responses: Array<{ status: number; source?: ReturnType<typeof makeStreamSource> }>,
) {
  const calls: Array<{ url: string; lastEventId: string | null; headers: Headers }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      lastEventId: headers.get('Last-Event-ID'),
      headers,
    });
    const spec = responses[Math.min(i, responses.length - 1)];
    i++;
    const body = spec?.source ? spec.source.stream : null;
    // Mirror real fetch: aborting the signal errors the response body stream so
    // the client's reader.read() rejects and the loop exits (stall/close path).
    if (spec?.source && init?.signal) {
      init.signal.addEventListener('abort', () => {
        try {
          spec.source!.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // Already errored/closed — ignore.
        }
      });
    }
    return new Response(body, { status: spec?.status ?? 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** A manual timer seam so backoff/stall fire deterministically on demand. */
function makeTimerSeam() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  const setTimeoutImpl = (fn: () => void, _ms: number) => {
    const id = ++seq;
    pending.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutImpl = (h: ReturnType<typeof setTimeout>) => {
    pending.delete(h as unknown as number);
  };
  return {
    setTimeoutImpl,
    clearTimeoutImpl,
    /** Fire the oldest pending timer (e.g. a scheduled reconnect). */
    fireNext() {
      const [id, fn] = [...pending.entries()][0] ?? [];
      if (id !== undefined && fn) {
        pending.delete(id);
        fn();
      }
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

/** Resolve after the microtask/IO queue drains so stream reads settle. */
async function flush(times = 5): Promise<void> {
  for (let n = 0; n < times; n++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// parseFrame (Req 4.2)
// ---------------------------------------------------------------------------

describe('parseFrame (Req 4.2)', () => {
  it('extracts event, numeric id, and data', () => {
    const f = parseFrame('event: log\nid: 7\ndata: {"a":1}');
    expect(f).toEqual({ event: 'log', id: 7, data: '{"a":1}' });
  });

  it('strips a single leading space after the colon', () => {
    const f = parseFrame('event: log\ndata: hello');
    expect(f?.data).toBe('hello');
  });

  it('returns null for a comment-only frame (e.g. :heartbeat)', () => {
    expect(parseFrame(':heartbeat')).toBeNull();
    expect(parseFrame(':ok\nretry: 1000')).toBeNull();
  });

  it('defaults the event name to "message" when only data is present', () => {
    const f = parseFrame('data: payload');
    expect(f).toEqual({ event: 'message', id: null, data: 'payload' });
  });

  it('joins multi-line data fields with newlines', () => {
    const f = parseFrame('event: log\ndata: a\ndata: b');
    expect(f?.data).toBe('a\nb');
  });
});

// ---------------------------------------------------------------------------
// First-connect vs reconnect Last-Event-ID (Req 4.3)
// ---------------------------------------------------------------------------

describe('connectStream Last-Event-ID seeding (Req 4.3)', () => {
  it('sends Last-Event-ID = history last_event_id on the first connect', async () => {
    const source = makeStreamSource();
    const { fetchImpl, calls } = makeFetchStub([{ status: 200, source }]);
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: 42,
      onEntry: () => {},
      onEnded: () => {},
      onStatus: () => {},
      onFatal: () => {},
      fetchImpl,
    });
    await flush();
    expect(calls[0]?.lastEventId).toBe('42');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer tok');
    handle.close();
  });

  it('omits Last-Event-ID on the first connect when history id is null', async () => {
    const source = makeStreamSource();
    const { fetchImpl, calls } = makeFetchStub([{ status: 200, source }]);
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: null,
      onEntry: () => {},
      onEnded: () => {},
      onStatus: () => {},
      onFatal: () => {},
      fetchImpl,
    });
    await flush();
    expect(calls[0]?.lastEventId).toBeNull();
    handle.close();
  });

  it('reconnect sends the highest id seen so far (Req 4.3, 4.5)', async () => {
    const first = makeStreamSource();
    const second = makeStreamSource();
    const { fetchImpl, calls } = makeFetchStub([
      { status: 200, source: first },
      { status: 200, source: second },
    ]);
    const timers = makeTimerSeam();
    const ids: number[] = [];
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: null,
      onEntry: (id) => ids.push(id),
      onEnded: () => {},
      onStatus: () => {},
      onFatal: () => {},
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    await flush();
    first.push(logFrame(10, { ts: 'a' }));
    first.push(logFrame(11, { ts: 'b' }));
    await flush();
    // Drop the connection → a reconnect is scheduled.
    first.error();
    await flush();
    timers.fireNext(); // run the scheduled reconnect
    await flush();
    // Second connect must carry the highest id (11), not the seed.
    expect(calls[1]?.lastEventId).toBe('11');
    expect(ids).toEqual([10, 11]);
    handle.close();
  });
});

// ---------------------------------------------------------------------------
// Status-code handling (Req 4.8, 3.4)
// ---------------------------------------------------------------------------

describe('connectStream status-code handling (Req 4.8, 3.4)', () => {
  async function expectFatal(status: number, kind: string) {
    const { fetchImpl } = makeFetchStub([{ status }]);
    const onFatal = vi.fn();
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: null,
      onEntry: () => {},
      onEnded: () => {},
      onStatus: () => {},
      onFatal,
      fetchImpl,
    });
    await flush();
    expect(onFatal).toHaveBeenCalledWith(kind);
    handle.close();
  }

  it('401 → expired', () => expectFatal(401, 'expired'));
  it('403 → expired', () => expectFatal(403, 'expired'));
  it('404 → not_found', () => expectFatal(404, 'not_found'));
  it('410 → ended', () => expectFatal(410, 'ended'));

  it('other non-200 waits then reconnects (no fatal)', async () => {
    const good = makeStreamSource();
    const { fetchImpl, calls } = makeFetchStub([
      { status: 500 },
      { status: 200, source: good },
    ]);
    const timers = makeTimerSeam();
    const onFatal = vi.fn();
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: null,
      onEntry: () => {},
      onEnded: () => {},
      onStatus: () => {},
      onFatal,
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    await flush();
    expect(onFatal).not.toHaveBeenCalled();
    timers.fireNext(); // the 5s error wait
    await flush();
    expect(calls.length).toBe(2);
    handle.close();
  });
});

// ---------------------------------------------------------------------------
// session_ended stops reconnect (Req 4.6)
// ---------------------------------------------------------------------------

describe('connectStream session_ended (Req 4.6)', () => {
  it('fires onEnded and does not reconnect', async () => {
    const source = makeStreamSource();
    const { fetchImpl, calls } = makeFetchStub([{ status: 200, source }]);
    const timers = makeTimerSeam();
    const onEnded = vi.fn();
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: null,
      onEntry: () => {},
      onEnded,
      onStatus: () => {},
      onFatal: () => {},
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    await flush();
    source.push(endedFrame(5));
    await flush();
    expect(onEnded).toHaveBeenCalledTimes(1);
    // No reconnect scheduled.
    expect(timers.pendingCount).toBe(0);
    expect(calls.length).toBe(1);
    handle.close();
  });
});

// ---------------------------------------------------------------------------
// Stall timer (Req 4.7)
// ---------------------------------------------------------------------------

describe('connectStream stall timer (Req 4.7)', () => {
  it('aborts and reconnects when no frame arrives within the stall window', async () => {
    const first = makeStreamSource();
    const second = makeStreamSource();
    const { fetchImpl, calls } = makeFetchStub([
      { status: 200, source: first },
      { status: 200, source: second },
    ]);
    const timers = makeTimerSeam();
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: null,
      onEntry: () => {},
      onEnded: () => {},
      onStatus: () => {},
      onFatal: () => {},
      fetchImpl,
      stallMs: 60_000,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    await flush();
    // The only pending timer is the stall timer; fire it → abort + reconnect.
    timers.fireNext();
    await flush();
    // Reconnect timer scheduled; fire it to reopen.
    timers.fireNext();
    await flush();
    expect(calls.length).toBe(2);
    handle.close();
  });
});

// ---------------------------------------------------------------------------
// Dedup across reconnect (Req 4.4, 6.9)
// ---------------------------------------------------------------------------

describe('connectStream dedup (Req 4.4, 6.9)', () => {
  it('history load + SSE connect produces no duplicate entries', async () => {
    // History already delivered ids 1..3; SSE replays from last_event_id=3.
    const history: SSEEvent[] = [
      { id: 1, data: 'h1' },
      { id: 2, data: 'h2' },
      { id: 3, data: 'h3' },
    ];
    const source = makeStreamSource();
    const { fetchImpl } = makeFetchStub([{ status: 200, source }]);

    let merged = [...history];
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: 3, // seed from history last_event_id
      onEntry: (id, data) => {
        merged = mergeEvents(merged, [{ id, data: JSON.stringify(data) }]);
      },
      onEnded: () => {},
      onStatus: () => {},
      onFatal: () => {},
      fetchImpl,
    });
    await flush();
    // Stream delivers the next events only (4 and 5).
    source.push(logFrame(4, 'e4'));
    source.push(logFrame(5, 'e5'));
    await flush();

    expect(merged.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    handle.close();
  });

  it('disconnect + reconnect replays only the missing events (no re-render)', async () => {
    const first = makeStreamSource();
    const second = makeStreamSource();
    const { fetchImpl } = makeFetchStub([
      { status: 200, source: first },
      { status: 200, source: second },
    ]);
    const timers = makeTimerSeam();

    let merged: SSEEvent[] = [];
    const onEntryCalls: number[] = [];
    const handle = connectStream({
      sessionId: 's1',
      token: 'tok',
      firstEventId: null,
      onEntry: (id, data) => {
        onEntryCalls.push(id);
        merged = mergeEvents(merged, [{ id, data: JSON.stringify(data) }]);
      },
      onEnded: () => {},
      onStatus: () => {},
      onFatal: () => {},
      fetchImpl,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    await flush();
    first.push(logFrame(1, 'a'));
    first.push(logFrame(2, 'b'));
    await flush();
    // Drop → reconnect; the broker replays starting AFTER id 2.
    first.error();
    await flush();
    timers.fireNext();
    await flush();
    // Replay delivers only 3 (and the broker would not resend 1,2). Even if a
    // duplicate id arrived, mergeEvents dedups it.
    second.push(logFrame(2, 'b')); // simulate an accidental overlap
    second.push(logFrame(3, 'c'));
    await flush();

    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
    // The overlapping id 2 collapses to a single rendered entry.
    expect(merged.filter((e) => e.id === 2).length).toBe(1);
    handle.close();
  });
});

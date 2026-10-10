/**
 * Fetch-based Server-Sent-Events client for the session stream (Requirement 4).
 *
 * Native `EventSource` cannot attach the bearer header the auth middleware
 * requires, nor abort cleanly on unmount, so this reads the stream with
 * `fetch` + `ReadableStream` + `AbortController` (Requirement 4.1, 4.6).
 *
 * Responsibilities:
 *  - Parse SSE frames: `event`, numeric `id`, `data`; ignore `:` comment lines
 *    (`:ok`, `:heartbeat`) (Requirement 4.2).
 *  - First connect seeds `Last-Event-ID` from the history `last_event_id`
 *    (omit when null); every reconnect sends the highest id seen so far
 *    (Requirement 4.3), tracked via `trackLastEventId`.
 *  - Dedup is the caller's job via `mergeEvents`; `onEntry(id, data)` fires once
 *    per received frame and the caller merges by id (Requirement 4.4).
 *  - Reconnect on drop with `computeBackoff` (Requirement 4.5, 4.9).
 *  - Status codes: 401/403 → expired; 404 → not found; 410 → ended; other
 *    non-200 → wait 5 s then backoff (Requirement 4.8, 3.4).
 *  - 60 s stall timer reset by every frame AND every `:heartbeat`; firing
 *    aborts and reconnects (Requirement 4.7).
 *  - `session_ended` → `onEnded()`, abort, no further reconnect (Requirement
 *    4.6).
 */

import { computeBackoff, trackLastEventId } from './logic.js';

/** Fatal, non-recoverable stream outcomes (Requirement 4.8, 3.4). */
export type SseFatalKind = 'not_found' | 'ended' | 'expired';

/** Transient status reported to the UI (Requirement 4.9, 7.4). */
export type SseStatus = 'live' | 'reconnecting';

/** Handle returned by {@link connectStream}; `close()` aborts the stream. */
export interface SseHandle {
  close(): void;
}

export interface ConnectStreamOptions {
  sessionId: string;
  token: string;
  /**
   * The history response's `last_event_id`: the first-connect `Last-Event-ID`.
   * `null` → send no header on the first connect (new session).
   */
  firstEventId: number | null;
  /** Fired once per received `log` frame; the caller dedups by id. */
  onEntry: (id: number, data: unknown) => void;
  /** Fired on a `session_ended` frame; the stream then stops permanently. */
  onEnded: () => void;
  /** Fired on connection-status transitions (`live` / `reconnecting`). */
  onStatus: (status: SseStatus) => void;
  /** Fired on a fatal status (401/403, 404, 410); the stream stops. */
  onFatal: (kind: SseFatalKind) => void;
  // --- Injectable seams for testing (default to the real primitives) ---
  /** `fetch` implementation (injectable for unit tests). */
  fetchImpl?: typeof fetch;
  /** Stall timeout in ms (default 60000; Requirement 4.7). */
  stallMs?: number;
  /** Non-200 (non-fatal) retry wait in ms (default 5000; Requirement 4.8). */
  errorRetryMs?: number;
  /** `setTimeout`/`clearTimeout` seam (injectable for deterministic tests). */
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** A single parsed SSE frame. */
interface ParsedFrame {
  event: string;
  id: number | null;
  data: string;
}

/**
 * Parse one raw SSE frame (the text between blank-line delimiters) into its
 * `event`, numeric `id`, and `data` fields. Comment lines (starting with `:`)
 * contribute nothing. Returns `null` when the frame carries no field lines
 * (e.g. a pure comment frame).
 */
export function parseFrame(raw: string): ParsedFrame | null {
  let event = 'message';
  let id: number | null = null;
  const dataParts: string[] = [];
  let sawField = false;

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue; // comment / blank
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per the SSE spec a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value;
      sawField = true;
    } else if (field === 'id') {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) id = n;
      sawField = true;
    } else if (field === 'data') {
      dataParts.push(value);
      sawField = true;
    }
  }

  if (!sawField) return null;
  return { event, id, data: dataParts.join('\n') };
}

/**
 * Open a resilient SSE stream against `GET /sessions/:id/stream`.
 *
 * Returns an {@link SseHandle} whose `close()` aborts the current connection
 * and prevents any further reconnect.
 */
export function connectStream(opts: ConnectStreamOptions): SseHandle {
  const {
    sessionId,
    token,
    firstEventId,
    onEntry,
    onEnded,
    onStatus,
    onFatal,
  } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const stallMs = opts.stallMs ?? 60_000;
  const errorRetryMs = opts.errorRetryMs ?? 5_000;
  const setTimer = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h));

  let closed = false;
  let attempt = 0;
  let firstConnect = true;
  let highestId = firstEventId ?? 0;
  let controller: AbortController | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function clearStall(): void {
    if (stallTimer !== null) {
      clearTimer(stallTimer);
      stallTimer = null;
    }
  }

  function armStall(): void {
    clearStall();
    if (closed) return;
    stallTimer = setTimer(() => {
      // Half-open TCP: abort and reconnect (Requirement 4.7).
      if (closed) return;
      controller?.abort();
    }, stallMs);
  }

  function scheduleReconnect(delayMs: number): void {
    if (closed) return;
    onStatus('reconnecting');
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void open();
    }, delayMs);
  }

  /** Last-Event-ID header value for this attempt, or null to omit it. */
  function lastEventIdHeader(): string | null {
    if (firstConnect) {
      return firstEventId !== null ? String(firstEventId) : null;
    }
    return highestId > 0 ? String(highestId) : null;
  }

  async function open(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'text/event-stream');
    const leid = lastEventIdHeader();
    if (leid !== null) headers.set('Last-Event-ID', leid);

    let res: Response;
    try {
      res = await doFetch(`/sessions/${encodeURIComponent(sessionId)}/stream`, {
        headers,
        signal: controller.signal,
      });
    } catch {
      // Network error before any response — reconnect with backoff.
      if (closed) return;
      scheduleReconnect(computeBackoff(attempt++));
      return;
    }

    if (closed) return;

    // Fatal, non-recoverable statuses (Requirement 4.8, 3.4).
    if (res.status === 401 || res.status === 403) {
      close();
      onFatal('expired');
      return;
    }
    if (res.status === 404) {
      close();
      onFatal('not_found');
      return;
    }
    if (res.status === 410) {
      close();
      onFatal('ended');
      return;
    }
    if (res.status !== 200 || res.body === null) {
      // Other non-200: wait 5 s, then reconnect with backoff (Requirement 4.8).
      scheduleReconnect(errorRetryMs);
      return;
    }

    // Connected.
    firstConnect = false;
    attempt = 0;
    onStatus('live');
    armStall();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armStall(); // any bytes (incl. heartbeat) reset the stall timer
        buffer += decoder.decode(value, { stream: true });

        // Split complete frames on the blank-line delimiter.
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const frame = parseFrame(rawFrame);
          if (frame === null) continue; // comment-only frame (e.g. :heartbeat)

          if (frame.event === 'session_ended') {
            close();
            onEnded();
            return;
          }
          if (frame.id !== null) {
            highestId = trackLastEventId(highestId, frame.id);
            let data: unknown = frame.data;
            try {
              data = JSON.parse(frame.data);
            } catch {
              // Leave as the raw string if it is not JSON.
            }
            onEntry(frame.id, data);
          }
        }
      }
    } catch {
      // Read error — fall through to reconnect below.
    } finally {
      clearStall();
    }

    if (closed) return;
    // Stream ended without `session_ended` → reconnect (Requirement 4.5).
    scheduleReconnect(computeBackoff(attempt++));
  }

  void open();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      clearStall();
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      controller?.abort();
    },
  };
}

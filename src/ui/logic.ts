/**
 * Pure logic for the web UI — importable by both browser and Node.
 * No DOM or fetch dependencies.
 */

export type SessionStatus = 'active' | 'completed' | 'abandoned' | 'failed';

export type BadgeColor = 'green' | 'gray' | 'yellow' | 'red';

export interface SSEEvent {
  id: number;
  data: string;
}

export interface HashRouteList {
  view: 'list';
}

export interface HashRouteDetail {
  view: 'detail';
  sessionId: string;
}

export type HashRoute = HashRouteList | HashRouteDetail;

/**
 * Merge SSE events into an existing list, deduplicating by id.
 * Returns a new array with unique events sorted by id ascending.
 */
export function mergeEvents(existing: readonly SSEEvent[], incoming: readonly SSEEvent[]): SSEEvent[] {
  const seen = new Map<number, SSEEvent>();
  for (const e of existing) {
    seen.set(e.id, e);
  }
  for (const e of incoming) {
    seen.set(e.id, e);
  }
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

/**
 * Track the highest event ID seen. Returns the max of the current
 * highest and the new ID.
 */
export function trackLastEventId(current: number, newId: number): number {
  return newId > current ? newId : current;
}

/**
 * Compute the reconnection delay using exponential backoff.
 * Initial: 1000ms, doubles each attempt, capped at 30000ms.
 */
export function computeBackoff(attempt: number): number {
  const delay = 1000 * Math.pow(2, attempt);
  return Math.min(delay, 30000);
}

/**
 * Map a session status to its badge color.
 */
export function statusToBadge(status: SessionStatus): BadgeColor {
  switch (status) {
    case 'active': return 'green';
    case 'completed': return 'gray';
    case 'abandoned': return 'yellow';
    case 'failed': return 'red';
  }
}

/**
 * Derive a "waiting for" summary from the last stream entry type.
 */
export function deriveWaitingFor(lastEntryType: string | undefined): string | undefined {
  if (lastEntryType === undefined) return undefined;
  switch (lastEntryType) {
    case 'tool_call': return 'waiting: tool';
    case 'tool_result': return 'waiting: turn complete';
    case 'prompt_injected': return 'waiting: turn complete';
    case 'prompt_injection_failed': return 'waiting: retry';
    case 'web_interrupt': return 'waiting: next prompt';
    case 'session_ended': return undefined;
    case 'agent_message': return 'waiting: tool';
    default: return `waiting: ${lastEntryType}`;
  }
}

/**
 * Parse a hash-based route string.
 * `#/` or empty → list view
 * `#/sessions/<id>` → detail view
 * Anything else → list view
 */
export function parseHashRoute(hash: string): HashRoute {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  const match = /^\/sessions\/([^/]+)$/.exec(trimmed);
  if (match?.[1]) {
    return { view: 'detail', sessionId: match[1] };
  }
  return { view: 'list' };
}

// ---------------------------------------------------------------------------
// Fetch resilience helpers
// ---------------------------------------------------------------------------

export type FetchOutcome = 'success' | 'auth' | 'network' | 'timeout';

/**
 * Determine whether an HTTP status code is retryable.
 * Network errors (status 0 or undefined) and 5xx are retryable.
 * 401 is NOT retryable (auth failure).
 * 4xx other than 401 are not retryable.
 */
export function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return false;
}

/**
 * Classify a fetch result into an outcome type.
 */
export function classifyFetchError(status: number): FetchOutcome {
  if (status === 401) return 'auth';
  if (status >= 500) return 'network';
  return 'network';
}

/**
 * Compute the retry delay for a resilient fetch attempt.
 * Uses exponential backoff: base * 2^attempt, capped at maxDelay.
 */
export function computeFetchRetryDelay(attempt: number, baseMs = 500, maxMs = 5000): number {
  const delay = baseMs * Math.pow(2, attempt);
  return Math.min(delay, maxMs);
}

// ---------------------------------------------------------------------------
// Stream-entry parsing (session stream chat view)
// ---------------------------------------------------------------------------

/** Badge color for a system verification pill. */
export type SystemBadge = 'green' | 'yellow' | 'red';

/** Router system-event subtypes recognized by the chat renderer. */
export type SystemSubtype =
  | 'session_started'
  | 'prompt_injected'
  | 'session_ended'
  | 'session_verified'
  | 'verification_failed'
  | 'web_inject'
  | 'web_interrupt';

/**
 * A raw `stream.log` entry, normalized into a discriminated union by
 * {@link parseStreamEntry}. Each variant is `kind`-tagged so the renderer can
 * dispatch without re-inspecting the raw shape.
 */
export type ParsedEntry =
  // Router events (`source: "router"`).
  | { kind: 'system'; subtype: SystemSubtype; text: string; badge?: SystemBadge }
  // Real streaming chunk — participates in bubble reassembly.
  | { kind: 'agent_chunk'; text: string; streaming: true }
  // Legacy flat agent message — one bubble, does NOT join reassembly.
  | { kind: 'agent_message'; text: string; streaming: false }
  // Tool invocation start. `toolCallId === null` means a legacy bare entry;
  // the renderer assigns a synthetic id when it sees `null`.
  | { kind: 'tool_call'; toolCallId: string | null; title: string }
  // Tool output fragment(s) keyed by `toolCallId`.
  | { kind: 'tool_update'; toolCallId: string; text: string }
  // Tool permission request awaiting operator approval.
  | { kind: 'permission'; title: string }
  // Kiro internal (`_kiro.dev/*`) — hidden by default in the renderer.
  | { kind: 'internal'; subtype: string; text: string }
  // Unrecognized shape. `typeLabel` is the entry `type` field or `'unknown'`.
  | { kind: 'unknown'; typeLabel: string };

/**
 * Coerce an arbitrary value to a string, returning `''` for null/undefined
 * and non-string primitives that are not meaningful text.
 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Map a router system subtype + raw entry to a human string and optional badge.
 */
function mapSystem(subtype: SystemSubtype, raw: Record<string, unknown>): ParsedEntry {
  switch (subtype) {
    case 'session_started':
      return { kind: 'system', subtype, text: 'Session started' };
    case 'prompt_injected':
      return {
        kind: 'system',
        subtype,
        text: `Prompt injected (${asText(raw.prompt_source) || 'unknown'})`,
      };
    case 'session_ended':
      return {
        kind: 'system',
        subtype,
        text: `Session ended — ${asText(raw.reason) || 'unknown'}`,
      };
    case 'session_verified':
      return {
        kind: 'system',
        subtype,
        text: `Verified — ${asText(raw.termination_reason) || 'unknown'}`,
        badge: 'green',
      };
    case 'verification_failed':
      return {
        kind: 'system',
        subtype,
        text: `Verification failed — ${asText(raw.error) || 'unknown'}`,
        badge: 'red',
      };
    case 'web_inject':
      return { kind: 'system', subtype, text: 'Operator inject' };
    case 'web_interrupt':
      return { kind: 'system', subtype, text: 'Operator interrupt' };
  }
}

/** The closed set of router event `type`s that map to a system subtype. */
const SYSTEM_SUBTYPES: readonly SystemSubtype[] = [
  'session_started',
  'prompt_injected',
  'session_ended',
  'session_verified',
  'verification_failed',
  'web_inject',
  'web_interrupt',
];

/**
 * Concatenate the text fragments from an agent `tool_call_update` content array.
 * Each element has the shape `{ content: { text: string } }`; anything else is
 * skipped so a malformed fragment cannot break parsing.
 */
function concatToolUpdateText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const item of content) {
    if (item && typeof item === 'object') {
      const inner = (item as { content?: unknown }).content;
      if (inner && typeof inner === 'object') {
        out += asText((inner as { text?: unknown }).text);
      }
    }
  }
  return out;
}

/**
 * Normalize a raw `stream.log` entry into a {@link ParsedEntry} tagged union.
 *
 * Pure and total: it never throws and never exposes `JSON.stringify(raw)` in the
 * `unknown` fallback (only the entry's `type` field) to avoid leaking prompt
 * content. Dispatch follows the taxonomy in the session-stream-chat design:
 *
 * - `source === 'router'` → `system` (mapped text + optional badge).
 * - `source === 'agent'`, `type === 'session/update'` → read `update.sessionUpdate`
 *   (`agent_message_chunk` → `agent_chunk`, `tool_call` → `tool_call`,
 *   `tool_call_update` → `tool_update`).
 * - `source === 'agent'`, `type === 'session/request_permission'` → `permission`.
 * - `source === 'agent'`, `type` starts with `_kiro.dev/` → `internal`.
 * - Legacy flat agent shapes (`agent_message`, bare `tool_call`) are tolerated.
 * - Anything else → `unknown`.
 */
export function parseStreamEntry(raw: unknown): ParsedEntry {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'unknown', typeLabel: 'unknown' };
  }
  const entry = raw as Record<string, unknown>;
  const source = entry.source;
  const type = typeof entry.type === 'string' ? entry.type : undefined;
  const typeLabel = type ?? 'unknown';

  // Router events → system pills.
  if (source === 'router') {
    if (type && (SYSTEM_SUBTYPES as readonly string[]).includes(type)) {
      return mapSystem(type as SystemSubtype, entry);
    }
    return { kind: 'unknown', typeLabel };
  }

  if (source === 'agent') {
    // Modern ACP streaming envelope.
    if (type === 'session/update') {
      const update = entry.update;
      if (update && typeof update === 'object') {
        const u = update as Record<string, unknown>;
        const sub = u.sessionUpdate;
        if (sub === 'agent_message_chunk') {
          const content = u.content;
          const text =
            content && typeof content === 'object'
              ? asText((content as { text?: unknown }).text)
              : '';
          return { kind: 'agent_chunk', text, streaming: true };
        }
        if (sub === 'tool_call') {
          const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : null;
          return { kind: 'tool_call', toolCallId, title: asText(u.title) };
        }
        if (sub === 'tool_call_update') {
          const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : '';
          return { kind: 'tool_update', toolCallId, text: concatToolUpdateText(u.content) };
        }
      }
      return { kind: 'unknown', typeLabel };
    }

    // Tool permission request.
    if (type === 'session/request_permission') {
      const toolCall = entry.toolCall;
      const title =
        toolCall && typeof toolCall === 'object'
          ? asText((toolCall as { title?: unknown }).title)
          : '';
      return { kind: 'permission', title };
    }

    // Kiro internal noise.
    if (type && type.startsWith('_kiro.dev/')) {
      return { kind: 'internal', subtype: type, text: asText(entry.content) };
    }

    // Legacy flat fallbacks emitted by older sessions / the test harness.
    if (type === 'agent_message') {
      return { kind: 'agent_message', text: asText(entry.content), streaming: false };
    }
    if (type === 'tool_call') {
      const toolCallId = typeof entry.toolCallId === 'string' ? entry.toolCallId : null;
      return { kind: 'tool_call', toolCallId, title: asText(entry.title) };
    }

    return { kind: 'unknown', typeLabel };
  }

  return { kind: 'unknown', typeLabel };
}


// ---------------------------------------------------------------------------
// Markdown rendering (session stream chat view)
// ---------------------------------------------------------------------------

/**
 * HTML-escape a string so it is safe to insert into markup as text content.
 * Escapes the five characters that are significant in HTML/attribute contexts.
 * This is the browser `escapeHtml` extended with quote escaping so the same
 * function is safe inside attribute values (e.g. link `href`).
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whether a link URL uses a scheme safe to emit in an `href`.
 *
 * Only `http:`, `https:`, and `mailto:` are permitted. Scheme-relative
 * (`//host`), path/relative, and fragment (`#…`) URLs are allowed because they
 * cannot execute script. Anything with an explicit disallowed scheme (notably
 * `javascript:`, `data:`, `vbscript:`) is rejected. The check ignores leading
 * whitespace and control characters that browsers strip when resolving schemes.
 */
export function isSafeLinkHref(href: string): boolean {
  // Strip leading control chars / whitespace the way browsers do before
  // resolving a scheme, so `java\tscript:` cannot slip through.
  const cleaned = href.replace(/[\u0000-\u0020]+/g, '');
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!schemeMatch) {
    // No explicit scheme → relative, scheme-relative, or fragment. Safe.
    return true;
  }
  const scheme = (schemeMatch[1] ?? '').toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

/**
 * Render a safe `href` value: return the original URL when its scheme is
 * permitted, otherwise `'#'`. The returned value is NOT yet HTML-escaped.
 */
export function safeLinkHref(href: string): string {
  return isSafeLinkHref(href) ? href : '#';
}

/**
 * Minimal, safe inline markdown renderer for agent messages.
 *
 * Order is **escape-then-format**: the input is HTML-escaped first (via
 * {@link escapeHtml}) so no raw HTML/JSON artifacts are visible and no markup
 * injection is possible, and only then are a small set of markdown constructs
 * turned into HTML. Supported constructs:
 *
 * - Fenced code blocks (```lang\n…```)  → `<pre><code>…</code></pre>`
 * - Inline code (`` `code` ``)          → `<code>…</code>`
 * - Bold (`**text**`)                   → `<strong>…</strong>`
 * - Italic (`*text*` / `_text_`)        → `<em>…</em>`
 * - Links (`[text](url)`)               → `<a href>…</a>` (scheme-filtered)
 * - Line breaks (`\n`)                  → `<br>`
 *
 * Links only emit `href` values with `http:`, `https:`, or `mailto:` schemes;
 * any other scheme (e.g. `javascript:`) becomes `'#'` (see {@link safeLinkHref}).
 * No new dependency is introduced — this is intentionally a small subset, not a
 * full CommonMark implementation.
 */
export function renderMarkdown(text: string): string {
  // 1. Escape everything up front.
  const escaped = escapeHtml(text);

  // 2. Extract fenced code blocks first so their contents are not subject to
  //    inline formatting. Replace with placeholders, restore at the end.
  const codeBlocks: string[] = [];
  let out = escaped.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, body: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + body + '</code></pre>');
    return '\u0000CODEBLOCK' + idx + '\u0000';
  });

  // 3. Inline code — also protected from further inline formatting.
  const inlineCode: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    const idx = inlineCode.length;
    inlineCode.push('<code>' + body + '</code>');
    return '\u0000INLINECODE' + idx + '\u0000';
  });

  // 4. Links: [text](url). `url` is already HTML-escaped; validate its scheme
  //    on the unescaped-entity form so `&amp;` in a query string is tolerated.
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const decoded = url.replace(/&amp;/g, '&');
    const href = escapeHtml(safeLinkHref(decoded));
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });

  // 5. Bold before italic so `**x**` is not eaten by the single-char rules.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  // 6. Line breaks (outside code blocks, which used placeholders).
  out = out.replace(/\n/g, '<br>');

  // 7. Restore protected code spans/blocks.
  out = out.replace(/\u0000INLINECODE(\d+)\u0000/g, (_m, i: string) => inlineCode[Number(i)] ?? '');
  out = out.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? '');

  return out;
}

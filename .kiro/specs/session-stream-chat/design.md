# Design: Session Stream Chat View

## Overview

This feature replaces the raw NDJSON scroll box in the session detail view with a chat-style
conversation renderer. It is entirely contained in `src/web-ui.ts` — the inlined browser script
returned by `renderWebUI()`. No backend, routing, auth, or SSE-transport code changes.

The core change: replace the single `appendLogEntry(data)` function (which does
`div.textContent = data`) and the initial-load loop (which does
`div.textContent = JSON.stringify(entry)`) with a stateful renderer that:

1. Parses each entry into a discriminated shape.
2. Maintains reassembly state (open agent bubble, tool-call cards by id).
3. Dispatches to a per-type renderer that produces/updates DOM.

```
stream.log entry (JSON)
        │
        ▼
  parseStreamEntry(raw)  ──►  { kind, ...fields }   (pure)
        │
        ▼
  renderStreamEntry(entry, ctx)   (stateful, mutates #log-container)
        │
        ├─ router system pill        (session_started / prompt_injected / …)
        ├─ agent message bubble      (agent_message_chunk reassembly)
        ├─ tool card                 (tool_call + tool_call_update by toolCallId)
        ├─ permission card           (session/request_permission)
        └─ internal row (hidden)     (_kiro.dev/*)
```

Both the initial-load path (completed sessions) and the SSE path (active sessions) funnel through
the same `renderStreamEntry`, so there is one rendering code path.

## Why keep `#log-container` and `.log-entry`

The brief allows repurposing `#log-container`. The existing SSE test suite
(`sse-render`, `sse-hardening`, `sse-reconnect`, `visibility-reconnect`, `network-repro`) waits on
`#log-container` and asserts `.log-entry` elements filtered by text. To minimize churn and keep
the SSE data pipeline (`connectSSE`, `scheduleReconnect`, de-dup, `Last-Event-ID`) untouched, we:

- Keep the scroll container's id as `#log-container` but restyle it from a monospace `white-space:pre`
  box into a vertical chat column.
- Give every top-level chat element the `log-entry` class **plus** a chat-specific class
  (e.g. `chat-msg-agent`, `chat-system`, `chat-tool`, `chat-permission`, `chat-internal`).

This lets existing text-based `.log-entry` assertions keep matching while new tests can target the
richer classes.

## Data Model: `parseStreamEntry` (pure)

A pure function (unit-testable, exported for Tier 1) that normalizes the raw entry into a tagged union:

```ts
type ParsedEntry =
  | { kind: 'system'; subtype: 'session_started' | 'prompt_injected' | 'session_ended'
      | 'session_verified' | 'verification_failed' | 'web_inject' | 'web_interrupt';
      text: string; badge?: 'green' | 'yellow' | 'red' }
  | { kind: 'agent_chunk'; text: string; streaming: true }    // real chunk — participates in bubble reassembly
  | { kind: 'agent_message'; text: string; streaming: false } // legacy flat — one bubble, does NOT join reassembly
  | { kind: 'tool_call'; toolCallId: string | null; title: string }  // null = legacy bare entry, renderer assigns synthetic id
  | { kind: 'tool_update'; toolCallId: string; text: string }
  | { kind: 'permission'; title: string }
  | { kind: 'internal'; subtype: string; text: string }
  | { kind: 'unknown'; typeLabel: string };  // typeLabel = entry.type || 'unknown'
```

Dispatch rules:

- `source === 'router'` → `system` (map `type` to the subtype + human string + badge color).
- `source === 'agent'`:
  - `type === 'session/update'` → read `update.sessionUpdate`:
    - `agent_message_chunk` → `agent_chunk` (`streaming: true`, text from `update.content.text`)
    - `tool_call` → `tool_call` (`update.toolCallId`, `update.title`)
    - `tool_call_update` → `tool_update` (`update.toolCallId`, concat `update.content[].content.text`)
  - `type === 'session/request_permission'` → `permission` (`toolCall.title`)
  - `type` starts with `_kiro.dev/` → `internal` (subtype = the `_kiro.dev/...` string)
  - **Legacy fallbacks** (no `session/update` envelope):
    - `type === 'agent_message'` → `agent_message` (`streaming: false`, text from top-level `content`). Closes any open bubble but does NOT become `openBubble`.
    - `type === 'tool_call'` → `tool_call` (best-effort `toolCallId`/`title`; if the entry has no `toolCallId`, emit `toolCallId: null` — the renderer assigns the synthetic id `'legacy-' + ctx.entryCount` when it sees `null`)
- anything else → `unknown` (`typeLabel` = entry `type` field or `'unknown'`; does NOT stringify full raw entry to avoid leaking prompt content).

The legacy fallbacks are required because the test harness seeds entries like
`{ source:'agent', type:'agent_message', content:'msg-1' }` and
`{ source:'agent', type:'tool_call' }` (see `sse-render.spec.ts`, `network-repro.spec.ts`).

## Render Context (stateful)

`renderStreamEntry` needs a small mutable context, held per detail-view mount:

```ts
interface RenderCtx {
  container: HTMLElement;          // #log-container
  isActive: boolean;               // session status === 'active'
  showInternals: boolean;          // "Show internals" toggle state
  openBubble: HTMLElement | null;  // current agent bubble accepting chunks, or null
  toolCards: Map<string, { card: HTMLElement; body: HTMLElement; lines: string[] }>;
  autoScroll: boolean;             // false once user scrolls up
  entryCount: number;              // monotonic counter incremented on each renderStreamEntry call; used as suffix for legacy-* synthetic ids
}
```

Reassembly logic:

- **agent_chunk**: if `openBubble` is set, append text to it and re-render its markdown; else create a
  new `.log-entry.chat-msg-agent` bubble, set `openBubble`.
- **Any non-agent_chunk kind**: set `openBubble = null` first (closes the current bubble), then render
  that kind. This implements "a non-chunk entry interrupts the bubble" (Req 3.3).
- **tool_call**: create card, register in `toolCards` by id. Collapsed unless `isActive` and it is the
  latest tool. Track "latest tool card" so the new one expands and the previous collapses (active only).
- **tool_update**: look up card by id (create lazily if absent), push text lines into `lines`, update body.
  Body shows last N lines (N = 20) with a "Show more" button revealing all lines.
- **permission**: render `.chat-permission` yellow card. On terminal sessions render muted.
- **internal**: render `.chat-internal` element with `display:none` unless `showInternals`. `_kiro.dev/metadata`
  renders as a small gray pill (context% + turn duration); others as a compact row.
- **system**: render `.chat-system` pill with the mapped text and optional badge.
- **unknown**: render a `.log-entry.chat-unknown` element showing the `typeLabel` (the entry's `type` field, or `"unknown"` if absent). Do NOT expose raw JSON content.

## System Event String Mapping

| subtype | text | badge |
|---|---|---|
| `session_started` | `Session started — {repo}` (repo from meta) | — |
| `prompt_injected` | `Prompt injected ({prompt_source})` | — |
| `session_ended` | `Session ended — {reason}` | gray |
| `session_verified` | `Verified — {termination_reason}` + PR chips from `prs` | green |
| `verification_failed` | `Verification failed — {error}` | red |
| `web_inject` / `web_interrupt` | `Operator {inject|interrupt}` | — |

`repo` is taken from the loaded `meta` (available in `loadDetailView`), passed into the render context.

## DOM Structure

Before (current):

```html
<div id="log-container">           <!-- monospace, white-space:pre -->
  <div class="log-entry">{"ts":...,"source":"agent",...}</div>
</div>
```

After:

```html
<div class="stream-toolbar">
  <label><input type="checkbox" id="toggle-internals"> Show internals</label>
</div>
<div id="log-container" class="chat-stream">
  <div class="log-entry chat-system"><span class="chat-pill">Session started — org/repo</span></div>
  <div class="log-entry chat-msg-agent"><div class="chat-md"><!-- rendered markdown --></div></div>
  <div class="log-entry chat-tool collapsed" data-tool-id="abc">
    <div class="chat-tool-header">Run tests <span class="collapse-icon">▼</span></div>
    <pre class="chat-tool-body">…last N lines…</pre>
    <button class="show-more-btn">Show more</button>
  </div>
  <div class="log-entry chat-permission">Waiting for approval: …</div>
  <div class="log-entry chat-internal" style="display:none">…</div>
</div>
<button id="jump-to-bottom" style="display:none">Jump to bottom ↓</button>
```

Key points:

- `#log-container` persists (id unchanged) → `waitForSelector('#log-container')` keeps working.
- Every stream element keeps `log-entry` → `.log-entry` assertions keep matching.
- Agent bubble's visible text includes the message text → `hasText:'msg-N'` keeps matching.

## CSS Changes

Remove/replace the monospace box rule:

```css
/* OLD */
#log-container{…font-family:monospace;…white-space:pre}
.log-entry{margin:0;padding:2px 0}
```

Add chat styling (dark theme, consistent with existing palette `#0d1117`, `#30363d`, `#58a6ff`):

```css
#log-container.chat-stream{background:#0d1117;border:1px solid #30363d;border-radius:8px;
  padding:12px;max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.chat-system{align-self:flex-start}
.chat-pill{display:inline-block;background:#21262d;color:#8b949e;border-radius:12px;padding:4px 10px;font-size:12px}
.chat-msg-agent{align-self:stretch;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 12px}
.chat-md{font-size:14px;line-height:1.5}
.chat-md code{font-family:monospace;background:#0d1117;padding:1px 4px;border-radius:4px}
.chat-tool{border:1px solid #30363d;border-radius:8px;overflow:hidden}
.chat-tool-header{cursor:pointer;padding:8px 12px;background:#161b22;display:flex;justify-content:space-between}
.chat-tool-body{margin:0;padding:8px 12px;font-family:monospace;font-size:12px;white-space:pre-wrap;overflow-x:auto}
.chat-tool.collapsed .chat-tool-body,.chat-tool.collapsed .show-more-btn{display:none}
.chat-permission{background:#3a2d00;border:1px solid #9e6a03;color:#e3b341;border-radius:8px;padding:10px 12px}
.chat-internal{color:#8b949e;font-size:12px}
.chat-meta-pill{display:inline-block;background:#21262d;color:#8b949e;border-radius:10px;padding:2px 8px;font-size:11px}
#jump-to-bottom{position:sticky;bottom:8px;align-self:center;background:#21262d;color:#eee;border:1px solid #30363d}
```

The existing `.log-entry{margin:0;padding:2px 0}` rule is retained (harmless), or narrowed; the chat
classes supply the real layout.

## Markdown Rendering

The agent writes markdown. To avoid a new dependency (AGENTS.md: "don't add dependencies without a
clear need"), implement a **minimal, safe inline markdown renderer** covering the common cases the
agent uses: fenced code blocks, inline code, bold/italic, links, and line breaks. The renderer MUST
HTML-escape all text first (reuse existing `escapeHtml`) and only then apply formatting, so no raw
HTML/JSON escaping is visible and no injection is possible. A heavier markdown library is out of scope
unless a follow-up item justifies it.

## Auto-scroll and Jump-to-Bottom

- On each appended element: if `ctx.autoScroll`, set `container.scrollTop = container.scrollHeight`.
- Add a `scroll` listener on `#log-container`: if the user scrolls away from the bottom (beyond a small
  threshold), set `ctx.autoScroll = false` and, when the session is active, show `#jump-to-bottom`.
  If they scroll back to the bottom, set `autoScroll = true` and hide the button.
- `#jump-to-bottom` click scrolls to bottom and re-enables auto-scroll.

For completed sessions there is no live append, but auto-scroll after the initial render batch places
the newest entry in view (matching existing behavior); the button is only relevant for live sessions.

## Integration Points in `web-ui.ts`

1. **`loadDetailView`** — replace the initial-load loop:
   - Build the toolbar (Show internals) + `#log-container` + jump button in the detail HTML.
   - Create the `RenderCtx` (container, `isActive`, `showInternals=false`, empty maps, `autoScroll=true`, `repo` from meta).
   - Iterate `data.entries` calling `renderStreamEntry(parseStreamEntry(entry), ctx)`.
   - Wire the "Show internals" toggle to flip `ctx.showInternals` and toggle `display` on `.chat-internal`.
   - Wire the scroll listener + jump button.
   - Keep SSE start (`connectSSE(sessionId, 0)`) and control wiring unchanged.
2. **`connectSSE` → message handler** — replace the `appendLogEntry(currentData)` call with
   `renderStreamEntry(parseStreamEntry(JSON.parse(currentData)), ctx)`. The `session_ended` special-case
   (set `ended`, "Stream ended", `hideControls()`) is unchanged. The `ctx` must be reachable from the
   SSE handler; store it on the module-level `activeSSE` object (e.g. `activeSSE.renderCtx`) so it survives
   reconnects within the same detail mount.
3. **`appendLogEntry`** — removed and replaced by `renderStreamEntry`. Its name is internal; no test
   references the function directly (tests assert DOM, not JS symbols).

## Preserved / Untouched

- `renderDetailMeta`, controls (`renderControls`, send/stop/kill wiring), SSE reconnect
  (`scheduleReconnect`, de-dup via `lastId`, `Last-Event-ID`), visibility/online reconnect handlers.
- HTTP endpoints and server code — no changes.

## Test Impact Analysis

| Test file | Assertion today | Impact |
|---|---|---|
| `sse-render.spec.ts` | waits `#log-container`; `.log-entry` `hasText:'msg-N'`; order by `msg-N`; `session_ended` → "Stream ended" + controls hidden; auto-scroll on `#log-container` | **Passes unchanged** if agent bubbles keep `.log-entry` + visible text, ordering preserved, and auto-scroll preserved. The "multiple events … ID order" test appends 5 separate `agent_message` entries with no interrupt — note these reassemble into ONE bubble. See below. |
| `sse-hardening.spec.ts` | `.log-entry` `hasText:'online-3'` / `after-online`; reconnect `Last-Event-ID` | Passes if agent text is in `.log-entry`. Reconnect logic unchanged. |
| `sse-reconnect.spec.ts` | `.log-entry` `hasText:'entry-2'/'msg-5'`; counts `#log-container .log-entry` for `msg-\d+`, expects each id once | **Selector-sensitive:** counts one `.log-entry` per appended `msg-N`. Reassembly would collapse them into one bubble → count breaks. See mitigation. |
| `visibility-reconnect.spec.ts` | `.log-entry` `hasText:'vis-N'` / `after-reconnect` | Same reassembly consideration as above (asserts visibility, not count) — passes if text present. |
| `network-repro.spec.ts` | waits `#log-container`; seeds `tool_call` entries | Passes; `#log-container` preserved, tool_call renders as a card (still `.log-entry`). |
| `detail-view.spec.ts` | metadata header, routing, not-found, back | **Passes unchanged** — header untouched. |

### Reassembly vs. per-entry-count tests (mitigation)

`sse-reconnect.spec.ts` and the ID-order test in `sse-render.spec.ts` append multiple separate
`agent_message` entries and expect one rendered element per entry. Full contiguous reassembly (Req 3)
would merge them into a single bubble, breaking the "each `msg-N` appears once as a `.log-entry`" count.

Resolution: **reassembly applies to true streaming chunks (`agent_message_chunk` via the
`session/update` envelope), not to the legacy flattened `agent_message` entries used by the harness.**
Legacy `agent_message` entries each render as their own `.log-entry.chat-msg-agent` element (one per
entry), preserving per-entry counting and ordering. Real Kiro sessions emit `agent_message_chunk` and
get reassembled. This satisfies both Req 3 (chunk reassembly for real streams) and Req 9 (test
compatibility) without editing those SSE tests.

If the harness is later updated to emit `agent_message_chunk`, the corresponding tests would move to
asserting reassembled bubble text (a documented, intentional selector update per Req 9.7), but that is
not required by this feature.

## Verification Strategy

- **Tier 1 (unit/property):** test `parseStreamEntry` for every taxonomy row and legacy shape; property
  test that a run of `agent_message_chunk` fragments reassembles to the exact concatenation of inputs
  (fast-check, ≥100 iterations); test system-string mapping and badge selection.
- **Tier 2 (browser, Playwright):** the existing `test/browser` suite is the behavioral gate. Run the full
  suite; confirm `sse-render`, `sse-reconnect`, `sse-hardening`, `visibility-reconnect`, `network-repro`,
  and `detail-view` pass. Add a focused spec asserting: an agent bubble renders markdown (no visible JSON),
  a `tool_call` renders a collapsible `.chat-tool` card (collapsed on completed sessions), a
  `_kiro.dev/metadata` entry is hidden until "Show internals" is toggled, and a `session/request_permission`
  entry renders a `.chat-permission` card on an active session.
- `npm run typecheck` and `npm test` must pass before push (AGENTS.md).

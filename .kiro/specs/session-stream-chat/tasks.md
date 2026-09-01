# Tasks: Session Stream Chat View

All work is in `src/web-ui.ts` (inlined browser script + CSS) plus new Tier 1 unit tests and
Tier 2 browser tests. No backend changes.

## Task 1: Add `parseStreamEntry` pure function
- [x] Add an exported pure function `parseStreamEntry(raw)` to the inlined script that normalizes a stream entry into the tagged union from design (`system`, `agent_chunk` [streaming:true], `agent_message` [streaming:false], `tool_call`, `tool_update`, `permission`, `internal`, `unknown`)
- [x] Implement router dispatch: map `session_started`, `prompt_injected`, `session_ended`, `session_verified`, `verification_failed`, `web_inject`, `web_interrupt` to `system` with human text + badge color
- [x] Implement agent `session/update` dispatch on `update.sessionUpdate`: `agent_message_chunk` → `agent_chunk`, `tool_call` → `tool_call`, `tool_call_update` → `tool_update` (concat `update.content[].content.text`)
- [x] Implement `session/request_permission` → `permission` (`toolCall.title`)
- [x] Implement `_kiro.dev/*` → `internal` (subtype preserved)
- [x] Implement legacy fallbacks: `type === 'agent_message'` (top-level `content`) → `agent_message` (`streaming: false`); bare `type === 'tool_call'` → `tool_call` with `toolCallId: null` (renderer assigns synthetic id from `ctx.entryCount`)
- [x] Fall back to `unknown` with `typeLabel = raw.type || 'unknown'` for unrecognized shapes; never throw, never expose `JSON.stringify(raw)`

**Requirements**: 1.2, 1.3, 2.1, 3.2, 4.1, 4.2, 5.1, 7.1

## Task 1b: Tier 1 tests for `parseStreamEntry`
- [x] Unit test each taxonomy row maps to the correct `kind`/fields (router, agent stream, permission, internal)
- [x] Unit test legacy `agent_message` and bare `tool_call` fallbacks
- [x] Unit test unrecognized entry → `unknown`, no throw
- [x] Property test (fast-check, ≥100 iters): a sequence of `agent_message_chunk` fragments, when concatenated by the reassembly rule, equals the raw concatenation of their `text` values

**Requirements**: 1.3, 3.1, 3.2

## Task 2: Replace `#log-container` CSS with chat styles
- [x] Remove the monospace `#log-container{…monospace;white-space:pre}` rule and repurpose `#log-container.chat-stream` as a flex column scroll container
- [x] Add `.chat-system`/`.chat-pill`, `.chat-msg-agent`/`.chat-md`, `.chat-tool`/`.chat-tool-header`/`.chat-tool-body`, `.chat-permission`, `.chat-internal`/`.chat-meta-pill`, `.chat-unknown`, `#jump-to-bottom`, `.stream-toolbar` styles per design
- [x] Keep a (narrowed) `.log-entry` rule so the class remains valid
- [x] Verify colors/spacing match the existing dark palette (`#0d1117`, `#161b22`, `#30363d`, `#58a6ff`, warning `#9e6a03`)

**Requirements**: 1.1, 2.1, 2.2, 2.3, 2.4, 2.5

## Task 3: Add minimal safe markdown renderer
- [x] Add a `renderMarkdown(text)` helper that HTML-escapes first (reuse `escapeHtml`), then applies fenced code blocks, inline code, bold, italic, links, and line breaks. Rendered links SHALL only emit `href` with `http:`, `https:`, or `mailto:` schemes — any other scheme (e.g. `javascript:`) SHALL be replaced with `#`
- [x] Ensure no raw HTML/JSON escaping artifacts are visible and no injection is possible (escape-then-format order)
- [x] Do NOT add a new dependency

**Requirements**: 1.4, 2.2, 3.5

## Task 4: Implement `renderStreamEntry` with render context
**Depends on**: Task 1, Task 3
- [x] Define the `RenderCtx` shape (container, `isActive`, `showInternals`, `openBubble`, `toolCards` map, `autoScroll`, `repo`, `entryCount: number` — monotonic counter incremented on each `renderStreamEntry` call, used as unique suffix for legacy synthetic tool ids)
- [x] Implement `renderStreamEntry(parsed, ctx)` dispatching per `kind`, each producing/updating a `.log-entry` element with its chat-specific class
- [x] Agent chunk reassembly: append to `ctx.openBubble` (re-render markdown) when open; else create a new `.chat-msg-agent` bubble and set `openBubble`
- [x] Close the open bubble (`openBubble = null`) before rendering any non-`agent_chunk` kind (including `agent_message`)
- [x] **agent_chunk** (`streaming: true`): if `openBubble` is set, append text to it and re-render markdown; else create a new `.log-entry.chat-msg-agent` bubble with `data-bubble-open="true"` and set `openBubble`. When a bubble is closed (any non-chunk entry), remove `data-bubble-open` attribute. Never set `agent_message` entries as `openBubble`.
- [x] **agent_message** (`streaming: false`): always creates a new independent `.log-entry.chat-msg-agent` bubble; does NOT set `openBubble`; closes any open bubble first
- [x] System pills render mapped text + badge; `session_verified` shows PR chips from `prs`
- [x] `unknown` renders a `.log-entry.chat-unknown` element showing `typeLabel` (entry `type` field or `"unknown"`); never expose raw JSON
- [x] Auto-scroll to bottom after append when `ctx.autoScroll` is true

**Requirements**: 1.1, 1.2, 2.1, 2.2, 3.1, 3.3, 3.4, 6.3, 9.2, 9.3, 9.4, 9.5

## Task 5: Tool-call collapsible cards
**Depends on**: Task 4
- [x] `tool_call` creates a `.chat-tool` card keyed by `toolCallId` (or `'legacy-' + ctx.entryCount` when `toolCallId === null`), header = first line of `title`, registered in `ctx.toolCards`
- [x] `tool_update` appends `text` lines to the matching card's body; create the card lazily if the id is unknown
- [x] Body shows last 20 lines by default with a "Show more" button that expands full output
- [x] Collapsed by default on terminal sessions; latest tool card expanded by default on active sessions (previous collapses)
- [x] Header click toggles expand/collapse

**Requirements**: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7

## Task 6: Permission and internal rendering
**Depends on**: Task 4
- [x] `permission` renders a yellow `.chat-permission` card "Waiting for approval: {title}"; muted style when session is terminal
- [x] `internal` renders `.chat-internal` hidden by default; `_kiro.dev/metadata` → gray `.chat-meta-pill` (context% + turn duration); others → compact row
- [x] Add the "Show internals" toggle in a `.stream-toolbar`; toggling flips `ctx.showInternals` and shows/hides `.chat-internal` elements

**Requirements**: 2.4, 2.5, 5.1, 5.2, 5.3, 7.1, 7.2, 7.3, 7.4

## Task 7: Wire loadDetailView, SSE path, and auto-scroll to the new renderer
**Depends on**: Task 4, Task 5, Task 6
- [x] In `loadDetailView`, build the `.stream-toolbar` + `#log-container.chat-stream` + `#jump-to-bottom` markup
- [x] Create the `RenderCtx` (repo/`isActive` from `meta`, `entryCount: 0`) and store it on `activeSSE` so the SSE handler and reconnects reuse it
- [x] Replace the initial-load loop with `data.entries.forEach(e => renderStreamEntry(parseStreamEntry(e), ctx))`
- [x] Replace the `appendLogEntry(currentData)` call in the SSE message handler with `renderStreamEntry(parseStreamEntry(JSON.parse(currentData)), ctx)`; remove the old `appendLogEntry`
- [x] Preserve the `session_ended` special-case (set `ended`, "Stream ended", `hideControls()`)
- [x] Leave `connectSSE`, `scheduleReconnect`, de-dup, `Last-Event-ID`, visibility/online handlers, `renderDetailMeta`, and control wiring untouched
- [x] Add a `scroll` listener on `#log-container` that sets `ctx.autoScroll = false` and shows `#jump-to-bottom` (active sessions) when the user scrolls up past a threshold; re-enables and hides when back at bottom
- [x] `#jump-to-bottom` click scrolls to bottom and re-enables auto-scroll
- [x] Confirm the existing auto-scroll-on-new-entry behavior (Req 9.5) still holds for the `sse-render` auto-scroll test

**Requirements**: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 8.1, 8.2, 8.3, 8.4, 9.1, 9.5

## Task 8: Tier 2 browser tests for chat rendering
**Depends on**: Task 7
- [ ] Add a spec asserting an agent message renders markdown in `.chat-msg-agent` with no visible JSON/HTML escaping
- [ ] Assert a `tool_call` (+ `tool_call_update`) renders a `.chat-tool` card, collapsed by default on a completed session, expandable on header click
- [ ] Assert a `_kiro.dev/metadata` entry is hidden until "Show internals" is toggled, then shows a `.chat-meta-pill`
- [ ] Assert a `session/request_permission` entry renders a `.chat-permission` card on an active session
- [ ] Assert `#jump-to-bottom` appears after scrolling up on a live session and returns to bottom on click

**Requirements**: 1.4, 2.2, 2.3, 4.4, 4.7, 5.1, 6.4, 7.2, 7.3

## Task 9: Regression-verify existing browser tests + selector updates
**Depends on**: Task 7, Task 8
- [ ] Run the full `test/browser` suite; confirm `detail-view`, `sse-render`, `sse-hardening`, `sse-reconnect`, `visibility-reconnect`, `network-repro` pass
- [ ] Confirm legacy `agent_message` entries render one `.log-entry.chat-msg-agent` each so `sse-reconnect`'s per-`msg-N` count and `sse-render`'s ID-order assertions still hold (no test edits expected here per design resolution)
- [ ] Only where a test asserts a DOM shape that legitimately changed (e.g. verbatim raw JSON in `.log-entry`), update the selector/assertion to the new chat rendering — do not delete tests to make them pass
- [ ] Run `npm run typecheck` and `npm test`; both must pass before push

**Requirements**: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7

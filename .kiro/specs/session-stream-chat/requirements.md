# Requirements: Session Stream Chat View

This document specifies the requirements for replacing the raw NDJSON scroll box in the
session detail view with a chat-style conversation UI that makes `stream.log` human-readable.

All changes are frontend-only, living in `src/web-ui.ts`. No backend, routing, auth, or SSE
transport changes are in scope. The `/sessions/{id}/stream` and `/sessions/{id}?lines=N`
endpoints are unchanged; only the rendering of their payload changes.

## Background: Stream Entry Taxonomy

Every `stream.log` entry is a JSON object with `ts` (ISO timestamp), `source`
(`"router"` | `"agent"`), and `type` (string). The renderer must handle the full taxonomy below.

### Router events (`source: "router"`)

| `type` | Key fields | Meaning |
|---|---|---|
| `session_started` | `original_prompt: string` | Session initialized |
| `prompt_injected` | `prompt_source: string` | A prompt was sent to the agent |
| `session_ended` | `reason: string` | Terminal event |
| `session_verified` | `termination_reason: string`, `prs: [...]` | GitHub verification succeeded |
| `verification_failed` | `error: string` | GitHub verification failed |
| `web_inject` / `web_interrupt` | injection metadata | Operator actions (rendered as router/system) |

### Agent streaming (`source: "agent"`, `type: "session/update"`)

Each carries an `update` object with `update.sessionUpdate` discriminating the sub-type:

| `update.sessionUpdate` | Key fields | Meaning |
|---|---|---|
| `agent_message_chunk` | `update.content.text: string` | A streaming text fragment |
| `tool_call` | `update.toolCallId`, `update.title: string` | Tool invocation start |
| `tool_call_update` | `update.toolCallId`, `update.content[].content.text` | Tool output fragment(s) |

### Agent tool permissions (`source: "agent"`, `type: "session/request_permission"`)

| Key fields | Meaning |
|---|---|
| `toolCall.title: string`, `options: [...]` | A tool is requesting operator approval |

### Kiro internal (`source: "agent"`, `type` begins with `_kiro.dev/`)

| `type` | Meaning |
|---|---|
| `_kiro.dev/metadata` | Context-usage percentage, turn duration |
| `_kiro.dev/session/update` | Subagent / session metadata |
| `_kiro.dev/mcp/server_initialized` | Infrastructure noise |
| `_kiro.dev/commands/available` | Infrastructure noise |
| `_kiro.dev/subagent/list_update` | Infrastructure noise |

### Legacy / simplified entries

The existing test harness and older sessions emit flattened entries that do not follow the
`session/update` envelope, e.g. `{ source: "agent", type: "agent_message", content: "..." }`
and `{ source: "agent", type: "tool_call" }`. The renderer MUST tolerate these shapes so that
existing seeded fixtures and browser tests continue to render.

## Requirement 1: Chat-Style Rendering Replaces Raw JSON

### User Story
As an operator reviewing a session, I want the stream rendered as a readable conversation with
visual hierarchy, so I do not have to read raw JSON or paste it into an LLM to understand it.

### Acceptance Criteria
1. Opening a completed session SHALL render each `stream.log` entry as a styled chat element, not as a raw JSON string.
2. The renderer SHALL dispatch on `source`, `type`, and (for agent stream updates) `update.sessionUpdate` to select a per-type visual component.
3. Any entry whose shape is unrecognized SHALL render as a single-line fallback element showing the entry's `type` field (or `"unknown"` if absent), rather than throwing, breaking the stream, or exposing raw JSON content.
4. Agent text SHALL be displayed as rendered content with no visible HTML/JSON escaping artifacts (no literal `{`, `"text":`, `&lt;`, etc. in normal reading flow).

## Requirement 2: Four (Plus Internal) Visual Speakers

### User Story
As an operator, I want distinct visual treatment for each kind of stream participant so I can
scan a long session and immediately tell system events from agent output from tool activity.

### Acceptance Criteria
1. **Agent Router (system)** entries SHALL render as left-aligned system pills/badges:
   - `session_started` → "Session started — {repo}"
   - `prompt_injected` → "Prompt injected ({prompt_source})"
   - `session_ended` → "Session ended — {reason}"
   - `session_verified` / `verification_failed` → a verification badge (green for verified, red/yellow for failed) with the termination reason or error text.
2. **Agent message** entries (`agent_message_chunk`, legacy `agent_message`) SHALL render as a prominent message bubble with markdown rendered.
3. **Tool call** entries (`tool_call` + associated `tool_call_update`) SHALL render as a collapsible, code-block-styled card.
4. **Permission request** entries (`session/request_permission`) SHALL render as a yellow warning card reading "Waiting for approval: {toolCall.title}".
5. **Kiro internal** entries (`_kiro.dev/*`) SHALL be hidden by default and revealed via a toggle (see Requirement 7).

## Requirement 3: Agent Message Chunk Reassembly

### User Story
As an operator, I want streamed agent text shown as coherent paragraphs, not one bubble per
token fragment, so agent messages read naturally.

### Acceptance Criteria
1. A contiguous run of `agent_message_chunk` entries (`streaming: true`) uninterrupted by any non-chunk entry SHALL be concatenated in stream order into a single message bubble. Legacy `agent_message` entries (`streaming: false`) do NOT participate in this reassembly — each renders as its own independent bubble and does NOT open or continue a reassembly sequence.
2. Concatenation SHALL join `update.content.text` (or legacy `content`) fragments with no added separators, reproducing the original agent text.
3. When a non-chunk entry (tool call, permission request, router event, internal event, or legacy `agent_message`) appears, the current reassembly bubble SHALL be considered closed; the next `agent_message_chunk` after that SHALL start a NEW bubble.
4. During live streaming, a new `agent_message_chunk` that belongs to the currently open bubble (the last bubble element in the chat container, if it has `data-bubble-open="true"`) SHALL append to that same bubble's rendered text rather than creating a new element.
5. The assembled bubble text SHALL be rendered as markdown. The markdown renderer SHALL HTML-escape input first and apply formatting second (escape-then-format). Rendered markdown links SHALL only emit `href` values with `http:`, `https:`, or `mailto:` schemes — any other scheme (including `javascript:`) SHALL be replaced with `#` to prevent XSS.
6. N in "last N lines" for tool card bodies (Req 4.6) SHALL be 20 lines.

## Requirement 4: Tool Call Collapsible Cards

### User Story
As an operator, I want tool invocations grouped into one collapsible card each, so tool output
does not flood the conversation but is available on demand.

### Acceptance Criteria
1. A `tool_call` entry SHALL create a tool card keyed by `update.toolCallId`, with a header showing the first line of `update.title`.
2. Subsequent `tool_call_update` entries with the same `toolCallId` SHALL append their `update.content[].content.text` fragments to that card's body.
3. A `tool_call_update` whose `toolCallId` has no preceding `tool_call` SHALL create a card lazily (tolerating out-of-order or missing starts).
4. Tool cards SHALL be collapsed by default when the session is completed/terminal.
5. The tool card with the highest sequence index (the last one appended) SHALL be expanded by default when the session is active.
6. Card bodies SHALL show the last N lines by default with a "Show more" affordance to expand the full accumulated output.
7. Clicking a tool card header SHALL toggle its expanded/collapsed state.

## Requirement 5: Permission Request Cards

### User Story
As an operator, I want a clear, prominent prompt when the agent is blocked waiting for my
approval, so I know a decision is required.

### Acceptance Criteria
1. A `session/request_permission` entry SHALL render as a yellow warning card reading "Waiting for approval: {toolCall.title}".
2. The permission card SHALL be visually prominent (yellow/warning styling) while the session is active.
3. Permission cards from historical (completed) sessions MAY render in a muted/resolved style; they SHALL NOT present as an actionable pending request on a terminal session.

## Requirement 6: Loading and Live Behavior

### User Story
As an operator, I want completed sessions to render fully at once and active sessions to update
live, so both retrospective review and live monitoring work.

### Acceptance Criteria
1. For completed sessions, the full entry set from `GET /sessions/{id}?lines=N` SHALL be rendered in one pass on load.
2. For active sessions, new entries delivered over the existing SSE connection SHALL be appended in real time using the same per-type renderers.
3. The view SHALL auto-scroll to the bottom when new entries arrive, UNLESS the user has manually scrolled up.
4. When the user has scrolled up on a live session, a "Jump to bottom" control SHALL appear; activating it SHALL scroll to the newest entry and re-enable auto-scroll.
5. A `session_ended` event received over SSE SHALL still hide the controls and set the SSE status to "Stream ended" (existing behavior preserved).
6. Existing SSE reconnect, de-duplication by event ID, `Last-Event-ID` resume, and visibility/online reconnect behavior SHALL be unchanged.

## Requirement 7: Kiro Internal Toggle

### User Story
As an operator, I want infrastructure noise hidden by default but available when I need to debug,
so the conversation stays clean without losing information.

### Acceptance Criteria
1. `_kiro.dev/*` entries SHALL be hidden by default.
2. A "Show internals" toggle SHALL reveal/hide all `_kiro.dev/*` entries.
3. `_kiro.dev/metadata` entries, when shown, SHALL render as a small gray pill displaying context-usage percentage and turn duration.
4. Other `_kiro.dev/*` entries, when shown, SHALL render as compact collapsed rows.

## Requirement 8: Preserved Behavior (Out of Scope for Change)

### Acceptance Criteria
1. The session metadata header (ID, created, ended, reason, PR links) rendered by `renderDetailMeta` SHALL be unchanged.
2. Routing, auth header handling, and SSE reconnect logic (`connectSSE`, `scheduleReconnect`, visibility/online handlers) SHALL be unchanged.
3. The `/sessions/{id}/stream` and `/sessions/{id}` HTTP endpoints SHALL be unchanged.
4. The prompt inject / stop / kill controls and their wiring SHALL be unchanged.

## Requirement 9: DOM Structure and Test Compatibility

### User Story
As a test author, I need the existing browser tests for streaming and the detail view to keep
passing (with selector updates only where the DOM legitimately changes), so the migration is safe.

### Acceptance Criteria
1. The container element SHALL remain identified as `#log-container` (repurposed as the chat scroll container) so `page.waitForSelector('#log-container')` continues to work in `sse-render`, `sse-hardening`, `sse-reconnect`, `visibility-reconnect`, and `network-repro` specs.
2. Each rendered top-level stream element SHALL retain the class `log-entry` (in addition to any new chat-specific classes) so existing assertions of the form `.log-entry` filtered by text content continue to match.
3. The visible text of an agent message element SHALL contain the agent's message text (e.g. legacy `content` value) so tests locating `.log-entry` by `hasText: 'msg-N'` still match.
4. Per-entry ordering by event ID (Requirement in `sse-render`) SHALL be preserved: appended entries render in monotonically increasing ID order.
5. Auto-scroll-to-bottom behavior on `#log-container` SHALL be preserved for the auto-scroll test.
6. `session_ended` SHALL continue to set `#sse-status` to "Stream ended" and hide `.controls`.
7. Any test that asserts a DOM shape that legitimately changes (e.g. that a raw JSON string appears verbatim in `.log-entry`) SHALL be updated to assert the new chat rendering instead. No test SHALL be deleted merely to make it pass.

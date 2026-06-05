# Implementation Plan: Web Server Control Plane

## Overview

This plan implements a localhost-bound HTTP control plane for the agent-router daemon, exposing session observability (list, detail, live SSE stream) and control (inject, interrupt, kill) via REST endpoints plus a minimal single-page web UI. The implementation is ordered to respect dependency chains: foundation types and config first, then core module modifications (turn queue, ACP cancel), then the web layer (auth, SSE broker, routes), then the UI, and finally shutdown integration.

## Tasks

- [ ] 1. Foundation: Type extensions and config changes
  - [ ] 1.1 Extend PromptSource and TerminationReason unions in session-files.ts
    - Add `'web'` to the `PromptSource` union type
    - Replace `'terminated'` with `'terminated_cli'` and add `'terminated_web'` to the `termination_reason` field in `SessionMeta`
    - Add read-time normalization: if meta.json contains `"terminated"`, treat as `"terminated_cli"`
    - Update all exhaustiveness checks across the codebase that switch on these unions
    - _Requirements: 8.12, 10.10, 10.11_

  - [ ] 1.2 Add new config keys and validation to config.ts
    - Add `controlPort` (integer 1–65535, default 3100, must not equal `port`)
    - Add `bindPublic` (boolean, default false)
    - Add `shutdownDrainSeconds` (positive integer, default 60)
    - Add `trustedProxy` object with `identityHeader`, `proofHeader`, `proofSecret` fields (all required if object present)
    - Add `allowedEmails` (string array, each non-empty, ≤254 chars)
    - Validate `trustedProxy.proofSecret` file exists and is readable at startup; FatalError if not
    - Warn (but continue) if `proofSecret` file permissions are more permissive than 0600
    - FatalError if `trustedProxy` present but missing any of the three required fields
    - _Requirements: 1.1, 1.2, 1.3, 3.1, 3.4, 3.5, 3.6, 13.4_

  - [ ]* 1.3 Write property tests for config validation
    - Test port conflict detection (`controlPort` === `port` → FatalError)
    - Test `trustedProxy` incomplete config → FatalError
    - Test `allowedEmails` validation (non-empty strings, ≤254 chars)
    - Test file: `test/tier1/web-server/config-validation.test.ts`
    - _Requirements: 1.3, 3.4, 3.5, 13.4_

- [ ] 2. Core modification: Per-session turn queue in session-mgr.ts
  - [ ] 2.1 Implement TurnQueue and integrate into SessionHandle
    - Create `createTurnQueue(acp, sessionFiles, sessionId, log)` function
    - `enqueue()` returns a Promise that resolves when `sendPrompt` is CALLED (prompt dispatched to ACP), NOT when the turn completes. The web inject route calls `.catch()` on the returned promise (fire-and-forget) and returns 202 immediately. Promise rejection triggers `prompt_injection_failed` logging.
    - Add `turnQueue: TurnQueue` to `SessionHandle` interface
    - Wire turn queue creation into `createSession` (initial prompt occupies queue from start)
    - Modify `injectPrompt` to delegate to `handle.turnQueue.enqueue(prompt, source)` instead of calling `acp.sendPrompt` directly
    - Ensure the webhook/event-queue path also uses the turn queue (harden against latent race)
    - Preserve post-turn `verify()` side effect for all prompt sources
    - Add `drain()` to turn queue for shutdown support
    - _Requirements: 8.2, 8.3, 8.4, 8.5_

  - [ ] 2.2 Write property test for turn queue serialization (Property 24)
    - **Property 24: Turn Queue Serialization**
    - Verify at most one `sendPrompt` is in-flight at a time with concurrent enqueues
    - Verify FIFO ordering is preserved
    - Test file: `test/tier1/web-server/turn-queue.test.ts`
    - **Validates: Requirements 8.2, 8.4**

  - [ ] 2.3 Extend terminateSession signature with reason and actor parameters
    - Change `terminateSession(sessionId)` to `terminateSession(sessionId, reason?, actor?)`
    - Default `reason` to `'terminated_cli'`, default `actor` to `'local'`
    - Use the provided `reason` when writing `termination_reason` to meta.json
    - Include `actor` field in the `session_ended` stream.log entry
    - Update the CLI server call site to pass `'terminated_cli'`
    - _Requirements: 10.2, 10.3, 10.11_

- [ ] 3. Core modification: ACP cancel() method
  - [ ] 3.1 Add cancel() method to ACPClient interface in acp.ts
    - Add `cancel(): void` to the `ACPClient` interface
    - Implement in `createACPClientFromStreams`: write `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<acpSessionId>"}}` (notification — no `id` field) to stdin
    - Implement in `spawnACPClient` (inherits from createACPClientFromStreams)
    - Non-blocking `stream.write()` — fire-and-forget, no response expected
    - _Requirements: 9.1, 9.9_

  - [ ]* 3.2 Write unit test for cancel() method
    - Verify cancel writes correct JSON-RPC notification to stdin
    - Verify cancel is a no-op when session is idle (does not throw)
    - Test file: `test/tier1/web-server/acp-cancel.test.ts`
    - _Requirements: 9.9, 9.10_

- [ ] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Authentication middleware: web-auth.ts
  - [ ] 5.1 Create web-auth.ts with createAuthMiddleware and createWriteGuard
    - Implement `createAuthMiddleware(config: AuthConfig)` — Hono middleware factory
    - Auth resolution order: (1) trusted-proxy proof → identity extraction → validate email; (2) bearer token → timing-safe compare; (3) reject 401
    - Handle edge case: valid proof + malformed email → 401 with code `"invalid_identity"`
    - Handle edge case: proof present but invalid → fall through to bearer (no reject)
    - Set `c.set('auth', AuthResult)` on success with `{ authenticated: true, actor, method }`
    - Use `crypto.timingSafeEqual` for both bearer and proof comparisons
    - Implement `createWriteGuard(allowedEmails?)` — rejects 403 if proxy-auth user not in allowlist; bearer-token auth always passes
    - Case-insensitive email matching for allowlist
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.2, 3.3, 3.7, 3.8, 13.1, 13.2, 13.3_

  - [ ] 5.2 Write property tests for auth middleware (Properties 1–4)
    - **Property 1: Bearer Authentication Correctness**
    - **Property 2: Authentication Rejection**
    - **Property 3: Proof-Before-Trust (Proxy Auth)**
    - **Property 4: Write Allowlist Enforcement**
    - Test as pure functions of (headers, config) → AuthResult
    - Test file: `test/tier1/web-server/web-auth.test.ts`
    - **Validates: Requirements 2.1, 2.2, 2.3, 3.2, 3.3, 13.1, 13.2**

- [ ] 6. SSE broker: sse-broker.ts
  - [ ] 6.1 Implement createSSEBroker with two-phase subscribe and fan-out
    - Create `createSSEBroker(deps)` function
    - Export pure helper functions for testability: `splitCompleteLines(chunk, residual)` → returns `{ lines: string[], residual: string }`, `buildLineOffsetIndex(lines)` → returns offset array, `seekToLine(offsets, lineNumber)` → returns byte offset
    - Implement two-phase subscribe: Phase 1 (backlog replay from byte 0 or Last-Event-ID offset) → Phase 2 (live tail via shared poll timer)
    - One shared `setInterval` per active session (250ms default), not per client
    - Partial-line buffering: split on `\n`, retain trailing fragment for next poll
    - Line-number ↔ offset mapping for efficient Last-Event-ID resumption
    - Per-session `lineOffsets` array for O(1) seek on reconnect
    - Session-ended detection: emit `event: session_ended` and close all client streams
    - Single global heartbeat timer (30s) writing `:heartbeat\n\n` to all open streams
    - Handle already-terminal sessions: full replay + immediate close, no poll timer
    - Client deduplication: `lineNumber > client.cursor` before emitting
    - Clean up poll timer when last client disconnects from a session
    - `shutdown()` method to clear all timers and close all streams
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.8, 6.9, 6.10_

  - [ ] 6.2 Write property tests for SSE broker pure logic (Properties 11, 12)
    - **Property 11: SSE Event IDs Are Monotonic**
    - **Property 12: SSE Last-Event-ID Resumption**
    - Test `splitCompleteLines`, `buildLineOffsetIndex`, and `seekToLine` as pure functions
    - Test line-number extraction and offset-mapping correctness
    - Test file: `test/tier1/web-server/sse-broker.test.ts`
    - **Validates: Requirements 6.2, 6.10**

- [ ] 7. Route handlers: web-routes.ts
  - [ ] 7.1 Create web-routes.ts with session listing and detail endpoints
    - Implement `GET /sessions` — filter by `status`, `since`, `limit` (default 50, max 500); return session summaries sorted by `created_at` descending
    - Implement `GET /sessions/:id` — return `{ meta, entries, skipped_lines }`; tail `lines` param (default 200, max 2000)
    - Validate query parameters: 400 for invalid values
    - Skip malformed JSON lines in stream.log and report `skipped_lines` count
    - UUID validation is handled by middleware (task 9.1) — do NOT re-validate in handlers
    - _Requirements: 4.1–4.7, 5.1–5.7_

  - [ ]* 7.2 Write property tests for session listing and detail (Properties 5, 7, 8, 9, 10)
    - **Property 5: UUID Path Parameter Validation**
    - **Property 7: Session Listing Filter Invariants**
    - **Property 8: Session Summary Completeness**
    - **Property 9: Detail Entries Are Chronological**
    - **Property 10: Detail Tail Correctness**
    - Test as pure filter/sort/tail functions
    - Test file: `test/tier1/web-server/session-listing.test.ts` and `test/tier1/web-server/session-detail.test.ts`
    - **Validates: Requirements 4.1–4.5, 5.2, 5.4, 5.6**

  - [ ] 7.3 Add SSE stream endpoint to web-routes.ts
    - Implement `GET /sessions/:id/stream` — delegate to SSE broker
    - Validate session existence before opening SSE connection
    - Return appropriate SSE content-type headers
    - Handle `Last-Event-ID` request header for resumption
    - UUID validation is handled by middleware — do NOT re-validate in handler
    - _Requirements: 6.1, 6.6, 6.7, 6.10_

  - [ ] 7.4a Add inject endpoint: POST /sessions/:id/inject
    - Validate prompt (1–10000 chars trimmed, non-whitespace-only)
    - Fire-and-forget enqueue to turn queue, return 202 with `{ "accepted": true }`
    - Check session exists (404), active on disk (409 `session_not_active`), live handle in registry (409 `session_not_resident`)
    - Check `shuttingDown()` flag — return 503 if draining
    - If stream.log write fails for Actor_Log, reject with 500 code `"logging_failed"` (Req 12.5)
    - UUID validation is handled by middleware — do NOT re-validate in handler
    - _Requirements: 8.1–8.11, 12.1–12.5, 15.1_

  - [ ] 7.4b Add interrupt endpoint: POST /sessions/:id/interrupt
    - Call `acp.cancel()`, append `web_interrupt` stream entry with actor
    - Return 200 with `{ "ok": true }`
    - Idle session: cancel() is a no-op, still returns 200
    - Check session exists (404), active on disk (409), live handle (409 `session_not_resident`)
    - Check `shuttingDown()` flag — return 503 if draining
    - If stream.log write fails for Actor_Log, reject with 500 code `"logging_failed"` (Req 12.5)
    - UUID validation is handled by middleware — do NOT re-validate in handler
    - _Requirements: 9.1–9.10, 12.1–12.5, 15.1_

  - [ ] 7.4c Add kill endpoint: POST /sessions/:id/kill
    - Delegate to `terminateSession(id, 'terminated_web', actor)` with 10s `Promise.race`
    - Return 200 or 502 `"termination_timeout"` on timeout
    - Residual state on 502: `terminateSession` continues running, writes terminal meta within ~5s (SIGKILL fallback)
    - Check session exists (404), active on disk (409), live handle (409 `session_not_resident`)
    - Check `shuttingDown()` flag — return 503 if draining
    - If stream.log write fails for Actor_Log, reject with 500 code `"logging_failed"` (Req 12.5)
    - UUID validation is handled by middleware — do NOT re-validate in handler
    - _Requirements: 10.1–10.11, 12.1–12.5, 15.1_

  - [ ]* 7.5 Write property tests for request hygiene (Properties 15, 22, 23)
    - **Property 15: Invalid Prompt Rejection**
    - **Property 22: Request Body Size Enforcement**
    - **Property 23: Content-Type Enforcement**
    - Test prompt validation as pure function
    - Test file: `test/tier1/web-server/request-hygiene.test.ts`
    - **Validates: Requirements 8.7, 8.8, 16.1, 16.2**

- [ ] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Web server factory and request hygiene: web-server.ts
  - [ ] 9.1 Create web-server.ts with createWebApp and startWebServer
    - Implement `createWebApp(deps)` — Hono app factory that mounts auth middleware, write guard, body limit (64KB), content-type validation, UUID validation, and routes
    - Middleware chain order: BodyLimit → ContentType (POST only) → UUID validation → Auth → WriteGuard → Handler
    - UUID `:id` validation is ONLY in this middleware (regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`) — handlers do NOT re-validate
    - Implement `startWebServer(app, config)` — bind to 127.0.0.1 or 0.0.0.0 based on `bindPublic`
    - Detect port conflicts with webhook server `port` (FatalError)
    - Handle bind failure (FatalError with address and port in message)
    - Use Hono's `bodyLimit` middleware with `maxSize: 65536`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 16.1, 16.2, 16.3, 16.4_

- [ ] 10. Static Web UI
  - [ ] 10.1a Create src/ui/logic.ts — pure ESM browser+Node importable logic
    - SSE event merge/dedup by `id` field (prevents duplicate display on reconnect)
    - Last-Event-ID resume logic (track highest seen ID, supply on reconnect)
    - Exponential backoff schedule computation (1s initial, double each attempt, 30s max cap)
    - Status → badge mapping (active→green, completed→gray, abandoned→yellow, failed→red)
    - "Waiting for" derivation from last stream entry `type` field (e.g., `tool_call`→"waiting: tool", `prompt_injected`→"waiting: turn complete")
    - Hash-route parser: `parseHashRoute(hash)` → `{ view: 'list' } | { view: 'detail', sessionId: string }`
    - All functions are pure, no DOM or fetch dependencies
    - _Requirements: 7.6, 7.9, 14.2, 14.3, 14.5_

  - [ ]* 10.1a-test Write Tier 1 property test for UI pure logic
    - Test backoff schedule: verify capped at 30s, always ≥1s, monotonically non-decreasing
    - Test dedup: applying same event twice yields no duplicate entries
    - Test hash-route parser: arbitrary strings produce valid parse results
    - Test status→badge mapping covers all Session_Status values
    - Test file: `test/tier1/web-server/ui-logic.test.ts`
    - **Validates: Requirements 7.9, 14.2, 14.3**

  - [ ] 10.1b Create web-ui.ts shell HTML with token-embedding and routing framework
    - Export function that returns the HTML string with conditional daemon-token embedding
    - On loopback bind: embed `window.__DAEMON_TOKEN = '<token>'` in a `<script>` tag
    - On public bind or when proxy proof is present: omit the token
    - Hash-based client-side routing: `#/` for list view, `#/sessions/<id>` for detail
    - Import logic from `src/ui/logic.ts` inline (bundled into the HTML string as a module script)
    - Single static HTML with vanilla JavaScript (no build system)
    - _Requirements: 7.1, 7.2, 7.3, 7.6, 7.8_

  - [ ] 10.1c Implement list view + pagination + summary line + status badges
    - Session list with pagination (20 per page), status badges (green/gray/yellow/red)
    - "Waiting for" summary line in session list derived from last stream entry type
    - Display authenticated identity in header banner
    - PR deep links to GitHub in list entries
    - _Requirements: 7.4, 7.10, 7.11, 14.5_

  - [ ] 10.1d Implement detail view + SSE client + write controls + mobile CSS
    - Session detail: metadata, PR deep links to GitHub, live SSE stream
    - SSE reconnection with exponential backoff (1s → 30s max) using `Last-Event-ID`
    - Reconnect on browser `visibilitychange` (regaining focus)
    - Prompt injection textarea (3 rows, max 10000 chars), Stop button (amber), Kill button (red) with confirmation dialog
    - Hide write controls for non-active sessions
    - Mobile: min 44×44px tap targets, 16px body font, single-column at ≤480px, 14px min log font at ≤768px, horizontally scrollable log container
    - _Requirements: 7.5, 7.7, 7.9, 11.1–11.7, 14.1–14.4_

- [ ] 11. Integration: Wire web server into index.ts
  - [ ] 11.1 Wire createWebApp and startWebServer into daemon startup
    - Import and call `createWebApp` after the webhook server is created
    - Pass `SessionManager`, `SessionFiles`, `DaemonTokenStore`, `Logger`, config, and `SSEBroker` as dependencies
    - Call `startWebServer` to bind the web server
    - Add web server listener to `DaemonState`
    - Support `--bind-public` CLI flag (CLI flag takes precedence over config `bindPublic`)
    - Log control port binding info
    - _Requirements: 1.1, 1.2, 1.5_

- [ ] 12. Graceful shutdown modification
  - [ ] 12.1 Modify shutdown sequence in index.ts for drain-to-completion budget
    - Set `shuttingDown` flag early so web write endpoints return 503
    - Distinguish idle-active sessions (no turn in-flight) from busy sessions during drain
    - Idle-active sessions: terminate immediately (SIGTERM → 5s → SIGKILL)
    - Busy sessions: wait up to `shutdownDrainSeconds` for current turn to complete
    - After budget expires: SIGKILL remaining sessions, write `termination_reason: "shutdown"`, `status: "abandoned"`
    - Ensure ALL terminated sessions emit `session_ended` stream.log entry (shutdown path included)
    - Close web server listener with 5s drain for active SSE connections
    - Close SSE broker (shutdown all timers and streams)
    - Maintain session_ended invariant: every path appends entry before writing terminal meta
    - _Requirements: 1.5, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [ ] 12.2 Audit and fix session_ended invariant (Property 27) across all terminal paths
    - Audit ALL existing terminal paths in session-mgr.ts: completion, failure, timeout_inactivity, timeout_max_lifetime, killed (CLI and web), and shutdown-abandon (the site at ~line 827 where shutdown writes `status: 'abandoned'`)
    - Ensure each path emits exactly one `session_ended` stream.log entry before writing terminal meta.json
    - Specifically verify the shutdown-abandon path appends `session_ended` with `reason: "shutdown"` (currently may be missing for some paths)
    - Verify all timeout paths (inactivity, max_lifetime) append `session_ended` before removing from registry
    - _Requirements: 6.8, 15.3_

- [ ] 13. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Tier 2 integration tests
  - [ ] 14.1 Write Tier 2 test for inject lifecycle (Properties 14, 16, 17, 24)
    - **Property 14: Valid Inject Returns 202**
    - **Property 16: Write Operations Produce Audit Trail**
    - **Property 17: Failed Injection Logged**
    - **Property 24: Turn Queue Serialization** (concurrent inject ordering)
    - Test file: `test/tier2/web-inject-lifecycle.test.ts`
    - **Validates: Requirements 8.1, 8.2, 8.4, 12.1, 12.2, 12.3**

  - [ ] 14.2 Write Tier 2 test for kill and interrupt (Properties 6, 18, 19, 25)
    - **Property 6: Terminal Sessions Are Immutable**
    - **Property 18: Kill Produces Correct Terminal State**
    - **Property 19: Interrupt Preserves Active Status**
    - **Property 25: Non-Resident Active Session Returns 409**
    - Also test: logging_failed → 500 when stream.log write fails for kill/interrupt Actor_Log (Req 12.5)
    - Test file: `test/tier2/web-kill-interrupt.test.ts`
    - **Validates: Requirements 9.2, 10.2, 10.3, 10.6, 10.7, 12.5**

  - [ ] 14.3 Write Tier 2 test for SSE full lifecycle (Properties 11, 12, 13)
    - **Property 11: SSE Event IDs Are Monotonic**
    - **Property 12: SSE Last-Event-ID Resumption**
    - **Property 13: SSE Session-Ended Closes Connection**
    - Test file: `test/tier2/web-sse.test.ts`
    - **Validates: Requirements 6.2, 6.8, 6.10**

  - [ ] 14.4 Write Tier 2 test for graceful shutdown (Properties 20, 21)
    - **Property 20: Graceful Shutdown Leaves No Active Sessions**
    - **Property 21: Drain Phase Request Routing**
    - Test file: `test/tier2/web-shutdown.test.ts`
    - **Validates: Requirements 15.1, 15.3, 15.5**

  - [ ] 14.5 Write Tier 2 test for auth-before-resource (Property 26)
    - **Property 26: Authentication Precedes Resource Resolution**
    - Verify unauthenticated requests always get 401, never 404/409
    - Test file: `test/tier2/web-auth-ordering.test.ts` (own file — not shared with 14.2)
    - **Validates: Requirements 16.4**

  - [ ] 14.6 Write Tier 2 test for P27 session_ended invariant across ALL termination paths
    - **Property 27: Every Terminal Transition Emits session_ended**
    - Test each termination path: completion, failure, timeout_inactivity, timeout_max_lifetime, killed (web), killed (CLI), shutdown
    - Verify exactly one `session_ended` entry exists per terminated session
    - Test file: `test/tier2/web-session-ended-invariant.test.ts`
    - **Validates: Requirements 6.8, 15.3**

  - [ ] 14.7 Write Tier 2 test for token-embedding security
    - Test that served HTML at GET / contains the daemon token when bound to loopback
    - Test that served HTML does NOT contain the daemon token when `bindPublic: true`
    - Test file: `test/tier2/web-token-embedding.test.ts`
    - **Validates: Requirements 7.2, 7.3**

  - [ ] 14.8 Write Tier 2 test for bind-address verification
    - Verify loopback-default: server binds to 127.0.0.1 with default config (P1)
    - Verify `bindPublic: true` → server binds to 0.0.0.0
    - Test file: `test/tier2/web-bind-address.test.ts`
    - **Validates: Requirements 1.1, 1.2**

  - [ ] 14.9 Write Tier 2 test for token rotation (Req 2.5)
    - After a daemon restart (new token), old token → 401
    - Test file: `test/tier2/web-token-embedding.test.ts` (extend 14.7)
    - **Validates: Requirements 2.5**

- [ ] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Required test tasks (non-`*`) validate correctness properties the design invested effort in — these are load-bearing invariants
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Tier 1 tests cover pure-logic properties (auth, UUID, listing filters, prompt validation, SSE helpers, UI logic)
- Tier 2 tests cover stateful/lifecycle properties (inject delivery, kill semantics, SSE streaming, shutdown, P27 invariant)
- The turn queue is the key architectural change — it affects both webhook and web inject paths
- The `'terminated'` → `'terminated_cli'` migration requires updating existing call sites but preserves backward-compatible reads
- UUID `:id` validation is centralized in the middleware (task 9.1) — route handlers do NOT re-validate
- `src/ui/logic.ts` is pure ESM importable by both browser and Node for Tier 1 testability

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "5.1"] },
    { "id": 3, "tasks": ["4", "5.2", "6.1"] },
    { "id": 4, "tasks": ["6.2", "7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3"] },
    { "id": 6, "tasks": ["7.4a", "7.4b", "7.4c", "7.5"] },
    { "id": 7, "tasks": ["8", "9.1", "10.1a"] },
    { "id": 8, "tasks": ["10.1a-test", "10.1b"] },
    { "id": 9, "tasks": ["10.1c", "10.1d"] },
    { "id": 10, "tasks": ["11.1"] },
    { "id": 11, "tasks": ["12.1", "12.2"] },
    { "id": 12, "tasks": ["13"] },
    { "id": 13, "tasks": ["14.1", "14.3", "14.4", "14.7", "14.8"] },
    { "id": 14, "tasks": ["14.2", "14.5", "14.6", "14.9"] },
    { "id": 15, "tasks": ["15"] }
  ]
}
```

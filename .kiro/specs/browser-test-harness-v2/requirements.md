# Requirements: Browser Test Harness v2

This document describes the requirements for the Playwright-based browser test suite in `test/browser/`. It documents what **exists and works today**, not aspirational behavior.

## Requirement 1: Per-Test Server Lifecycle

### User Story
As a test author, I need each browser test to run against an isolated, ephemeral server instance so tests are independent and parallelizable.

### Acceptance Criteria
1. Each test gets a fresh temporary directory (`fs.mkdtempSync`) cleaned up on teardown.
2. Each test gets its own SQLite database, session files, SSE broker, session manager, and web server.
3. The web server binds on a dynamically allocated `controlPort` from `getFreePort()`. The config `port` field (webhook-facing) is hardcoded to `9999` in tests since webhooks are not exercised by browser tests; the HTTP server address is always `http://127.0.0.1:${controlPort}`.
4. A TCP readiness probe (`waitForTCP`) with 50ms polling interval and 5s timeout ensures the server is accepting connections before tests proceed.
5. Teardown closes the server, shuts down the SSE broker and session manager, and removes the temp directory.

## Requirement 2: Session Seeding

### User Story
As a test author, I need to seed sessions in two modes — filesystem-only (no ACP subprocess, writes only to a tmpdir) and live (spawns a real FakeKiroBackend ACP subprocess) — to test both static rendering and interactive behavior.

### Acceptance Criteria
1. `seedSession({ live: false })` creates session files on disk (meta.json, stream.log) without spawning an ACP subprocess. Default status is `'active'`.
2. `seedSession({ live: true })` creates a session through the session manager, which spawns a FakeKiroBackend ACP subprocess. The subprocess runs the multi-prompt scenario and is torn down after the test.
3. `seedSession` accepts `status`, `repo`, and `streamEntries`. In `live: false` mode, all three are applied. In `live: true` mode, `repo` is passed to `createSession`; `status` and `streamEntries` are silently ignored (the live branch returns before reading them). The session title is hardcoded as `'Browser test session'` and is not parameterizable.
4. Seeded sessions are visible via the HTTP API (`GET /sessions`).

## Requirement 3: Console Error Collection

### User Story
As a test author, I need automatic capture of browser console errors, warnings, page errors, and dialog messages so I can assert "no errors" after user interactions.

### Acceptance Criteria
1. `ConsoleCollector` captures `console.error` messages, `console.warning` messages, page crash errors, and dialog messages (auto-accepted).
2. `assertNoErrors()` throws if any errors or pageErrors were captured during the test.
3. The collector is wired to the Playwright `page` fixture automatically.

## Requirement 4: Authentication Token Handling

### User Story
As a test author, I need to verify that the daemon token is embedded in the page when `bindPublic: false` and absent when `bindPublic: true`.

### Acceptance Criteria
1. When `bindPublic: false` (default fixture), `window.__DAEMON_TOKEN` is set to the daemon token value.
2. When `bindPublic: true`, `window.__DAEMON_TOKEN` is undefined; API requests require an `Authorization: Bearer <token>` header.
3. The `token` fixture exposes the current daemon token for use in direct API calls from tests.

## Requirement 5: SSE Streaming and Real-Time Rendering

### User Story
As a test author, I need to verify that stream entries appended to `stream.log` appear in the browser in real-time via SSE.

### Acceptance Criteria
1. Entries appended via `sessionFiles.appendStream()` appear as `.log-entry` elements in `#log-container` within 2 seconds (SSE broker polls at 50ms).
2. Entries render in monotonically increasing ID order.
3. The log container auto-scrolls to the bottom on new entries.
4. A `session_ended` SSE event hides the controls and updates `#sse-status` to "Stream ended".

## Requirement 6: SSE Reconnection on Connection Drop

### User Story
As a test author, I need to verify that the client reconnects after an SSE connection drop, resumes from the last event ID, and does not produce duplicates.

### Acceptance Criteria
1. `sseBroker.disconnectAll(sessionId)` terminates the active SSE connection for a session.
2. After disconnection, `#sse-status` shows "Reconnecting in 1s..." — `connectSSE()` resets `attempt=0` on every call, so the reconnect delay is always `computeBackoff(0)` = 1000ms.
3. The reconnection request includes a `Last-Event-ID` header with the ID of the last received event.
4. No duplicate event IDs appear in the rendered log after reconnection.
5. No reconnection is attempted after a `session_ended` event has been received.
6. After a successful reconnect, a second drop also reconnects at 1000ms (attempt resets each time `connectSSE()` is called).

## Requirement 7: SSE Reconnection on Visibility Change (CDP)

### User Story
As a test author, I need to verify that tab visibility transitions trigger SSE reconnection using Chrome DevTools Protocol lifecycle states.

### Acceptance Criteria
1. CDP is accessed via `page.context().newCDPSession(page)`.
2. `Page.setWebLifecycleState` with `state: 'frozen'` simulates the tab becoming hidden/backgrounded.
3. `Page.setWebLifecycleState` with `state: 'active'` simulates the tab returning to foreground.
4. The `frozen` → `active` transition triggers an SSE reconnect; the reconnect request SHALL include a `Last-Event-ID` header matching the last received event ID (verifiable via Playwright `page.route()` intercept).
5. Entries appended while the page is frozen appear after resuming to `'active'`.
6. No duplicate event IDs after visibility-change reconnection.
7. The state `'hidden'` is **not used** — only `'frozen'` and `'active'` are valid CDP lifecycle states for this purpose.

## Requirement 8: SSE Reconnection on Network Online Event

### User Story
As a test author, I need to verify that the browser's `online` event triggers SSE reconnection.

### Acceptance Criteria
1. Dispatching `window.dispatchEvent(new Event('online'))` triggers a new SSE stream request with `Last-Event-ID`.
2. No duplicate entries after online-triggered reconnection.
3. No reconnection on `online` event if `session_ended` was already received.
4. No reconnection on visibility change if `session_ended` was already received.

## Requirement 9: Fetch Resilience

### User Story
As a test author, I need to verify that the web client handles network failures by making 3 total attempts (1 initial + 2 retries) with exponential backoff, showing an error state with a "Retry" button on exhaustion, and displaying an auth-specific message on 401.

### Acceptance Criteria
1. Transient network failures (1-2 failed requests) are retried silently; the list renders after recovery.
2. Permanent failures (all 3 total attempts exhausted: 1 initial + 2 retries) show an error state with a "Retry" button.
3. 401 responses show an auth-specific error message immediately (no retries).
4. Hung requests (no response) time out and show a "timed out" error state, not an infinite spinner.
5. Fetch timeout is 10 seconds per attempt; max retries is 3 total attempts (1 initial + 2 retries = FETCH_MAX_RETRIES constant). Total worst-case budget: 3 × 10s = 30s. See design §8 for the test timeout implication.

## Requirement 10: Prompt Injection via UI

### User Story
As a test author, I need to verify the prompt injection flow — send, success feedback, validation, and error handling.

### Acceptance Criteria
1. Typing in `#prompt-input` and clicking `#btn-send` posts to `/sessions/<id>/inject`.
2. On success, the textarea clears and the button re-enables.
3. A `web_inject` entry appears in `stream.log`.
4. Empty or whitespace-only input does not trigger a request.
5. On server error (500), an alert fires with "Inject failed" and the textarea retains its content.
6. Non-active sessions do not render prompt controls.

## Requirement 11: Kill Session via UI

### User Story
As a test author, I need to verify the kill-session flow including confirmation dialog, success state, and error handling.

### Acceptance Criteria
1. Clicking `#btn-kill` shows a `.confirm-overlay` with "Kill this session? This cannot be undone."
2. Clicking "Cancel" dismisses the overlay without killing; session remains active.
3. Clicking "Kill" (confirm) posts to `/sessions/<id>/kill`; on success, controls hide and `meta.json` shows `status: 'abandoned'`, `termination_reason: 'terminated_web'`.
4. On kill failure (500), an alert fires with "Kill failed" and controls remain visible.

## Requirement 12: List View Rendering

### User Story
As a test author, I need to verify the session list renders correctly with status badges, repo labels, and timestamps.

### Acceptance Criteria
1. Session items render as `.session-item` elements with `.badge` status indicators.
2. Active sessions show `.badge-green` with text "active"; completed sessions show `.badge-gray`.
3. No console errors during list view load.
4. Exactly one `/repos/sessions` request is made (no N+1 per-row detail fetches).
5. `waiting_for` metadata from the server response renders in the list.
6. Pagination ("Show more") appears when sessions exceed the per-repo limit (5).

## Requirement 13: Detail View Routing

### User Story
As a test author, I need to verify hash-based routing between list and detail views.

### Acceptance Criteria
1. Clicking a session row navigates to `#/sessions/<id>` and shows `#detail-view`.
2. Detail view displays session metadata: badge, repo, session ID, creation timestamp.
3. Non-existent session ID shows "Session not found" with a back link.
4. Navigating to `#/` returns to the list view.

## Requirement 14: Network Failure Reproduction

### User Story
As a test author, I need network-shaping tests that prove the client handles mobile/high-latency scenarios correctly.

### Acceptance Criteria
1. Playwright `route.abort('connectionfailed')` simulates network failures.
2. Playwright route delays simulate high-latency proxy connections.
3. The single-request list fix (no N+1 fan-out) is validated under simulated network pressure.
4. The `test.fail()` marks in `network-repro.spec.ts` are stale — the online reconnect is implemented (the `window.addEventListener('online', ...)` handler exists in `web-ui.ts` and passes in `sse-hardening.spec.ts`). Task 14.5 removes them.

## Requirement 15: One-Request List Optimization

### User Story
As a test author, I need to verify the client issues exactly one request to load the session list, with no per-row follow-up requests.

### Acceptance Criteria
1. Loading the list view issues exactly one `/repos/sessions` request.
2. Zero `/sessions/<id>` requests are made for individual session details.
3. The `waiting_for` field is derived server-side and included in the grouped response.

## Requirement 16: Projects Panel

### User Story
As a test author, I need to verify the projects panel renders, supports repo filtering, and has correct accessibility attributes.

### Acceptance Criteria
1. Projects panel renders with ungrouped repos when no projects are configured.
2. ARIA attributes present: `role="region"`, `aria-labelledby`, `aria-expanded`.
3. Clicking a repo item filters the session list and shows a filter bar.
4. The "Clear" button restores the full grouped session list.
5. Collapse/expand toggle works on project sections (aria-expanded updates, collapsed class toggles).
6. No console errors during panel interactions.
7. Existing pagination still works with the projects panel present.
8. SSE streaming to detail view still works with the projects panel present.

## Requirement 17: Fixture Infrastructure Self-Validation

### User Story
As a test author, I need self-tests that prove the fixture infrastructure works correctly before relying on it in feature tests.

### Acceptance Criteria
1. Server starts and responds to `/sessions` health check with 200.
2. `seedSession({ live: false })` creates a session visible in the API.
3. `seedSession({ live: true })` creates a live session in the session manager.
4. `seedSession` with `streamEntries` appends entries to `stream.log`.
5. `ConsoleCollector` captures `console.error` from the page.
6. `assertNoErrors()` passes when no errors have occurred.
7. The `page` fixture does NOT auto-navigate (starts at `about:blank`).
8. The `token` fixture matches the value from `tokenStore.read()`.

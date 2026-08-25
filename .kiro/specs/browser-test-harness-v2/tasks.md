# Tasks: Browser Test Harness v2

## 1. Fixture Infrastructure
_Requirements: 1, 2, 3, 4_

- [x] 1.1. Implement `getFreePort()` — TCP server on port 0, read assigned port, close
- [x] 1.2. Implement `waitForTCP(port, host, timeoutMs)` — 50ms polling, 5s default timeout
- [x] 1.3. Implement `ConsoleCollector` — capture errors, warnings, dialogs, pageErrors; `assertNoErrors()`
- [x] 1.4. Implement per-test server lifecycle fixture — tmpdir → db → sessionFiles → tokenStore → sseBroker → sessionManager → webApp → startWebServer → waitForTCP
- [x] 1.5. Implement teardown — close server, shutdown broker/manager/db, rm tmpdir
- [x] 1.6. Implement `seedSession({ live, status, repo, streamEntries })` — filesystem-only and live modes
- [x] 1.7. Expose fixtures: `page`, `baseUrl`, `seedSession`, `sessionFiles`, `sseBroker`, `db`, `token`, `tokenStore`, `rootDir`, `sessionManager`, `console`
- [x] 1.8. Configure Playwright — testDir=test/browser, timeout=30s, workers=4/1, chromium headless, trace on-first-retry

## 2. Fixture Self-Validation Tests (`fixture-validation.spec.ts`)
_Requirements: 17_

- [x] 2.1. Test: server starts and responds to `/sessions` health check with 200
- [x] 2.2. Test: `seedSession({ live: false })` creates filesystem session visible in API
- [x] 2.3. Test: `seedSession({ live: true })` creates live session in session manager
- [x] 2.4. Test: `seedSession` with `streamEntries` appends entries to stream.log
- [x] 2.5. Test: `ConsoleCollector` captures `console.error` from page
- [x] 2.6. Test: `assertNoErrors()` passes when no errors occurred
- [x] 2.7. Test: page does NOT auto-navigate (starts at `about:blank`)
- [x] 2.8. Test: `token` fixture matches `tokenStore.read()` value

## 3. Module Resolution Smoke Test (`smoke.spec.ts`)

- [x] 3.1. Test: `createWebApp` is importable via `.js` extension (ESM resolution check)

## 4. List View Rendering (`list-view.spec.ts`)
_Requirements: 12_

- [x] 4.1. Test: session items render with badge on navigation
- [x] 4.2. Test: active session displays `.badge-green` with "active" text
- [x] 4.3. Test: completed session displays `.badge-gray`
- [x] 4.4. Test: no console errors during list view load

## 5. Detail View Routing (`detail-view.spec.ts`)
_Requirements: 13_

- [x] 5.1. Test: clicking session row navigates to `#/sessions/<id>` and shows detail view
- [x] 5.2. Test: detail view displays session metadata (badge, repo, ID, timestamps)
- [x] 5.3. Test: non-existent session shows "Session not found" with back link
- [x] 5.4. Test: navigating to `#/` returns to list view

## 6. SSE Real-Time Rendering (`sse-render.spec.ts`)
_Requirements: 5_

- [x] 6.1. Test: new stream entries render as `.log-entry` elements
- [x] 6.2. Test: multiple events render in monotonically increasing ID order
- [x] 6.3. Test: `session_ended` event hides controls and updates SSE status to "Stream ended"
- [x] 6.4. Test: log container auto-scrolls to bottom on new entries

## 7. SSE Reconnection on Drop (`sse-reconnect.spec.ts`)
_Requirements: 6_

- [x] 7.1. Test: stream drop via `disconnectAll()` shows "Reconnecting in 1s..." status
- [x] 7.2. Test: no duplicate event IDs after reconnect
- [x] 7.3. Test: reconnection request includes `Last-Event-ID` header
- [x] 7.4. Test: no reconnection after `session_ended` event
- [x] 7.5. Test: delay resets after successful reconnect (second drop also ~1s)

## 8. Visibility-Change Reconnection (`visibility-reconnect.spec.ts`)
_Requirements: 7_

- [x] 8.1. Test: CDP `frozen` → `active` triggers SSE reconnect with last event ID. **Note:** This test verifies entries appear after reconnect but does NOT assert the `Last-Event-ID` header via `page.route()` intercept — that assertion is the gap in task 8.2.
- [x] 8.2. Test: entries appended while frozen appear on resume to active. Add `page.route()` intercept to assert reconnect request includes `Last-Event-ID` header — current `[x]` test in 8.1 does not verify the header, only that entries appear (which passes even on full replay without Last-Event-ID).
- [x] 8.3. Test: no duplicate IDs after visibility-change reconnect

## 9. SSE Hardening — Online Event (`sse-hardening.spec.ts`)
_Requirements: 8_

- [x] 9.1. Test: `online` event triggers SSE reconnect with `Last-Event-ID`
- [x] 9.2. Test: no duplicate entries after online reconnect
- [x] 9.3. Test: no reconnect after `session_ended` on `online` event
- [x] 9.4. Test: no reconnect after `session_ended` on `visibilitychange`

## 10. Auth Token Handling (`auth-token.spec.ts`)
_Requirements: 4_

- [x] 10.1. Test: `window.__DAEMON_TOKEN` present when `bindPublic: false` (default)
- [x] 10.2. Test: `window.__DAEMON_TOKEN` absent when `bindPublic: true`

## 11. Prompt Injection (`inject-prompt.spec.ts`)
_Requirements: 10_

- [x] 11.1. Test: inject sends prompt and clears textarea on success
- [x] 11.2. Test: inject creates `web_inject` entry in stream.log
- [x] 11.3. Test: empty textarea does not send request
- [x] 11.4. Test: whitespace-only textarea does not send request
- [x] 11.5. Test: inject failure shows alert and retains textarea content
- [x] 11.6. Test: non-active session does not render controls

## 12. Kill Session (`kill-session.spec.ts`)
_Requirements: 11_

- [x] 12.1. Test: kill button shows confirmation dialog
- [x] 12.2. Test: cancel in confirmation dismisses without killing
- [x] 12.3. Test: confirm kill terminates session with `terminated_web`
- [x] 12.4. Test: controls hidden after successful kill
- [x] 12.5. Test: kill failure shows error alert and keeps controls visible

## 13. Fetch Resilience (`fetch-resilience.spec.ts`)
_Requirements: 9_

- [x] 13.1. Test: transient failure then recovery — retries silently, list renders
- [x] 13.2. Test: permanent failure — shows error state with Retry button
- [x] 13.3. Test: 401 response — auth-specific message, no retry
- [x] 13.4. Test: hung request — timeout, not infinite spinner
- [x] 13.5. Test: transient failure then recovery on detail load
- [x] 13.6. Test: 401 on detail view shows auth error
- [x] 13.7. Test: permanent failure on detail shows Retry button

## 14. Network Pressure Reproduction (`network-repro.spec.ts`)
_Requirements: 14_

- [x] 14.1. Test: N+1 fan-out eliminated — single request for list
- [x] 14.2. Test: list renders within 5s under 200ms route delay per request
- [x] 14.3. Test: transient network failure on list shows recovery
- [x] 14.4. Test: hung fetch times out and shows error
- [x] 14.5. Cleanup: remove stale `test.fail()` marks from online-event tests (feature is implemented; marks are leftover from before implementation)

## 15. One-Request List Optimization (`one-request-list.spec.ts`)
_Requirements: 15_

- [x] 15.1. Test: list view issues exactly one `/repos/sessions` request, zero per-row fetches
- [x] 15.2. Test: list renders `waiting_for` from server response
- [x] 15.3. Test: pagination "Show more" appears when sessions exceed page size

## 16. Projects Panel (`projects-panel.spec.ts`)
_Requirements: 16_

- [x] 16.1. Test: projects panel shows ungrouped repo when no projects configured
- [x] 16.2. Test: projects panel has correct ARIA attributes
- [x] 16.3. Test: clicking repo in panel filters the session list
- [x] 16.4. Test: clearing repo filter restores full list
- [x] 16.5. Test: collapse/expand toggle works on project sections
- [x] 16.6. Test: no console errors during projects panel interaction
- [x] 16.7. Test: existing pagination still works with projects panel present
- [x] 16.8. Test: SSE streaming to detail view still works with projects panel present

## Identified Gaps

- [x] G2 (DEFECT NOTE — documentation only): The SSE backoff never escalates past 1000ms because `connectSSE()` resets `attempt=0` on every call. Add a code comment in `src/web-ui.ts` near `connectSSE` explaining this behavior. Do NOT change the backoff logic — Req 6.2 requires fixed 1000ms first retry and tests 7.1/7.5 assert it. If escalating backoff is desired in future, open a separate spec item: the fix requires threading `lastAttempt` from the reconnect cycle into the next `connectSSE()` call.
- [x] G3. Update spec headers in all 15 `test/browser/*.spec.ts` files to reference `.kiro/specs/browser-test-harness-v2/` with the correct v2 task numbers
- [x] G4. Fetch resilience timeout budget: tasks 13.4 and 14.4 exercise the full 3× retry loop with 10s per attempt (Req 9.5), consuming 30s minimum — equal to the Playwright test timeout. Apply `test.setTimeout(60_000)` to these tests, or reduce the `AbortController` timeout in tests (e.g., 2s) to avoid a race with the Playwright deadline. This is a correctness issue: without it, the timeout-expired test itself can expire.

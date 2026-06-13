# Requirements Document

## Introduction

The web UI (`src/web-ui.ts`) is a ~600-line HTML string containing vanilla JavaScript that renders sessions, streams SSE events, handles prompt injection, and manages session lifecycle actions. Every existing test either checks HTTP responses (Tier 2) or performs string-contains assertions on the rendered HTML (Tier 1). No test ever executes the browser-side JavaScript in a real browser engine.

This feature introduces a Playwright-based browser test tier (`test/browser/`) that launches a real Chromium browser against a running instance of the web server. Tests reuse the existing fake backends (`FakeKiroBackend`, `createSessionFiles`, `createSSEBroker`, `createWebApp`, `startWebServer`) so they remain fully offline and deterministic. The goal is to catch bugs that are invisible to HTTP-level testing — such as JavaScript execution errors, SSE stream rendering failures, and DOM interaction issues.

## Glossary

- **Browser_Test_Harness**: The Playwright test infrastructure in `test/browser/` that manages web server lifecycle, fake backend setup, and browser page interaction for each test.
- **Playwright_Config**: The `playwright.config.ts` file at the repo root that configures Playwright test runner settings, projects, and optional webServer entry.
- **Web_Server**: The Hono-based HTTP server created by `createWebApp` and started by `startWebServer` that serves the web UI and API endpoints.
- **SSE_Broker**: The server-sent events broker (`createSSEBroker`) that tails `stream.log` files and pushes events to connected browser clients.
- **FakeKiroBackend**: The scriptable fake ACP subprocess from `test/harness/fake-kiro.ts` that simulates Kiro agent behavior via scenario JSON files.
- **Session_Manager**: The component (`createSessionManager`) that manages session lifecycle including creation, prompt injection, and termination.
- **DOM**: The Document Object Model rendered by the browser after executing the web UI's JavaScript.
- **List_View**: The root view (`#list-view`) of the web UI that displays session rows with status badges.
- **Detail_View**: The session detail view (`#detail-view`) that shows session metadata, log entries, and action controls.
- **Log_Container**: The `#log-container` DOM element in the detail view where SSE log entries are rendered.
- **CDP_Session**: A Chrome DevTools Protocol session obtained via `page.context().newCDPSession(page)` that provides low-level browser control including page lifecycle state transitions.

## Requirements

### Requirement 1: Playwright Test Infrastructure

**User Story:** As a developer, I want a Playwright-based test harness that starts a real web server per test and opens a browser page against it, so that I can write tests that exercise the browser-side JavaScript.

#### Acceptance Criteria

1. THE Browser_Test_Harness SHALL provide a Playwright fixture that starts a Web_Server on an ephemeral OS-assigned port, creates required fake infrastructure (SessionFiles, Database, SSE_Broker, Session_Manager with FakeKiroBackend), waits until the server is accepting TCP connections on that port, and exposes the base URL to the test.
2. THE Browser_Test_Harness SHALL provide a Playwright fixture that opens a Chromium page pointed at the running Web_Server base URL; since bindPublic defaults to false, the HTML embeds `window.__DAEMON_TOKEN` and the browser JavaScript uses it for API requests automatically — no extra Playwright header injection is needed for loopback tests.
3. WHEN a test completes with any outcome (pass, fail, or timeout), THE Browser_Test_Harness SHALL stop the Web_Server, shut down the SSE_Broker, shut down the Session_Manager, close the database, and remove the temporary directory.
4. THE Playwright_Config SHALL be located at the repo root and SHALL use Playwright's built-in TypeScript transpilation (esbuild-based) with module resolution configured to handle ESM-style `.js` extension imports that resolve to `.ts` files on disk — matching the resolution behavior of the project's existing `vitest.config.ts` and `tsc` settings.
5. THE Browser_Test_Harness SHALL run under a separate `playwright.config.ts` and SHALL NOT run under vitest.
6. WHEN `npx playwright test` is executed from the repo root, THE Playwright_Config SHALL discover and run all `*.spec.ts` files in `test/browser/`.
7. THE package.json SHALL contain a `test:browser` script that invokes `npx playwright test`.
8. IF the Web_Server fails to accept connections within 5 seconds of starting, THEN THE Browser_Test_Harness SHALL abort the test with an error message indicating server startup timeout.

### Requirement 2: List View Rendering

**User Story:** As a developer, I want to verify that the list view renders session rows in a real browser, so that I can catch JavaScript execution errors that prevent the UI from loading.

#### Acceptance Criteria

1. WHEN the browser navigates to the root URL (`/`), THE List_View SHALL render at least one element with CSS class `session-item` containing a child element with CSS class `badge` within 5 seconds of navigation.
2. WHEN a session exists with status "active", THE List_View SHALL display an element with CSS class `badge badge-green` whose text content equals "active".
3. THE Browser_Test_Harness SHALL attach a `page.on('console')` listener that captures all error-level and warning-level messages, and SHALL surface captured error messages in the Playwright test failure output when the test fails.

### Requirement 3: Detail View Navigation

**User Story:** As a developer, I want to verify that clicking a session row navigates to the detail view, so that I can confirm hash-based routing works in a real browser.

#### Acceptance Criteria

1. WHEN the user clicks a session row in the List_View, THE System SHALL update the URL hash to `#/sessions/<session_id>`, hide the List_View, and show the Detail_View.
2. WHEN the Detail_View loads for an active session, THE Detail_View SHALL display the session's status badge, repository name, full session ID, and creation timestamp.
3. IF the Detail_View loads for a session ID that does not exist, THEN THE Detail_View SHALL display a "Session not found" message and a back link to the List_View.
4. WHEN the URL hash changes to `#/` or is empty, THE System SHALL hide the Detail_View, show the List_View, and load the session list.

### Requirement 4: SSE Event Rendering in Detail View

**User Story:** As a developer, I want to verify that SSE events are rendered in the log container without manual refresh, so that I can confirm the fetch-based SSE implementation works in a real browser.

#### Acceptance Criteria

1. WHEN the Detail_View is open for an active session and the SSE_Broker emits a log event, THE Log_Container SHALL append a new DOM element with class `log-entry` containing the event's data field, within 500 milliseconds of the event being emitted by the broker.
2. WHEN multiple SSE events arrive, THE Log_Container SHALL display them in monotonically increasing ID order, where ID corresponds to the 1-indexed line number in the session's stream.log file.
3. WHEN a `session_ended` SSE event arrives, THE Detail_View SHALL update the SSE status indicator text to "Stream ended" and hide the session controls (send, stop, kill buttons).
4. IF the SSE connection is lost while the Detail_View is open, THEN THE Detail_View SHALL reconnect using exponential backoff starting at 1000 milliseconds and doubling per attempt up to a maximum of 30000 milliseconds, passing the last received event ID so that events are not missed.
5. WHEN the SSE connection reconnects and replays previously-seen events, THE Log_Container SHALL deduplicate entries by ID so that no ID appears more than once in the rendered list.
6. WHEN a new log entry is appended to the Log_Container, THE Log_Container SHALL auto-scroll to the bottom so the most recent entry is visible.

### Requirement 5: SSE Reconnection

**User Story:** As a developer, I want to verify that the SSE client reconnects after a stream interruption, so that I can confirm the exponential backoff and Last-Event-ID resumption logic works in a real browser.

#### Acceptance Criteria

1. WHEN the SSE stream drops (connection closes without a `session_ended` event), THE Detail_View SHALL display a status message indicating reconnection with the computed backoff delay in seconds (initial 1s, doubling per attempt, capped at 30s).
2. WHEN the SSE stream reconnects after a drop, THE Log_Container SHALL NOT contain entries with duplicate SSE event IDs, as determined by the `id` field of each SSE message.
3. WHEN the SSE stream reconnects, THE Browser_Test_Harness SHALL register the request listener (via `page.on('request')` or equivalent) before the SSE connection is established, so that reconnection requests are captured regardless of when the stream drop occurs, and SHALL verify that the reconnection request includes the `Last-Event-ID` header set to the numeric `id` field of the last successfully received SSE message before the drop.
4. WHEN the SSE stream emits a `session_ended` event, THE Detail_View SHALL NOT attempt reconnection and SHALL display a "Stream ended" status message.
5. THE Browser_Test_Harness SHALL verify that the first reconnection attempt occurs within 1500ms (±500ms tolerance) of the stream drop, and that after a successful reconnection the next drop triggers a reconnection attempt within 1500ms again (confirming delay reset).

### Requirement 6: Prompt Injection via UI

**User Story:** As a developer, I want to verify that the prompt injection textarea and Send button work in a real browser, so that I can confirm the DOM interaction and API call succeed end-to-end.

#### Acceptance Criteria

1. WHEN the user fills the prompt textarea and clicks the Send button in the Detail_View, THE Web_Server SHALL receive a POST to `/sessions/:id/inject` with a JSON body containing a `prompt` field set to the textarea content, and SHALL respond with HTTP 202 and a JSON body `{ "accepted": true }`.
2. WHEN the inject request succeeds with HTTP 202, THE Detail_View SHALL clear the textarea content and re-enable the Send button.
3. WHEN the inject request succeeds, THE session's `stream.log` SHALL contain a `web_inject` entry with `source` set to `"router"` and `type` set to `"web_inject"`.
4. IF the prompt textarea is empty or contains only whitespace, THEN THE Detail_View SHALL not send the request, and the Send button SHALL remain enabled.
5. IF the inject request fails with a non-2xx status, THEN THE Detail_View SHALL display an alert indicating the failure reason and SHALL NOT clear the textarea content.
6. IF the session is not in `active` status, THEN THE Web_Server SHALL respond with HTTP 409 and the Detail_View SHALL NOT render the prompt textarea or Send button.

### Requirement 7: Kill with Confirmation Dialog

**User Story:** As a developer, I want to verify that the Kill button shows a confirmation dialog and terminates the session when confirmed, so that I can confirm the modal interaction and session lifecycle work in a real browser.

#### Acceptance Criteria

1. WHEN the user clicks the Kill button in the Detail_View, THE Detail_View SHALL display a confirmation dialog overlay containing the text "Kill this session? This cannot be undone." and two buttons labeled "Kill" and "Cancel".
2. WHEN the user clicks "Cancel" in the confirmation dialog, THE Detail_View SHALL remove the confirmation dialog overlay from the DOM without sending a kill request to the server and without changing the session status.
3. WHEN the user clicks "Kill" in the confirmation dialog, THE Session_Manager SHALL terminate the session and the session status SHALL transition to "abandoned" with a termination_reason of "terminated_web".
4. WHEN the session is successfully killed, THE Detail_View SHALL hide the action controls (textarea, Send, Stop, Kill buttons) so that no further interaction controls are visible.
5. IF the kill request fails with a non-success HTTP response, THEN THE Detail_View SHALL display an error message indicating the failure reason and SHALL leave the action controls visible for retry.

### Requirement 8: Visibility Change Reconnection

**User Story:** As a developer, I want to verify that the SSE client reconnects when the page becomes visible after being hidden, so that I can confirm the `visibilitychange` event handler works in a real browser.

#### Acceptance Criteria

1. WHILE the Detail_View is displaying an active session with an established SSE connection (lastEventId greater than 0), THE Browser_Test_Harness SHALL use a Playwright CDP session (`page.context().newCDPSession(page)`) to invoke `Page.setWebLifecycleState` with state "hidden" followed by state "active" to transition the page visibility, and SHALL verify that a new SSE connection request is initiated within 2 seconds of the "active" transition and includes the last known event ID.
2. WHILE the page is in the CDP "hidden" lifecycle state, WHEN new log entries are appended to the session stream on the server, THEN after the CDP session transitions the page back to "active" and the SSE stream reconnects, THE Log_Container SHALL display the entries that were appended during the hidden period within 5 seconds of the visibility change.
3. WHEN the SSE stream reconnects after a CDP-triggered visibility change, THE Log_Container SHALL NOT contain any entry whose numeric event ID appears more than once in the rendered log list.
4. IF the SSE stream fails to reconnect within 5 seconds after a CDP-triggered visibility change from "hidden" to "active", THEN THE Browser_Test_Harness SHALL report the failure with the session ID and the last known event ID that was used in the reconnection attempt.

### Requirement 9: Auth Token JavaScript Accessibility

**User Story:** As a developer, I want to verify that the embedded daemon token is accessible to browser JavaScript as a global variable, so that I can confirm the token embedding works end-to-end in a real browser context.

#### Acceptance Criteria

1. WHEN the Web_Server is configured with `bindPublic: false` (the default), THE Browser_Test_Harness SHALL verify via `page.evaluate(() => window.__DAEMON_TOKEN)` that the returned value equals the daemon token provisioned for that test instance.
2. WHEN the Web_Server is configured with `bindPublic: true`, THE Browser_Test_Harness SHALL use `page.setExtraHTTPHeaders()` to inject `Authorization: Bearer <token>` for API requests, and SHALL verify that `page.evaluate(() => window.__DAEMON_TOKEN)` returns undefined.

### Requirement 10: Existing Test Suite Compatibility

**User Story:** As a developer, I want the new browser tests to coexist with the existing 794 vitest tests without interference, so that the entire test suite remains green.

#### Acceptance Criteria

1. THE Browser_Test_Harness SHALL store all browser test files in `test/browser/` and SHALL NOT modify any existing files in `test/tier1/`, `test/tier2/`, `test/tier3/`, `test/harness/`, `test/scenarios/`, or `test/fixtures/`.
2. THE Browser_Test_Harness SHALL use a separate Playwright configuration file and SHALL NOT modify the existing `vitest.config.ts`.
3. WHEN `npm test` is executed, THE existing vitest suite SHALL pass with the same number of passing tests as before browser test integration, and SHALL NOT include any files from `test/browser/` in its test run.
4. WHEN `npm run test:browser` is executed, THE Playwright test suite SHALL run without requiring vitest as a prerequisite and SHALL exit with code 0 on success or non-zero on failure.
5. THE Browser_Test_Harness SHALL NOT introduce a build step, bundler, or compile step to the project's existing source or test execution workflow.
6. IF a Playwright devDependency is added to `package.json`, THEN THE Browser_Test_Harness SHALL ensure that `npm install` completes without breaking existing dependency resolution and that `npm test` continues to pass.

### Requirement 11: Browser Console Error Capture

**User Story:** As a developer, I want all browser console errors to be captured and surfaced in test output, so that JavaScript runtime errors like "Error: Load failed" and "NetworkError" are visible in CI failure reports.

#### Acceptance Criteria

1. THE Browser_Test_Harness SHALL collect all browser console messages of level "error" or "warning" during each test execution.
2. WHEN a test fails, THE Browser_Test_Harness SHALL include the collected console error and warning messages in the Playwright test failure output.
3. THE Browser_Test_Harness SHALL provide an option for tests to assert that zero error-level console messages were emitted during the test, enabling tests to fail on unexpected JavaScript errors.

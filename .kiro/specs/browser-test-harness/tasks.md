# Implementation Plan: Browser Test Harness

## Overview

Introduces a Playwright-based browser test tier (`test/browser/`) that launches real Chromium against an ephemeral web server per test, exercising the browser-side JavaScript in `src/web-ui.ts`. The implementation proceeds in dependency order: prove module resolution first, then add the `disconnectAll` SSE broker method, then build fixtures, then write spec files, and finally wire the npm script.

## Tasks

- [ ] 1. Prove module resolution works
  - [ ] 1.1 Install `@playwright/test` and create smoke test
    - Install `@playwright/test` as a devDependency (`npm install -D @playwright/test`)
    - Create `playwright.config.ts` at the repo root with: `testDir: './test/browser'`, `testMatch: '**/*.spec.ts'`, `timeout: 30_000`, `retries: 0`, `workers: process.env.CI ? 1 : 4`, `reporter: [['list'], ['html', { open: 'never' }]]`, `use: { browserName: 'chromium', headless: true, trace: 'on-first-retry' }`
    - Create `test/browser/smoke.spec.ts` that imports `createWebApp` from `../../src/web-server.js` and asserts `typeof createWebApp === 'function'`
    - Run `npx playwright install chromium` then `npx playwright test test/browser/smoke.spec.ts` to verify .js→.ts module resolution works under Playwright's built-in esbuild TS loader
    - If resolution fails, add a Playwright `transform` option with an esbuild plugin that rewrites `.js` extensions to `.ts` before resolution
    - _Requirements: 1.4, 1.5, 1.6, 10.2, 10.5_

- [ ] 2. Add `disconnectAll` to SSEBroker
  - [ ] 2.1 Extend SSEBroker interface and implementation
    - Add `disconnectAll(sessionId: string): void` to the `SSEBroker` interface in `src/sse-broker.ts`
    - Implement in `createSSEBroker`: iterate `state.clients.values()`, call each client's `close()`, then `state.clients.clear()`, then stop the poll timer via `clearInterval(state.pollTimer); state.pollTimer = null`, then check heartbeat state (same pattern as the `unsubscribe` cleanup: check if any sessions have clients, if not clear heartbeat timer)
    - This does NOT write a `session_ended` event — it simulates server-initiated stream drop for reconnect testing
    - _Requirements: 5.1, 5.2, 5.3_

- [ ] 3. Create Playwright fixtures
  - [ ] 3.1 Create `test/browser/fixtures.ts` with full per-test server lifecycle
    - Import `test as base` from `@playwright/test` and project modules: `createSessionFiles`, `initDatabase`, `createLogger`, `createDaemonTokenStore`, `createSSEBroker`, `createWebApp`, `startWebServer`, `FakeKiroBackend`, `createSessionManager`, `spawnACPClient`
    - Define `ServerFixture` interface: `baseUrl`, `sessionFiles`, `sseBroker`, `sessionManager`, `db`, `tokenStore`, `rootDir`, `token`
    - Define `ConsoleCollector` interface: `errors: string[]`, `warnings: string[]`, `dialogs: string[]`, `pageErrors: string[]`, `assertNoErrors(): void`
    - Implement server fixture setup: `fs.mkdtempSync()` → `createSessionFiles(rootDir)` → `initDatabase(...)` → `createLogger({ level: 'error', output: () => {} })` → `createDaemonTokenStore(...)` → `createSSEBroker({ ..., pollIntervalMs: 50 })` → `FakeKiroBackend()` → `createSessionManager(...)` → `createWebApp(...)` → `startWebServer(app, { controlPort: 0, port: 9999, bindPublic: false }, log)`
    - Extract port via `(server.address() as net.AddressInfo).port` after `startWebServer` returns
    - Implement TCP readiness check: loop with 50ms interval, 5s deadline, attempting `net.connect()` to the assigned port; throw descriptive error on timeout
    - Implement teardown: `server.close()`, `sseBroker.shutdown()`, `await sessionManager.shutdown()`, `await db.shutdown()`, `fs.rmSync(rootDir, { recursive: true, force: true })`
    - Implement `ConsoleCollector`: attach `page.on('console')` for error/warning capture, `page.on('pageerror')` for uncaught exceptions, `page.on('dialog')` to auto-accept and capture dialog messages
    - Implement `seedSession` helper with two distinct modes:
      - `seedSession({ live: false })` (default): filesystem-only seed via `sessionFiles.createSession()` + optional `sessionFiles.updateMeta()` for terminal status. Good for list view, detail view, SSE render tests where no running process is needed.
      - `seedSession({ live: true })`: uses `sessionManager.createSession()` with FakeKiroBackend loaded with `test/scenarios/slow-multi-prompt.json` scenario. Required for inject tests (inject endpoint calls `sessionMgr.getActiveSession()` and returns 409 without a live handle) and kill tests (kill endpoint also requires a live handle).
    - The page fixture provides a Page WITHOUT auto-navigating — tests call `page.goto(baseUrl)` themselves so they can register listeners (e.g., `page.on('request')`) before navigation triggers SSE connections
    - Export `test` as `base.extend<ServerFixture & BrowserFixture>(...)` 
    - _Requirements: 1.1, 1.2, 1.3, 1.8, 2.3, 11.1, 11.2, 11.3_

- [ ] 4. Checkpoint
  - Ensure smoke test and fixtures compile correctly under `npx playwright test test/browser/smoke.spec.ts`. Ask the user if questions arise.

- [ ] 5. Implement list view tests
  - [ ] 5.1 Create `test/browser/list-view.spec.ts`
    - Import `test` and `expect` from the local `./fixtures.ts`
    - Seed a session with `seedSession({ live: false, status: 'active' })` — filesystem-only, no live process needed
    - Test: call `page.goto(baseUrl)`, wait for `.session-item` element with `.badge` child within 5s
    - Test: verify `.badge-green` with text "active" is visible
    - Test: verify `console.assertNoErrors()` passes (no unexpected JS errors)
    - _Requirements: 2.1, 2.2, 2.3, 11.3_

- [ ] 6. Implement detail view tests
  - [ ] 6.1 Create `test/browser/detail-view.spec.ts`
    - Seed with `seedSession({ live: false, status: 'active' })` — filesystem-only, detail view just needs metadata
    - Test: call `page.goto(baseUrl)`, click session row → URL hash updates to `#/sessions/<id>`, `#list-view` hidden, `#detail-view` visible
    - Test: detail view shows status badge, repo name, session ID, creation timestamp
    - Test: navigate to `#/sessions/nonexistent-id` → "Session not found" message and back link
    - Test: change hash to `#/` → list view shown, detail view hidden
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 7. Implement SSE rendering tests
  - [ ] 7.1 Create `test/browser/sse-render.spec.ts`
    - Seed with `seedSession({ live: false, status: 'active' })` — filesystem-only; SSE broker tails stream.log regardless of live process
    - Call `page.goto(baseUrl)`, navigate to detail view
    - Append entries to `stream.log` via `sessionFiles.appendStream()` after page navigation
    - Test: new `.log-entry` elements appear in `#log-container` within 500ms of broker emission
    - Test: multiple events render in monotonically increasing ID order
    - Test: append a `session_ended` entry → `#sse-status` shows "Stream ended", controls hidden
    - Test: log container auto-scrolls to bottom on new entries (scrollTop === scrollHeight - clientHeight)
    - _Requirements: 4.1, 4.2, 4.3, 4.6_

- [ ] 8. Implement SSE reconnection tests
  - [ ] 8.1 Create `test/browser/sse-reconnect.spec.ts`
    - Seed with `seedSession({ live: false, status: 'active' })` — filesystem-only; SSE broker handles stream.log tailing
    - Call `page.goto(baseUrl)`, navigate to detail view, wait for initial SSE events to render
    - Register `page.on('request')` listener BEFORE calling `sseBroker.disconnectAll()` to capture reconnection requests (the listener only needs to be in place before the disconnect, not before initial connect)
    - Test: call `sseBroker.disconnectAll(sessionId)` → status shows "Reconnecting in 1s..."
    - Test: after reconnect, verify no duplicate event IDs in `#log-container`
    - Test: verify reconnection request includes `Last-Event-ID` header matching last received event ID
    - Test: after `session_ended` event, verify NO reconnection attempt occurs
    - Test: first reconnect within 1500ms (±500ms) of drop; after successful reconnect, next drop also reconnects within 1500ms (confirming delay reset)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 9. Implement prompt injection tests
  - [ ] 9.1 Create `test/browser/inject-prompt.spec.ts`
    - Seed with `seedSession({ live: true })` — MUST use live session via `sessionManager.createSession()` with FakeKiroBackend loaded with `test/scenarios/slow-multi-prompt.json` (inject endpoint calls `sessionMgr.getActiveSession()` and returns 409 without a live handle)
    - Call `page.goto(baseUrl)`, navigate to detail view
    - Test: fill `#prompt-input`, click `#btn-send` → POST to `/sessions/:id/inject` succeeds with 202, textarea cleared, button re-enabled
    - Test: verify `stream.log` contains `web_inject` entry with `source: "router"`, `type: "web_inject"`
    - Test: empty/whitespace textarea → Send does nothing, button stays enabled
    - Test: simulate inject failure (terminate session first, then attempt inject) → alert dialog captured in `collector.dialogs`, textarea NOT cleared
    - Test: non-active session (seed with `live: false, status: 'completed'`) → controls not rendered (no textarea, no Send button)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [ ] 10. Implement kill session tests
  - [ ] 10.1 Create `test/browser/kill-session.spec.ts`
    - Seed with `seedSession({ live: true })` — MUST use live session via `sessionManager.createSession()` with FakeKiroBackend loaded with `test/scenarios/slow-multi-prompt.json` (kill endpoint calls `sessionMgr.getActiveSession()` and `sessionMgr.terminateSession()` which require a live handle)
    - Call `page.goto(baseUrl)`, navigate to detail view
    - Test: click `#btn-kill` → `.confirm-overlay` appears with "Kill this session? This cannot be undone." text, "Kill" and "Cancel" buttons
    - Test: click `#confirm-kill-no` → overlay removed, no kill request sent, session unchanged
    - Test: click `#confirm-kill-yes` → session terminates with status "abandoned" and `termination_reason: "terminated_web"`, controls hidden
    - Test: simulate kill failure (terminate session first to make it non-active, then re-navigate to detail — controls should not be rendered; alternatively use a session where the ACP process has already exited) → error alert captured in `collector.dialogs`, controls remain visible
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 11. Checkpoint
  - Ensure all tests pass so far with `npx playwright test`. Ask the user if questions arise.

- [ ] 12. Implement visibility reconnection tests
  - [ ] 12.1 Create `test/browser/visibility-reconnect.spec.ts`
    - Seed with `seedSession({ live: false, status: 'active' })` — filesystem-only; SSE broker handles stream.log tailing
    - Call `page.goto(baseUrl)`, navigate to detail view, wait for SSE events (lastEventId > 0)
    - Use CDP session: `const cdp = await page.context().newCDPSession(page)`
    - Test: `cdp.send('Page.setWebLifecycleState', { state: 'hidden' })` then `cdp.send('Page.setWebLifecycleState', { state: 'active' })` → new SSE request initiated within 2s with last known event ID
    - Test: append entries while hidden → after transitioning to "active", entries appear in `#log-container` within 5s
    - Test: after visibility-change reconnect, no duplicate event IDs in rendered log
    - Do NOT use `page.evaluate(() => document.dispatchEvent(...))` — use CDP `Page.setWebLifecycleState` for real visibility transitions
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 13. Implement auth token tests
  - [ ] 13.1 Create `test/browser/auth-token.spec.ts`
    - Test (bindPublic: false, default): `page.evaluate(() => window.__DAEMON_TOKEN)` returns the provisioned daemon token for this test instance
    - Test (bindPublic: true): create a second fixture variant with `bindPublic: true`, use `page.setExtraHTTPHeaders({ Authorization: 'Bearer <token>' })`, verify `page.evaluate(() => window.__DAEMON_TOKEN)` returns `undefined`
    - _Requirements: 9.1, 9.2_

- [ ] 14. Add `test:browser` script and verify compatibility
  - [ ] 14.1 Update `package.json` and verify existing tests pass
    - Add `"test:browser": "npx playwright test"` to the `scripts` section of `package.json`
    - Verify `npm test` still passes (vitest does not pick up `test/browser/*.spec.ts` files due to `.spec.ts` extension and include patterns)
    - Verify `npm run test:browser` runs the Playwright suite and exits cleanly
    - Verify no modifications to `vitest.config.ts`, `test/tier1/`, `test/tier2/`, `test/tier3/`, `test/harness/`, `test/scenarios/`, or `test/fixtures/`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

- [ ] 15. Final checkpoint
  - Ensure all tests pass (`npm test` and `npm run test:browser`), ask the user if questions arise.

## Notes

- The design document does NOT use property-based testing for browser tests — properties are verified through representative examples in Playwright assertions
- Each test gets full isolation: tmpdir, database, SSE broker, session manager, and server on an ephemeral port
- **seedSession has two modes**: `{ live: false }` (default) uses `sessionFiles.createSession()` + `sessionFiles.updateMeta()` (atomic write via temp+rename) — no running process. `{ live: true }` uses `sessionManager.createSession()` with FakeKiroBackend loaded with `test/scenarios/slow-multi-prompt.json`. Kill and inject tests MUST use `live: true`.
- **The page fixture does NOT auto-navigate** — tests call `page.goto(baseUrl)` themselves so they can register listeners before navigation triggers SSE connections
- **Scenario file**: All live-session tests use `test/scenarios/slow-multi-prompt.json` — it keeps the session active and accepts injected prompts. No new scenario file needed.
- Port extraction: `(server.address() as net.AddressInfo).port` after `startWebServer` returns
- Workers config: `process.env.CI ? 1 : 4` in `playwright.config.ts`
- `disconnectAll` implementation follows the same cleanup pattern as `unsubscribe()` — clearing clients, stopping poll timer, checking heartbeat state
- ConsoleCollector captures BOTH `page.on('console')` errors AND `page.on('pageerror')` uncaught exceptions
- SSE reconnect tests register `page.on('request')` listener before calling `disconnectAll()` — the listener needs to be in place before the disconnect, not before the initial connect
- Visibility change tests use CDP `Page.setWebLifecycleState`, NOT event dispatch
- The smoke test (task 1.1) verifies module resolution before any real tests are written

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["5.1", "6.1", "7.1", "13.1"] },
    { "id": 4, "tasks": ["8.1", "9.1", "10.1"] },
    { "id": 5, "tasks": ["12.1"] },
    { "id": 6, "tasks": ["14.1"] }
  ]
}
```

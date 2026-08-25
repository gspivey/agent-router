# Design: Browser Test Harness v2

This document describes the architecture and design decisions of the existing Playwright browser test harness in `test/browser/`.

## Overview

The browser test harness provides end-to-end testing of the Agent Router web UI by running a real (but isolated) server stack per test and driving a Chromium browser via Playwright. Tests validate that the single-page application correctly renders sessions, handles SSE streaming, manages reconnection, and provides interactive controls.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Playwright Test Process                                        │
│                                                                │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐   │
│  │  Test File   │──▶│  Fixtures    │──▶│  Per-Test Server │   │
│  │  (*.spec.ts) │   │  (fixtures.ts)│   │  Stack           │   │
│  └──────────────┘   └──────────────┘   └──────────────────┘   │
│         │                                       │              │
│         ▼                                       ▼              │
│  ┌──────────────┐                      ┌──────────────────┐   │
│  │  Chromium    │◀── HTTP/SSE ────────▶│  Hono Web Server │   │
│  │  (headless)  │                      │  (ephemeral port)│   │
│  └──────────────┘                      └──────────────────┘   │
│                                                 │              │
│                                    ┌────────────┼────────────┐ │
│                                    ▼            ▼            ▼ │
│                              ┌──────────┐ ┌──────────┐ ┌─────┐│
│                              │SessionMgr│ │SSEBroker │ │ DB  ││
│                              └──────────┘ └──────────┘ └─────┘│
│                                    │                           │
│                                    ▼                           │
│                              ┌──────────────┐                  │
│                              │FakeKiroBackend│                  │
│                              │(ACP subprocess)│                  │
│                              └──────────────┘                  │
└────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Ephemeral Port Allocation (not hardcoded)

**Decision:** Use `getFreePort()` which creates a TCP server on port 0, reads the OS-assigned port, then closes the server.

**Rationale:** Hardcoded ports (e.g., 9999) cause conflicts when tests run in parallel or when the port is occupied by another process. Ephemeral ports allow `workers: 4` parallelism in local development.

**Implementation:**
```typescript
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
```

The fixture uses `controlPort` (from `getFreePort()`) as the actual HTTP server bind port. Tests access the server at `http://127.0.0.1:${controlPort}`. The `config.port` field is set to 9999 as a placeholder — it represents the webhook-facing port and is **not used for binding** in browser tests since webhooks are not exercised. Only `controlPort` is used for the HTTP server.

### 2. CDP Lifecycle States: `frozen` / `active` (not `hidden`)

**Decision:** Use `Page.setWebLifecycleState` with states `'frozen'` and `'active'` to simulate tab backgrounding and foregrounding.

**Rationale:** The CDP `Page.setWebLifecycleState` command only accepts `frozen` and `active` as valid states. The state `'hidden'` does not exist in this CDP API. The web client listens for `visibilitychange` events, which fire when the page transitions between these lifecycle states.

**Implementation:**
```typescript
const cdp = await page.context().newCDPSession(page);
await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
await cdp.send('Page.setWebLifecycleState', { state: 'active' });
```

The web UI handles this via:
```javascript
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && activeSSE && !activeSSE.ended) {
    closeSSE();
    connectSSE(sessionId, lastId);
  }
});
```

### 3. SSE Backoff: Resets on Each `connectSSE()` Call

**Decision:** `connectSSE()` creates a fresh `activeSSE` object with `attempt: 0` every time it's called.

**Rationale:** The attempt counter resets to 0 on every `connectSSE()` invocation. Since `scheduleReconnect()` fires `setTimeout` which calls `connectSSE()` again, the attempt counter is effectively always 0 at the start of each connection attempt. This means:
- The first reconnect after any trigger (drop, visibility change, online event) = `computeBackoff(0)` = 1000ms
- The `scheduleReconnect` → `setTimeout` → `connectSSE` cycle resets attempt each iteration, so escalation beyond 1s does not occur in practice
- SSE tests correctly assert "Reconnecting in 1s..." for all reconnection triggers

Note: The fetch-based retry logic (for non-SSE requests) is separate and does implement escalating backoff across retries within a single request cycle.

**Implementation:**
```javascript
function computeBackoff(attempt) {
  const delay = 1000 * Math.pow(2, attempt);
  return Math.min(delay, 30000);
}

function connectSSE(sessionId, lastId) {
  // Fresh state — attempt always starts at 0
  activeSSE = { ..., attempt: 0, lastId: lastId, ended: false };
  fetch(url, { headers, signal }).then(function(resp) {
    if (!resp.ok) { scheduleReconnect(sessionId); return; }
    activeSSE.attempt = 0; // Reset on success
    // ... process stream
  });
}

function scheduleReconnect(sessionId) {
  if (activeSSE.ended) return;
  const delay = computeBackoff(activeSSE.attempt); // always 0 here
  activeSSE.attempt++;
  // setTimeout calls connectSSE which resets attempt to 0 again
  setTimeout(() => connectSSE(sessionId, activeSSE.lastId), delay);
}
```

### 4. Two-Mode Session Seeding

**Decision:** `seedSession` supports `live: false` (filesystem-only) and `live: true` (full session manager with FakeKiroBackend).

**Rationale:** Most tests only need rendered state and don't require a running ACP subprocess. Filesystem-only seeds are fast (no process spawn, no 300ms startup wait). Live sessions are needed for tests that exercise interactive features (inject prompt, kill session) that require a real session manager handle.

**Implementation:**
- `live: false` — calls `sessionFiles.createSession()` and `sessionFiles.updateMeta()` directly. UUID generated via `crypto.randomUUID()`.
- `live: true` — calls `sessionManager.createSession()` which spawns FakeKiroBackend with the `slow-multi-prompt.json` scenario, then waits 300ms for ACP initialization.

### 5. SSE Broker with Fast Polling

**Decision:** The SSE broker in test fixtures uses `pollIntervalMs: 50` (vs production default).

**Rationale:** Tests need sub-second latency between `appendStream()` and the entry appearing in the browser. The 50ms poll interval ensures entries are delivered within ~100ms while keeping test timeouts reasonable (2s assertion windows).

### 6. Fetch-Based SSE (not EventSource)

**Decision:** The web client uses `fetch()` with streaming body reader instead of native `EventSource`.

**Rationale:** `EventSource` does not support custom headers. The client needs to send `Authorization: Bearer <token>` and `Last-Event-ID` headers. The fetch-based implementation manually parses the SSE protocol (event/id/data lines separated by blank lines).

**Note:** The fetch-based SSE client ignores `retry:` hints from the server (it is not an EventSource). Reconnect delays come solely from `computeBackoff(attempt)`.

### 7. Network Simulation via Playwright Routes

**Decision:** Network failures are simulated using Playwright's `page.route()` API with `route.abort()`, `route.fulfill()`, and delayed `route.continue()`.

**Rationale:** This approach works at the browser network layer without requiring actual network degradation. It allows precise control: fail the Nth request, add delay to specific URL patterns, or return specific HTTP status codes.

### 8. Fetch Resilience Timeout Budget

> **WARNING:** With `retries: 0` and a 30s test timeout (`playwright.config.ts`), tests that exercise the full 3× retry loop with 10s timeout per attempt (Req 9.5) consume 30s minimum — equal to the Playwright test timeout. Tests 13.4 and 14.4 (fetch timeout/resilience) should either use a shorter timeout for the abort signal (e.g., 2s) or increase the test timeout via `test.setTimeout()` to avoid races with the Playwright deadline.

### 9. Reconnection Triggers

The web client reconnects SSE in three scenarios, all of which call `closeSSE()` → `connectSSE(sessionId, lastId)`:

| Trigger | Mechanism | Guard |
|---------|-----------|-------|
| Stream ends/errors | `scheduleReconnect()` with fixed 1000ms delay (see §3 — `connectSSE()` resets `attempt=0`) | `activeSSE.ended` check |
| Tab becomes visible | `visibilitychange` event, `visibilityState === 'visible'` | `!activeSSE.ended` |
| Network comes online | `window 'online'` event | `!activeSSE.ended` |

All three are guarded by the `ended` flag — once `session_ended` is received, no reconnection is attempted regardless of trigger.

## File Layout

```
test/browser/
├── fixtures.ts                 # Fixture infrastructure (getFreePort, waitForTCP,
│                               #   ConsoleCollector, seedSession, server lifecycle)
├── smoke.spec.ts               # Module resolution sanity check
├── fixture-validation.spec.ts  # Self-tests for the fixture infrastructure
├── list-view.spec.ts           # Session list rendering, badges, error-free load
├── detail-view.spec.ts         # Hash routing, metadata display, not-found state
├── sse-render.spec.ts          # Real-time entry rendering, ordering, auto-scroll
├── sse-reconnect.spec.ts       # Drop via disconnectAll → reconnect with Last-Event-ID
├── visibility-reconnect.spec.ts# CDP frozen→active lifecycle reconnection
├── sse-hardening.spec.ts       # Online event reconnect, de-dupe, session_ended guard
├── auth-token.spec.ts          # Token embedding (bindPublic false vs true)
├── inject-prompt.spec.ts       # Prompt injection flow, validation, error states
├── kill-session.spec.ts        # Kill confirmation, success/failure, controls hiding
├── fetch-resilience.spec.ts    # Retry, timeout, error state, 401 handling
├── network-repro.spec.ts       # Network pressure reproduction (N+1, latency, drops)
├── one-request-list.spec.ts    # Single-request list optimization verification
└── projects-panel.spec.ts      # Projects panel, repo filter, accessibility
```

## Playwright Configuration

- **Test directory:** `test/browser/`
- **Test match:** `**/*.spec.ts`
- **Timeout:** 30 seconds per test
- **Retries:** 0
- **Workers:** 1 in CI, 4 locally
- **Browser:** Chromium, headless
- **Trace:** On first retry only (with `retries: 0`, traces are never captured in practice — this is a known limitation)
- **Reporter:** List (console) + HTML (never auto-open)

## Fixture Dependency Graph

```
rootDir (tmpdir)
  └─▶ db (SQLite in rootDir)
  └─▶ sessionFiles (rootDir-based)
  └─▶ tokenStore (rootDir-based) ──▶ token
  └─▶ sseBroker (sessionFiles, rootDir)
  └─▶ sessionManager (db, sessionFiles, FakeKiroBackend)
  └─▶ baseUrl (rootDir, sessionManager, sessionFiles, sseBroker, tokenStore, db)
       └─▶ [creates web app, starts server, waits for TCP]
  └─▶ console (page)
  └─▶ seedSession (sessionFiles, sessionManager)
```

All fixtures are per-test (not per-worker or per-file), ensuring complete isolation.

## Test Categories

| Category | Files | Purpose |
|----------|-------|---------|
| Infrastructure | smoke, fixture-validation | Prove the harness works |
| Rendering | list-view, detail-view, one-request-list, projects-panel | Static UI correctness |
| Streaming | sse-render, sse-reconnect, visibility-reconnect, sse-hardening | Real-time SSE behavior |
| Interaction | inject-prompt, kill-session, auth-token | User actions and auth |
| Resilience | fetch-resilience, network-repro | Error handling and recovery |

## Known Stale Test Marks

`network-repro.spec.ts` contains two tests marked `test.fail()` that assert the `online` event triggers a proactive reconnect. This behavior **has since been implemented** (the `window.addEventListener('online', ...)` handler exists in `web-ui.ts`), and the same behavior is tested successfully in `sse-hardening.spec.ts`. The `test.fail()` marks in `network-repro.spec.ts` are stale and should be removed or converted to passing assertions.

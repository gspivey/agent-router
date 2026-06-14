# Requirements: Web Client Reliability

## Introduction

The daemon serves a single-page web UI (`src/web-ui.ts`) over its control server, used mainly
to check sessions from a phone via a Cloudflare tunnel. In practice it "fails to load sessions
quite often, especially on mobile over cloudflared." This spec makes the web client reliable
on flaky/proxied connections and gives us a way to run and exercise it directly.

**Diagnosed contributors (from the current code):**
- **N+1 request fan-out on list load.** `loadSessions` fetches `/sessions?limit=500`, then for
  *each* returned session calls `fetchWaitingFor` → `/sessions/<id>?lines=1`. A populated
  daemon issues hundreds of requests to render one list — exactly what saturates a mobile link
  or trips Cloudflare connection limits, surfacing as "Load failed".
- **No retry/backoff on the initial fetch.** A single transient failure on `/sessions` lands in
  a `catch` that shows an error with no recovery.
- **SSE is a custom fetch+ReadableStream** (EventSource can't send the auth header). Cloudflare
  can buffer/drop streaming responses; mobile network transitions kill the stream. Reconnect
  exists but is not driven by `online`/`visibilitychange`, and the response may lack
  anti-buffering headers.

## Requirements

### Requirement 1: One-request session list

**User story:** As a phone user, I want the session list to load in a single request, so it
renders reliably over a slow/proxied connection.

**Acceptance criteria:**
1. WHEN the list view loads THEN the client SHALL issue exactly one request for the list (no
   per-row follow-up fetch).
2. The `/sessions` list response SHALL include, per session, the fields the row needs today —
   status, repo, timestamps, and the "waiting-for" summary — computed server-side.
3. WHEN the daemon holds more sessions than the page size THEN the list SHALL paginate (default
   page size bounded; not "limit=500"), with active sessions always shown.
4. The number of network requests to render the list SHALL be O(1) in the number of sessions,
   not O(n).

### Requirement 2: Fetch resilience and clear errors

**User story:** As a user on a flaky connection, I want transient failures to recover on their
own and persistent ones to be explained, so the UI is not a dead "Load failed".

**Acceptance criteria:**
1. WHEN a list/detail fetch fails on a transient/network error THEN the client SHALL retry with
   bounded exponential backoff before surfacing an error.
2. WHEN retries are exhausted THEN the client SHALL show a clear error state with a manual
   "Retry" action.
3. WHEN a fetch fails with `401`/auth error THEN the client SHALL surface an auth-specific
   message, distinct from a network error, and SHALL NOT retry blindly.
4. A fetch SHALL have a bounded timeout so a hung request does not leave the UI spinning
   forever.

### Requirement 3: SSE reliable over Cloudflare / mobile

**User story:** As a phone user watching a session, I want the live stream to survive proxy
buffering and network transitions, so I don't have to reload to see updates.

**Acceptance criteria:**
1. The SSE response SHALL set headers that prevent proxy buffering and transformation
   (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, appropriate
   `Connection`), and SHALL emit an initial flush so the connection opens promptly through
   Cloudflare.
2. WHEN the page returns to visibility or the device comes back `online` THEN the client SHALL
   re-establish the stream if it had dropped.
3. WHEN the stream drops THEN the client SHALL reconnect with backoff and resume from the last
   received event id (`Last-Event-ID`), without duplicating already-rendered events.
4. The heartbeat interval SHALL be tuned below Cloudflare's idle timeout so an idle stream is
   not closed as dead.
5. WHEN the session has ended THEN the client SHALL stop reconnecting.

### Requirement 4: Runnable web client / reproduction

**User story:** As a developer, I want to run the web UI against a daemon and reproduce the
mobile/proxied failures, so the bugs are characterized and regression-tested.

**Acceptance criteria:**
1. There SHALL be a documented way to run the web client against a local or remote daemon
   (existing control server + token), captured in README.
2. The failure modes SHALL be reproduced under test using the existing browser harness
   (`.kiro/specs/browser-test-harness/`) — including a throttled/offline simulation for the
   fetch-resilience and SSE-reconnect paths.
3. A repro matrix SHALL be documented: desktop-direct vs mobile-over-cloudflared, with the
   observed failure and the fix that addresses it.

### Requirement 5: No regression to existing web behavior

**Acceptance criteria:**
1. The auth model (token embedded when `bindPublic: false`, `Authorization` header otherwise)
   SHALL be preserved.
2. Existing browser-harness tests SHALL continue to pass; new coverage SHALL be added for the
   one-request list, retry, and reconnect paths.

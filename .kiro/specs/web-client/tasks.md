# Implementation Plan: Web Client Reliability

> **PARTIALLY IMPLEMENTED** — Most tasks in this spec shipped in PRs #66–69 and #92–107.
> Only task 4.1b (verify/patch SSE anti-buffering headers) is genuinely open.
> Task 2.1 (server aggregation) is **DEFERRED** — do not implement from this spec; see `BACKLOG.md § P2.20`.
> The requirements describe the intended final state; the tasks describe what was shipped vs what remains.
> An agent picking up this spec should implement ONLY task 4.1b.

## Overview

Most work in this spec shipped in PRs #66–69 and #92–107. Task 2.1 (server aggregation) is deferred to `BACKLOG.md § P2.20`. Browser-harness coverage references `browser-test-harness-v2` (the original `browser-test-harness` spec is deprecated).

## Baseline: What Was Already Implemented (PRs #92–107)

The following items were shipped before this spec was written. They are marked `[x]` below and
should NOT be re-implemented. The agent must read this note before touching any task:

- **Pagination** (task 2.2): `loadSessions` issues a single `/sessions` request; `fetchWaitingFor`
  per-row loop deleted; pagination/"load more" UI added.
- **`visibilitychange` reconnect** (task 4.2): SSE client reconnects when the tab becomes visible.
- **`online` reconnect** (task 4.2): SSE client reconnects when the browser comes back online.
- **`Last-Event-ID` tracking** (task 4.2): reconnect requests include `Last-Event-ID` header.
- **`session_ended` stops reconnect** (task 4.2): client does not attempt to reconnect after
  receiving a `session_ended` event.
- **SSE `id:` per event** (task 4.1): every SSE event emitted by the server carries an `id:` field.
- **SSE heartbeat configurable** (task 4.1): heartbeat interval is configurable; default documented
  against Cloudflare idle timeout.
- **`computeBackoff` / `scheduleReconnect`** (task 4.2): exponential backoff helpers implemented
  in the client.

**Note on task 2.2 dependency inversion:** Task 2.2 (client renders list from one request) shipped in PRs #92–107 and deleted `fetchWaitingFor` / the per-row loop. Task 2.1 (server aggregation) was NOT shipped — so the waiting-for field is absent in the current list response and the detail column shows blank. Task 2.1 is deferred to `BACKLOG.md § P2.20` rather than implemented in this spec. The N+1 is gone, replaced by a missing-field gap until 2.1 ships.

**Deferred item:** Task 2.1 — server-side waiting-for aggregation + pagination (see `BACKLOG.md § P2.20`). Do not implement from this spec.

## Tasks

- [x] 1. Diagnose and reproduce
  - [x] 1.1 Repro the load/SSE failures under the browser harness
    - Add browser specs that shape the network (CDP `Network.emulateNetworkConditions`, route
      delay/abort, offline→online) to reproduce: list "Load failed" under request pressure, and
      SSE drop on a mid-stream cut / backgrounding. Capture a repro matrix
      (desktop-direct vs mobile/cloudflared-like) in the spec/README. These start as
      expected-fail and become the regression suite.
    - _Requirements: 4.2, 4.3_

- [x] 2. One-request session list (kill the N+1)
  - [ ] 2.1 **DEFERRED TO BACKLOG — server-side list aggregation + pagination**
    - See `BACKLOG.md § P2.20`. **Do not implement from this spec.**
    - Current state: task 2.2 shipped (per-row `fetchWaitingFor` loop deleted, single `/sessions` request). The server does NOT yet return the waiting-for summary field, so the column is blank in the current UI. This task adds that server-side computation.
    - Extend the list handler (`src/web-routes.ts`) so each item includes the waiting-for summary computed server-side from the session's last stream entry. Add bounded pagination (`limit`/`offset`) with active sessions always included; remove the `limit=500` path. Additive wire shape — client still works against an old server that omits the new fields.
    - Tier 2: list response includes waiting-for and paginates; active always shown.
    - _Requirements: 1.2, 1.3, 1.4_
  - [x] 2.2 Client renders the list from one request
    - `loadSessions` (`src/web-ui.ts`) issues a single request and renders from it; delete
      `fetchWaitingFor` and the per-row loop; add pagination/"load more" UI.
    - Browser test: exactly one `/sessions` request, zero `/sessions/<id>` follow-ups on list
      render.
    - **Already implemented in PRs #92–107. Do not re-implement.**
    - _Requirements: 1.1, 1.4_

- [x] 3. Client fetch resilience
  - [x] 3.1 Resilient fetch wrapper + error/auth UI
    - Replace `apiFetch` with a wrapper: bounded `AbortController` timeout, retry-with-backoff
      for network/5xx (not `401`), typed outcome. List/detail show an error state with a Retry
      button on exhaustion and an auth-specific message on `401`. Mutations are not auto-retried.
    - Browser tests: route fails N then succeeds → silent recovery; permanent fail → error +
      working Retry; `401` → auth message, no blind retry; hung request → timeout, not infinite
      spinner.
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 4. SSE hardening for Cloudflare / mobile
  - [x] 4.1a Server SSE id/heartbeat (shipped)
    - SSE `id:` per event and configurable heartbeat implemented in PRs #92–107.
    - _Requirements: 3.4_
  - [ ] 4.1b Server SSE anti-buffering headers and initial flush (verify + patch if missing)
    - Confirm `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, explicit
      `Content-Type: text/event-stream`, initial flush comment (`:ok\n\n`), and `retry:` hint
      are present in `src/web-server.ts` / `src/sse-broker.ts`. If any are missing, add them.
      These are the Cloudflare anti-buffering requirements.
    - Tier 2: SSE response carries the anti-buffering headers and initial flush.
    - _Requirements: 3.1_
  - [x] 4.2 Client reconnect on visibility/online + resume
    - Drive reconnect from `visibilitychange` and `online` (plus existing stream-error); send
      `Last-Event-ID` on reconnect and de-dupe by id; stop reconnecting on `session_ended`.
    - Browser tests: simulated drop + foreground/online → reconnect with no duplicate ids;
      `session_ended` → no reconnect (extends the existing harness reconnect specs).
    - **All reconnect logic already implemented in PRs #92–107** (`visibilitychange`, `online`,
      `Last-Event-ID`, `session_ended` guard, `computeBackoff`, `scheduleReconnect`).
      The `[x]` covers the implementation; browser-harness regression coverage is a follow-on
      tracked under `browser-test-harness-v2` spec.
    - _Requirements: 3.2, 3.3, 3.5, 5.1, 5.2_

## Notes

- The `browser-test-harness` spec is deprecated (see that spec's deprecation header). Browser harness coverage for tasks 4.2 and 1.1 should reference the new `browser-test-harness-v2` spec once it is generated.
- Group 2 (server aggregation) is deferred to `BACKLOG.md § P2.20`. Task 2.2 (client single-request) shipped in PRs #92–107 but without the server aggregation, so the waiting-for column is blank. The resilience polish (Groups 3–4) does not depend on 2.1.
- Keep the fetch-based SSE transport (needed for the auth header); the fix is headers +
  reconnect triggers, not the transport.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.2", "3.1", "4.1a"] },
    { "id": 2, "tasks": ["4.1b", "4.2"] }
  ]
}
```
Note: Task 2.1 is removed from the wave graph — it is deferred to BACKLOG and has no dependency relationship with the remaining tasks.
```

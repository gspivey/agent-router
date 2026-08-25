# Implementation Plan: Web Client Reliability

## Overview

Diagnose first, then fix in dependency order: server-side list aggregation (removes the N+1),
client fetch resilience, then SSE hardening. Each group is a single PR with browser-harness
coverage. Builds on `.kiro/specs/browser-test-harness/` (must be merged first — it provides the
Playwright fixtures these tests use).

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

**Primary remaining work:** Task 2.1 — server-side waiting-for aggregation and N+1 elimination.
All other remaining tasks are incremental hardening on top of the above baseline.

## Tasks

- [ ] 1. Diagnose and reproduce
  - [x] 1.1 Repro the load/SSE failures under the browser harness
    - Add browser specs that shape the network (CDP `Network.emulateNetworkConditions`, route
      delay/abort, offline→online) to reproduce: list "Load failed" under request pressure, and
      SSE drop on a mid-stream cut / backgrounding. Capture a repro matrix
      (desktop-direct vs mobile/cloudflared-like) in the spec/README. These start as
      expected-fail and become the regression suite.
    - _Requirements: 4.2, 4.3_

- [ ] 2. One-request session list (kill the N+1)
  - [ ] 2.1 **PRIMARY REMAINING WORK — server-side list aggregation + pagination**
    - This is the highest-impact open task. The `/sessions` list handler (`src/web-routes.ts`)
      currently returns bare session rows; the client fans out N individual `GET /sessions/<id>`
      calls to fetch the waiting-for summary for each row — this is the N+1 that causes "Load
      failed" under mobile / Cloudflare conditions.
    - Extend the list handler so each item includes status, repo, timestamps, and the
      waiting-for summary (computed server-side from the last stream entry). Add bounded
      pagination (`limit`/`offset` or cursor) with active sessions always included; remove the
      `limit=500` path. Additive wire shape — client must still work against an old server that
      returns rows without the new fields.
    - Tier 2: list response includes waiting-for and paginates; active always shown.
    - _Requirements: 1.2, 1.3, 1.4_
  - [x] 2.2 Client renders the list from one request
    - `loadSessions` (`src/web-ui.ts`) issues a single request and renders from it; delete
      `fetchWaitingFor` and the per-row loop; add pagination/"load more" UI.
    - Browser test: exactly one `/sessions` request, zero `/sessions/<id>` follow-ups on list
      render.
    - **Already implemented in PRs #92–107. Do not re-implement.**
    - _Requirements: 1.1, 1.4_

- [ ] 3. Client fetch resilience
  - [x] 3.1 Resilient fetch wrapper + error/auth UI
    - Replace `apiFetch` with a wrapper: bounded `AbortController` timeout, retry-with-backoff
      for network/5xx (not `401`), typed outcome. List/detail show an error state with a Retry
      button on exhaustion and an auth-specific message on `401`. Mutations are not auto-retried.
    - Browser tests: route fails N then succeeds → silent recovery; permanent fail → error +
      working Retry; `401` → auth message, no blind retry; hung request → timeout, not infinite
      spinner.
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 4. SSE hardening for Cloudflare / mobile
  - [x] 4.1 Server SSE header/flush + heartbeat
    - In the SSE route (`src/web-server.ts`) / broker (`src/sse-broker.ts`): set
      `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, explicit event-stream
      content type; write an initial flush; ensure each event has an `id:` and emit a `retry:`
      hint; make heartbeat interval configurable (documented vs Cloudflare idle cap).
    - Tier 2: SSE response carries the headers + initial flush; events carry ids.
    - **SSE `id:` per event and configurable heartbeat already implemented in PRs #92–107.**
      Verify remaining items (headers, initial flush, `retry:` hint) before treating as open.
    - _Requirements: 3.1, 3.4_
  - [x] 4.2 Client reconnect on visibility/online + resume
    - Drive reconnect from `visibilitychange` and `online` (plus existing stream-error); send
      `Last-Event-ID` on reconnect and de-dupe by id; stop reconnecting on `session_ended`.
    - Browser tests: simulated drop + foreground/online → reconnect with no duplicate ids;
      `session_ended` → no reconnect (extends the existing harness reconnect specs).
    - **All sub-items already implemented in PRs #92–107** (`visibilitychange`, `online`,
      `Last-Event-ID`, `session_ended` guard, `computeBackoff`, `scheduleReconnect`).
      The remaining work is browser-harness regression coverage for these paths.
    - _Requirements: 3.2, 3.3, 3.5, 5.1, 5.2_

## Notes

- Depends on `.kiro/specs/browser-test-harness/` being merged (Playwright fixtures).
- Group 2 (server aggregation) is the highest-impact fix — it removes the request fan-out that
  causes most mobile "Load failed" cases. Do it before the resilience polish.
- Keep the fetch-based SSE transport (needed for the auth header); the fix is headers +
  reconnect triggers, not the transport.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "4.1"] },
    { "id": 3, "tasks": ["4.2"] }
  ]
}
```

# Design: Web Client Reliability

## Overview

Three fix areas plus a reproduction harness, ordered diagnose → server aggregation → client
resilience → SSE hardening. The work touches the server routes (`src/web-routes.ts`,
`src/web-server.ts`), the SSE broker (`src/sse-broker.ts`), and the client SPA
(`src/web-ui.ts`), and is exercised through the existing Playwright browser harness.

Anchor points in the current code (verified):
- `loadSessions` (`src/web-ui.ts` ~L235) fetches `/sessions?limit=500` then calls
  `fetchWaitingFor` (~L216) per session → `/sessions/<id>?lines=1`. This is the N+1.
- `apiFetch` (~L156) is a thin `fetch` wrapper with auth header, no retry/timeout.
- SSE is a fetch+ReadableStream with `AbortController` and `scheduleReconnect`/`computeBackoff`
  (~L339–411); reconnect is triggered only by stream error, not by `online`/`visibilitychange`.
- The SSE broker heartbeat default is 30s (`src/sse-broker.ts` ~L96).

## Area 0 — Diagnose & reproduction harness

Before changing behavior, reproduce the failures under the browser harness with network
shaping (Playwright/CDP `Network.emulateNetworkConditions`, route abort/delay) and an
offline→online toggle. Produce the repro matrix (desktop-direct vs mobile/cloudflared-like:
high latency, request caps, mid-stream cut). This both confirms the N+1/SSE hypotheses and
becomes the regression suite. Output: `test/browser/*.spec.ts` repro cases (initially
expected-fail), and a short repro-matrix note in the spec/README.

## Area 1 — One-request session list (kills the N+1)

**Server.** Extend the `/sessions` list handler (`src/web-routes.ts`) so each item already
carries what the row renders: `status`, `repo`, `created_at`/timestamps, and the **waiting-for
summary** currently derived client-side from the last stream line. The waiting-for computation
moves server-side (read the session's last stream entry once when assembling the list). Add
real pagination: bounded default page size (e.g. 20–50) with active sessions always included,
plus `limit`/`offset` (or cursor) params — replacing `limit=500`.

**Client.** `loadSessions` issues one request and renders directly from the response; delete
`fetchWaitingFor` and the per-row fetch loop. Render pagination controls / "load more".

**Decision:** computing waiting-for server-side is the crux — it's what forced the per-row
fetch. Keep the wire shape backward-compatible (additive fields) so older clients still work.

## Area 2 — Client fetch resilience

Replace bare `apiFetch` with a wrapper that adds:
- **Bounded timeout** via `AbortController` (e.g. 10s) so a hung request fails fast.
- **Retry with backoff** for network/5xx (e.g. 3 tries, exponential), but **not** for `401`.
- **Typed outcome** so callers can distinguish auth vs network vs empty.

UI: list/detail views show a distinct **error state with a Retry button** when retries are
exhausted, and an **auth-specific message** on `401`. A transient blip self-heals silently.

**Decision:** retry only idempotent GETs (list/detail/stream-open). Mutations (inject/kill) are
not auto-retried — surface their error to the user as today.

## Area 3 — SSE hardening for Cloudflare / mobile

**Server (`src/web-server.ts` / SSE route + `src/sse-broker.ts`):**
- Set `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, and an explicit
  `Content-Type: text/event-stream`; write an initial comment/flush (`:ok\n\n`) so Cloudflare
  opens the stream immediately.
- Tune the heartbeat below Cloudflare's ~100s idle cap (the 30s default is fine; make it
  configurable and document it).
- Emit an SSE `retry:` hint and ensure each event carries an `id:` so the client can resume.

**Client (`src/web-ui.ts`):**
- Drive reconnect from `visibilitychange` (tab/app foregrounded) and `online` events, in
  addition to stream-error — mobile backgrounding/network-switch is the common drop.
- On reconnect, send `Last-Event-ID` (already tracked as `activeSSE.lastId`) and de-dupe by
  event id so resumed events don't double-render.
- Stop reconnecting on `session_ended`.

**Decision:** keep the fetch-based SSE (needed for the auth header) rather than switching to
`EventSource`; the gaps are header hygiene + reconnect triggers, not the transport choice.

## Testing strategy

- **Browser harness (Playwright):** one-request list (assert exactly one `/sessions` request,
  no `/sessions/<id>` follow-ups); retry path (route fails N times then succeeds → recovers;
  permanent fail → error+Retry; `401` → auth message); SSE reconnect on simulated drop +
  visibility/online with no duplicate ids; `session_ended` → no reconnect.
- **Tier 2 (server):** `/sessions` list response includes waiting-for + paginates; SSE response
  carries the anti-buffering headers and an initial flush.
- Network shaping via CDP for the mobile/cloudflared-like cases.

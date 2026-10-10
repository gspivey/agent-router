# Implementation Plan — Web UI Overhaul (SPA)

Each top-level task is one PR-sized increment and maps directly to a ROADMAP item (71–78).
Tasks are dependency-ordered: by the time an agent reaches a task, every prerequisite has
merged. Every UI-rendering task carries unit coverage (vitest + `@testing-library/svelte`) and
Playwright evidence at `375×812` (iPhone 14) and `1280×800` (desktop) viewports (NFR-4.1). Tick a
sub-task's box only when its code and its tests are on the branch and green.

> **PR boundaries:** Task 1 → ROADMAP 71. Task 2 → ROADMAP 72. … Task 8 → ROADMAP 78.
> One task per PR; never combine two tasks in one PR.
>
> **Routing strategy (CRITICAL-3):** Tasks 2–7 mount the SPA at `/app` and `/app/*` ONLY; the
> legacy `GET /` and `GET /ui` keep serving `web-ui.ts` the whole time. Task 8 is the cutover:
> it rewires `GET /` and `GET /ui` to the SPA and deletes `web-ui.ts`. The operator keeps using
> the app (including from a phone) throughout the migration.
>
> **Hash routing (HIGH-5):** all client routes are hash-based (`#/`, `#/sessions/:id`). No
> history-API paths anywhere.

---

- [x] 1. Client build infrastructure + history/SSE seam field (ROADMAP 71)
  > **Broker id prerequisite (HIGH-B):** before this task merges, verify in `src/sse-broker.ts`
  > that the broker assigns consecutive SSE ids to VALID entries only, by incrementing its own id
  > counter once per valid entry — malformed lines are dropped before id assignment and never
  > advance the counter, so ids within a slice are always contiguous. `last_event_id` is therefore
  > the broker's id counter value for the LAST valid entry, NOT the raw line count
  > `skipped_lines + entries.length`. The `first_event_id = last_event_id - (entries.length - 1)`
  > derivation in sub-task 1.8 depends on this no-gaps guarantee. If the broker does NOT drop
  > malformed lines before id assignment or does NOT assign contiguous ids to valid entries,
  > the id-derivation approach must be redesigned and this task is BLOCKED until that is resolved.
  - [x] 1.1 Create `client/` with its own `package.json` declaring Svelte 5 (`svelte` `^5`),
    Vite (`^5`), Tailwind CSS pinned to the v3 line (`tailwindcss` `^3.4.0`, must NOT resolve to
    v4), and TypeScript, plus the exact dev dependencies: `postcss ^8.4.0`, `autoprefixer ^10.4.0`,
    `@sveltejs/vite-plugin-svelte ^4.0.0`, `svelte-check ^4.0.0`, `vitest ^2.0.0`,
    `@testing-library/svelte ^5.0.0`, `jsdom ^25.0.0`; and `dev` / `build` / `check`
    (`svelte-check`) / `test` (`vitest run`) / `test:watch` (`vitest`) scripts. Do NOT add
    `svelte-routing` or any external routing library — hash routing is hand-rolled in
    `client/src/lib/router.svelte.ts` via the native `hashchange` event (HIGH-4). (Req 1.1, 1.2,
    1.9; HIGH-8.)
  - [x] 1.2 Add `client/vite.config.ts`, `client/svelte.config.js`, `client/tailwind.config.ts`,
    and `client/postcss.config.js`. Configure the Vite dev server with `port: 5174`,
    `strictPort: true`, `allowedHosts: ['localhost','127.0.0.1']`, `hmr: { port: 5175 }`, and a
    proxy of `/api`, `/sessions` (`ws: true`), `/repos`, `/projects`, `/config` to
    `http://localhost:${process.env.CONTROL_PORT ?? '8787'}`. Set `base: '/app/'` (CRITICAL-1).
    Add the `@shared/logic` alias to `../src/ui/logic.ts` (the ONLY cross-directory import) and
    set `server.fs.allow: ['..']` so Vite can serve `../src/ui/logic.ts` in dev (HIGH-3).
    (Req 1.1, 2.2; design: dev proxy, Vite base + asset paths, shared logic.)
  - [x] 1.3 Add `client/tsconfig.json` targeting the DOM lib; it must NOT extend the root
    tsconfig (Req 1.5). Add a `compilerOptions.paths` entry
    `{ "@shared/logic": ["../src/ui/logic.ts"] }` (one level up, since `client/` and `src/` are
    siblings) mirroring the Vite alias so `svelte-check`
    and the TS language service resolve the shared module (HIGH-3).
  - [x] 1.4 Add `client/index.html` with
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
    and the `<!--__DAEMON_TOKEN__-->` sentinel before `</head>` (Req 1.4; design: token embed).
    Acceptance: `svelte-check` exits 0 with the `@shared/logic` alias resolving correctly through
    the tsconfig `paths` entry (HIGH-3).
  - [x] 1.5 Add `client/src/app.css` defining the full palette as `:root` CSS custom properties
    with the exact token names and values in Req 1.7, and wire Tailwind base/components/utilities
    layers (Req 1.7).
  - [x] 1.6 Add `client/src/main.ts` + `client/src/App.svelte` as a minimal "Hello World" mount
    (no feature UI yet).
  - [x] 1.7 Add root `package.json` scripts `build:client` (`npm --prefix client run build`) and
    `dev:client` (`npm --prefix client run dev`), leaving `start`, `dev`, `typecheck`, `test`,
    `test:*` unchanged (Req 1.6).
  - [x] 1.8 **Backend seam (CRITICAL-2 / HIGH-B):** add the additive `first_event_id: number | null`
    and `last_event_id: number | null` fields to the `GET /sessions/:id?lines=200` response in
    `src/web-routes.ts`. `last_event_id` is the broker's own id counter value for the LAST valid
    entry in the slice (the counter advances once per valid entry, so this is NOT the raw line
    count `skipped_lines + entries.length` and NOT a 1-based line index); `first_event_id` is the
    broker id of the FIRST valid entry, computable as `last_event_id - (entries.length - 1)` given
    the no-gaps guarantee, where `entries.length` counts VALID entries only; both are `null` when
    `entries` is empty. The broker assigns consecutive SSE ids to VALID entries only — malformed
    lines are dropped before id assignment and never advance the counter, so ids within a slice are
    contiguous and `first_event_id === last_event_id - (entries.length - 1)`. `skipped_lines` (the
    number of `stream.log` lines before the slice, `file_line_count - entries.length`) is
    informational only and is NOT used to derive ids. Change no other field and no other endpoint.
    Add a Tier 2 CROSS-CHECK test that can actually FALSIFY a broken id sequence — do NOT use an
    algebraic self-check such as `first_event_id + entries.length - 1 === last_event_id` or its
    twin `last_event_id - first_event_id + 1 === entries.length`; both hold by construction and
    detect nothing:
    (1) seed `stream.log` with exactly 250 lines, with 5 malformed lines scattered INSIDE the last
    200 positions (so they appear within the slice, not only ahead of it);
    (2) call `GET /sessions/:id?lines=200` and assert `entries.length === 195` (200 − 5 malformed),
    assert `last_event_id === 250 - (count of malformed lines anywhere before the window end)`, and
    assert `first_event_id === last_event_id - 194` (also assert both fields are `null` for an
    empty session);
    (3) open SSE with `Last-Event-ID: <first_event_id - 1>` to replay the entire slice from SSE;
    (4) collect 195 SSE frames and assert, for every 0-indexed `i`, that frame `i` has SSE
    `id === first_event_id + i` AND its `data` field matches `entries[i].ts` (proving the correct
    entries replay in order, not the malformed ones).
    The test does NOT hang: the whole window is present in `stream.log` before the subscribe, and
    the SSE endpoint supports replay from `Last-Event-ID` (Req 10.1, 10.2, 10.4; NFR-2.1).
  - [x] 1.9 Add `client/dist/` to `.gitignore`. Verify `npm run build:client` emits
    `client/dist/index.html` and exits 0, the gzipped JS payload is under 300 KB, and
    `npm run check` passes (Req 1.3; NFR-1.1).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.9, 1.10, 10.1, 10.2, 10.4; NFR-1.1, NFR-2.1, NFR-2.3, NFR-3.1_

- [x] 2. Hono SPA serving under /app + dev proxy wiring (ROADMAP 72)
  - [x] 2.1 Add `src/web-spa.ts` exporting `isDevMode(nodeEnv)`, `embedTokenFor(c, deps)`, and
    `registerSpaRoutes(app, deps)` (`SpaServingDeps`: `log`, `clientDist` default `./client/dist`,
    `nodeEnv`, `token: string | null`, `bindPublic: boolean`, `hasProxyProof(c): boolean`).
    `embedTokenFor(c, deps)` returns `deps.token` ONLY when `!deps.bindPublic && !deps.hasProxyProof(c)`
    (direct loopback access), else `null`, so the token is never embedded on a public bind or a
    proxied/tunnel request (CRITICAL-A; HIGH-2; design: backend changes). Add a unit test covering
    all 4 combinations of `bindPublic` ∈ {true,false} × `hasProxyProof(c)` ∈ {true,false}:
    ONLY `{ bindPublic: false, hasProxyProof: false }` shall return the token; the other three
    combinations shall return `null`.
  - [x] 2.2 Prod branch, asset catch-all: register
    `app.use('/app/*', serveStatic({ root: './client/dist', rewriteRequestPath: (p) => p.replace(/^\/app/, '') }))`
    from `@hono/node-server/serve-static`, AFTER all API routes. The `rewriteRequestPath` strips
    the `/app` prefix so assets referenced under `/app/assets/*` (Vite `base: '/app/'`) resolve
    to `client/dist/assets/*` with the correct MIME. `index.html` is NOT served through this
    catch-all. Do NOT add any `/ui` SPA prefix (Req 2.1, 2.5, 2.8; design: Vite base + asset
    paths, CRITICAL-1).
  - [x] 2.3 Dev behavior (`NODE_ENV === 'development'`): the daemon does NOT serve/proxy `/app`
    (Vite owns it at `:5174` and proxies the API back); `registerSpaRoutes` is a no-op for `/app`
    in dev (Req 2.2).
  - [x] 2.4 Missing-build guard: when prod and `./client/dist/index.html` is absent, log a
    warning naming the path and still register the `/app` route so the API and legacy UI keep
    serving (Req 2.6).
  - [x] 2.5 Shell handler + wiring. Register the bare-path shell routes
    `app.get('/app', (c) => serveIndexWithOptionalToken(c))` and
    `app.get('/app/', (c) => serveIndexWithOptionalToken(c))` BEFORE the `/app/*` asset catch-all
    (2.2) so the shell wins for `/app` and `/app/`. `serveIndexWithOptionalToken` reads
    `client/dist/index.html`, injects
    `<script>window.__DAEMON_TOKEN=${JSON.stringify(token)}</script>` into the sentinel (using
    `JSON.stringify(token)` so special characters are escaped safely) when `embedTokenFor(c, deps)`
    returns a token (i.e. ONLY `!bindPublic && !hasProxyProof(c)`) and otherwise replaces the
    sentinel with empty, sets `Cache-Control: no-store` on the token-injected shell response, and
    returns `text/html` (CRITICAL-A). `SpaServingDeps`
    carries `token`, `bindPublic`, and `hasProxyProof(c)` (HIGH-2). Then wire `registerSpaRoutes`
    into
    `src/web-server.ts` AFTER `app.route('/', routes)` so API routes win; leave the legacy
    `GET /` and `GET /ui` `renderWebUI` handlers in place — do NOT delete
    `renderWebUI`/`src/web-ui.ts` in this task. Ensure the bearer-auth middleware stays scoped to
    the API prefixes (`/sessions/*`, `/repos/*`, `/projects`, `/config`) and does NOT cover
    `/app/*`, so static assets remain public (Req 2.3, 2.4, 2.7, 2.9; HIGH-1; design: token embed
    decision, CRITICAL-1).
  - [x] 2.6 Playwright (`test/browser/spa/serving.spec.ts`): `GET /app` and `GET /app/` return
    200 + `text/html` from the dedicated shell handler; `GET /app/assets/index.js` returns a
    hashed asset with its correct MIME **and HTTP 200 without an `Authorization` header** (static
    assets are public); a shell served for a direct-loopback request (`bindPublic:false`,
    no proxy proof) embeds `window.__DAEMON_TOKEN` AND carries `Cache-Control: no-store`, while a
    shell served for a public bind or a proxied/tunnel request embeds NO token (CRITICAL-A);
    `GET /` and `GET /ui` still return the legacy UI; an API route
    (`GET /sessions`) is handled by the daemon, not the SPA route (Req 2.1–2.8; HIGH-1; CRITICAL-A;
    NFR-4.1, NFR-4.2).
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8; NFR-2.1, NFR-4.1, NFR-4.2_

- [x] 3. Auth flow + typed API client + SSE stream client (ROADMAP 73)
  - [x] 3.1 Add `client/src/lib/logic.ts` re-exporting `@shared/logic`, and
    `client/src/lib/types.ts` with CLIENT-OWNED DTOs mirroring the backend shapes
    (`SessionSummary`, `SessionListResponse`, `SessionMeta`, `StreamEntry`,
    `SessionDetailResponse` INCLUDING `first_event_id: number | null` and
    `last_event_id: number | null`). The client must NOT import types from `../src/` (only the
    `@shared/logic` alias is allowed) (Req 3.6, 10.1; NFR-2.2; HIGH-8).
  - [x] 3.2 Add `client/src/lib/stores.svelte.ts` with runes state (`auth` with
    `error: 'none'|'missing'|'expired'`, `sessionList`, `createChatState`) and token resolution in
    the exact precedence: (1) URL `?token` → write `localStorage['ar_token']` AND
    `window.__DAEMON_TOKEN`, strip via `history.replaceState`; (2) non-empty
    `window.__DAEMON_TOKEN` → persist to `localStorage` (overwrite stale); (3) stored
    `localStorage['ar_token']`; else `auth.error='missing'`. Add the lockout handler that enters
    the 'expired' state on 401/403 (Req 3.1, 3.2, 3.5, 3.7).
  - [x] 3.3 Add `client/src/lib/api.ts`: typed functions for the sessions-only endpoints
    (`listSessions`, `getSession` returning `first_event_id`/`last_event_id`, `inject`,
    `interrupt`), each attaching
    `Authorization: Bearer <token>`; on 401 OR 403, clear `ar_token`, abort active SSE, enter the
    "Session expired — reload" state, and do not retry. Do NOT add repos/projects/config/kill
    functions (Req 3.3, 3.4, 3.6, 5.8).
  - [x] 3.4 Add `client/src/lib/sse.ts`: `fetch`-based stream reader using an `AbortController`
    that parses SSE frames (`event`/`id`/`data`, ignore `:` comment lines), seeds the first
    `Last-Event-ID` from the history `last_event_id` (omit the header when null), sends the highest
    seen id on reconnect via `trackLastEventId`, dedups via `mergeEvents`, reconnects on drop with
    `computeBackoff`, handles 404 ("not found", no reconnect) / 410 ("ended", no reconnect) /
    401|403 (expired lockout) / other non-200 (wait 5 s then backoff), applies a 60 s stall timer
    (reset by frames and `:heartbeat`) that aborts+reconnects, stops on `session_ended`, and
    reports `live`/`reconnecting` status. `close()` calls `controller.abort()` (Req 4.1–4.9).
  - [x] 3.5 Unit (vitest) — auth: token precedence resolution (URL > `__DAEMON_TOKEN` >
    localStorage, fresh overwrites stale); 401/403 lockout clears token and aborts SSE — all with
    no network (Req 3.1–3.5).
  - [x] 3.6 Unit (vitest) — SSE client against a STUBBED `fetch` (HIGH-7). Mock a `ReadableStream`
    that emits SSE frames so the client is tested without a live server. Cover: SSE frame parser
    (`event`/`id`/`data`, ignore `:` comment lines); first-connect vs reconnect `Last-Event-ID`
    (seed from history `last_event_id`, omit when null; reconnect sends the highest seen id);
    404/410/non-200 branches; the 60 s stall timer; `session_ended` stops reconnect. Add the two
    required dedup tests:
    - **History load + SSE connect** with the correct `Last-Event-ID` from history produces NO
      duplicate entries.
    - **Disconnect + reconnect** replays only the missing events (no re-render of events already
      received). (Req 4.1–4.9.)
  - [x] 3.7 Playwright (`test/browser/spa/auth.spec.ts`) — AUTH ONLY (SSE browser tests moved to
    Task 6.11 per HIGH-7): `?token` stripped from the URL bar; a fresh `?token` overwrites a stale
    stored token; API requests carry the bearer header; a stored-token second visit succeeds
    (200); a 401/403 shows the "expired" state and clears the token (Req 3.1–3.4, 3.7; NFR-4.1).
    Do NOT put end-to-end SSE assertions here; those run against a real Hono server in Task 6.11.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9; NFR-2.2_

- [x] 4. Mobile-first session list view + single Sessions nav (ROADMAP 74)
  - [x] 4.1 Add `client/src/routes/router.svelte.ts` using `parseHashRoute` for `#/` (list) and
    `#/sessions/<id>` (chat), and render the matching view from `App.svelte`. Define ONLY these
    two routes — no `#/repos`, `#/config`, or `#/projects` (design: routing; Req 5.8).
  - [x] 4.2 Add `SessionList.svelte` + `SessionCard.svelte`: populate from a single
    `api.listSessions()` call; each card shows status badge (color via `statusToBadge`), repo
    name, created timestamp, and `waiting_for` when present; cards ≥72 px tall, full-width below
    768 px (Req 5.1, 5.2, 5.5; NFR-1.2).
  - [x] 4.3 Add `Header.svelte` (simple header with the Sessions title, shown at all tiers; no
    tab bar, no Repos/Config). There is NO multi-tab bottom/top navigator (Req 5.3, 5.4, 5.8).
  - [x] 4.4 Activating a card navigates to `#/sessions/:id`; all list/nav interactive elements
    present ≥44×44 tap targets (Req 5.6, 5.7).
  - [x] 4.5 Unit (vitest): list renders from one stubbed `listSessions` response; badge colors
    map via `statusToBadge`; no Repos/Config element exists in the DOM (Req 5.1, 5.2, 5.8).
  - [x] 4.6 Playwright (`test/browser/spa/list.spec.ts`): list → detail navigation via hash;
    exactly one `GET /sessions` request on load; no Repos/Config nav present; screenshots at
    375 px and 1280 px (Req 5.1, 5.6, 5.8; NFR-1.2, NFR-4.1).
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8; NFR-1.2, NFR-3.2_

- [x] 5. Core chat view — bubble renderer, all entry kinds (ROADMAP 75)
  - [x] 5.1 Add `ChatView.svelte`: fetch history via `api.getSession(id, 200)` (capturing
    `entries`, `meta`, `first_event_id`, `last_event_id`), normalize each raw entry with
    `parseStreamEntry`, render in
    ascending `id` order; no SSE yet. Implement Svelte-native rendering from the `ParsedEntry`
    union — do NOT port `renderStreamEntry` from `web-ui.ts` (Req 6.1, 6.9).
  - [x] 5.2 Add `MessageBubble.svelte` (right-aligned; **plain-text content, no `{@html}` in v1**;
    `--agent-bubble-*` tokens) for `agent_chunk`/`agent_message`, with chunk reassembly by turn
    (Req 6.2, NFR-6.2; design: bubble reassembly, safe rendering boundary HIGH-D).
  - [x] 5.3 Add `SystemPill.svelte` (centered; badge color `green→--success`, `yellow→--warning`,
    `red→--error`) for `system` (Req 6.3).
  - [x] 5.4 Add `ToolCallCard.svelte` (full-width collapsible; `tool_update` text appended by
    `toolCallId`; collapsed by default below 768 px) and `PermissionCard.svelte` as a READ-ONLY
    card showing the request title only — NO Accept/Decline or other action buttons (Req 6.4,
    6.5, 6.8).
  - [x] 5.5 Add `InternalPill.svelte` (minimized gray pill using `formatMetadataPill`, expandable)
    and `UnknownPill.svelte` (shows `typeLabel` only, no payload) (Req 6.6, 6.7).
  - [x] 5.6 Constrain bubbles to `max-w-[85vw]` below 768 px; chat container `overflow-x: hidden`
    and code blocks `overflow-x: auto; max-width: 100%` (Req 6.8; HIGH-13).
  - [x] 5.7 Unit (vitest): each `ParsedEntry` kind renders its component from stubbed entries;
    `PermissionCard` renders no `<button>` action controls; agent content is rendered as
    plain text in v1 (no `{@html}` anywhere; the JSON pivot uses `textContent`). v1 XSS coverage
    targets the ACTUAL v1 render path — do NOT test `renderMarkdown` (it is v2-only and unwired in
    v1). Instead (HIGH-2 / NFR-6.3): render an `agent_message` entry whose content is
    `<img src="x" onerror="window.xss=1">` and assert the DOM contains no `<img>` element and
    `window.xss` is `undefined` (proves text interpolation, not HTML). The `{@html}` CI lint check
    (`grep -r '{@html' client/src/ && exit 1 || exit 0`) is enforced via the Task 5 definition of
    done below (Req 6.1–6.7; NFR-6).
  - [x] 5.8 Playwright (`test/browser/spa/chat-render.spec.ts`): every entry kind renders with its
    component from a seeded history; permission card has no action buttons; bubbles `max-w-[85vw]`
    and tool cards collapsed at 375 px; a completed-session history load shows NO streaming cursor
    or tool spinners; screenshots at 375 px and 1280 px (Req 6.1–6.9, 7.2, 7.3; NFR-4.1).
  - [x] 5.9 **Task 5 definition of done — `{@html}` invariant (HIGH-2 / NFR-6.3):** add a CI lint
    check `grep -r '{@html' client/src/ && exit 1 || exit 0` that FAILS the build if any `{@html}`
    directive appears anywhere under `client/src/`. v1 renders all content as plain text so this
    already passes; the check makes "no `{@html}` in v1" an enforced invariant. This check is part
    of the Task 5 definition of done and shall run in CI (Req 6.2; NFR-6.2, NFR-6.3).
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9; NFR-2.2, NFR-3.2, NFR-6_

- [x] 6. Live SSE streaming + streaming states + operator controls (ROADMAP 76)
  - [x] 6.1 Wire `connectStream` from `src/lib/sse.ts` into `ChatView.svelte` for
    `meta.status === 'active'` sessions, seeding the first connect from `last_event_id`; append
    incoming entries without reload, merged by `id`; call `close()` (abort) in `onDestroy`, on
    `expired`, and on `session_ended` (Req 7.1, 4.6).
  - [x] 6.2 Render the pulsing `▌` cursor on the active agent bubble ONLY when
    `meta.status === 'active'` AND no turn-complete entry (a `router`-source `session_verified`,
    `session_ended`, or `prompt_injected`) has appeared after the highest-`id` agent-source
    `agent_message_chunk`. Clear the cursor per turn when such an entry arrives (Req 7.2; HIGH-5).
  - [x] 6.3 Render a spinner on an in-progress `ToolCallCard` ONLY when the session is active AND
    the tool call is not yet finished — i.e. it has no following `tool_call_update` for the same
    `toolCallId` whose ACP `status` is `'completed'` or `'failed'` (ACP has no `complete: boolean`
    field; use the `status` field, HIGH-C). Hide the spinner and show the expand arrow once the
    session is inactive OR a `'completed'`/`'failed'` status has arrived; suppress the expand
    affordance until then (Req 7.3).
  - [x] 6.4 Add `ReconnectPill.svelte` shown while `connection === 'reconnecting'` and removed on
    `'live'` (Req 7.4).
  - [x] 6.5 Add `SkeletonBubble.svelte` shown while the history fetch is in flight, replaced on
    resolve (Req 7.5).
  - [x] 6.6 Add `Composer.svelte` — ALWAYS visible, text input (font ≥16 px) + Send calling
    `api.inject(id, prompt)`; on mobile/tablet a fixed bottom bar above the detail bar with
    `padding-bottom: env(safe-area-inset-bottom)` (Req 7.6, 8.7).
  - [x] 6.7 Add `DetailBar.svelte` (mobile/tablet chat bottom bar: back + title + Interrupt) and
    the Interrupt control (labeled "Interrupt", not "Kill") calling `api.interrupt(id)` behind a
    tap-confirmable dialog reading "Interrupt the current agent turn?" (no hover); after the call
    resolves, re-fetch `meta` via `api.getSession(id)` and do NOT assume the session ended; tap
    target ≥44×44 (Req 5.3, 7.7; HIGH-6).
  - [x] 6.8 Mobile chat layout: chat container `height: 100dvh`; auto-scroll to bottom on new SSE
    entry UNLESS the user scrolled up >100 px, in which case show a tap-to-scroll "↓ New messages"
    badge (Req 7.1; HIGH-13).
  - [x] 6.9 On `session_ended`, append the ended system pill, hide cursor/spinners, and disable
    (keep visible) the Composer Send and Interrupt controls (Req 7.8).
  - [x] 6.10 Unit (vitest): cursor shows only on active+incomplete and never on a non-active
    history load; spinner only on active+incomplete tool call; `session_ended` disables controls —
    all against a stubbed SSE sequence (Req 7.2, 7.3, 7.8).
  - [x] 6.11 Playwright (`test/browser/spa/sse-live.spec.ts`) — END-TO-END SSE against a REAL Hono
    server (the SSE browser tests moved here from Task 3 per HIGH-7). Assert the full stack: SSE
    connects with the correct first `Last-Event-ID` derived from the history `last_event_id` and
    receives a `log` frame; an agent action appends new bubbles without reload; dropping the stream
    shows the reconnect pill, then reconnects with the highest-id `Last-Event-ID` and entries
    resume with NO duplicate ids; the Composer sends an inject; the Interrupt confirmation
    ("Interrupt the current agent turn?") works by tap and re-fetches `meta` afterward;
    `session_ended` disables controls; screenshots at 375 px and 1280 px (Req 4.1, 4.3, 4.4, 7.1,
    7.4, 7.6, 7.7, 7.8; NFR-4.1).
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

- [ ] 7. JSON pivot toggle + polish + accessibility (ROADMAP 77)
  - [ ] 7.1 Add `JsonToggle.svelte` (`{ }` glyph, ≥44×44) composed into every bubble/card/pill;
    per-entry toggle state swaps the rendered view for `<pre>{JSON.stringify(entry, null, 2)}</pre>`
    and back; ALWAYS visible on all viewports (a small `{ }` chip on mobile/tablet; desktop MAY
    add hover-reveal on top of the always-visible baseline) (Req 8.1, 8.2).
  - [ ] 7.2 Audit every component so no hardcoded hex literal remains; all colors reference the
    Req 1.7 custom properties (Req 8.3; NFR-3.1).
  - [ ] 7.3 Add `role="log"` and `aria-live="polite"` to the conversation container; make entries
    focusable (Req 8.4).
  - [ ] 7.4 Add `HelpOverlay.svelte` and keyboard handling at `lg`+ (≥1024 px): `J` toggles JSON
    on the focused entry, `?` opens the help overlay (Req 8.5).
  - [ ] 7.5 Enforce input font size ≥16 px (Composer included) and body font ≥14 px (Req 8.7).
  - [ ] 7.6 Unit (vitest): JSON toggle swaps rendered↔`<pre>` per entry; toggle is present/visible
    at a mobile width (Req 8.1, 8.2).
  - [ ] 7.7 Playwright (`test/browser/spa/json-a11y.spec.ts`): JSON toggle flips a bubble to
    `<pre>` and back and is visible at 375 px; `role="log"`/`aria-live` present; a tap-target
    bounding-box audit asserts every interactive element ≥44×44; screenshots of the JSON view at
    375 px and 1280 px (Req 8.1, 8.2, 8.4, 8.6; NFR-4.1).
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7; NFR-3.1_

- [ ] 8. Cutover: migrate / and /ui to the SPA, remove the monolith (ROADMAP 78)
  - [ ] 8.1 Rewire `GET /` and `GET /ui` to serve `client/dist/index.html` (with the optional
    token sentinel embed), delete `src/web-ui.ts`, and remove the `renderWebUI` import and all
    `renderWebUI` references from `src/web-server.ts` (Req 9.1).
  - [ ] 8.2 Remove or update tests asserting against the legacy server-rendered HTML string so
    `npm run typecheck` and `npm test` both exit 0 (Req 9.2).
  - [ ] 8.3 Confirm `GET /`, `GET /ui`, and `GET /app` all return the SPA (200) after the cutover
    (Req 9.5).
  - [ ] 8.4 Playwright (`test/browser/spa/smoke.spec.ts`): full flow (session list → open a
    session → chat renders) at 375 px and 1280 px (Req 9.3; NFR-4.1).
  - [ ] 8.5 Update `README.md` to document `build:client`, `dev:client`, the `/app` mount during
    migration, and the `NODE_ENV=development` Vite proxy workflow (Req 9.4).
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

---

## ROADMAP mapping

| ROADMAP item | Task | Scope summary |
|---|---|---|
| 71 | 1 | `client/` scaffold: Svelte 5 + Vite (`base: '/app/'`) + Tailwind v3.4, palette, root build scripts, Hello-World SPA, Vite dev proxy; **plus** the additive `first_event_id`/`last_event_id` fields on `GET /sessions/:id` (CRITICAL-2) |
| 72 | 2 | `src/web-spa.ts` serves the SPA under `/app` (prod `serveStatic root ./client/dist`), token sentinel embed, wired after API routes; legacy `/` + `/ui` untouched |
| 73 | 3 | Token precedence (URL > `__DAEMON_TOKEN` > localStorage), 401/403 lockout, sessions-only typed `api.ts`, `fetch`+`AbortController` SSE client with first `Last-Event-ID` from history, backoff, stall timer, 404/410 handling |
| 74 | 4 | Mobile-first session list, single Sessions header (no Repos/Config), hash routing, one-request load |
| 75 | 5 | Chat view: all `ParsedEntry` kinds rendered (historical only); read-only permission card |
| 76 | 6 | Live SSE wiring + streaming states (cursor/spinner conditions, reconnect pill, skeletons, ended), Composer (inject) + Interrupt, mobile chat layout |
| 77 | 7 | JSON pivot toggle (always visible), custom-property audit, ARIA/keyboard, tap-target audit |
| 78 | 8 | Cutover `/` + `/ui` to SPA, delete `src/web-ui.ts`, update tests, smoke flow, README |

## Dependency order

```
71 ──▶ 72 ──▶ 73 ──▶ 74 ──▶ 75 ──▶ 76 ──▶ 77 ──▶ 78
```

Task 72 depends on 71 (needs `client/dist/` and the sentinel). Task 73 depends on 71 (client
project + the `first_event_id`/`last_event_id` seam). Tasks 74–77 depend on 73 (api + sse
clients). Task 78 (the
cutover) depends on 77 (SPA is feature-complete before `/` and `/ui` are migrated and the
monolith is removed).

## Definition of done (per task)

- `npm run typecheck` and `npm test` exit 0 (backend tiers 1+2 unaffected).
- `npm run build:client` exits 0 and stays under the 300 KB gzipped JS budget (NFR-1.1).
- `npm run check` (svelte-check) exits 0.
- Unit tests (vitest + `@testing-library/svelte`) pass with no live network; the SSE broker is
  stubbed.
- Playwright specs for the task pass headless with screenshots at `375×812` and `1280×800` where
  the task renders UI (NFR-4.1, NFR-4.2); CI runs `npm run build:client`, then `npm run test` in
  `client/` (vitest unit tests), then the Playwright browser tests (HIGH-8).
- No hardcoded hex literals introduced in components (checked explicitly from Task 7 onward).
- No change to `src/web-auth.ts` or `src/sse-broker.ts`, and no backend API change beyond the
  additive `first_event_id`/`last_event_id` fields on `GET /sessions/:id` (NFR-2.1).

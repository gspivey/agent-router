# Requirements — Web UI Overhaul (SPA)

## Introduction

agent-router is a single-user TypeScript daemon (Hono 4.x, `tsx`, and a synchronous
SQLite binding) that orchestrates Kiro CLI agents against GitHub repositories. Its operator dashboard
is currently a single ~900-line server-rendered module, `src/web-ui.ts`, that returns
one HTML string with inlined `<style>` and `<script type="module">` blocks. There is no
framework, no bundler, and no component model, which makes the UI costly to extend and
hard to make genuinely responsive.

This feature replaces `src/web-ui.ts` with a Svelte 5 single-page application (SPA) built
with Vite and Tailwind CSS. During the migration the SPA is mounted at `/app` and `/app/*`
so the legacy UI at `GET /` and `GET /ui` keeps working untouched; only the final cutover item
migrates `GET /` and `GET /ui` to the SPA and deletes `src/web-ui.ts`. The daemon serves the
compiled SPA from `client/dist/` in production and proxies to the Vite dev server in
development. The backend REST and SSE API is unchanged except for one additive field on the
`GET /sessions/:id` detail response (`first_event_id` and `last_event_id`), which is required to
make history and SSE dedup correct.

The operator accesses the dashboard at least 50% of the time from a phone, including during
migration. **Mobile is a day-one requirement, not a later enhancement**, and the
legacy UI must stay available throughout. Every component is specified mobile-first. The session
stream view is redesigned to render as a chat conversation rather than a log dump.

### Terminology

- **SPA** — the Svelte 5 client application compiled by Vite into `client/dist/`, mounted at
  `/app` during migration and at `/` + `/ui` after the final cutover.
- **Daemon token** — the bearer token minted on each daemon start (`src/daemon-token.ts`),
  used as `Authorization: Bearer <token>` on every authenticated API request.
- **StreamEntry** — a raw `stream.log` NDJSON line, shaped
  `{ ts: string; source: 'router' | 'agent'; type: string; [key: string]: unknown }`
  (`src/session-files.ts`).
- **ParsedEntry** — the normalized discriminated union produced by `parseStreamEntry()`
  in `src/ui/logic.ts`, used to drive chat rendering.
- **first_event_id / last_event_id** — the SSE event ids of the FIRST and LAST valid entries in
  the slice returned by `GET /sessions/:id`. `last_event_id` is the broker's own id counter value
  for the LAST valid entry in the slice (the counter advances once per valid entry), and
  `first_event_id` is the broker id stored alongside the FIRST valid entry. The broker SHALL
  assign consecutive SSE ids to valid entries only — malformed lines are dropped before id
  assignment and never advance the counter, so ids within a slice are always contiguous. These ids
  are therefore NOT a raw line count: `last_event_id` is never `skipped_lines + entries.length`
  (which would include malformed lines) and is not a 1-based line index. With the no-gaps
  guarantee, `first_event_id === last_event_id - (entries.length - 1)` where `entries.length` is
  the count of VALID entries only, and the id of the entry at 0-indexed position `i` is
  `first_event_id + i`. The SPA uses `last_event_id` to request SSE replay from the correct
  offset.
- **Loopback bind** — the daemon bound to `127.0.0.1` with no trusted-proxy proof present,
  the condition under which the daemon currently embeds the token into the page
  (`embedToken === true`).
- **Tap target** — an interactive element's hit area, measured in CSS pixels.

### Dependencies and assumptions

- The backend REST/SSE API in `src/web-routes.ts`, auth in `src/web-auth.ts`, and the SSE
  broker in `src/sse-broker.ts` are **not modified** by this feature, with one exception: the
  `GET /sessions/:id` detail response gains additive `first_event_id: number | null` and
  `last_event_id: number | null` fields (CRITICAL-2 / Requirement 10). No other request/response
  shapes change, no endpoints are added or removed, and auth and broker behavior are untouched.
- `parseStreamEntry()` and the sibling pure helpers in `src/ui/logic.ts`
  (`escapeHtml`, `isSafeLinkHref`, `safeLinkHref`, `formatMetadataPill`,
  `mergeEvents`, `trackLastEventId`, `computeBackoff`, `statusToBadge`, `deriveWaitingFor`,
  `parseHashRoute`) are the authoritative stream and session-status logic. The SPA **reuses**
  this module rather than reimplementing it. (`renderMarkdown` also lives in `src/ui/logic.ts`
  but is v2 future work and is NOT used by the v1 SPA, which renders all agent content as plain
  text — see NFR-6.) `renderStreamEntry` is NOT part of this module — it
  lives in `src/web-ui.ts`, is DOM-mutation based, and is NOT portable to Svelte (see
  Requirement 6 and the design "Shared logic" section).
- The daemon continues to serve the dashboard on `config.controlPort`.
- Node.js 20+, ESM throughout, TypeScript strict mode. No build step is introduced for the
  backend; the SPA has its own Vite build confined to `client/`.
- The SPA uses **hash-based routing** (`#/`, `#/sessions/:id`). History-API paths are never used,
  so a deep-link reload never hits a JSON API endpoint and never produces a spurious 401.

---

## Requirements

### Requirement 1 — Client build infrastructure

**User Story:** As a developer, I want a Svelte 5 + Vite + Tailwind client project under
`client/`, so that the dashboard is built from maintainable components with a reproducible
build.

#### Acceptance Criteria

1.1. The repository shall contain a `client/` directory with its own `package.json`,
`vite.config.ts`, `svelte.config.js`, and `tsconfig.json` that are independent of the root
`package.json` and root `tsconfig.json`.

1.2. The client `package.json` shall declare Svelte 5 (`svelte` `^5`), Vite (`vite` `^5`),
Tailwind CSS pinned to the v3 line (`tailwindcss` `^3.4.0`, which must NOT resolve to v4), and
TypeScript as dependencies, and shall declare the exact dev dependencies listed in Requirement
1.9, and shall define `dev`, `build`, and `check` scripts (`check` runs `svelte-check`).

1.3. WHEN `npm run build` is executed inside `client/`, the build shall emit static assets
into `client/dist/` including an `index.html` entry point, and the build shall exit with
code 0.

1.4. The client `index.html` shall include `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
(`viewport-fit=cover` is required so `env(safe-area-inset-*)` resolves on iOS).

1.5. The client `tsconfig.json` shall target the DOM library and shall NOT extend the root
`tsconfig.json`.

1.6. The root `package.json` shall define a `build:client` script that runs the client build
and a `dev:client` script that runs the Vite dev server, and neither script shall alter the
existing `start`, `dev`, `typecheck`, or `test` scripts.

1.7. The client base stylesheet shall define the color palette as CSS custom properties on
`:root` using exactly these token names and values: `--bg: #0d1117`, `--surface: #161b22`,
`--border: #30363d`, `--agent-bubble-bg: #1f6feb`, `--agent-bubble-text: #ffffff`,
`--system-pill-bg: #21262d`, `--system-pill-text: #8b949e`, `--tool-card-bg: #161b22`,
`--tool-card-accent: #388bfd`, `--text-primary: #e6edf3`, `--text-muted: #8b949e`,
`--success: #3fb950`, `--error: #f85149`, `--warning: #d29922`.

1.8. WHEN the daemon runs with `NODE_ENV` unset or not equal to `development` and
`client/dist/index.html` exists, a request to `GET /app` shall return the SPA shell with
HTTP 200. (During migration `GET /` and `GET /ui` continue to return the legacy UI; see
Requirement 2 and Requirement 9.)

1.9. The client dev dependencies shall be pinned to the following majors (caret within the
stated major): `tailwindcss ^3.4.0`, `postcss ^8.4.0`, `autoprefixer ^10.4.0`,
`@sveltejs/vite-plugin-svelte ^4.0.0`, `svelte-check ^4.0.0`, `vitest ^2.0.0`,
`@testing-library/svelte ^5.0.0`, and `jsdom ^25.0.0`. No dependency range may permit
Tailwind v4. No external routing library shall be declared: hash routing is implemented in
`client/src/lib/router.svelte.ts` using the native `hashchange` event (see Requirement 5 and the
design "Routing" section).

1.10. The client `package.json` scripts shall include `"test": "vitest run"` and
`"test:watch": "vitest"` in addition to `dev`, `build`, and `check`. CI shall run `npm run test`
in `client/` before the Playwright browser tests.

---

### Requirement 2 — Hono static serving and dev proxy

**User Story:** As an operator, I want the daemon to serve the compiled SPA under `/app` in
production and proxy to Vite in development, so that one URL works in both modes without
changing the API and without disrupting the legacy UI during migration.

#### Acceptance Criteria

2.1. WHEN `process.env.NODE_ENV !== 'development'`, the daemon shall serve SPA assets for
`GET /app/*` from `client/dist/` using `serveStatic` from `@hono/node-server/serve-static`
configured with `root: './client/dist'` AND
`rewriteRequestPath: (path) => path.replace(/^\/app/, '')` so the `/app` prefix is stripped
before the path is resolved against `client/dist` (the Vite build sets `base: '/app/'`, so assets
are referenced as `/app/assets/*` but live on disk at `client/dist/assets/*`). This SPA asset
route shall be registered AFTER all API routes (`/sessions`, `/sessions/*`, `/repos/*`,
`/projects`, `/config`). `index.html` is NOT served through `serveStatic` — only through the
dedicated shell handler in Requirement 2.4.

2.2. WHEN `process.env.NODE_ENV === 'development'`, the Vite dev server shall own
`/app` and `/app/*` and shall proxy API paths (`/api`, `/sessions`, `/repos`, `/projects`,
`/config`) back to the daemon at `http://localhost:${CONTROL_PORT}` (see Requirement 2.8); the
operator loads the SPA directly from Vite at `http://localhost:5174/app` in development.

2.3. WHEN a request matches an existing API route (`/sessions`, `/sessions/:id`,
`/sessions/:id/stream`, `/sessions/:id/inject`, `/sessions/:id/interrupt`,
`/sessions/:id/kill`, `/repos/sessions`, `/repos/:repo/sessions`, `/projects`, `/config`),
the daemon shall dispatch to the existing handler and shall NOT serve SPA assets for that
request.

2.4. WHEN `GET /app` or `GET /app/` is served in production, the request shall be handled by
`serveIndexWithOptionalToken(c)` (NOT by `serveStatic`), which reads `client/dist/index.html`,
optionally injects `<script>window.__DAEMON_TOKEN="..."</script>` (Requirement 3 / the token
embed decision), and returns it with `Content-Type: text/html`. The bare-path shell routes
(`/app`, `/app/`) shall be registered before the `/app/*` asset catch-all so the shell handler
wins for those two paths.

2.5. WHEN a request for a hashed static asset emitted by the Vite build (for example a file
ending in `.js` or `.css`, referenced under `/app/assets/*` because the build sets
`base: '/app/'`) is served in production, the `/app/*` `serveStatic` catch-all shall resolve it
from `client/dist` after stripping the `/app` prefix and the response shall carry the asset's
correct MIME type (`text/javascript` or `text/css` respectively) and HTTP 200.

2.6. WHEN the daemon starts in production and `client/dist/index.html` does not exist, the
daemon shall log a warning that names the missing path and shall continue serving the API and
the legacy UI rather than exiting.

2.7. During migration (before the final cutover) the existing `GET /` and `GET /ui` routes that
call `renderWebUI()` shall remain registered and shall continue to return the legacy UI
unchanged; the SPA shall be reachable only under `/app` and `/app/*`.

2.8. The daemon shall NOT serve the SPA under any path prefix other than `/app` during
migration. There shall be no `/ui` SPA prefix, because the Vite `dist/` output places
`index.html` at the SPA root (`client/dist/index.html`), not under a `/ui` subdirectory.

2.9. The bearer-auth middleware shall be scoped to the non-SPA API routes ONLY — specifically
`/sessions/*`, `/repos/*`, `/projects`, and `/config` — and shall NOT apply to `/app/*`. Static
SPA assets must be publicly accessible: a `GET /app/assets/<hashed>.js` request shall return HTTP
200 without an `Authorization` header. The token is embedded in the delivered HTML, not required
to fetch assets.

---

### Requirement 3 — Authentication flow

**User Story:** As an operator opening a shared deep link on my phone, I want the token in the
URL to be captured and reused automatically, so that I never type a token, a fresh embedded
token always wins over a stale stored one, and the token does not linger in the address bar.

#### Acceptance Criteria

3.1. The SPA shall resolve the token in exactly this precedence order on load:
  1. URL query parameter `?token=<value>` — IF present, the SPA shall write it to `localStorage`
     key `ar_token` AND to `window.__DAEMON_TOKEN`, then remove the `token` parameter from the
     address bar via `history.replaceState` without reloading the page.
  2. `window.__DAEMON_TOKEN` (server-injected at page load) — IF present and non-empty, the SPA
     shall use it and shall persist it to `localStorage` key `ar_token`.
  3. `localStorage` key `ar_token` — the SPA shall use the stored value only when neither step 1
     nor step 2 produced a token.

3.2. The precedence in 3.1 means a fresh embedded token (steps 1–2) always overwrites a stale
stored token: WHEN a `?token` param or a non-empty `window.__DAEMON_TOKEN` is present, the SPA
shall overwrite any existing `localStorage['ar_token']` with that fresh value before issuing any
authenticated request.

3.3. WHEN the SPA issues any request to an authenticated API route, the request shall include
an `Authorization: Bearer <token>` header whose value is the resolved token (per 3.1).

3.4. WHEN any API call or SSE connect attempt returns HTTP 401 or HTTP 403, the SPA shall clear
`ar_token` from `localStorage`, stop all active SSE streams (via their AbortControllers), and
display a "Session expired — reload the page" message with a reload button, and the SPA shall
NOT retry automatically.

3.5. IF no token is available from the query parameter, `window.__DAEMON_TOKEN`, or
`localStorage`, THEN the SPA shall render the authentication-error state and shall not issue
authenticated API requests.

3.6. The SPA shall provide a typed API client module at `client/src/lib/api.ts` that exposes a
typed function for each endpoint the SPA actually uses: list sessions (`GET /sessions`), get
session detail (`GET /sessions/:id`), inject (`POST /sessions/:id/inject`), and interrupt
(`POST /sessions/:id/interrupt`); each function shall attach the bearer header and return typed
response data. The client shall NOT define functions for `/repos/sessions`,
`/repos/:repo/sessions`, `/projects`, `/config`, or `/sessions/:id/kill`, because those views
are out of scope (Requirement 5) and the kill action is served by `/sessions/:id/interrupt`.

3.7. WHEN the operator opens the dashboard a second time in the same browser with no `token`
parameter, no `window.__DAEMON_TOKEN`, and a value already stored under `localStorage` key
`ar_token`, the SPA shall use the stored token and shall issue authenticated requests
successfully (HTTP 200) against a daemon configured with that token.

---

### Requirement 4 — SSE stream client

**User Story:** As an operator watching a live session, I want the stream to connect with my
bearer token, resume cleanly after a drop, and never show an event twice, so that I see every
event exactly once even on a flaky mobile connection.

#### Acceptance Criteria

4.1. The SPA shall open the session stream using `fetch` against `GET /sessions/:id/stream`
with an `Authorization: Bearer <token>` header, an `AbortController` signal, and shall read the
response body as a `ReadableStream`, because native `EventSource` cannot set request headers.

4.2. The SPA shall parse Server-Sent-Event frames from the stream, extracting the `event`
name, the numeric `id`, and the `data` payload for each frame, and shall ignore comment lines
that begin with `:` (including the `:ok` preamble and `:heartbeat` lines).

4.3. On the FIRST SSE connect for a session, IF the `last_event_id` returned by the history load
(Requirement 10) is non-null, the SPA shall send `Last-Event-ID: <last_event_id>` so the broker
replays only entries after that id; IF `last_event_id` is null (new session with no entries), the
SPA shall send no `Last-Event-ID` header. On every reconnect, the SPA shall send the highest
`id` it has received so far in the `Last-Event-ID` header.

4.4. WHEN two frames carrying the same `id` are received across a reconnect, the SPA shall
render exactly 1 entry for that `id` (deduplicate by `id`), reusing the `mergeEvents` logic
from `src/ui/logic.ts`.

4.5. WHEN the stream connection drops (read error or stream end without `session_ended`) and the
session is active, the SPA shall reconnect using exponential backoff computed by `computeBackoff`
from `src/ui/logic.ts` (first retry 1000 ms, doubling, capped at 30000 ms).

4.6. Each SSE connection shall use an `AbortController`, and the SPA shall call
`controller.abort()` on component unmount (Svelte `onDestroy`), on a 401/403 response, and on a
`session_ended` event. After a `session_ended` event the SPA shall not open a new stream
connection for that session.

4.7. WHILE the session is active, IF no SSE frame (including `:heartbeat` comments) is received
for 60 seconds, the SPA shall close the connection and reconnect (to recover from half-open
mobile TCP connections).

4.8. WHEN the SSE endpoint returns HTTP 404, the SPA shall display a "Session not found" message
and shall NOT reconnect. WHEN it returns HTTP 410, the SPA shall display a "Session ended"
message and shall NOT reconnect. WHEN it returns any other non-200 (and non-401/403) status, the
SPA shall wait 5 seconds and reconnect with exponential backoff capped at 30000 ms.

4.9. WHEN the connection drops and a reconnect is in progress, the SPA shall display a
transient reconnect indicator, and WHEN the stream reconnects successfully the SPA shall
remove that indicator.

---

### Requirement 5 — Mobile-first session list view and single-tab navigation

**User Story:** As an operator on a phone, I want a scannable list of sessions with status and
repository at a glance and large tap targets, so that I can open the right session with one
thumb.

#### Acceptance Criteria

5.1. The route `#/` shall render a session list populated from a single `GET /sessions` request,
and each list entry shall display the session's status badge, repository name, creation
timestamp, and `waiting_for` value when present.

5.2. Each session status shall map to a badge color via `statusToBadge` from
`src/ui/logic.ts`: `active` → green, `completed` → gray, `abandoned` → yellow, `failed` → red.

5.3. The SPA navigation shall have exactly ONE destination: Sessions. There is no multi-tab
navigator. Repos and Config views are out of scope for this spec. On mobile and tablet
(viewport width below 1024 CSS pixels) the list view shall present a single-row header (title only,
no tab bar); the session detail (chat) view shall present a bottom bar containing a
back-navigation button, the session title, and an Interrupt button (see Requirement 6/7), with
each control's tap target measuring at least 44×44 CSS pixels.

5.4. At viewport widths of 1024 CSS pixels or wider, the SPA shall render a single-row top header
with the Sessions title and no bottom bar.

5.5. Each session card shall measure at least 72 CSS pixels tall and shall span the full
content width at viewport widths below 768 CSS pixels.

5.6. WHEN the operator activates a session card, the SPA shall navigate to the chat route
`#/sessions/:id` for that session.

5.7. All interactive elements in the list view and navigation shall present a tap target of at
least 44×44 CSS pixels.

5.8. The SPA shall not define, link to, or route to Repos or Config views. No navigation
element, API client function, or route shall reference `/repos`, `/projects`, or `/config`.

---

### Requirement 6 — Chat view bubble renderer

**User Story:** As an operator reviewing a session, I want the stream rendered as a chat
conversation with distinct treatments per entry type, so that I can follow the agent's work
instead of reading a raw log.

#### Acceptance Criteria

6.1. The route `#/sessions/:id` shall render historical entries fetched from
`GET /sessions/:id?lines=200`, normalizing each raw entry with `parseStreamEntry()` from
`src/ui/logic.ts` before rendering. The client shall implement its own Svelte-native rendering
and shall NOT reuse `renderStreamEntry` from `src/web-ui.ts` (it is DOM-mutation based and not
portable); the `ParsedEntry` discriminated union is the data contract.

6.2. WHEN a parsed entry has kind `agent_chunk` or `agent_message`, the SPA shall render a
right-aligned message bubble whose content is rendered as **plain text** (no `{@html}`) in v1,
using the `--agent-bubble-bg` and `--agent-bubble-text` palette tokens. (Markdown rendering via
`renderMarkdown` is v2 future work per NFR-6.2 and is NOT used in v1; this resolves the earlier
Req 6.2 / NFR-6.2 conflict in favor of plain text.)

6.3. WHEN a parsed entry has kind `system`, the SPA shall render a horizontally centered pill
showing the entry's `text`, and WHEN the entry carries a `badge` the pill shall apply the
corresponding palette token (`green` → `--success`, `yellow` → `--warning`, `red` → `--error`).

6.4. WHEN a parsed entry has kind `tool_call`, the SPA shall render a full-width collapsible
card whose header shows the tool title, and WHEN parsed entries of kind `tool_update` share
the same `toolCallId`, their text shall be appended to that card's body.

6.5. WHEN a parsed entry has kind `permission`, the SPA shall render a full-width READ-ONLY card
showing the request title. The card shall display what the agent is requesting permission for
and shall NOT render Accept, Decline, or any other action control. Permission responses are out
of scope for this spec; the card is informational only (this respects NFR-2.1 — no new API).

6.6. WHEN a parsed entry has kind `internal`, the SPA shall render a minimized gray pill
showing the precomputed `text` (from `formatMetadataPill`), and the pill shall expand to show
detail when activated.

6.7. WHEN a parsed entry has kind `unknown`, the SPA shall render a gray pill showing only the
entry's `typeLabel` and shall not render raw payload content.

6.8. At viewport widths below 768 CSS pixels, message bubbles shall be constrained to a
width no greater than 85vw, and tool-call cards shall render collapsed by default and expand
when the operator activates the card header.

6.9. The chat view shall render all entry kinds without SSE connected (historical load only),
and shall render entries in ascending event-`id` order. Each log line shall be rendered exactly
once: given a history load of N entries and an SSE stream that begins from the correct offset
(Requirement 4.3), no entry shall appear twice.

---

### Requirement 7 — Live SSE streaming, streaming states, and operator controls

**User Story:** As an operator, I want new events to appear in the open chat without a reload,
clear visual cues for in-progress work, and always-visible controls to steer or stop the agent,
so that I can watch and direct the agent in real time.

#### Acceptance Criteria

7.1. WHEN the chat view is open and the SSE client receives a new entry, the SPA shall append
the rendered entry to the conversation without a page reload.

7.2. A turn is considered complete when a `router`-source entry of type `session_verified`,
`session_ended`, or `prompt_injected` appears AFTER the highest-`id` agent-source `session/update`
entry whose `sessionUpdate` is `agent_message_chunk`. The streaming cursor glyph `▌` shall be
hidden when: (a) `meta.status !== 'active'`, OR (b) a turn-complete entry (as just defined)
appears after that highest-`id` `agent_message_chunk`. The cursor shall be shown ONLY while a turn
is actively streaming — that is, while `meta.status === 'active'` AND no turn-complete entry has
been received after that `agent_message_chunk`. For a history load where `meta.status` is NOT
`active`, no cursor shall be shown regardless of entry content.

7.3. A tool-call card spinner shall be rendered ONLY WHEN both (a) the session is active AND
(b) the tool call is not yet finished, where "finished" means a following `tool_call_update` for
the same `toolCallId` carries an ACP `status` of `'completed'` OR `'failed'` (ACP has no
`complete: boolean` field; the completion signal is the `status` field). While the spinner is
shown the card shall not render an expand affordance; once the session is inactive OR a
`'completed'`/`'failed'` `status` has arrived, the spinner shall be hidden and the expand arrow
shall be shown.

7.4. WHEN the SSE connection drops, the SPA shall display a transient reconnect pill reading
`Reconnecting…`, and WHEN the connection is restored the SPA shall remove the reconnect pill.

7.5. WHILE the historical-entries fetch is in flight, the SPA shall render skeleton bubbles,
and those skeleton bubbles shall be replaced by rendered entries once the historical fetch
resolves.

7.6. The chat view shall render a `Composer.svelte` component that is ALWAYS visible, containing
a text input and a Send button that calls `POST /sessions/:id/inject`. On mobile and tablet the
composer shall be a fixed bottom bar positioned above the bottom navigation bar, with
`padding-bottom: env(safe-area-inset-bottom)`.

7.7. The chat view shall render an Interrupt button (labeled "Interrupt", not "Kill") that calls
`POST /sessions/:id/interrupt` to interrupt the CURRENT agent turn — this does not necessarily
end the session. On mobile and tablet the Interrupt button shall live in the session detail
bottom bar / header (Requirement 5.3). Activating Interrupt shall first present a confirmation
dialog reading "Interrupt the current agent turn?" that can be confirmed by tap alone (no hover
required). After the interrupt call resolves, the SPA shall re-fetch `meta` (via
`GET /sessions/:id`) to show the updated status and shall NOT assume the session has ended. The
Interrupt button's tap target shall be at least 44×44 CSS pixels.

7.8. WHEN a `session_ended` frame arrives for the open session, the SPA shall append the
session-ended system pill, hide the streaming cursor and tool spinners, and disable the Composer
Send and Interrupt controls (the controls remain visible but inert).

---

### Requirement 8 — JSON pivot, polish, and accessibility

**User Story:** As an operator debugging an event, I want to flip any bubble to its raw JSON
and to drive the UI from the keyboard, so that I can inspect payloads and use the dashboard
accessibly.

#### Acceptance Criteria

8.1. Every rendered bubble, card, and pill shall present a JSON-toggle control labeled with a
`{ }` glyph whose tap target measures at least 44×44 CSS pixels. The control shall be visible on
ALL viewports: on mobile and tablet (below 1024 CSS pixels) it shall be a small always-visible
`{ }` chip; on desktop (1024 CSS pixels or wider) it may use hover-reveal as an enhancement, but
an always-visible baseline state is required.

8.2. WHEN the operator activates an entry's JSON-toggle control, the SPA shall replace that
entry's rendered view with a `<pre>` element containing `JSON.stringify(entry, null, 2)` for
that entry only, and a second activation shall restore the rendered view; toggle state shall be
tracked per entry.

8.3. All component styling shall reference the CSS custom properties defined in Requirement
1.7, and no component shall contain a hardcoded hex color literal.

8.4. The chat conversation container shall carry `role="log"` and `aria-live="polite"` so that
appended entries are announced by assistive technology.

8.5. On desktop viewports (1024 CSS pixels or wider), WHEN an entry is focused and the operator
presses the `J` key, the SPA shall toggle that entry's JSON view, and WHEN the operator presses
the `?` key the SPA shall display a keyboard-shortcut help overlay.

8.6. Every interactive element across the SPA shall present a tap target of at least 44×44 CSS
pixels (WCAG 2.5.5), and the audit evidence shall be captured in the item's screenshots.

8.7. Text input controls (including the Composer input) shall use a font size of at least 16 CSS
pixels (to prevent iOS auto-zoom), and body text shall use a font size of at least 14 CSS pixels.

---

### Requirement 9 — Legacy-to-SPA cutover and monolith retirement

**User Story:** As a maintainer, I want the old `src/web-ui.ts` module and its route wiring
removed only after the SPA is feature-complete, so that the live operator is never disrupted and
there is a single UI implementation at the end.

#### Acceptance Criteria

9.1. The cutover (final item) shall migrate `GET /` and `GET /ui` to serve the SPA
`index.html`, delete `src/web-ui.ts`, and remove the `renderWebUI` import and its route
registrations from `src/web-server.ts`. Before this item, `GET /` and `GET /ui` continue to
return the legacy UI (Requirement 2.7).

9.2. Any test that asserts against the legacy server-rendered HTML string shall be removed or
updated so that `npm run typecheck` and `npm test` both exit with code 0 after the deletion.

9.3. A Playwright smoke test shall drive the full flow (session list → open a session → chat
view renders) at a 375 CSS pixel viewport and at a 1280 CSS pixel viewport, and both shall
pass.

9.4. The `README.md` shall be updated to document the new client build and dev workflow,
including the `build:client` and `dev:client` scripts, the `/app` mount during migration, and
the `NODE_ENV=development` Vite proxy behavior.

9.5. After the cutover, the SPA shall be the response for `GET /`, `GET /ui`, and `GET /app`
with HTTP 200.

---

### Requirement 10 — History/SSE seam (detail response shape)

**User Story:** As an operator opening a live session, I want the history load to tell the SPA
exactly where the SSE replay shall begin and give each history entry an unambiguous id, so that
no log line is ever rendered twice.

#### Acceptance Criteria

10.1. The `GET /sessions/:id?lines=200` response shall include `first_event_id: number | null`
and `last_event_id: number | null` fields alongside `meta`, `entries`, and `skipped_lines`.
`last_event_id` is the broker's own id counter value for the LAST valid entry in `entries` (the
broker increments its counter once per valid entry, so this is NOT a raw line count and NOT a
1-based line index). `first_event_id` is the broker id stored alongside the FIRST valid entry in
the returned slice, which (given the contiguity guarantee in 10.2) equals
`last_event_id - (entries.length - 1)` where `entries.length` is the count of VALID entries only.
Both are `null` when `entries` is empty (new session with no entries). These are additive backend
changes to the response shape and are the only backend API change in this feature. The existing
`skipped_lines` field is the number of `stream.log` lines before the returned slice (i.e.
`file_line_count - entries.length`); it is informational only and shall NOT be used to derive
event ids. In particular, `last_event_id` shall NOT be computed as `skipped_lines + entries.length`,
because that raw line count includes malformed lines that received no SSE id.

10.2. The broker SHALL assign consecutive SSE ids to valid entries only, by incrementing its own
id counter once per valid entry. Malformed lines are dropped before id assignment and never
advance the counter, so ids within a returned slice are always contiguous. This guarantee shall be
verified against `src/sse-broker.ts` before the backend seam (Task 1) merges; IF the broker does
not drop malformed lines before id assignment or does not assign contiguous ids to valid entries,
the id-derivation approach shall be redesigned and Task 1 is blocked. Given the no-gaps guarantee,
`first_event_id === last_event_id - (entries.length - 1)` whenever `entries` is non-empty (with
`entries.length` counting VALID entries only), and the SPA shall derive the id of the entry at
0-indexed position `i` as `first_event_id + i`. The backend shall include a CROSS-CHECK test that
can actually FALSIFY a broken id sequence — NOT an algebraic self-check such as
`first_event_id + entries.length - 1 === last_event_id` (or its twin
`last_event_id - first_event_id + 1 === entries.length`), which hold by construction and detect
nothing. The cross-check test shall: (1) seed `stream.log` with exactly 250 lines, with 5
malformed lines scattered INSIDE the last 200 positions (so they fall within the `lines=200`
window, not only ahead of it); (2) call `GET /sessions/:id?lines=200` and assert
`entries.length === 195` (200 − 5 malformed), assert
`last_event_id === 250 - (count of malformed lines anywhere before the window end)`, and assert
`first_event_id === last_event_id - 194`; (3) open SSE with `Last-Event-ID: <first_event_id - 1>`
so the broker replays the entire slice; (4) collect 195 SSE frames and assert, for every 0-indexed
`i`, that frame `i` has SSE `id === first_event_id + i` AND its `data` matches `entries[i].ts`,
proving the correct valid entries replay in order (not the malformed ones). (The test does NOT
hang: the window is fully present in `stream.log` before the subscribe, and the SSE endpoint
supports replay from `Last-Event-ID`.)

10.3. The SPA shall use `last_event_id` as the offset for its first SSE connect per Requirement
4.3: send `Last-Event-ID: <last_event_id>` when non-null, send no header when null.

10.4. The additive `first_event_id`/`last_event_id` fields shall not change any other field of
the detail response and shall not alter the `/sessions`, `/sessions/:id/stream`,
`/sessions/:id/inject`, or `/sessions/:id/interrupt` contracts.

---

## Non-Functional Requirements

### NFR-1 — Performance

NFR-1.1. The compiled SPA's total JavaScript payload shall not exceed 300 KB gzipped as
reported by the Vite build output.

NFR-1.2. The session list view shall issue exactly one `GET /sessions` request on initial load
(no per-row fan-out).

### NFR-2 — Compatibility and scope

NFR-2.1. The SPA shall consume only existing REST and SSE endpoints, with the additive
`first_event_id` and `last_event_id` fields on the `GET /sessions/:id` response (Requirement
10). It shall not require any change to `src/web-auth.ts` or `src/sse-broker.ts`, and shall not
add or remove any endpoint.

NFR-2.2. The SPA shall reuse `parseStreamEntry` and the sibling pure helpers from
`src/ui/logic.ts` as a shared module and shall not reimplement stream parsing, markdown
rendering, status-to-badge mapping, backoff computation, or hash-route parsing.

NFR-2.3. The build system shall confine all SPA tooling (Svelte, Vite, Tailwind) to the
`client/` directory and shall not introduce a bundler or transpiler into the backend build;
the backend shall continue to run under `tsx` with `tsc --noEmit` for type checking.

### NFR-3 — Maintainability and theming

NFR-3.1. All color values shall be expressed as CSS custom properties (Requirement 1.7) so a
light theme can be added later without editing component markup.

NFR-3.2. Each visual primitive (message bubble, tool-call card, system pill, permission card,
composer, navigation) shall be implemented as a discrete Svelte component file under
`client/src/components/`.

### NFR-4 — Testability

NFR-4.1. Each UI increment shall include unit coverage (vitest + `@testing-library/svelte`, no
live network, SSE broker stubbed) and Playwright coverage under `test/browser/spa/` with
assertions and screenshot evidence at a 375×812 CSS pixel (iPhone 14) viewport and a 1280×800
CSS pixel desktop viewport.

NFR-4.2. Playwright browser tests shall run headless Chromium with a single worker in CI,
consistent with the existing `playwright.config.ts`. `npm run build:client` shall pass before
browser tests run, and `npm run check` (svelte-check) shall be part of the definition of done
for every task.

### NFR-5 — Out of scope

The following are explicitly out of scope and shall not be implemented by this feature:
light mode (only the custom-property scaffolding is in scope), session-creation UI, a Repos
view, a Config view, config-editing UI, permission-response actions (the permission card is
read-only), authentication-system changes, backend API changes beyond the additive
`first_event_id`/`last_event_id` fields (Requirement 10), internationalization, a native mobile
app or PWA manifest, and real-time session-list updates via SSE (a polling timer is acceptable
for the list view).

### NFR-6 — XSS / safe rendering boundary

NFR-6.1. The SPA shall NOT use the Svelte `{@html}` directive on any value derived from
`StreamEntry` fields (agent content, tool parameters, titles, or any other payload field) without
first passing that value through an **allowlist** sanitizer (`renderMarkdown`). The sanitizer
shall permit ONLY the following HTML elements — `a`, `b`, `strong`, `em`, `i`, `code`, `pre`,
`br`, `p`, `ul`, `ol`, `li`, `blockquote`, `h1`–`h6`, `hr` — and shall strip every other tag
(including `iframe`, `script`, `style`, and `img`). It shall permit ONLY these attributes: `href`
(valid only when it is `https:`, `http:`, or `mailto:` — never `javascript:`), `class`, and `id`;
all other attributes, all `on*` event-handler attributes, and `style` shall be removed. The ONLY
value that may ever be passed to a Svelte `{@html}` directive is the output of this allowlist
sanitizer.

NFR-6.2. For v1, ALL agent content shall be rendered as plain text with no `{@html}` directive
anywhere in the SPA. `renderMarkdown()` is defined in the spec as **v2 future work** for when a
sanitized markdown renderer is added, and shall NOT be wired into any `{@html}` sink in v1. The
JSON pivot view shall render via `textContent` (also safe). (This resolves the Req 6.2 vs NFR-6.2
conflict: v1 is unambiguously plain text.)

NFR-6.3. v1 XSS testing shall target the actual v1 rendering path (plain-text interpolation),
NOT the v2-only `renderMarkdown` sanitizer, which does not exist as a wired code path in v1 and
would make tests against it meaningless. The following two checks shall be enforced:
  - A CI lint check that fails if any `{@html}` directive appears in the client:
    `grep -r '{@html' client/src/ && exit 1 || exit 0`. v1 renders all content as plain text, so
    this already holds; the check makes "no `{@html}` in v1" an enforced invariant. This check
    shall be part of the Task 5 definition of done.
  - A vitest test that renders an agent-message entry whose content is
    `<img src="x" onerror="window.xss=1">` and asserts the resulting DOM contains no `<img>`
    element and that `window.xss` is `undefined` — proving the SPA uses text interpolation (not
    HTML) for agent content.

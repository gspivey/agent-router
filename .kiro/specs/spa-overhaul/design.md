# Design — Web UI Overhaul (SPA)

## Overview

This design replaces the server-rendered monolith `src/web-ui.ts` with a Svelte 5 single-page
application that the Hono daemon serves as static assets in production and proxies to via Vite
in development. During the migration the SPA is mounted at `/app` and `/app/*`; the legacy
`GET /` and `GET /ui` keep returning the existing `web-ui.ts` HTML so the operator's daily use
(including from a phone) is never disrupted. The final cutover item migrates `GET /` and
`GET /ui` to the SPA and deletes `web-ui.ts`.

The backend REST and SSE API is untouched except for two additive fields: `GET /sessions/:id`
gains `first_event_id: number | null` and `last_event_id: number | null`. The browser-side
stream-parsing logic already lives in
`src/ui/logic.ts` as pure, DOM-free functions; the SPA imports that module directly so there is
a single source of truth for parsing, markdown rendering, status mapping, hash routing, and
backoff.

The design is mobile-first. Layout, navigation, bubble widths, and tap targets are specified
for the base (phone) breakpoint first; desktop treatments are additive. The session stream is
rendered as a chat conversation: agent output on the right, router/system events as centered
pills, tool calls and permission requests as full-width cards. The chat view always shows a
Composer (inject) and an Interrupt control (`POST /sessions/:id/interrupt`).

### Design goals

- **Single parsing source of truth.** The client reuses `parseStreamEntry` and siblings from
  `src/ui/logic.ts`. No reimplementation. `renderStreamEntry` from `web-ui.ts` is NOT reused.
- **Near-zero backend API change.** The only change is the additive `first_event_id` and
  `last_event_id` fields on the session-detail response. No endpoints are added or removed; auth
  and broker are untouched.
- **No operator disruption.** Legacy UI stays live under `/` and `/ui` until the final cutover;
  the SPA is additive under `/app` throughout the migration.
- **Mobile day one.** Every component works at 320 px and scales up.
- **Themeable.** All colors are CSS custom properties, so a light theme is a later drop-in.
- **Small payload.** Svelte compiles away the framework runtime; the gzipped JS budget is
  300 KB (NFR-1.1).

---

## Architecture

### High-level request flow (migration phase — SPA under /app)

```
                         ┌──────────────────────────────────────────┐
   Browser (SPA)         │                 Hono daemon                │
   ─────────────         │              (config.controlPort)          │
                         │                                            │
  GET /      ───────────▶│  API route match?                         │
  GET /ui                │   ├─ yes → existing handler (web-routes)  │
  GET /app   ───────────▶│   │        (/sessions, /repos, /projects, │
  GET /app/*             │   │         /config, inject/interrupt/kill)│
  GET /sessions/:id ─────▶│   ├─ GET / or /ui → legacy renderWebUI    │
  GET /sessions/:id/stream│   └─ GET /app/* → NODE_ENV check:         │
  POST /sessions/:id/...  │             ├─ development → Vite :5174   │
                         │             └─ production  → serveStatic   │
                         │                   root './client/dist'      │
                         └──────────────────────────────────────────┘
```

Route-ordering rule (Requirement 2): all API routes and their auth middleware register first;
the legacy `GET /` and `GET /ui` handlers remain; the SPA routes (`GET /app`, `GET /app/`, and
the `GET /app/*` asset catch-all) register last. A request only reaches the SPA routes when it
did not match an API route.

**Auth scope (HIGH-1).** The bearer-auth middleware is scoped to the non-SPA API routes ONLY:
`/sessions/*`, `/repos/*`, `/projects`, and `/config`. It MUST NOT apply to `/app/*`. Static SPA
assets (JS, CSS, fonts) must be publicly fetchable with no `Authorization` header, because the
token lives inside the delivered HTML (injected by `serveIndexWithOptionalToken`) and the SPA
attaches it to subsequent API calls — the assets themselves carry no secret. Scoping auth to the
API path prefixes (rather than a global `app.use('*', auth)`) is what keeps `/app/*` public; a
global auth middleware would return 401 on every asset request and the SPA shell could never
load. After the final cutover,
`GET /` and `GET /ui` are rewired to the SPA and `renderWebUI` is removed.

### Directory layout

```
agent-router/
  src/                       # existing Hono backend
    web-server.ts            # MODIFIED: add SPA /app serving; cutover rewires / and /ui
    web-routes.ts            # MODIFIED (minimal): add first_event_id/last_event_id to GET /sessions/:id
    web-spa.ts               # NEW: registerSpaRoutes(deps) → mounts SPA under /app
    web-ui.ts                # DELETED at cutover (final item)
    ui/
      logic.ts               # UNCHANGED: shared pure logic (imported by client)
  client/                    # NEW — Svelte 5 SPA (own package.json, tsconfig)
    index.html               # viewport meta (viewport-fit=cover); token sentinel comment
    package.json
    vite.config.ts
    svelte.config.js
    tsconfig.json
    tailwind.config.ts
    postcss.config.js
    src/
      main.ts                # SPA bootstrap: auth init → mount App
      App.svelte             # top-level: hash-router outlet + nav chrome
      app.css                # :root custom properties + Tailwind layers
      lib/
        logic.ts             # re-export shim → @shared/logic (= ../src/ui/logic.ts; see "Shared logic")
        types.ts             # client-OWNED DTOs (mirrors StreamEntry + response shapes)
        api.ts               # typed REST client (bearer header) — sessions-only
        sse.ts               # fetch-based SSE client (AbortController, Last-Event-ID, backoff)
        stores.svelte.ts     # Svelte 5 runes global state (auth, sessions)
      components/
        Header.svelte        # simple top header (desktop) / list header (mobile)
        DetailBar.svelte     # mobile bottom bar: back + title + Interrupt
        SessionList.svelte
        SessionCard.svelte
        ChatView.svelte
        MessageBubble.svelte
        SystemPill.svelte
        ToolCallCard.svelte
        PermissionCard.svelte  # READ-ONLY: no action buttons
        InternalPill.svelte
        UnknownPill.svelte
        Composer.svelte      # always-visible inject input + Send
        JsonToggle.svelte
        SkeletonBubble.svelte
        ReconnectPill.svelte
        HelpOverlay.svelte
      routes/
        router.svelte.ts     # hash route state (reuses parseHashRoute)
    dist/                    # build output (gitignored); served in prod under /app
  test/
    browser/
      spa/                   # NEW Playwright specs for the SPA
```

Note: there is NO `TopNav`/`BottomNav` multi-tab component and NO Repos/Config views or route
definitions — navigation has a single destination (Sessions) per Requirement 5.

### Technology and versions

| Concern            | Choice                                  | Notes |
|--------------------|-----------------------------------------|-------|
| Framework          | Svelte 5 (runes)                        | Reactive state = one update per SSE event |
| Build tool         | Vite `^5`                               | Dev server on port 5174, `strictPort: true` |
| Styling            | Tailwind CSS `^3.4.0` (v3 line only)    | Mobile-first utility classes; must NOT be v4 |
| Routing            | native `hashchange` (no library)        | `#/`, `#/sessions/:id`; reuses `parseHashRoute` |
| Language           | TypeScript strict (client tsconfig)     | DOM lib target, not root tsconfig |
| Static serving     | `@hono/node-server/serve-static`        | Already a backend dependency |
| E2E testing        | Playwright (existing config)            | Chromium headless, specs in `test/browser/spa/` |
| Unit testing       | vitest + `@testing-library/svelte`      | No live network; SSE broker stubbed |

Exact client dev dependencies (pinned to a major; see Requirement 1.9):

```jsonc
// client/package.json devDependencies (majors pinned)
{
  "tailwindcss": "^3.4.0",
  "postcss": "^8.4.0",
  "autoprefixer": "^10.4.0",
  "@sveltejs/vite-plugin-svelte": "^4.0.0",
  "svelte-check": "^4.0.0",
  "vitest": "^2.0.0",                 // HIGH-8: unit test runner for the client
  "@testing-library/svelte": "^5.0.0",// HIGH-8: component testing
  "jsdom": "^25.0.0"                  // HIGH-8: DOM environment for vitest
  // NO routing library: hash routing is implemented in
  // client/src/lib/router.svelte.ts using the native `hashchange` event (HIGH-4).
}
```

The client `package.json` scripts (HIGH-8): `dev`, `build`, `check` (`svelte-check`),
`test` (`vitest run`), and `test:watch` (`vitest`).

The client has its **own** `package.json` and dependency tree. It is not hoisted into the root
`package.json`; the root only gains two orchestration scripts (`build:client`, `dev:client`).

---

## Backend changes

Three backend files are touched: `src/web-server.ts` (wiring), a new helper `src/web-spa.ts`,
and a minimal additive change to `src/web-routes.ts` for `first_event_id`/`last_event_id`. Auth
in `src/web-auth.ts` and the SSE broker in `src/sse-broker.ts` are untouched (NFR-2.1).

### `first_event_id` / `last_event_id` on the detail response (`src/web-routes.ts`)

The `GET /sessions/:id` handler already reads the last `lines` entries from `stream.log`. The
change is to also compute and return `first_event_id` and `last_event_id` — the SSE event ids of
the FIRST and LAST entries in the returned `entries` slice, or `null` when `entries` is empty:

```ts
// GET /sessions/:id?lines=200  (additive fields only)
// last_event_id = the broker's own id counter value for the LAST valid entry in the slice.
// The broker increments its counter only when it assigns an id to a valid entry, so this is
// NOT a raw line index — malformed lines never advance the counter.
const lastId = entries.length > 0 ? brokerIdOf(entries[entries.length - 1]) : null;
return c.json({
  meta,
  entries,
  skipped_lines,
  // entries.length is the count of VALID entries only, so first_event_id walks back from the
  // last valid entry's broker id by that count — never by a raw line count.
  first_event_id: lastId !== null ? lastId - (entries.length - 1) : null,  // NEW
  last_event_id:  lastId,                                                  // NEW
});
```

**`skipped_lines` clarified (HIGH-B).** `skipped_lines` is the number of `stream.log` lines that
precede the returned slice — i.e. `file_line_count - entries.length` (zero when the whole file
fits within `lines`). It is **informational only** (it tells the client how much history was
truncated ahead of the slice) and is NOT used by the client to derive event ids, and it is NOT
used to compute `last_event_id`. `last_event_id` is the broker's id counter value for the last
valid entry in the slice; `skipped_lines + entries.length` (a raw line count including malformed
lines) is explicitly NOT the id and must not be used as such.

**Broker id guarantee (CRITICAL-2 / HIGH-B).** The broker assigns consecutive SSE ids to valid
entries ONLY, by incrementing its own id counter once per valid entry. Malformed lines in
`stream.log` are dropped by the broker before id assignment, so they consume no SSE id and never
advance the counter; the ids within any returned slice are always contiguous (contiguous integers
across the valid entries). This is why `last_event_id` is the broker's id counter value for the
LAST valid entry in the slice — NOT the raw line count `skipped_lines + entries.length` (which
would include malformed lines) and NOT a 1-based line index. Likewise `first_event_id` is the
broker id of the FIRST valid entry in the slice — not a count derived from `entries.length` over
raw lines. **This guarantee must be verified against the broker before Task 1 merges** (see Task 1
note): if `src/sse-broker.ts` does not drop malformed lines before id assignment, or does not
assign contiguous integers to valid entries, the `first_event_id = last_event_id - (entries.length - 1)`
derivation is invalid, the id-derivation approach needs redesign, and Task 1 is blocked until that
is resolved. Given the no-gaps guarantee, the full slice is pinned down by its last id:
`first_event_id === last_event_id - (entries.length - 1)`, and the id of the entry at 0-indexed
position `i` is `first_event_id + i`. This derivation is unambiguous and removes the earlier,
ambiguous single-`lastEntryId` scheme. No other field changes (Requirement 10.4).

Two algebraic self-checks are both unfalsifiable and MUST NOT be used as tests: the obvious
`last_event_id - first_event_id + 1 === entries.length`, and its algebraic twin
`first_event_id + entries.length - 1 === last_event_id`. They are the same equation rearranged;
because the handler derives `first_event_id` as `last_event_id - (entries.length - 1)`, both hold
by construction and can never detect a broken id sequence. Instead the backend test is a real
cross-check against the SSE replay seam (Task 1.8):
(1) seed `stream.log` with exactly 250 lines, with 5 malformed lines scattered INSIDE the last 200
positions (so they fall within the `lines=200` window, not only ahead of it);
(2) call `GET /sessions/:id?lines=200` and assert `entries.length === 195` (200 − 5 malformed),
assert `last_event_id === 250 - (count of malformed lines anywhere before the window end)`, and
assert `first_event_id === last_event_id - 194`;
(3) open the SSE stream with `Last-Event-ID: <first_event_id - 1>` so the broker replays the
entire slice;
(4) collect 195 SSE frames and assert, for every 0-indexed `i`, that frame `i` has SSE
`id === first_event_id + i` AND its `data` matches `entries[i].ts` — proving the correct valid
entries replay in order (not the malformed ones) and that the id sequence actually lines up.
This falsifies a broken id sequence (a tautology cannot), proves the history/SSE id seam lines up
on real data when malformed lines sit inside the window, and asserts the id-to-entry mapping
rather than restating the derivation.

The client sends `Last-Event-ID: <last_event_id>` on its first SSE connect (or omits the header
when `last_event_id` is null), so SSE replay begins exactly after the history slice and no entry
renders twice.

### Static serving + dev proxy (`src/web-spa.ts`)

A new factory produces the SPA-serving middleware so the logic is unit/Playwright-testable and
`createWebApp` stays readable. The SPA is mounted under `/app` only.

```ts
// src/web-spa.ts
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, Hono } from 'hono';
import type { Logger } from './log.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SpaServingDeps {
  log: Logger;
  /** Repo-relative root of the built client, default './client/dist'. */
  clientDist?: string;
  /** Reads process.env.NODE_ENV by default; injectable for tests. */
  nodeEnv?: string;
  /** The daemon bearer token to embed into index.html, or null when none is minted. */
  token: string | null;
  /** True when the daemon is bound to a public interface (config.bindPublic). */
  bindPublic: boolean;
  /** True when the request carries trusted-proxy proof (e.g. cloudflared headers). */
  hasProxyProof(c: Context): boolean;
}

/** True when the daemon is in development (SPA is served by Vite, not here). */
export function isDevMode(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development';
}

/**
 * The token to embed into the shell for this request, or null to embed nothing.
 * Embed the token ONLY when the daemon is loopback-bound (`!bindPublic`) AND the request
 * carries NO trusted-proxy proof (`!hasProxyProof(c)`) — i.e. direct loopback access by the
 * operator on the same machine. In every other case (public bind, or a proxied request)
 * embed null so the bearer secret is never delivered to a tunnel/remote user.
 */
export function embedTokenFor(c: Context, deps: SpaServingDeps): string | null {
  return !deps.bindPublic && !deps.hasProxyProof(c) ? deps.token : null;
}

/** Register the SPA routes under /app onto the Hono app AFTER all API routes. */
export function registerSpaRoutes(app: Hono, deps: SpaServingDeps): void { /* … */ }
```

Behavior:

- **Dev mode** (`NODE_ENV === 'development'`): the daemon does NOT serve or proxy `/app`. The
  operator loads the SPA from Vite directly at `http://localhost:5174/app`, and Vite proxies API
  calls back to the daemon (see "Dev proxy"). `registerSpaRoutes` is therefore a no-op for `/app`
  in dev; the daemon only serves the API (Requirement 2.2).
- **Prod mode**: because the Vite build is configured with `base: '/app/'` (see "Vite base and
  asset paths" below), every built asset is referenced as `/app/assets/*.js` (not `/assets/*.js`).
  The daemon therefore serves `/app/*` with `serveStatic` configured to **strip the `/app`
  prefix** before resolving against `client/dist`, because the files on disk live at
  `client/dist/assets/*` (not `client/dist/app/assets/*`):

  ```ts
  app.use('/app/*', serveStatic({
    root: './client/dist',
    rewriteRequestPath: (path) => path.replace(/^\/app/, ''),
  }));
  ```

  This catch-all handles all static assets (JS, CSS, fonts) with their correct MIME type
  (Requirement 2.5). `index.html` is **NOT** served through `serveStatic` — only through the
  dedicated handler described next. There is NO `/ui` SPA prefix; the dist output places
  `index.html` at the SPA root, so `/app` maps to `client/dist/index.html` (Requirement 2.8).
- **Shell (`index.html`) handler**: requests to `GET /app` and `GET /app/` (no trailing asset
  path) are handled by `serveIndexWithOptionalToken(c)`, which reads `client/dist/index.html`,
  optionally injects `<script>window.__DAEMON_TOKEN="..."</script>`, and returns it with
  `Content-Type: text/html` (Requirement 2.4). These two routes register BEFORE the `/app/*`
  catch-all so the shell handler wins for the bare paths and `serveStatic` handles everything
  else.
- **Missing build**: at registration time, if prod mode and
  `path.join('./client/dist', 'index.html')` does not exist, log a warning naming the path and
  still register the routes so the API and the legacy UI keep serving (Requirement 2.6).

### Vite base and asset paths (CRITICAL-1)

`client/vite.config.ts` sets `base: '/app/'`. This makes the built `index.html` reference every
hashed asset under `/app/` (for example `<script src="/app/assets/index-abc123.js">`), which is
exactly the prefix the daemon serves. Without this base, assets would be emitted at `/assets/*`
and 404 under the `/app` mount. The `serveStatic` `rewriteRequestPath` above removes the `/app`
prefix so the on-disk layout (`client/dist/assets/*`) resolves correctly.

Because the SPA uses **hash routing** (see "Routing"), a deep link is `/app#/sessions/<id>`. The
browser only ever requests `/app` as a real document load, so a deep SPA path never hits the
server as a document request and `serveStatic` needs no history-fallback rewrite. The `?token=…`
deep link targets `/app?token=<bearer>#/sessions/<id>` or simply `/app?token=<bearer>`.

### Legacy routes during migration and at cutover (`src/web-server.ts`)

During migration (SPA under `/app`):

```diff
  import { renderWebUI } from './web-ui.js';   // kept during migration
  …
  app.get('/',   (c) => { … renderWebUI(…) … });   // UNCHANGED (legacy)
  app.get('/ui', (c) => { … renderWebUI(…) … });   // UNCHANGED (legacy)
  …
  // (all API routes + auth middleware unchanged)
  app.route('/', routes);
+ registerSpaRoutes(app, { log, clientDist: './client/dist' });  // mounts /app LAST
  return app;
```

At the final cutover item (Requirement 9.1):

```diff
- import { renderWebUI } from './web-ui.js';
  …
- app.get('/',   (c) => { … renderWebUI(…) … });
- app.get('/ui', (c) => { … renderWebUI(…) … });
  …
  app.route('/', routes);
+ // serve the SPA index for / and /ui, and assets + /app via serveStatic
+ registerSpaRoutes(app, { log, clientDist: './client/dist' });
+ // cutover: / and /ui now return client/dist/index.html with optional token embed
  return app;
```

Order matters: `registerSpaRoutes` runs after `app.route('/', routes)` so API matches win
(Requirement 2.3). `src/web-ui.ts` is deleted in the cutover item (Requirement 9.1).

### Token embedding decision

The brief offers two options for delivering the token on a loopback bind. **Decision: keep the
URL-param + `window.__DAEMON_TOKEN` fallback; do NOT add a `/api/token` endpoint.** Rationale:

- A `/api/token` endpoint would be a new unauthenticated route that returns the bearer secret,
  widening the attack surface and requiring an endpoint addition (violates NFR-2.1).
- The existing `embedToken` concept already injects `window.__DAEMON_TOKEN` on loopback binds.
  The SPA reads it with the precedence defined in Requirement 3.1.

Because the SPA is a static `index.html`, the daemon cannot template a `<script>` into it the way
`renderWebUI` did without a tiny intercept. Two mechanisms cover both binds:

1. **Loopback bind** (operator on the same machine): the operator opens
   `http://127.0.0.1:<port>/app`. `GET /app` and `GET /app/` (and, after cutover, `GET /` and
   `GET /ui`) ALWAYS go through `serveIndexWithOptionalToken(c)`, never through `serveStatic`.
   This handler reads `client/dist/index.html`, calls `embedTokenFor(c)`, and returns the result.
   If `embedTokenFor` returns a token string, the handler replaces the sentinel comment
   `<!--__DAEMON_TOKEN__-->` with
   `<script>window.__DAEMON_TOKEN = JSON.stringify(token)</script>` and sets
   `Cache-Control: no-store`. If `embedTokenFor` returns `null`, the sentinel comment is replaced
   with an empty string (the page loads, but no token is injected). Static assets
   (`/app/assets/*`, `/app/*.js`, `/app/*.css`) are served through `serveStatic` via the `/app/*`
   wildcard route, which does NOT match `/app` or `/app/` (those are handled first).
2. **Remote bind / phone** (behind cloudflared): the operator opens a shared deep link
   `https://<tunnel>/app?token=<bearer>`. The SPA captures `?token`, stores it to `localStorage`
   AND `window.__DAEMON_TOKEN`, and strips it from the URL (Requirement 3.1).

The per-request embed decision is `embedTokenFor(c, deps)`, which returns the token string ONLY
when `!deps.bindPublic && !deps.hasProxyProof(c)` (direct loopback access) and `null` otherwise —
so the token is never embedded for a public bind or a proxied (tunnel) request (CRITICAL-A /
HIGH-2). The three fields
`token`, `bindPublic`, and `hasProxyProof` are supplied on `SpaServingDeps` (see the interface
above), so the serving layer never reaches into module-level config and stays unit-testable.

```ts
// inside registerSpaRoutes, prod mode only
// Bare-path shell handler FIRST so it wins for /app and /app/ …
app.get('/app',  (c) => serveIndexWithOptionalToken(c, deps, embedTokenFor(c, deps)));
app.get('/app/', (c) => serveIndexWithOptionalToken(c, deps, embedTokenFor(c, deps)));
// … then the asset catch-all (JS/CSS/fonts), stripping the /app prefix:
app.use('/app/*', serveStatic({
  root: './client/dist',
  rewriteRequestPath: (path) => path.replace(/^\/app/, ''),
}));
// at cutover, also:
// app.get('/',   (c) => serveIndexWithOptionalToken(c, deps, embedTokenFor(c, deps)));
// app.get('/ui', (c) => serveIndexWithOptionalToken(c, deps, embedTokenFor(c, deps)));
```

`serveIndexWithOptionalToken` reads `client/dist/index.html` once (cached) and optionally injects
the token into the sentinel. The token is written with `JSON.stringify(token)` so any special
characters (quotes, backslashes, `</script>`-style sequences) are safely escaped:
`<script>window.__DAEMON_TOKEN=${JSON.stringify(token)}</script>`. When a token IS embedded, the
response MUST carry `Cache-Control: no-store` so the token-bearing shell is never cached by the
browser or an intermediary; when no token is embedded the sentinel is replaced with empty string.
The response returns `text/html` (Requirement 2.4). `index.html` is never served through
`serveStatic`; only hashed assets are.

---

## Shared logic between backend and client

`src/ui/logic.ts` is pure and DOM-free by construction (its header comment states this). The
client imports it so parsing never diverges (NFR-2.2).

### Import mechanism

Vite resolves TypeScript across directories. The client references the backend module through a
Vite path alias so the import site stays clean and the ESM `.js` extension convention is honored:

```ts
// client/vite.config.ts
resolve: {
  alias: {
    '@shared/logic': path.resolve(__dirname, '../src/ui/logic.ts'),
  },
},
server: {
  fs: { allow: ['..'] },   // HIGH-3: let Vite serve files outside client/ (i.e. ../src/ui/logic.ts)
}
```

The Vite alias covers the dev server and the build, but `svelte-check` (and the editor's TS
language service) resolve types through `tsconfig`, not Vite. So the same alias MUST be mirrored
in the client tsconfig `paths` or `svelte-check` fails to resolve `@shared/logic` (HIGH-3):

```jsonc
// client/tsconfig.json  (compilerOptions)
{
  "compilerOptions": {
    "paths": {
      "@shared/logic": ["../src/ui/logic.ts"]
    }
    // … DOM lib target; does NOT extend the root tsconfig (Requirement 1.5)
  }
}
```

Two more things make the alias work in `npm run dev`:
- `server.fs.allow: ['..']` lets the Vite dev server read `../src/ui/logic.ts`, which is outside
  the `client/` root (Vite blocks out-of-root reads by default).
- The tsconfig `paths` entry is resolved relative to the tsconfig's own directory (`client/`), so
  `../src/ui/logic.ts` points at the repo-root `src/ui/logic.ts` (`client/` and `src/` are
  siblings, so a single `..` reaches the repo root).

```ts
// client/src/lib/logic.ts  — re-export shim so components import from one place
export * from '@shared/logic';
```

Constraints that make this safe:

- `src/ui/logic.ts` imports nothing from Node or the DOM, so it compiles cleanly under the
  client's DOM-targeted tsconfig.
- The client's own **`types.ts`** owns the response and `StreamEntry` DTOs — the client does NOT
  reach into `../src/` for types via relative imports. The ONLY cross-directory import is the
  `@shared/logic` alias to the pure logic module (and that is the single documented exception).
- The client tsconfig does NOT extend the root tsconfig (Requirement 1.5). The root tsconfig
  `include` continues to cover only `src/`, `bin/`, `test/`.
- No build step is added to the backend; `tsx` still runs `src/` directly (NFR-2.3).

Functions the client consumes from `src/ui/logic.ts` (verified against source):
`parseStreamEntry`, type `ParsedEntry`, type `SystemSubtype`, type `SystemBadge`,
`escapeHtml`, `isSafeLinkHref`, `safeLinkHref`, `formatMetadataPill`,
`mergeEvents`, `trackLastEventId`, `computeBackoff`, `statusToBadge`, `deriveWaitingFor`,
`parseHashRoute`. (`renderMarkdown` also lives in `src/ui/logic.ts` but is v2 future work and is
NOT consumed by the v1 SPA — v1 renders all agent content as plain text; see "Safe rendering
boundary" / HIGH-D.)

**`renderStreamEntry` is NOT in `src/ui/logic.ts`.** It lives in `src/web-ui.ts` and depends on
DOM-mutation patterns incompatible with Svelte, so it is NOT portable. The client implements its
own Svelte-native rendering using the `ParsedEntry` discriminated union as the data contract
(Requirement 6.1).

### Safe rendering boundary (XSS, HIGH-9 / HIGH-D / NFR-6)

**v1 renders ALL agent content as plain text. There is no `{@html}` directive anywhere in the v1
SPA.** Agent message bubbles, tool parameters, titles, and every other `StreamEntry`-derived value
are bound as text (Svelte escapes text interpolation by construction), so no payload field can
introduce markup or script. The JSON pivot view likewise sets `textContent` (via Svelte text
binding inside `<pre>`), which is also safe. This removes the earlier Req 6.2 / NFR-6.2
contradiction (one place said render markdown via `{@html}`, another said plain text): v1 is
unambiguously plain text.

`renderMarkdown(text: string): string` is defined in `src/ui/logic.ts` as **future work (v2)**,
to be used only when a sanitized markdown renderer is added. It is NOT wired into any `{@html}`
sink in v1. When it is introduced, it MUST sanitize via an **allowlist** (not a blocklist):

- **Permitted elements:** `a`, `b`, `strong`, `em`, `i`, `code`, `pre`, `br`, `p`, `ul`, `ol`,
  `li`, `blockquote`, `h1`–`h6`, `hr`. Every other tag (including `iframe`, `script`, `style`,
  `img`) is stripped.
- **Permitted attributes:** `href` (only when it validates as `https:`, `http:`, or `mailto:` —
  never `javascript:`), `class`, and `id`. No `on*` event-handler attributes, no `style`, no
  other attributes.

Because v2 is the only context in which `renderMarkdown()` output could reach `{@html}`, that
output is the ONLY value that may ever be passed to a Svelte `{@html}` directive, and only after
it has gone through the allowlist sanitizer above.

**v1 XSS tests (HIGH-2 / NFR-6.3).** v1 testing targets the ACTUAL v1 render path — plain-text
interpolation — NOT `renderMarkdown`, which is unwired in v1 and so cannot be meaningfully tested
as a v1 behavior. Two enforced checks:

- A CI lint check that FAILS if any `{@html}` directive appears under `client/src/`:
  `grep -r '{@html' client/src/ && exit 1 || exit 0`. v1 is plain text so this already passes;
  the check makes "no `{@html}` in v1" an enforced invariant (part of the Task 5 definition of
  done).
- A vitest test that renders an `agent_message` entry whose content is
  `<img src="x" onerror="window.xss=1">` and asserts the DOM output contains no `<img>` element
  and that `window.xss` is `undefined` — proving the SPA uses text interpolation, not HTML.

**v2 sanitizer tests (future work, not run in v1).** When `renderMarkdown()` is introduced in v2
and wired to a `{@html}` sink, it MUST be covered by allowlist unit tests, e.g.
`renderMarkdown('<iframe src="evil">')` returns an empty string (iframe not on the allowlist);
`renderMarkdown('<a href="javascript:alert(1)">x</a>')` strips the `href` (only
`https:`/`http:`/`mailto:` are permitted); `renderMarkdown('<img onerror="alert(1)">')` strips the
element (`img` not on the allowlist, `on*` attributes never permitted). These are v2-only and are
NOT part of the v1 scope.

---

## Client application design

### State (Svelte 5 runes) — `client/src/lib/stores.svelte.ts`

```ts
export const auth = $state<{
  token: string | null;
  error: 'none' | 'missing' | 'expired';   // 'expired' covers 401 AND 403
}>({ token: null, error: 'none' });

export const sessionList = $state<{
  loading: boolean;
  items: SessionSummary[];
  total: number;
  error: string | null;
}>({ loading: false, items: [], total: 0, error: null });

/** Per chat view: raw entries ordered by SSE id, plus connection status. */
export function createChatState(sessionId: string) {
  const entries = $state<RawStreamEntry[]>([]);          // merged by id via mergeEvents
  let firstEventId = $state<number | null>(null);        // from history response first_event_id
  let lastEventId  = $state<number | null>(null);        // from history response last_event_id; seeds first SSE connect
  let status = $state<'active' | 'completed' | 'abandoned' | 'failed'>('active'); // meta.status
  let connection = $state<'loading' | 'live' | 'reconnecting' | 'ended'>('loading');
  // … setHistory(entries, firstEventId, lastEventId, metaStatus), append(id, data), markEnded()
  return { entries, firstEventId, lastEventId, status, connection /* getters */ };
}
```

Each SSE event is one reactive write; Svelte updates only the affected bubble.

### Auth initialization — `client/src/lib/stores.svelte.ts` + `main.ts`

Resolution precedence (Requirement 3.1–3.5), executed exactly in this order:

1. **URL `?token`.** Read `location.search`. If present → write `localStorage['ar_token']`,
   write `window.__DAEMON_TOKEN`, `history.replaceState({}, '', location.pathname + location.hash)`
   to strip it, set `auth.token`.
2. **`window.__DAEMON_TOKEN`.** Else if a non-empty string → persist to `localStorage['ar_token']`
   (overwriting any stale value) and set `auth.token`.
3. **`localStorage['ar_token']`.** Else if non-empty → set `auth.token`.
4. Else → `auth.error = 'missing'`, render the auth-error state, issue no authed requests.

Because steps 1–2 overwrite `localStorage`, a fresh embedded or deep-link token always wins over
a stale stored one (Requirement 3.2).

**401/403 lockout (Requirement 3.4):** a 401 or 403 from any API call or SSE connect sets
`auth.error = 'expired'`, clears `localStorage['ar_token']`, aborts all active SSE
AbortControllers, and renders a "Session expired — reload the page" view with a reload button.
No automatic retry.

### Typed API client — `client/src/lib/api.ts`

One function per endpoint the SPA uses; each attaches the bearer header and parses JSON. Return
types live in `client/src/lib/types.ts` (client-owned) and mirror the backend response shapes.
Repos/projects/config/kill functions are intentionally absent (Requirement 3.6, 5.8).

```ts
async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = auth.token;
  if (!token) throw new AuthError('missing');
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) { enterExpiredState(); throw new AuthError('expired'); }
  return res;
}

export const api = {
  listSessions(q?: { status?; since?; limit?; offset? }): Promise<SessionListResponse>,
  getSession(id: string, lines = 200): Promise<SessionDetailResponse>,   // includes first/last_event_id
  inject(id: string, prompt: string): Promise<{ accepted: true }>,       // POST, 202
  interrupt(id: string): Promise<{ ok: true }>,                          // Interrupt button
};
```

Response DTOs (`client/src/lib/types.ts`, client-owned) copy the backend's exact field names:

```ts
export interface SessionSummary {
  session_id: string;
  repo: string | null;
  status: 'active' | 'completed' | 'abandoned' | 'failed';
  created_at: number;              // unix seconds
  completed_at: number | null;
  termination_reason: string | null;
  prs: Array<{ repo: string; pr_number: number; registered_at: number }>;
  waiting_for: string | null;
}
export interface SessionListResponse { sessions: SessionSummary[]; total: number; offset: number; limit: number; }
export interface SessionMeta { status: 'active' | 'completed' | 'abandoned' | 'failed'; /* … */ }
/** Mirrors StreamEntry; the client owns this type and does NOT import it from ../src/. */
export interface StreamEntry { ts: string; source: 'router' | 'agent'; type: string; [k: string]: unknown }
export interface SessionDetailResponse {
  meta: SessionMeta;
  entries: StreamEntry[];
  skipped_lines: number;
  first_event_id: number | null;  // NEW — SSE id of the FIRST entry in this slice (Requirement 10.1)
  last_event_id: number | null;   // NEW — SSE id of the LAST entry in this slice  (Requirement 10.1)
}
```

The client derives the id of each entry as `first_event_id + i` (0-indexed), which is
unambiguous because broker ids are contiguous integers starting from 1 (CRITICAL-2).

`entries` are normalized through `parseStreamEntry` before rendering (Requirement 6.1).

### SSE client — `client/src/lib/sse.ts`

Native `EventSource` cannot set an `Authorization` header, so the client uses `fetch` +
`ReadableStream` with an `AbortController` (Requirement 4.1, 4.6).

```ts
export interface SseHandle { close(): void; }   // close() calls controller.abort()

export function connectStream(opts: {
  sessionId: string;
  token: string;
  firstEventId: number | null;      // seeded from history response `last_event_id`; null → no header
  getLastEventId: () => number;     // highest id seen, for reconnect Last-Event-ID
  onEntry: (id: number, data: unknown) => void;
  onEnded: () => void;
  onStatus: (s: 'live' | 'reconnecting') => void;
  onFatal: (kind: 'not_found' | 'ended' | 'expired') => void;  // 404 / 410 / 401|403
}): SseHandle { /* … */ }
```

Frame parsing (Requirement 4.2):

- Decode the byte stream with a `TextDecoder`, buffer a residual, split complete frames on the
  blank-line delimiter (`\n\n`).
- Within a frame, read `event:`, `id:`, and `data:` lines. Lines beginning with `:` are comments
  (`:ok`, `:heartbeat`) and are ignored — but their arrival resets the stall timer (below).
- `event: session_ended` → call `onEnded()`, `controller.abort()`, and stop; never reconnect
  (Requirement 4.6).
- `event: log` → `onEntry(id, JSON.parse(data))`; update the highest id via `trackLastEventId`.

First connect vs reconnect (Requirement 4.3): on the first connect, send
`Last-Event-ID: <last_event_id>` (the history response's `last_event_id`, passed as
`firstEventId`) only when it is non-null; send no header when null. On every reconnect, send
`Last-Event-ID: <getLastEventId()>`.

Status-code handling (Requirement 4.8, 3.4):
- `401` / `403` → `onFatal('expired')`, abort, no reconnect (triggers the lockout state).
- `404` → `onFatal('not_found')`, abort, no reconnect ("Session not found").
- `410` → `onFatal('ended')`, abort, no reconnect ("Session ended").
- Other non-200 → wait 5 s, then reconnect with `computeBackoff` capped at 30000 ms.

Reconnect on drop (Requirement 4.5, 4.9): on read error or stream end without `session_ended`
while the session is active, increment an attempt counter, wait `computeBackoff(attempt)` ms,
then reopen with the `Last-Event-ID` header. On a successful reopen, reset the counter and call
`onStatus('live')`. While waiting, call `onStatus('reconnecting')` so the chat shows the
reconnect pill (Requirement 7.4).

Stall detection (Requirement 4.7): a 60 s timer is reset on every frame AND every `:heartbeat`
comment. If it fires while the session is active, `controller.abort()` and reconnect (recovers
half-open mobile TCP connections).

Lifecycle (Requirement 4.6): `SseHandle.close()` calls `controller.abort()`. `ChatView.svelte`
calls `close()` in `onDestroy`, on an `expired` fatal, and on `session_ended`.

Dedup (Requirement 4.4, 6.9): the chat state merges incoming `(id, data)` via `mergeEvents`, and
the first SSE connect begins at `last_event_id` from history, so each log line renders exactly
once.

### Routing — `client/src/routes/router.svelte.ts`

**No external routing library is used (HIGH-4).** Hash routing is implemented in
`client/src/lib/router.svelte.ts` (equivalently `client/src/routes/router.svelte.ts`) using the
native `hashchange` event plus `parseHashRoute()` from the shared logic module — that IS the
router. `svelte-routing` was removed from the dependency list because an external router both
duplicates and conflicts with this hand-rolled hash router.

Hash routing (reusing `parseHashRoute` from shared logic). The server never sees a deep SPA path
as a document request:

- `#/` or empty → session list (`SessionList.svelte`).
- `#/sessions/<id>` → chat view (`ChatView.svelte`).

Only these two routes exist. There are no `#/repos`, `#/config`, or `#/projects` routes
(Requirement 5.8). `App.svelte` subscribes to `hashchange`, derives the route with
`parseHashRoute`, and renders the matching view plus the chrome (`Header` always; `DetailBar` on
the chat route at mobile/tablet widths).

---

## Chat view rendering

`ChatView.svelte` loads history (`api.getSession(id, 200)` → `entries`, `meta`, `lastEventId`),
then — for `meta.status === 'active'` sessions — opens the SSE stream starting at `lastEventId`.
Rendering dispatches on `parseStreamEntry(raw).kind`.

### Entry taxonomy → component mapping

| `ParsedEntry.kind` | Component          | Alignment / treatment                               | Req |
|--------------------|--------------------|-----------------------------------------------------|-----|
| `agent_chunk`      | `MessageBubble`    | Right-aligned; plain-text (v1, no `{@html}`); streaming cursor | 6.2, 7.2 |
| `agent_message`    | `MessageBubble`    | Right-aligned; plain-text (v1, no `{@html}`); not streaming    | 6.2 |
| `system`           | `SystemPill`       | Centered; optional badge color from `badge`         | 6.3 |
| `tool_call`        | `ToolCallCard`     | Full-width collapsible; header = title; spinner until `status` finishes | 6.4, 7.3 |
| `tool_update`      | (folds into card)  | Appended to card body keyed by `toolCallId`; its ACP `status` (`'completed'`/`'failed'`) finishes the card | 6.4, 7.3 |
| `permission`       | `PermissionCard`   | Full-width; READ-ONLY (title only, no buttons)      | 6.5 |
| `internal`         | `InternalPill`     | Minimized gray pill; expandable; `formatMetadataPill` text | 6.6 |
| `unknown`          | `UnknownPill`      | Gray pill with `typeLabel` only (no payload)        | 6.7 |

### Bubble reassembly

Consecutive `agent_chunk` entries that belong to the same turn reassemble into one bubble by
concatenating `text` in id order. A `tool_call`, `system`, `permission`, or `agent_message`
entry (or a turn-complete signal) closes the open bubble. `tool_update` entries are matched to
their `tool_call` by `toolCallId`; a `tool_call` with `toolCallId === null` gets a synthetic id
assigned by the renderer (as documented in `parseStreamEntry`).

### Streaming states (Requirement 7)

- **Active bubble cursor (7.2, HIGH-5):** a *turn* is complete when a `router`-source entry of
  type `session_verified`, `session_ended`, or `prompt_injected` appears after the highest-`id`
  agent-source `session/update` entry with `sessionUpdate: 'agent_message_chunk'`. Render the `▌`
  glyph (CSS pulse) ONLY while `meta.status === 'active'` AND no turn-complete entry has appeared
  after that highest-`id` `agent_message_chunk`. Hide the cursor when `meta.status !== 'active'`
  OR a turn-complete entry has arrived after that chunk (per-turn cursor clearing). For a
  non-active history load, no cursor is shown.
- **Tool spinner (7.3, HIGH-C):** a `ToolCallCard` shows a header spinner and no expand chevron
  ONLY when the session is active AND the tool call is not yet finished. A tool call is finished
  when a following `tool_call_update` for the same `toolCallId` carries an ACP `status` of
  `'completed'` OR `'failed'` (there is NO `complete: boolean` field in ACP — the completion
  signal is the `status` field). When the session is inactive OR a finishing `status` has arrived,
  the spinner is hidden and the expand arrow is shown.
- **Reconnect pill (7.4):** `ReconnectPill` renders `Reconnecting…` while
  `connection === 'reconnecting'`, removed on `'live'`.
- **Skeletons (7.5):** `SkeletonBubble` × N render while the history fetch is in flight;
  replaced on resolve.
- **Composer (7.6):** `Composer.svelte` is always visible — a text input (font ≥16 px) + Send
  button → `api.inject(id, prompt)`. On mobile/tablet it is a fixed bottom bar above the detail
  bar with `padding-bottom: env(safe-area-inset-bottom)`.
- **Interrupt (7.7, HIGH-6):** an **Interrupt** button (labeled "Interrupt", not "Kill") →
  `api.interrupt(id)`, which interrupts the current agent turn and does NOT necessarily end the
  session. On mobile/tablet it lives in `DetailBar`. Activation opens a tap-confirmable dialog
  reading "Interrupt the current agent turn?" (no hover). After the call resolves, re-fetch `meta`
  via `api.getSession(id)` to reflect the updated status rather than assuming the session ended.
  Tap target ≥44×44.
- **Ended (7.8):** on `session_ended`, append the ended system pill, hide cursor/spinners, and
  disable (but keep visible) Composer Send and Interrupt.

### Mobile chat layout (Requirement 7, HIGH-13)

- **Viewport height:** the chat container uses `height: 100dvh` so iOS Safari URL-bar collapse
  does not clip the composer.
- **Safe-area insets:** the detail bar and composer apply `padding-bottom: env(safe-area-inset-bottom)`
  (enabled by `viewport-fit=cover` in the viewport meta, Requirement 1.4).
- **Auto-scroll:** on a new SSE entry, auto-scroll to the bottom UNLESS the user has manually
  scrolled up more than 100 px. When scrolled up, show a "↓ New messages" badge that scrolls to
  the bottom on tap.
- **Code overflow:** code blocks in tool output use `overflow-x: auto` with `max-width: 100%` and
  never break the container; the chat container itself uses `overflow-x: hidden`.

### JSON pivot — `JsonToggle.svelte` (Requirement 8.1–8.2)

Every bubble/card/pill composes a `JsonToggle` button (`{ }` glyph, ≥44×44 tap target). State is
local per entry (`let showJson = $state(false)`). When on, the component renders
`<pre>{JSON.stringify(entry, null, 2)}</pre>`. The toggle is ALWAYS visible on all viewports; on
mobile/tablet it is a small always-visible `{ }` chip, and on desktop it MAY additionally reveal
on hover (`@media (hover: hover)`) as an enhancement over the always-visible baseline. Desktop
`J` key toggles the focused entry (8.5).

---

## Responsive and accessibility design

### Breakpoints (standardized across all three spec files)

| Range            | Tier    | Layout |
|------------------|---------|--------|
| `< 768px`        | mobile  | single-column; simple list header; chat `DetailBar` + fixed `Composer`; bubbles `max-w-[85vw]`; tool cards collapsed |
| `768px–1023px`   | tablet  | same nav model as mobile (DetailBar on chat); wider content area |
| `>= 1024px`      | desktop | simple top header; no bottom bar; hover JSON-toggle enhancement; keyboard shortcuts |

The Tailwind `lg` breakpoint (1024px) is the mobile/tablet ↔ desktop divider. The 768px boundary
is Tailwind `md`. There is a single navigation destination (Sessions) at every tier
(Requirement 5).

### Navigation

- `Header.svelte`: simple header with the Sessions title; shown at all tiers. No tab bar, no
  Repos/Config entries (Requirement 5.3, 5.8).
- `DetailBar.svelte`: on the chat route at mobile/tablet widths (`< 1024px`), a bottom bar with a
  back button, the session title, and the Interrupt button, each ≥44×44 (Requirement 5.3, 7.7),
  `padding-bottom: env(safe-area-inset-bottom)`.

### Accessibility (Requirement 8.4–8.7)

- The chat conversation container carries `role="log"` and `aria-live="polite"` (8.4).
- Entries are focusable (`tabindex="0"`); at `lg`+ `J` toggles JSON on the focused entry (8.5);
  `?` opens `HelpOverlay.svelte` (8.5).
- Every interactive element ≥44×44 CSS px (8.6); audited via a Playwright bounding-box assertion.
- Inputs ≥16 px (prevents iOS zoom), body ≥14 px (8.7).

### Theming (Requirement 1.7, 8.3, NFR-3.1)

`client/src/app.css` declares the palette on `:root`:

```css
:root {
  --bg: #0d1117;            --surface: #161b22;        --border: #30363d;
  --agent-bubble-bg: #1f6feb; --agent-bubble-text: #ffffff;
  --system-pill-bg: #21262d; --system-pill-text: #8b949e;
  --tool-card-bg: #161b22;  --tool-card-accent: #388bfd;
  --text-primary: #e6edf3;  --text-muted: #8b949e;
  --success: #3fb950;       --error: #f85149;          --warning: #d29922;
}
```

Components reference these via Tailwind arbitrary values (e.g. `bg-[var(--agent-bubble-bg)]`) or
`@apply`-backed component classes. No component contains a literal hex (8.3). System-pill badge
mapping: `green → --success`, `yellow → --warning`, `red → --error` (6.3).

---

## Development and build workflow

### Root scripts (Requirement 1.6)

```jsonc
// package.json (root) — additive only
{
  "scripts": {
    "build:client": "npm --prefix client run build",
    "dev:client":   "npm --prefix client run dev"
    // existing start / dev / typecheck / test / test:* unchanged
  }
}
```

### Vite config (`client/vite.config.ts`) — dev proxy (HIGH-8)

The Vite dev server owns `/app` and proxies API paths back to the daemon. `CONTROL_PORT` comes
from an env var, not a shared file.

```ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

const CONTROL_PORT = process.env.CONTROL_PORT ?? '8787';
const target = `http://localhost:${CONTROL_PORT}`;

export default defineConfig({
  base: '/app/',                              // assets referenced under /app/ (CRITICAL-1)
  plugins: [svelte()],
  resolve: {
    alias: { '@shared/logic': path.resolve(__dirname, '../src/ui/logic.ts') },
  },
  server: {
    fs: { allow: ['..'] },                    // serve @shared/logic from ../src in dev (HIGH-3)
    port: 5174,
    strictPort: true,                         // fail rather than fall back to another port
    allowedHosts: ['localhost', '127.0.0.1'], // explicit allowlist, NOT `true`
    hmr: { port: 5175 },                      // separate HMR socket, avoids proxied-WS conflict
    proxy: {
      '/api':      { target, changeOrigin: true },
      '/sessions': { target, changeOrigin: true, ws: true }, // ws:true for SSE/stream
      '/repos':    { target, changeOrigin: true },
      '/projects': { target, changeOrigin: true },
      '/config':   { target, changeOrigin: true },
    },
  },
});
```

Notes:
- `base: '/app/'` makes built assets reference `/app/assets/*`, matching the daemon mount (CRITICAL-1).
- `server.fs.allow: ['..']` lets Vite serve `../src/ui/logic.ts` (the `@shared/logic` alias) in dev (HIGH-3).
- `strictPort: true` ensures the daemon's assumption of port 5174 holds.
- `allowedHosts` is an explicit allowlist for safety (not `true`).
- `hmr.port: 5175` keeps the HMR websocket off the proxied `/sessions` stream path.
- The client never imports a "shared" file via `../src/` except the single `@shared/logic` alias;
  all client types live in `client/src/lib/types.ts` (HIGH-8, "Shared logic").

### Dev loop

1. Terminal A: `npm run dev:client` → Vite on `:5174`, serving the SPA at `http://localhost:5174/app`.
2. Terminal B: `CONTROL_PORT=<port> NODE_ENV=development npm run dev` → daemon on `controlPort`.
   The operator opens `http://localhost:5174/app`; Vite serves the SPA and proxies API/SSE calls
   to the daemon (Requirement 2.2) with hot module reload.

### Prod loop

1. `npm run build:client` → `client/dist/` (Requirement 1.3).
2. `npm start` → daemon serves `client/dist/` under `/app` via `serveStatic` (Requirement 2.1).
   Legacy `/` and `/ui` keep serving `web-ui.ts` until the cutover item.

`client/dist/` is added to `.gitignore`.

---

## Error handling

| Condition | Behavior | Req |
|-----------|----------|-----|
| No token available | Render auth-error ('missing') state; issue no authed requests | 3.5 |
| API or SSE returns 401 or 403 | Clear `ar_token`, abort all SSE, show "Session expired — reload" + reload button; no retry | 3.4 |
| API returns 4xx (non-401/403) / 5xx | Surface a view-level error with a Retry action (transient 5xx may auto-retry; mutations are not auto-retried) | — |
| SSE drop, session active | Reconnect with `computeBackoff` + `Last-Event-ID`; show reconnect pill | 4.5, 4.9, 7.4 |
| SSE 404 | "Session not found"; no reconnect | 4.8 |
| SSE 410 | "Session ended"; no reconnect | 4.8 |
| SSE other non-200 | wait 5 s, reconnect with backoff (cap 30 s) | 4.8 |
| No SSE frame for 60 s (active) | abort + reconnect (half-open TCP recovery) | 4.7 |
| `session_ended` frame | abort; append ended pill; hide cursor/spinners; disable controls | 4.6, 7.8 |
| `client/dist/index.html` missing (prod) | Daemon logs warning naming the path; API + legacy UI keep serving | 2.6 |
| Malformed stream entry | `parseStreamEntry` returns `{kind:'unknown', typeLabel}`; render type-only pill | 6.7 |

The SPA never renders raw payloads for `unknown` entries (only `typeLabel`), mirroring the
no-leak guarantee in `parseStreamEntry` (Requirement 6.7).

---

## Testing strategy

Two layers per UI increment (NFR-4.1, NFR-4.2):

**Unit (vitest + `@testing-library/svelte`, jsdom):** components mount with no live network. The
SSE client is tested against a **stubbed `fetch` returning a mock `ReadableStream`** that emits a
configurable sequence of SSE frames, so frame parsing, first-connect vs reconnect `Last-Event-ID`,
dedup, cursor, stall-timer, and reconnect states are exercised deterministically (HIGH-7). This
layer owns the SSE correctness tests — notably: (a) history load + SSE connect with the correct
`Last-Event-ID` produces no duplicates, and (b) disconnect + reconnect replays only the missing
events. No real tokens, no real GitHub, no real Kiro.

**Browser (Playwright, `test/browser/spa/`):** run against a real Hono instance with a stubbed
session whose `stream.log` is preloaded. The token is passed as a query param. Two viewport
configs: `375×812` (iPhone 14) and `1280×800` (desktop). CI order (HIGH-8): `npm run build:client`
→ `npm run test` in `client/` (vitest unit tests) → the Playwright browser tests. `npm run check`
(svelte-check) is part of the definition of done for every task.

| Item | Playwright evidence (`test/browser/spa/`) |
|------|---------------------|
| 72 | SPA root `GET /app` returns 200 + `text/html`; a hashed asset returns correct MIME; `GET /` and `GET /ui` still return the legacy UI; an API call hits the daemon handler, not the SPA route |
| 73 | AUTH ONLY (SSE browser tests moved to item 76 per HIGH-7): `?token` stripped from the URL bar; a fresh `?token` overwrites a stale stored token; API requests carry `Authorization: Bearer`; a 401/403 clears the token and shows the "expired" state. SSE client logic is covered by vitest unit tests (stubbed `fetch`/`ReadableStream`), including the history+connect no-duplicates test and the disconnect+reconnect replay-only-missing test |
| 74 | Navigate list → detail; one `GET /sessions` on load (NFR-1.2); single Sessions nav (no Repos/Config); screenshots at 375 px and 1280 px |
| 75 | Each entry kind renders with its component; `PermissionCard` shows no action buttons; bubbles `max-w-[85vw]` and tool cards collapsed at 375 px; screenshots |
| 76 | END-TO-END SSE vs a real Hono server (moved here from item 73 per HIGH-7): SSE connects with the correct first `Last-Event-ID` from history and receives a `log` frame; an agent action appends bubbles without reload; cursor only on active+incomplete; drop the stream → reconnect pill → reconnect with highest-id `Last-Event-ID` → entries resume with no duplicate ids; a completed history load shows no cursor/spinners; Composer visible; Interrupt confirmation ("Interrupt the current agent turn?") works by tap and re-fetches meta |
| 77 | JSON toggle flips a bubble to `<pre>` and back and is always visible on mobile; `role="log"`/`aria-live` present; tap-target bounding-box audit ≥44×44; screenshots |
| 78 | Cutover: `GET /`, `GET /ui`, `GET /app` all return the SPA (200); full flow (list → open → chat) at 375 px and 1280 px; legacy HTML-string tests removed; `npm run typecheck` + `npm test` green |

Shared pure logic (`src/ui/logic.ts`) already has Tier 1 coverage and is not re-tested here; the
SPA imports it unchanged (NFR-2.2).

---

## Decisions and alternatives considered

1. **SPA at `/app` during migration, cutover last.** Mounting under `/app` keeps the legacy UI
   live at `/` and `/ui` so the operator's phone workflow is never interrupted. Only the final
   item rewires `/` and `/ui` and deletes `web-ui.ts`. A big-bang replacement would break daily
   use mid-migration.
2. **Hash routing over history routing.** A history-API deep link reload would hit a JSON API
   path and return 401; hash routing (`/app#/sessions/:id`) never does. It also avoids a
   server-side SPA-fallback rewrite and keeps `serveStatic` trivial; the token deep link uses the
   query string, which hash routing leaves intact.
3. **Additive `first_event_id`/`last_event_id` over client-side guessing.** Returning both the
   first and last entry SSE ids from the history load lets the client derive every entry's id as
   `first_event_id + i` (contiguous broker ids) and begin the first SSE connect at `last_event_id`,
   guaranteeing exactly-once rendering. Guessing the offset client-side is fragile across
   reconnects; a single ambiguous `lastEventId` could not pin the first id of the slice.
4. **Token embed via sentinel replace, not `/api/token`.** A token endpoint is a new
   unauthenticated secret-returning route (rejected per NFR-2.1). The sentinel-replace on `/app`
   (and `/`+`/ui` after cutover) preserves the existing `embedToken` semantics with no new
   endpoint.
5. **Single Sessions nav; Repos/Config out of scope.** Dropping the multi-tab navigator removes
   unspecced surface, dead API functions, and dead routes, shrinking the footprint of this spec.
6. **Read-only permission card.** There is no backend endpoint to accept/decline permissions, so
   adding buttons would require a new API (violates NFR-2.1). The card is informational only.
7. **Import `src/ui/logic.ts` via a single Vite alias; client owns its types.** The logic module
   is DOM-free and designed for dual use (NFR-2.2); it is the only cross-directory import. All
   DTOs live in the client's own `types.ts` to avoid brittle `../src/` type imports.
8. **`renderStreamEntry` is not portable.** It lives in `web-ui.ts` and mutates the DOM
   directly; the client re-renders natively in Svelte from the `ParsedEntry` union instead.
9. **`fetch` + `ReadableStream` + `AbortController` for SSE, not `EventSource`.** `EventSource`
   cannot attach the bearer header the auth middleware requires, nor abort cleanly on unmount.
10. **Svelte 5 runes over React/Vue.** One reactive write per SSE event, no virtual-DOM diffing,
    and a small compiled payload fit the streaming workload and the 300 KB budget (NFR-1.1).

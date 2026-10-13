# Requirements — SPA UI Polish + Overview Dashboard

Feature slug: `spa-polish`

## Introduction

The agent-router SPA (`client/`, Svelte 5 + Vite 5 + Tailwind 3) works but has six
rough edges: no landing page, edge-to-edge content with zero margins, no app
branding in the header, inconsistent chat message rendering, horizontal overflow
in the session list, and an unintuitive cron status display in Config. This feature
polishes those six issues and adds a new Overview dashboard at `#/`, moving the
Sessions list to `#/sessions`.

The work is scoped to the client, with **one** backend addition: a new overview read
endpoint registered internally at `/overview` in `src/web-routes.ts` (existing routes
carry no `/api` prefix; the Vite dev proxy adds it). Its public URL is therefore
`/api/overview`. All existing components
are **modified or extended**, never rewritten from scratch. All colors come from
the CSS custom properties defined in `client/src/app.css`; the only hardcoded hex
allowed is in `app.css` itself (two new tokens are added there).

The work is serialized into three dependency-ordered ROADMAP items — **87**
(backend + shared primitives + layout/overflow fixes), **88** (header + router +
message grammar), and **89** (Overview page + Config cron status + empty states).
Item 87 → 88 → 89.

### Verified baseline (from source)

These facts are established from the current code and constrain the requirements:

- **Router** (`client/src/routes/router.svelte.ts` + `src/ui/logic.ts`): `HashRoute`
  is the union `{ view: 'list' } | { view: 'detail'; sessionId } | { view: 'config' }`.
  `parseHashRoute` maps `#/sessions/<id>` → `detail`, `#/config` → `config`, and
  everything else (including `#/`) → `list`. The chat view's `view` value is
  **`'detail'`**, not `'chat'`. `App.svelte` branches on `route.current.view`.
- **Backend** (`src/web-routes.ts`): `createWebRoutes(deps)` returns a `Hono<WebEnv>`
  app. Routes are registered without an `/api` prefix (e.g. `/sessions`, `/config`,
  `/repos/sessions`). `deps` provides `sessionMgr`, `sessionFiles`, `sseBroker`,
  `rootDir`, `log`, `shuttingDown`, and optional `config`, `tokenStore`, `db`.
- **Types** (`client/src/lib/types.ts`): `CronScheduleEntry` has a `paused: boolean`
  field (not `enabled`). There is no `OverviewResponse` type yet.
- **Tokens** (`client/src/app.css`): `--accent` and `--muted` do not exist yet.
- **Vite** (`client/vite.config.ts`): base `/app/`, proxies `/api` to the daemon.
  No `__APP_VERSION__` define exists yet.
- **ROADMAP** max item is 86; new items are 87, 88, 89.

### Non-functional constraints (carried forward from prior SPA specs)

- **NFR-1 (no NEW raw HTML):** No NEW `{@html}` usage shall be added outside the
  existing sanitized markdown rendering path (`client/src/components/MessageBubble.svelte`).
  Any new component that needs HTML output MUST compose `MessageBubble.svelte` with
  its `bare?: boolean` prop (which causes `MessageBubble` to render the agent text via
  `renderMarkdown()` without its outer bubble wrapper, for contexts that supply their
  own wrapper). `MessageRow.svelte` SHALL use `<MessageBubble bare />` for the
  `agent` kind and SHALL contain no `{@html}` directive. No other new `{@html}` sink
  may be introduced anywhere else.
  > Note: the EXISTING `MessageBubble.svelte` is the ONLY allowed location for the
  > sanitized markdown rendering path (via `renderMarkdown()`). A new `bare` prop is
  > added to `MessageBubble.svelte` so `MessageRow` can delegate the agent text to it
  > without introducing a second `{@html}` sink. All other content is rendered as
  > plain text or via existing safe helpers.
- **NFR-2 (tokens only):** Every color uses `var(--token)`. No hardcoded hex in any
  `.svelte` file; the only hex lives in `app.css`. **Exception:** the `error`
  `MessageRow` kind uses the Tailwind palette utilities `bg-red-900/30
  border-red-700 text-red-300` (not raw hex strings, but resolved Tailwind classes)
  as specified by the brief. These are the only non-`var()` color references allowed
  in `.svelte` files.
- **NFR-3 (type-clean):** `svelte-check` passes with zero errors.
- **NFR-4 (client owns types):** The client never imports from `../src/`. The only
  cross-directory import remains the `@shared/logic` alias.
- **NFR-5 (modify, not rewrite):** Existing components are extended in place.
  `MessageBubble.svelte` and `SystemPill.svelte` remain as files for compatibility.
- **NFR-6 (test tier):** vitest unit/component tests only. No Playwright E2E.

---

## Item 87 — Backend overview endpoint, shared primitives, layout & overflow fixes

### Requirement 1 — Overview backend endpoint

**User story:** As the operator, I want a single read endpoint that summarizes
daemon health and activity, so the Overview page can render in one request.

#### Acceptance criteria

1.1. The endpoint SHALL be registered internally at the mount path `/overview`
(matching existing unprefixed route patterns like `/config` and `/sessions`); its
public URL is `/api/overview` via the Vite proxy. WHEN a client issues
`GET /api/overview` (reaching the handler at `/overview`) THEN the daemon SHALL
respond `200` with a JSON body conforming to the `OverviewResponse` shape.

1.2. The `OverviewResponse` SHALL contain exactly these fields:
`active_sessions: number`, `queue_depth: number`, `recent_prs: Array<{ title,
repo, url, state, opened_at }>`, `cron_summary: Array<{ name, repo, schedule,
state, next_fire }>`, `health: 'healthy' | 'degraded'`,
`version: string`, `uptime_s: number`.

1.3. `active_sessions` SHALL equal the count of sessions whose `status === 'active'`.

1.4. `queue_depth` SHALL equal the count of tasks in `'queued'` state in the task DB
(`tasks` table, `state = 'queued'`). WHEN the task DB is unavailable or the tasks
feature has not been enabled THEN `queue_depth` SHALL be `0`. The endpoint SHALL NOT
parse `ROADMAP.md` at request time.

1.5. Each `cron_summary[].state` SHALL be one of `'active' | 'paused' | 'error'`,
derived error-first from the cron's DB state: `IF last_status === 'failed' THEN
'error' ELSE IF paused THEN 'paused' ELSE 'active'`. The source fields are the cron
state table columns (`last_status`, `paused`). `next_fire` SHALL be an ISO 8601
string or `null`.

1.6. `health` SHALL be one of `'healthy' | 'degraded'`, computed as: `'degraded'`
WHEN any cron `state === 'paused'` OR any cron `state === 'error'` OR any `active`
session has `created_at < now - 2h`; else `'healthy'`. There is no runtime `'error'`
health state — a crashed daemon simply stops responding and the browser surfaces a
connection error (see Req 2.2 / the client-only "failed to fetch" state).

1.7. `version` SHALL be the daemon's package version string; `uptime_s` SHALL be the
whole-seconds process uptime.

1.8. The `/overview` endpoint SHALL always return HTTP `200` with zero/empty fallback
values (`0`, empty arrays) if any data source is unavailable. It SHALL never throw or
return a `5xx` for a missing/optional dependency.

1.9. The endpoint SHALL be read-only and SHALL NOT mutate any session, cron, or
config state.

1.10. `GET /overview` SHALL use the same bearer token auth middleware as all other
authenticated routes. Unauthenticated requests SHALL receive HTTP `401`.

### Requirement 2 — Client `OverviewResponse` type

**User story:** As a client developer, I want a typed DTO for the overview response
so the Overview page is type-checked.

#### Acceptance criteria

2.1. `client/src/lib/types.ts` SHALL define an `OverviewResponse` interface mirroring
Requirement 1.2 by value, following the existing client-owns-types convention.

2.2. The API layer (`client/src/lib/api.ts`) SHALL expose a method that fetches
`GET /api/overview` and returns a typed `OverviewResponse`, using the existing
`AuthError` handling. The server-side `health` field is `'healthy' | 'degraded'`
only; a failed fetch (crashed/unreachable daemon) is surfaced as a client-only
"failed to fetch overview" error state in the Overview page, not as a server
`health` value.

### Requirement 3 — `StatusBadge` component

**User story:** As a user, I want a consistent status pill so I can tell cron and
session states apart at a glance.

#### Acceptance criteria

3.1. A new `StatusBadge.svelte` SHALL render an inline pill with classes
`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium`
and a leading dot (`h-2 w-2 rounded-full`).

3.2. The component SHALL accept a closed-union `state` prop of
`'active' | 'paused' | 'error'` and an optional `label?: string` override prop.
It SHALL render: `active` → `var(--success)` dot + label (default "Active");
`paused` → `var(--warning)` dot + label (default "Paused"); `error` →
`var(--error)` dot + label (default "Error"). When `label` is provided it
replaces the default text, allowing callers to pass custom labels (e.g. "Healthy",
"Degraded").

3.3. The badge SHALL carry an accessible text label alongside the dot (the dot is
`aria-hidden`), so screen readers announce the state.

### Requirement 4 — `Card` and `PageHeader` primitives

**User story:** As a user, I want consistent surfaces and headings across views.

#### Acceptance criteria

4.1. A new `Card.svelte` SHALL render a reusable wrapper with
`rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4` and a default
slot for its contents.

4.2. A new `PageHeader.svelte` SHALL render an `<h1>` and an optional subtitle,
intended for the top of each view.

### Requirement 5 — Layout margins

**User story:** As a user, I want content to have breathing room instead of running
edge-to-edge.

#### Acceptance criteria

5.1. `App.svelte` SHALL wrap each routed view in a layout container that applies
horizontal and vertical padding and a centered max width.

5.2. The standard (`wide`) layout variant — used by the list, config, and overview
views — SHALL use `max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8`. The narrow layout
variant — used by the chat (`detail`) view — SHALL use `max-w-4xl mx-auto px-4 sm:px-6
lg:px-8` with NO vertical padding (no `py-6`), because vertical padding would push the
chat composer below the fold. To preserve the full-height chat layout under a 56px
(`h-14`, `3.5rem`) sticky header, `ChatView.svelte` SHALL use
`h-[calc(100dvh-3.5rem)]` instead of `h-[100dvh]`.

5.3. The layout wrapper SHALL be factored into a `PageLayout.svelte` component
accepting a width variant so each view selects its max width.

### Requirement 6 — Session list overflow fix

**User story:** As a mobile user, I want session rows to never overflow horizontally.

#### Acceptance criteria

6.1. In `SessionCard.svelte`, every flex parent in the row SHALL carry `min-w-0` so
children can shrink.

6.2. Any preview/subtitle text SHALL use `min-w-0 line-clamp-2 break-words text-sm
text-[var(--text-muted)]` with inline style `overflow-wrap: anywhere;`.

6.3. The repo/title line SHALL use `truncate` (single line).

6.4. `SessionList.svelte`'s container SHALL carry `overflow-x-hidden`.

6.5. WHEN rendered at a 320px viewport width THEN no session row content SHALL cause
horizontal overflow.

### Requirement 7 — App version define

**User story:** As a developer, I want the build to expose the app version so the
header can display it.

#### Acceptance criteria

7.1. `client/vite.config.ts` SHALL add a `define` for `__APP_VERSION__` read from the
client `package.json` version field, serialized as a JSON string.

7.2. `client/src/vite-env.d.ts` SHALL declare `__APP_VERSION__` so TypeScript resolves
it.

### Requirement 8 — New CSS tokens

#### Acceptance criteria

8.1. `client/src/app.css` SHALL add to `:root`:
`--accent` (value `#388bfd`), `--muted` (same value as `--text-muted`), and
`--header-bg` (value `rgb(13 17 23 / 0.9)` — the existing `--bg` hex `#0d1117`
expressed as RGB channels with 90% alpha). `--header-bg` MUST use the RGB-channel
form so the header can apply a translucent background via `bg-[var(--header-bg)]`
(Tailwind 3 opacity modifiers like `/90` do not work on hex-valued CSS variables).

8.2. No other hardcoded hex SHALL be introduced outside `app.css`.

---

## Item 88 — Header branding, router/overview routing, unified message grammar

### Requirement 9 — Router: add Overview, move Sessions to `#/sessions`

**User story:** As a user, I want `#/` to be the Overview and the session list at a
dedicated `#/sessions` route.

#### Acceptance criteria

9.1. `src/ui/logic.ts` SHALL extend `HashRoute` with an `{ view: 'overview' }` variant
and `parseHashRoute` SHALL map `#/` and empty hash to `overview`.

9.2. `parseHashRoute` SHALL map `#/sessions` (no id) to the session list (`list`), and
continue to map `#/sessions/<id>` to `detail` and `#/config` to `config`.

9.3. `router.svelte.ts` SHALL add a `goToOverview()` helper that sets `location.hash =
'#/'`, and `goToList()` SHALL navigate to `#/sessions`.

9.4. `App.svelte` SHALL render the Overview view WHEN `route.current.view ===
'overview'`, the session list WHEN `'list'`, config WHEN `'config'`, and the chat view
WHEN `'detail'` (unchanged chat semantics).

9.5. The router (or per-view code) SHALL set `document.title` per route: "Agent Router"
for overview, "Sessions · Agent Router" for list, "Config · Agent Router" for config.

### Requirement 10 — Header branding and navigation

**User story:** As a user, I want clear app branding, a version indicator, and tabbed
navigation in the header.

#### Acceptance criteria

10.1. `Header.svelte` SHALL render, on the left, an SVG router/branch glyph icon and
the text "Agent Router", together linking to `#/`.

10.2. `Header.svelte` SHALL display the version string from `__APP_VERSION__`.

10.3. The nav SHALL contain three tabs in order: **Overview** (`#/`), **Sessions**
(`#/sessions`), **Config** (`#/config`).

10.4. The active tab SHALL use an accent underline `border-b-2
border-[var(--accent)]`, replacing the previous `bg-[var(--system-pill-bg)]` active
style.

10.5. The active tab SHALL carry `aria-current="page"`; interactive nav elements SHALL
expose a visible focus ring via `focus-visible:ring-2
focus-visible:ring-[var(--accent)]`.

10.6. The header SHALL remain sticky (`sticky top-0`, `h-14`) and SHALL use
`backdrop-blur-sm bg-[var(--header-bg)]`, replacing the previous `bg-[var(--surface)]`.
The `--header-bg` token (an RGB-channel value with alpha, see Req 8.1) is used instead
of a Tailwind opacity modifier on a hex token (`bg-[var(--bg)]/90`), because opacity
modifiers do not work with hex-valued CSS variables in Tailwind 3.

### Requirement 11 — Unified message grammar in chat

**User story:** As a user, I want chat messages rendered with one consistent visual
grammar so I can tell who said what.

#### Acceptance criteria

11.1. A new `MessageRow.svelte` SHALL be the single row component used by
`ChatView.svelte` for the four message-bubble kinds: `agent` messages, `prompt`/
user entries, `system` status entries, and `error` entries. `ToolCallCard.svelte`
and `PermissionCard.svelte` remain separate and are NOT handled by `MessageRow`.
The old `MessageBubble.svelte` and `SystemPill.svelte` SHALL remain as files (NFR-5).

11.2. `MessageRow.svelte` SHALL render each kind with this grammar:
- `agent` → RIGHT aligned, `bg-[var(--agent-bubble-bg)]
  text-[var(--agent-bubble-text)]`, label "Agent". Agent text SHALL be rendered
  through `<MessageBubble bare />` (no new `{@html}`).
- `prompt` / user inject → LEFT aligned, `bg-[var(--surface)] border
  border-[var(--border)]`, label "Prompt" or "You".
- `tool_call` → rendered by `ToolCallCard.svelte` (NOT MessageRow).
- `tool_result` → rendered by `ToolCallCard.svelte` (NOT MessageRow).
- `system` / `session_started` / `session_ended` / `prompt_injected` → CENTERED,
  no bubble, `text-xs text-[var(--text-muted)]` with divider lines on either side,
  no label (matches the existing `SystemPill` style).
- `error` → RIGHT aligned, `bg-red-900/30 border border-red-700 text-red-300`, label
  "Error".

11.3. Every non-system row SHALL render a label line above the bubble
(`text-xs font-medium text-[var(--text-muted)] mb-1`) and SHALL expose the entry
timestamp in a `title` attribute AND as a displayed relative time (e.g. "3m ago").

11.4. For consecutive rows from the same sender, the label SHALL appear only on the
first row; intra-group spacing SHALL be `gap-1` and inter-group spacing `gap-4`.

11.5. Tool calls SHALL be rendered by `ToolCallCard.svelte` (not `MessageRow`). The
existing `ToolCallCard` collapse behavior (collapsed label `▸ tool_name(args_summary)`
→ expanded `<pre>` body) is unmodified by this feature.

11.6. Agent bubbles SHALL NEVER be centered.

11.7. `MessageRow.svelte` SHALL use no `{@html}`; it SHALL render agent text via the
existing safe rendering path used by the current chat view.

---

## Item 89 — Overview page, Config cron status, empty states

### Requirement 12 — Overview page

**User story:** As the operator, I want a landing dashboard summarizing current
activity and health.

#### Acceptance criteria

12.1. A new `Overview.svelte` SHALL render at `#/` and fetch `GET /api/overview` on
mount via the API layer, surfacing load, empty, and error states.

12.2. The page SHALL render four stat cards in a responsive row (2×2 on mobile):
Active Sessions, Queued Work (`queue_depth`), Recent PRs (24h count from
`recent_prs`), and a Health badge driven by `OverviewResponse.health`.

12.3. Each stat SHALL be rendered by a new `StatCard.svelte` child component
(label + value, built on `Card.svelte`).

12.4. The page SHALL render a Recent Sessions list showing the last five sessions,
reusing `SessionCard.svelte`.

12.5. The page SHALL render a compact Cron Summary (name, schedule, `StatusBadge`,
next fire) driven by `cron_summary`.

12.6. Each section SHALL show a skeleton loading state while the request is in flight.

12.7. WHEN a section's data is empty THEN that section SHALL show a muted icon +
message empty state.

### Requirement 13 — Config cron status column

**User story:** As the operator, I want the cron table to show an at-a-glance status
badge, not just a toggle button.

#### Acceptance criteria

13.1. The Config cron error state SHALL be derived from the `cron_summary` data in the
`GET /api/overview` response, NOT from `GET /config`. `GET /config` is out of scope and
never populates a `last_run_failed` flag, so the error state is sourced from
`cron_summary[].state === 'error'`. `ConfigView.svelte` SHALL fetch `/api/overview`
once (reusing the API method from Req 2.2) to obtain `cron_summary` and use it for the
`StatusBadge`.

13.2. `ConfigView.svelte`'s cron table SHALL add a `StatusBadge` column BEFORE the
Pause/Resume action button.

13.3. The badge state SHALL be derived error-first by combining two sources matched by
cron `name`:
- The **error bit** comes from `cron_summary[].state === 'error'` (sourced from
  `/api/overview`).
- The **paused bit** comes from the matching `CronScheduleEntry.paused` field from
  `GET /config` combined with the local optimistic pause/resume toggle.

Formula: `IF cron_summary[name].state === 'error' THEN 'error' ELSE IF
entry.paused OR optimistic-paused THEN 'paused' ELSE 'active'`.

Row matching is by `name` (string equality against `cron_summary[].name`). WHEN a
cron name from `/config` has no matching entry in `cron_summary` (e.g. `/api/overview`
fetch failed or returned partial data) THEN the badge SHALL fall back to deriving
state from `entry.paused` only (no error bit), treating missing as non-error.

13.4. The badge SHALL reflect the existing optimistic pause/resume state so toggling
updates the badge immediately.

13.5. The Pause/Resume button SHALL retain its neutral outline style.

### Requirement 14 — Empty states and polish across views

**User story:** As a user, I want every view to communicate clearly when there is no
data, with consistent accessibility.

#### Acceptance criteria

14.1. The session list, overview sections, and chat view SHALL each render a muted
icon + message empty state WHEN their data is empty.

14.2. `RepoGroup.svelte` SHALL show a paused indicator WHEN all sessions in the group
are inactive.

14.3. Each primary view SHALL render a `PageHeader.svelte` at its top.

14.4. All status badges SHALL be accompanied by a text label (no color-only meaning),
and active navigation SHALL carry `aria-current="page"`.

---

## Out of scope

- Dark/light mode toggle.
- Authentication changes.
- Backend changes beyond `GET /api/overview`.
- Data-model changes beyond the new endpoint.
- Playwright E2E tests (vitest only).
- Mobile swipe actions.

## Acceptance (feature-level)

- All six issues resolved and verified by vitest.
- No NEW `{@html}` directives in new/modified components other than the pre-existing
  `MessageBubble.svelte` (which is the sole sanctioned sanitized-markdown path per
  NFR-1). `MessageRow.svelte` contains no `{@html}`.
- All CSS uses `var(--token)` form; the only hex is in `app.css`.
- `svelte-check` is clean.
- `SessionCard.svelte` preview text does not overflow at a 320px viewport.
- The Config cron table shows a `StatusBadge` column.
- Overview renders at `#/` with all four stat cards and the cron summary.
- The header shows "Agent Router" branding with a version number.
- All chat messages render via `MessageRow.svelte` with correct alignment.

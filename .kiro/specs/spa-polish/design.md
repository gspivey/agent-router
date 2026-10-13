# Design — SPA UI Polish + Overview Dashboard

Feature slug: `spa-polish`

## Overview

This feature polishes the agent-router SPA and adds an Overview dashboard. It is a
mostly-client change (Svelte 5 runes + Vite 5 + Tailwind 3) with a single backend
addition: a read-only `GET /api/overview` endpoint in `src/web-routes.ts`.

The design respects the established SPA conventions:

- **Client owns its DTOs** (`client/src/lib/types.ts`) by value; the only
  cross-directory import is the `@shared/logic` alias → `src/ui/logic.ts`.
- **Pure logic is shared and DOM-free** in `src/ui/logic.ts`; routing is hand-rolled
  on top of `parseHashRoute` + the native `hashchange` event.
- **Existing components are modified, not replaced.** `MessageBubble.svelte` and
  `SystemPill.svelte` stay as files for compatibility even though `ChatView.svelte`
  stops importing them directly.
- **Colors come from CSS custom properties** in `app.css`. The only new hex lives in
  `app.css` (two new tokens).

The work is split across three PR-sized ROADMAP items (87 → 88 → 89), each with its
own tests, so each is independently reviewable and the dependency order holds.

## Architecture

```
                          ┌──────────────────────────────┐
   #/            ───────► │ Overview.svelte  (item 89)    │ ── GET /api/overview
   #/sessions    ───────► │ SessionList.svelte            │ ── GET /repos/sessions …
   #/sessions/id ───────► │ ChatView.svelte  (MessageRow) │ ── GET /sessions/:id, SSE
   #/config      ───────► │ ConfigView.svelte (StatusBadge│ ── GET /config
                          └──────────────────────────────┘
                                       ▲
                            App.svelte  → PageLayout (margins)
                            Header.svelte (branding, tabs, version)

   Shared primitives (item 87): Card, PageHeader, StatCard, StatusBadge
   Shared logic (item 88):      parseHashRoute adds 'overview'; HashRoute union grows
   Backend (item 87):           createWebRoutes adds GET /api/overview
```

### Routing model

`src/ui/logic.ts` owns the `HashRoute` union and `parseHashRoute`. Today:

```ts
export type HashRoute =
  | { view: 'list' }
  | { view: 'detail'; sessionId: string }
  | { view: 'config' };
```

The change adds an `overview` variant and remaps `#/`:

```ts
export interface HashRouteOverview { view: 'overview'; }
export type HashRoute =
  | HashRouteOverview
  | HashRouteList          // #/sessions
  | HashRouteDetail        // #/sessions/<id>
  | HashRouteConfig;       // #/config
```

`parseHashRoute` precedence after the change:

| Hash                 | Route                              |
|----------------------|------------------------------------|
| `''`, `#/`           | `{ view: 'overview' }`             |
| `#/sessions`         | `{ view: 'list' }`                 |
| `#/sessions/<id>`    | `{ view: 'detail', sessionId }`    |
| `#/config`           | `{ view: 'config' }`               |
| anything else        | `{ view: 'overview' }` (fallback)  |

> **Design note — the detail regex is unchanged.** The existing
> `^\/sessions\/([^/]+)$` match already excludes bare `#/sessions` (no trailing
> segment), so adding a `trimmed === '/sessions'` branch that returns `list` is a
> clean, non-overlapping addition. The default fallback flips from `list` to
> `overview`, since `#/` is now Overview.

`router.svelte.ts` keeps `route` as a `$state<{ current: HashRoute }>` and gains:

```ts
export function goToOverview(): void { location.hash = '#/'; }
export function goToList(): void { location.hash = '#/sessions'; } // was '#/'
```

`goToSession` and `goToConfig` are unchanged.

**`document.title` per route.** The router's `syncRoute()` is the single place the
hash is parsed, so it is the natural place to set `document.title`. A pure helper in
`src/ui/logic.ts` keeps the mapping testable:

```ts
export function routeTitle(route: HashRoute): string {
  switch (route.view) {
    case 'overview': return 'Agent Router';
    case 'list':     return 'Sessions · Agent Router';
    case 'config':   return 'Config · Agent Router';
    case 'detail':   return 'Session · Agent Router';
  }
}
```

`syncRoute()` calls `document.title = routeTitle(route.current)` after updating the
rune (guarded by `typeof document !== 'undefined'` for the test environment).

### App shell and layout

`App.svelte` currently mounts `Header` then branches on `route.current.view` with no
layout wrapper. The change introduces `PageLayout.svelte` and routes the new view:

```svelte
<Header />
{#if route.current.view === 'overview'}
  <PageLayout width="wide"><Overview /></PageLayout>
{:else if route.current.view === 'list'}
  <PageLayout width="wide"><SessionList /></PageLayout>
{:else if route.current.view === 'config'}
  <PageLayout width="wide"><ConfigView /></PageLayout>
{:else}
  <PageLayout width="narrow"><ChatView sessionId={route.current.sessionId} /></PageLayout>
{/if}
```

`PageLayout.svelte`:

```svelte
<script lang="ts">
  interface Props { width?: 'wide' | 'narrow'; }
  const { width = 'wide' }: Props = $props();
  // narrow (chat) drops vertical padding so the composer stays above the fold.
  const cls = $derived(
    width === 'narrow'
      ? 'max-w-4xl mx-auto px-4 sm:px-6 lg:px-8'
      : 'max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8',
  );
</script>
<div class={cls}><slot /></div>
```

> **Design note — the narrow (chat) variant removes vertical padding.** Only the
> standard (`wide`) variant adds `py-6`. The narrow variant applies horizontal gutters
> and max width but NO vertical padding, because `py-6` on the layout wrapper would
> push the chat composer below the fold. The chat view manages its own full-height
> scroll container, which changes from `h-[100dvh]` to `h-[calc(100dvh-3.5rem)]`
> (`3.5rem` = the 56px / `h-14` sticky header) so the chat column fits exactly below
> the header. Verified by the existing ChatView tests staying green.

## Components

### New components

| File | Role | Item |
|---|---|---|
| `PageLayout.svelte` | Centered max-width + gutter wrapper (`wide`/`narrow`) | 87 |
| `Card.svelte` | `rounded-lg border bg-surface p-4` surface, default slot | 87 |
| `PageHeader.svelte` | `<h1>` + optional subtitle | 87 |
| `StatusBadge.svelte` | Dot + label pill for `active`/`paused`/`error` | 87 |
| `MessageRow.svelte` | Unified chat row component (all kinds) | 88 |
| `Overview.svelte` | Dashboard page at `#/` | 89 |
| `StatCard.svelte` | Single stat card (label + value), built on `Card` | 89 |

### Modified components

| File | Change | Item |
|---|---|---|
| `App.svelte` | Add `PageLayout` wrappers; route `overview` | 87 (wrap) / 88 (route) |
| `SessionList.svelte` | Add `overflow-x-hidden` to the container; empty state | 87 / 89 |
| `SessionCard.svelte` | `min-w-0` on flex parents; preview `break-words`/`line-clamp-2`; `truncate` title | 87 |
| `Header.svelte` | Branding glyph + text + version; three nav tabs; accent underline; backdrop blur | 88 |
| `ChatView.svelte` | Render message-like entries through `MessageRow` | 88 |
| `MessageBubble.svelte` | Add `bare?: boolean` prop (renders via `renderMarkdown()` without outer wrapper) | 88 |
| `ToolCallCard.svelte` | No change to collapse behavior; kept as-is | — |
| `ConfigView.svelte` | Add `StatusBadge` column to the cron table; fetch `/api/overview` once for `cron_summary` | 89 |
| `RepoGroup.svelte` | Paused indicator when all sessions inactive | 89 |

> **Design note — Config cron status source (HIGH-4).** `GET /config` is out of scope
> and never populates a `last_run_failed` flag, so the Config cron table derives the
> error bit from `/api/overview` and the paused bit from `GET /config`.
> `ConfigView.svelte` fetches `/api/overview` once on mount and uses the matching
> `cron_summary[]` entry (matched by `name`) for the error bit, combined with the
> `CronScheduleEntry.paused` field from `/config` and the local optimistic pause/resume
> toggle. Row-matching is by `name` (string equality). WHEN a `/api/overview` fetch
> fails or a cron name is absent from `cron_summary`, the badge falls back to deriving
> state from `entry.paused` only (no error bit shown). This means optimistic
> pause/resume (toggling `entry.paused` locally before the server round-trips) keeps
> the badge live even when the overview data is stale.

### Preserved files (not deleted)

`MessageBubble.svelte` and `SystemPill.svelte` remain in the tree per NFR-5, even
though `ChatView.svelte` no longer imports them. Their existing tests continue to run.

### `StatusBadge.svelte`

```svelte
<script lang="ts">
  type BadgeState = 'active' | 'paused' | 'error';
  interface Props { state: BadgeState; label?: string; }
  const { state, label }: Props = $props();
  const DOT: Record<BadgeState, string> = {
    active: 'var(--success)', paused: 'var(--warning)', error: 'var(--error)',
  };
  const DEFAULT_LABEL: Record<BadgeState, string> = {
    active: 'Active', paused: 'Paused', error: 'Error',
  };
</script>
<span
  data-testid="status-badge"
  data-state={state}
  class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
>
  <span aria-hidden="true" class="h-2 w-2 rounded-full" style="background: {DOT[state]};"></span>
  {label ?? DEFAULT_LABEL[state]}
</span>
```

The label text is always present (no color-only meaning), satisfying Req 3.3 / 14.4.

### `MessageRow.svelte` — unified chat grammar

`MessageRow` is a presentational component. `ChatView.svelte` keeps its existing
pipeline (`parseStreamEntry` → `buildRenderItems` → `RenderItem[]`) and `EntryShell`
JSON-pivot wrapper. `MessageRow` is used ONLY for the agent/user-prompt/system/error
message bubbles. **`ToolCallCard.svelte` and `PermissionCard.svelte` remain as
separate components** and continue to render tool calls and permission requests;
`MessageRow` does not replace them.

#### `RenderItem` kind → render target mapping

Every existing `RenderItem`/stream kind maps to exactly one render target. `MessageRow`
only handles `agent`, `prompt`/`user`, `system`, and `error`:

| source entry / `RenderItem` kind | `MessageRow` `RowKind` | rendered by |
|---|---|---|
| `agent_message` / `agent_message_chunk` | `agent` | **MessageRow** |
| `tool_call` / `tool_call_update` | `tool_call` | **ToolCallCard** (NOT MessageRow) |
| `session/request_permission` | `permission` | **PermissionCard** (NOT MessageRow) |
| `session_started` / `session_ended` / `prompt_injected` | `system` | **MessageRow** (SystemPill-style centered row) |
| `_kiro.dev/metadata` (internal) | `internal` | **InternalPill** (only shown with ShowInternals) |
| user / injected prompt | `prompt` | **MessageRow** |
| error entry | `error` | **MessageRow** |
| skeleton loading rows | — | **SkeletonBubble** (NOT MessageRow) |

So `MessageRow` is the single row component for agent message bubbles, user/prompt
rows, system pills, and error rows. Tool calls, permission requests, internal
metadata pills, and loading skeletons each keep their dedicated component. (This is
why Req 11.1 is scoped to "all agent message bubbles use `MessageRow`", not "all chat
messages".)

`MessageRow` props (closed union to keep rendering total and testable):

```ts
type RowKind = 'agent' | 'prompt' | 'system' | 'error';
interface MessageRowProps {
  kind: RowKind;
  text: string;
  label?: string;        // defaults derived from kind; also the grouping key (see HIGH-11)
  timestamp?: string;    // ISO; shown in title + relative
  showLabel?: boolean;   // false for grouped consecutive rows
}
```

> **Design note — `tool_call`/`tool_result` are NOT `MessageRow` kinds.** They are
> rendered by `ToolCallCard.svelte` and `PermissionCard.svelte` respectively and never
> passed to `MessageRow`. The `toolName?`/`argsSummary?`/`ok?` props are removed;
> `ToolCallCard` keeps its own props. This makes `RowKind` a closed four-value union
> matching the requirements exactly.

Grammar table (Req 11.2), all colors tokenized:

| kind | align | bubble classes | label |
|---|---|---|---|
| `agent` | RIGHT | `bg-[var(--agent-bubble-bg)] text-[var(--agent-bubble-text)]` | "Agent" |
| `prompt` | LEFT | `bg-[var(--surface)] border border-[var(--border)]` | "Prompt" / "You" |
| `system` | CENTER | none; `text-xs text-[var(--text-muted)]` with divider lines | — |
| `error` | RIGHT | `bg-red-900/30 border border-red-700 text-red-300` | "Error" |

`tool_call` and `tool_result` entries are **NOT** in this table — they are rendered
by `ToolCallCard.svelte`, not `MessageRow`.

> **NFR-2 exception — the `error` row uses Tailwind palette utilities
> (`bg-red-900/30 border-red-700 text-red-300`) not `var(--token)` CSS variables.**
> These are Tailwind class names (not raw hex strings in `.svelte` files) and match
> the brief's Issue 4 specification verbatim. No `--error-bg` or `--error-border`
> CSS token exists in `app.css`; adding one is out of scope. This is the only
> permitted non-`var()` color reference in `.svelte` files (NFR-2).

Supporting rules:

- **Label line** (Req 11.3): rendered above the bubble as
  `text-xs font-medium text-[var(--text-muted)] mb-1` when `showLabel` and `kind !==
  'system'`.
- **Timestamp** (Req 11.3): `title={timestamp}` on the row plus a displayed relative
  string. Relative formatting is a pure helper in `src/ui/logic.ts`:
  `formatRelativeTime(nowMs, tsMs)` → "just now" / "3m ago" / "2h ago" / "5d ago".
  Keeping it pure (clock injected) makes it Tier-1 testable.
- **Grouping** (Req 11.4, HIGH-11): grouping is on the `(kind, label)` PAIR, not on
  `kind` alone. A row groups with the PREVIOUS row IFF `kind === prev.kind AND label
  === prev.label`. This prevents consecutive `tool_call` rows for *different* tools
  from collapsing into one group (their labels — tool names — differ), and prevents
  two consecutive agent messages from different sources (different labels) from
  grouping. The grouping decision is a pure helper
  `groupLabelVisible(prev, cur)` in `src/ui/logic.ts` that takes the `(kind, label)`
  of the previous and current rows and returns `false` (hide label, same group) only
  when both match. `ChatView` sets `showLabel = !sameGroup` and applies the vertical
  margin per row: the **first** row of a group gets `mt-4` (inter-group spacing); each
  **subsequent** row in the same group gets `mt-1` (intra-group spacing).
- **Tool collapse** (Req 11.5): handled entirely by `ToolCallCard.svelte`. `MessageRow`
  has no collapse behavior.
- **Never center agent** (Req 11.6): the `agent` branch is hard-coded RIGHT; there is
  no code path that centers it.
- **No NEW `{@html}`** (Req 11.7 / NFR-1): `MessageRow` MUST NOT introduce a new
  `{@html}` sink. The only sanctioned sanitized-markdown path is `renderMarkdown()`
  from `chat-render.ts`, used exclusively inside `MessageBubble.svelte`. For agent
  markdown, `MessageRow` delegates to that existing path by composing
  `MessageBubble.svelte` with a new `bare?: boolean` prop. When `bare` is `true`,
  `MessageBubble` renders agent text via `renderMarkdown()` but omits its outer bubble
  wrapper div, allowing `MessageRow` to supply its own wrapper. `MessageRow` uses
  `<MessageBubble bare />` for the `agent` kind and contains no `{@html}` directive.
  All other kinds render as escaped plain text. There is no alternative path that
  requires `{@html}` in `MessageRow`.

### `Overview.svelte`

Fetches `GET /api/overview` on mount via the API layer. State machine mirrors
`ConfigView.svelte`: `loading` → (`error` | data), with `AuthError` swallowed (the
global auth lockout handles it). Sections:

1. **Stat row** — four `StatCard`s in a grid: `grid grid-cols-2 gap-4 lg:grid-cols-4`
   (2×2 on mobile, 1×4 on large). Cards: Active Sessions (`active_sessions`), Queued
   Work (`queue_depth`), Recent PRs (count of `recent_prs` opened in the last 24h),
   Health. The Health card uses `value="System"` plus a `StatCard` `badge` prop
   derived from `health`: `healthy → {state:'active', label:'Healthy'}`,
   `degraded → {state:'paused', label:'Degraded'}`. There is no `error` health state (see
   health enum). If `getOverview()` fails, the whole page shows the client-only
   "failed to fetch overview" error state instead of rendering the Health card.
2. **Recent Sessions** — last five sessions via `SessionCard.svelte`. The overview
   endpoint summarizes PRs/crons but not full session rows; `Overview` fetches the
   session list the same way `SessionList` does (reusing the API method) and slices
   to five. Empty state when none.
3. **Cron Summary** — compact table rows: name, schedule, `StatusBadge` (state from
   `cron_summary[].state`), next fire. Empty state when none.

Each section renders a skeleton while `loading` (reuse `SkeletonBubble.svelte` or a
simple shimmer block) per Req 12.6, and a muted icon + message empty state per Req
12.7 / 14.1.

`StatCard.svelte` is a thin wrapper over `Card` with an optional `badge` so the Health
card can render a status pill below the value (`StatCard.value` alone is a
`string | number` and cannot carry a badge widget):

```svelte
<script lang="ts">
  import StatusBadge from './StatusBadge.svelte';
  import Card from './Card.svelte';
  type BadgeState = 'active' | 'paused' | 'error';
  interface StatBadge { state: BadgeState; label?: string; }
  interface Props { label: string; value: string | number; badge?: StatBadge; }
  const { label, value, badge }: Props = $props();
</script>
<Card>
  <div class="text-xs text-[var(--text-muted)]">{label}</div>
  <div class="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{value}</div>
  {#if badge}
    <StatusBadge state={badge.state} label={badge.label} />
  {/if}
</Card>
```

The Health card passes `value="System"` and a `badge` derived from `health`:
`healthy → {state:'active', label:'Healthy'}`, `degraded → {state:'paused',
label:'Degraded'}`. The badge dot colors are inherited from `StatusBadge`'s existing
`--success`/`--warning`/`--error` tokens (no separate color enum). There is no
`error` health state (see health enum), so `{state:'error'}` is reserved for other
badge consumers.

### `Header.svelte`

```svelte
<header class="sticky top-0 z-10 flex h-14 items-center gap-4 border-b
               border-[var(--border)] bg-[var(--header-bg)] px-4 backdrop-blur-sm">
  <a href="#/" class="flex items-center gap-2 focus-visible:ring-2
     focus-visible:ring-[var(--accent)]" aria-label="Agent Router home">
    <svg aria-hidden="true" …router/branch glyph… ></svg>
    <span class="text-sm font-semibold text-[var(--text-primary)]">Agent Router</span>
    <span class="text-xs text-[var(--text-muted)]">v{__APP_VERSION__}</span>
  </a>
  <nav aria-label="Main navigation" class="flex items-center gap-1">
    <!-- Overview / Sessions / Config tabs -->
  </nav>
</header>
```

Active-tab style changes from `bg-[var(--system-pill-bg)]` to a bottom accent
underline. A tab is active when:

| tab | active when |
|---|---|
| Overview | `route.current.view === 'overview'` |
| Sessions | `route.current.view === 'list' \|\| 'detail'` |
| Config | `route.current.view === 'config'` |

Active tabs get `border-b-2 border-[var(--accent)] text-[var(--text-primary)]` and
`aria-current="page"`; inactive tabs get `text-[var(--text-muted)]
hover:text-[var(--text-primary)]`. All tabs carry `focus-visible:ring-2
focus-visible:ring-[var(--accent)]`.

The SVG glyph is an inline `aria-hidden` path (a simple branch/route icon drawn with
`currentColor`), introducing no new dependency.

### `SessionCard.svelte` overflow fix

The existing card already uses `min-w-0 flex-1` on the middle column and `truncate`
on the repo line, so the fix is incremental:

- Ensure the outer `button` row and the middle column both carry `min-w-0` (the row
  gets it added).
- Keep `truncate` on the repo/title line (Req 6.3).
- The brief's "preview text" (`line-clamp-2 break-words … overflow-wrap: anywhere`)
  applies to any multi-line subtitle. The current card's subtitle is a single-line
  id+timestamp row, so the preview classes are applied to the subtitle text node and
  the `overflow-wrap: anywhere` inline style is added so a long `waiting_for`/repo
  value cannot push width. `SessionList.svelte` gains `overflow-x-hidden` on its
  container (Req 6.4) as the backstop.

> **Design note — the 320px no-overflow guarantee (Req 6.5)** is a layout property of
> `min-w-0` + `truncate`/`break-words` + container `overflow-x-hidden`. It is verified
> structurally in a vitest component test (asserting the classes/inline style are
> present) rather than by pixel measurement, since jsdom does not lay out.

## Backend: `GET /api/overview`

Registered in `createWebRoutes(deps)` on the local `app`, alongside the existing
handlers. The vite dev proxy already forwards `/api` to the daemon, so no proxy
change is needed.

> **Design note — path prefix.** Existing routes (`/sessions`, `/config`,
> `/repos/sessions`) have no `/api` prefix; the Vite proxy prepends `/api`. The new
> route is registered at the literal mount path **`/overview`** (NOT `/api/overview`),
> matching the existing unprefixed route patterns. Registering `/api/overview`
> literally would be served at the public URL `/api/api/overview` once the proxy adds
> its prefix. The public URL is therefore `/api/overview`, which the client fetches;
> the handler lives at `/overview`.

> **Design note — auth.** `/overview` SHALL sit behind the same bearer-token auth
> middleware as the other authenticated routes (Req 1.10). Unauthenticated requests
> receive `401`, consistent with `/config` and `/sessions`.

Handler shape (sketch, mirroring the existing guarded handlers):

```ts
const startedAt = Date.now(); // captured once in the factory closure

app.get('/overview', (c) => {   // public URL /api/overview via the Vite proxy
  const sessions = sessionFiles.listSessions();
  const nowS = Math.floor(Date.now() / 1000);

  const active = sessions.filter(s => s.status === 'active');
  const active_sessions = active.length;

  const cronStates = db?.getAllCronStates() ?? [];
  const cron_summary = buildCronSummary(config?.cron ?? [], cronStates); // pure
  const queue_depth = computeQueueDepth();                               // see below
  const recent_prs = collectRecentPrs(sessions);                         // pure-ish
  const health = computeHealth({
    cronSummary: cron_summary,
    activeSessions: active,
    nowS,
  }); // pure, Req 1.6 — 'healthy' | 'degraded' only

  return c.json({
    active_sessions,
    queue_depth,
    recent_prs,
    cron_summary,
    health,
    version: readVersion(),         // package.json version, cached
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
  } satisfies OverviewResponse);
});
```

Pure helpers (exported from `src/web-routes.ts` or a small sibling, Tier-1 testable):

- `computeHealth(input): 'healthy' | 'degraded'` — Req 1.6 logic exactly: `degraded`
  if any cron `state === 'paused'` OR any cron `state === 'error'` OR any active
  session `created_at < nowS - 7200`; else `healthy`. There is NO `'error'` branch in
  the health output and no `pollerDown` input — a crashed daemon cannot respond, so
  the browser surfaces a connection error instead (handled client-side in
  `Overview.svelte`).
- `buildCronSummary(cronConfig, cronStates)` — maps each configured cron to
  `{ name, repo, schedule, state, next_fire }`, deriving `state` error-first,
  identically to Req 1.5/13.3: `IF last_status === 'failed' THEN 'error' ELSE IF
  paused THEN 'paused' ELSE 'active'`. Source fields are the cron state table columns
  (`last_status`, `paused`). No `last_run_failed` or `enabled` field is read.

**`queue_depth` (Req 1.4).** `queue_depth` is the count of tasks in `'queued'` state
in the task DB — `SELECT count(*) FROM tasks WHERE state = 'queued'` against the
task-attempt-outcome DB that was just implemented. WHEN the task DB is unavailable or
the tasks feature has not been enabled, `computeQueueDepth()` returns `0`. It MUST NOT
parse `ROADMAP.md` at request time. The source is isolated behind a single
`computeQueueDepth()` function so the fallback keeps the endpoint total and
side-effect-free (Req 1.8, 1.9).

**`recent_prs` (24h).** Collected from session PR registrations
(`SessionSummary.prs`) across sessions, shaped to `{ title, repo, url, state,
opened_at }`. Where a field is not available from session metadata (e.g. PR title),
the helper uses a stable derived value (e.g. `repo#number`) rather than fabricating
data, and `state` defaults to `'open'` for a registered-but-unmerged PR and
`'merged'` when `merged_at` is set. The Overview page's "Recent PRs (24h)" stat
counts entries with `opened_at` within the last 24h.

**Health is `healthy` or `degraded` only.** There is no runtime `'error'` health
value and no poller-down probe: a crashed daemon cannot respond at all, so "down" is
observed by the browser as a failed fetch, not as a `health` field value.
`Overview.svelte` maps a failed `getOverview()` to a client-only "failed to fetch
overview" error state. `health` reaches `degraded` via any cron with
`state === 'paused'` or `state === 'error'`, or via stale active sessions
(`created_at < now - 2h`); else `healthy`.

**Always HTTP 200 (Req 1.8).** Every data source has a fallback (`0`, empty array),
so the handler always returns `200` with fallback values when a source is
unavailable; it never returns a `503 not_configured` or any `5xx` for an
optional/missing dependency.

**`version`.** Read once from the daemon's `package.json` `version` and cached in the
factory closure (never re-read per request).

### Client types & API

`client/src/lib/types.ts` adds:

```ts
export interface OverviewRecentPr {
  readonly title: string;
  readonly repo: string;
  readonly url: string;
  readonly state: string;
  readonly opened_at: string; // ISO 8601
}
export interface OverviewCronSummary {
  readonly name: string;
  readonly repo: string;
  readonly schedule: string;
  readonly state: 'active' | 'paused' | 'error';
  readonly next_fire: string | null;
}
export interface OverviewResponse {
  readonly active_sessions: number;
  readonly queue_depth: number;
  readonly recent_prs: OverviewRecentPr[];
  readonly cron_summary: OverviewCronSummary[];
  readonly health: 'healthy' | 'degraded';
  readonly version: string;
  readonly uptime_s: number;
}
```

The Config cron error state is NOT sourced from `GET /config` (which never populates a
`last_run_failed` flag and is out of scope). `ConfigView.svelte` instead reads the
`cron_summary[].state` from the `/api/overview` response (see the ConfigView design
note above). No change to `CronScheduleEntry` is required for the badge; the
`OverviewCronSummary.state` field is the single source of the error/paused/active
state the badge renders.

`client/src/lib/api.ts` adds `getOverview(): Promise<OverviewResponse>` calling
`GET /api/overview` through the same fetch wrapper used by `getConfig`, so `AuthError`
and resilience behavior are inherited.

## CSS tokens

`client/src/app.css` `:root` gains:

```css
--accent: #388bfd;             /* same value as --tool-card-accent, named for nav/focus */
--muted: #8b949e;              /* alias of --text-muted */
--header-bg: rgb(13 17 23 / 0.9); /* --bg (#0d1117) as RGB channels + 90% alpha */
```

`--header-bg` MUST be expressed in the RGB-channel form (`rgb(13 17 23 / 0.9)`), not a
hex with a Tailwind opacity modifier. In Tailwind 3, opacity modifiers like
`bg-[var(--bg)]/90` only work when the variable holds RGB channels; a hex-valued
variable breaks the modifier. The header therefore uses `bg-[var(--header-bg)]`
directly (no `/90`). These are the only new values; all `.svelte` files reference
them as `var(--accent)` / `var(--muted)` / `var(--header-bg)`.

## Vite / build

`client/vite.config.ts` adds a `define`:

```ts
import pkg from './package.json' assert { type: 'json' };
// …
define: { __APP_VERSION__: JSON.stringify(pkg.version) },
```

`client/src/vite-env.d.ts` declares the global:

```ts
declare const __APP_VERSION__: string;
```

> **Design note — importing `package.json` in `vite.config.ts`.** The config is ESM;
> a JSON import assertion (or `createRequire`) reads the version at config-eval time.
> If the import-assertion syntax causes a type hiccup under the client tsconfig, the
> fallback is `JSON.parse(readFileSync('./package.json','utf8')).version`. Either way
> `__APP_VERSION__` is a build-time string constant.

## Testing strategy (vitest only — NFR-6)

Tests follow the existing client test layout (`*.test.ts` beside components, pure
logic in `src/ui/logic.test.ts` / shared `.test.ts`).

### Item 87

- **Pure (shared logic / backend helpers):**
  - `computeHealth` — healthy / degraded (paused cron) / degraded (error cron) /
    degraded (stale active session at exactly 2h boundary); only
    `'healthy' | 'degraded'` outcomes (no `'error'`, no poller-down input). (Req 1.6)
  - `buildCronSummary` — error-first state derivation (error / paused / active per
    Req 1.5). (Req 1.5)
- **Component:**
  - `StatusBadge` renders correct label + dot token per state; dot is `aria-hidden`;
    label text present. (Req 3)
  - `Card` / `PageHeader` render slot/heading/subtitle. (Req 4)
  - `SessionCard` carries `min-w-0` on the row and `break-words` + `overflow-wrap`
    on the subtitle; title keeps `truncate`. (Req 6)
  - `SessionList` container has `overflow-x-hidden`. (Req 6.4)
- **Backend (Tier-2 style, if a daemon harness is reachable from the client suite is
  N/A here):** the endpoint is validated at the pure-helper level above; a thin
  handler test asserts the assembled `OverviewResponse` shape from stubbed deps and
  that the handler returns `200` with zero/empty fallback values when optional data
  sources are absent (there is no `503`/`not_configured` path). Auth (`401` when
  unauthenticated) is covered by the shared auth-middleware tests.

### Item 88

- **Pure:**
  - `parseHashRoute` — `#/` and `''` → overview; `#/sessions` → list; `#/sessions/x`
    → detail; `#/config` → config; junk → overview. (Req 9.1, 9.2)
  - `routeTitle` — one assertion per view. (Req 9.5)
  - `formatRelativeTime` — "just now"/"3m ago"/"2h ago"/"5d ago" with injected clock.
  - `groupLabelVisible` — label shown on sender change, hidden on repeat. (Req 11.4)
- **Component:**
  - `Header` shows "Agent Router", the version, three tabs; active tab has the accent
    underline + `aria-current="page"`; header uses backdrop-blur + `bg-[var(--header-bg)]`.
    (Req 10)
  - `MessageRow` — agent RIGHT with agent-bubble tokens; prompt LEFT; system CENTER
    no bubble; error RIGHT with the red classes; tool_call collapses/expands; agent is
    never centered; no `{@html}`. (Req 11)
  - `ChatView` renders through `MessageRow` and still passes existing streaming tests.

### Item 89

- **Component:**
  - `Overview` fetches on mount, renders four stat cards, recent sessions, cron
    summary; shows skeletons while loading and empty states when sections are empty.
    (Req 12)
  - `StatCard` renders label + value, and renders a `StatusBadge` below the value when
    the optional `badge` prop is supplied (Health card: `value="System"` + badge).
    (Req 12.3)
  - `ConfigView` cron table shows a `StatusBadge` column before the action button;
    state derives error-first from the `/api/overview` `cron_summary` combined with the
    optimistic paused flag; toggling updates the badge optimistically. (Req 13)
  - `RepoGroup` shows a paused indicator when all sessions are inactive. (Req 14.2)
  - Empty states present on list/overview/chat. (Req 14.1)

### Property tests

Where a pure helper has a natural invariant, add a fast-check property (≥100 runs),
consistent with the repo's Tier-1 convention — e.g. `formatRelativeTime` is monotonic
(a larger elapsed time never yields a "smaller" unit) and `computeHealth` is never
`healthy` when any cron is paused.

## Risks & mitigations

- **Chat composer pushed below the fold** by the narrow `PageLayout` wrapper →
  mitigated by removing vertical padding from the narrow variant and sizing the chat
  column to `h-[calc(100dvh-3.5rem)]` (header height), so the composer stays visible;
  verified by existing ChatView tests staying green.
- **`queue_depth` source** → counts `tasks` rows with `state = 'queued'` in the task
  DB, isolated behind `computeQueueDepth()` with a defined `0` fallback when the task
  DB is unavailable (Req 1.4).
- **`__APP_VERSION__` config import** → documented ESM import-assertion with a
  `readFileSync` fallback.
- **Token drift** (`--accent` vs existing `--tool-card-accent`) → `--accent` is given
  the same value, so no visual drift; the alias exists for semantic naming on nav/focus.

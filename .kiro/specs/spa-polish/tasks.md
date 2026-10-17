# Implementation Plan — SPA UI Polish + Overview Dashboard

Feature slug: `spa-polish`

Tasks are grouped by ROADMAP item (87 → 88 → 89) and ordered so each builds only on
already-merged work. Each top-level task is one PR-sized unit. Sub-tasks cite the
requirements they satisfy. Every behavioral change ships with vitest coverage
(NFR-6); `svelte-check` must stay clean (NFR-3); no `{@html}` (NFR-1); colors via
`var(--token)` only, hex only in `app.css` (NFR-2); client never imports from
`../src/` except the `@shared/logic` alias (NFR-4); existing components are modified
in place and `MessageBubble.svelte`/`SystemPill.svelte` are kept (NFR-5).

ROADMAP items map as: **87** = Group 1, **88** = Group 2, **89** = Group 3.

---

## Group 1 — ROADMAP item 87: backend endpoint, shared primitives, layout & overflow

- [x] 1. Add CSS tokens and the app-version build define
  - [ ] 1.1 Add `--accent: #388bfd`, `--muted: #8b949e`, and
    `--header-bg: rgb(13 17 23 / 0.9)` (the `--bg` hex `#0d1117` as RGB channels + 90%
    alpha) to `:root` in `client/src/app.css`. `--header-bg` MUST be RGB-channel form so
    the header can use `bg-[var(--header-bg)]` (Tailwind 3 opacity modifiers do not work
    on hex-valued vars). (Req 8.1, 8.2)
  - [ ] 1.2 Add `define: { __APP_VERSION__: JSON.stringify(pkg.version) }` to
    `client/vite.config.ts`, reading the version from `client/package.json` (import
    assertion, or `readFileSync` fallback). (Req 7.1)
  - [ ] 1.3 Declare `declare const __APP_VERSION__: string;` in
    `client/src/vite-env.d.ts`. (Req 7.2)

- [x] 2. Implement the `GET /api/overview` backend endpoint
  - [ ] 2.1 Read `src/web-routes.ts` fully (factory deps, existing guarded handlers,
    `groupSessionsByRepo`, cron-state access) before editing.
  - [ ] 2.2 Add exported pure helper `computeHealth(input)` returning
    `'healthy' | 'degraded'` (no `'error'`, no `pollerDown` input) per Req 1.6:
    `degraded` if any cron state is `'paused'` OR `'error'`, OR any active session
    `created_at < now - 7200s`; else `healthy`. A crashed daemon stops responding
    (observed client-side as a failed fetch), so there is no runtime `'error'` health
    value. (Req 1.6)
  - [ ] 2.3 Add exported pure helper `buildCronSummary(cronConfig, cronStates)`
    mapping each cron to `{ name, repo, schedule, state, next_fire }`, deriving `state`
    error-first (identical to Req 1.5/13.3):
    `IF last_status === 'failed' THEN 'error' ELSE IF paused THEN 'paused' ELSE 'active'`.
    Source fields are the cron state table columns (`last_status`, `paused`). No
    `last_run_failed` or `enabled` field is used. (Req 1.5)
  - [ ] 2.4 Add `computeQueueDepth()` counting `tasks` rows with `state = 'queued'` in
    the task DB when present, else returning `0`; MUST NOT parse `ROADMAP.md` at request
    time. (Req 1.4)
  - [ ] 2.5 Add `collectRecentPrs(sessions)` shaping `{ title, repo, url, state,
    opened_at }` from session PR registrations (`state` = `'merged'` when `merged_at`
    set, else `'open'`; derive a stable `title` without fabricating data).
  - [ ] 2.6 Cache the daemon `package.json` version in the factory closure; capture
    `startedAt` once for `uptime_s`. (Req 1.7)
  - [ ] 2.7 Register `app.get('/overview', …)` (NOT `/api/overview` — existing routes
    are unprefixed and the Vite proxy adds `/api`; the public URL is `/api/overview`)
    assembling `OverviewResponse`; ALWAYS return HTTP `200` with zero/empty fallback
    values (`0`, empty arrays) when a data source is unavailable (no `503`/
    `not_configured` path); place the route behind the same bearer-token auth
    middleware as other authenticated routes (`401` when unauthenticated); keep the
    handler read-only. (Req 1.1, 1.2, 1.3, 1.8, 1.9, 1.10)

- [x] 3. Add client `OverviewResponse` type and API method
  - [ ] 3.1 Add `OverviewRecentPr`, `OverviewCronSummary`, `OverviewResponse` to
    `client/src/lib/types.ts` (client-owns-types, by value). (Req 2.1)
  - [ ] 3.2 Add `getOverview(): Promise<OverviewResponse>` to `client/src/lib/api.ts`
    using the existing fetch wrapper / `AuthError` handling. (Req 2.2)

- [x] 4. Build shared presentational primitives
  - [ ] 4.1 Create `client/src/components/StatusBadge.svelte` (dot + label for
    `active`/`paused`/`error`; dot `aria-hidden`; tokenized colors). (Req 3.1–3.3)
  - [ ] 4.2 Create `client/src/components/Card.svelte`
    (`rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4`, default
    slot). (Req 4.1)
  - [ ] 4.3 Create `client/src/components/PageHeader.svelte` (`<h1>` + optional
    subtitle). (Req 4.2)

- [x] 5. Add layout margins
  - [ ] 5.1 Create `client/src/components/PageLayout.svelte` with a `width:
    'wide' | 'narrow'` prop. `wide` → `max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8`;
    `narrow` → `max-w-4xl mx-auto px-4 sm:px-6 lg:px-8` with NO vertical padding (no
    `py-6`), so the chat composer is not pushed below the fold. (Req 5.2, 5.3)
  - [ ] 5.2 Wrap each routed view in `App.svelte` with `PageLayout` (`wide` for list
    and config; `narrow` for the `detail`/chat view). Change `ChatView.svelte` height
    from `h-[100dvh]` to `h-[calc(100dvh-3.5rem)]` (`3.5rem` = the `h-14`/56px sticky
    header) so the chat column fits exactly below the header. (Req 5.1, 5.2)

- [x] 6. Fix session-list horizontal overflow
  - [ ] 6.1 Identify and reproduce the horizontal overflow bug using a REAL browser
    (not jsdom — jsdom does not lay out). The fix SHALL target the specific element
    that actually causes the overflow; likely candidates are the `RepoGroup` header
    row, a long session-ID display, or a badge with `whitespace-nowrap`. After
    reproducing, apply `min-w-0` to the offending flex parent and `line-clamp-2` to the
    message/subtitle text in `SessionCard.svelte`; keep `truncate` on the single-line
    repo/title line; add inline `overflow-wrap: anywhere;` to multi-line text. The
    acceptance criterion is a MANUAL browser check at a 320px viewport showing no
    horizontal overflow. (Req 6.1, 6.2, 6.3, 6.5)
  - [ ] 6.2 Add `overflow-x-hidden` to the `SessionList.svelte` container as a
    backstop. (Req 6.4)

- [x] 7. Item 87 tests (vitest)
  - [ ] 7.1 Pure: `computeHealth` (healthy / degraded via paused cron / degraded via
    error cron / degraded via stale active session at the 2h boundary). Only
    `'healthy' | 'degraded'` outcomes — no `'error'`/poller-down case. (Req 1.6)
  - [ ] 7.2 Pure: `buildCronSummary` error-first state derivation: `last_status ===
    'failed'` → error; `paused` → paused; else → active. (Req 1.5)
  - [ ] 7.3 Backend handler shape test from stubbed deps asserting the
    `OverviewResponse` fields AND that the handler returns `200` with zero/empty
    fallback values when optional data sources are absent (there is no `503`/
    `not_configured` path). (Req 1.1, 1.2, 1.8)
  - [ ] 7.4 Component: `StatusBadge` label + dot token per state, dot `aria-hidden`.
    (Req 3)
  - [ ] 7.5 Component: `Card` / `PageHeader` render slot / heading / subtitle. (Req 4)
  - [ ] 7.6 Component: `SessionCard` has `min-w-0` on the row and `break-words` +
    `overflow-wrap`/`line-clamp-2` on the subtitle, `truncate` on the title;
    `SessionList` container has `overflow-x-hidden`. NOTE: vitest/jsdom does NOT verify
    the 320px no-overflow guarantee (jsdom does not lay out); the 320px check is the
    manual browser acceptance criterion in task 6.1. (Req 6.1–6.4)

---

## Group 2 — ROADMAP item 88: header branding, router/overview routing, message grammar

- [x] 8. Extend the router with the Overview route
  - [x] 8.1 In `src/ui/logic.ts`, add `HashRouteOverview { view: 'overview' }` to the
    `HashRoute` union; update `parseHashRoute` so `#/`/empty → overview, `#/sessions`
    → list, `#/sessions/<id>` → detail (unchanged regex), `#/config` → config, and the
    fallback → overview. (Req 9.1, 9.2)
  - [x] 8.2 Add exported pure `routeTitle(route)` returning the per-view
    `document.title`. (Req 9.5)
  - [x] 8.3 In `client/src/routes/router.svelte.ts`, add `goToOverview()`
    (`#/`), change `goToList()` to `#/sessions`, and set `document.title =
    routeTitle(route.current)` inside `syncRoute()` (guarded for no-DOM). (Req 9.3, 9.5)
  - [x] 8.4 In `App.svelte`, add an explicit `overview` branch — there is NO deferral
    option, because omitting it makes `svelte-check` / the app crash when
    `route.current.view === 'overview'`. Item 88 MUST render a placeholder for the
    overview branch (a stub, e.g. `<div>Loading…</div>`) so the branch is present and
    typed. The last branches become:
    `{:else if route.current.view === 'detail'} …ChatView… {:else if route.current.view
    === 'overview'} <div>Loading…</div> {/if}`. The real `Overview.svelte` replaces this
    placeholder in task 12.8 (item 89). Keep list/config/detail branches. The router,
    titles, and nav must be fully functional in 88. (Req 9.4)

- [x] 9. Rework the header
  - [x] 9.1 Add the branding block to `Header.svelte`: inline `aria-hidden` SVG
    router/branch glyph + "Agent Router" text, linking to `#/`. (Req 10.1)
  - [x] 9.2 Display `v{__APP_VERSION__}`. (Req 10.2)
  - [x] 9.3 Render three nav tabs in order Overview (`#/`) / Sessions (`#/sessions`) /
    Config (`#/config`); compute active state (Sessions active for `list` and
    `detail`). (Req 10.3)
  - [x] 9.4 Replace the active style with `border-b-2 border-[var(--accent)]`; add
    `aria-current="page"` to the active tab and `focus-visible:ring-2
    focus-visible:ring-[var(--accent)]` to interactive elements. (Req 10.4, 10.5)
  - [x] 9.5 Switch the header background to `bg-[var(--header-bg)] backdrop-blur-sm`
    (NOT `bg-[var(--bg)]/90` — the opacity modifier does not work on a hex-valued var in
    Tailwind 3; `--header-bg` is the RGB-channel token from task 1.1), keeping
    `sticky top-0 h-14`. (Req 10.6)

- [x] 10. Build the unified `MessageRow` and adopt it in chat
  - [x] 10.1 Read `MessageBubble.svelte`, `SystemPill.svelte`, and
    `chat-render.ts` first. Add a `bare?: boolean` prop to `MessageBubble.svelte`: when
    `bare` is `true`, render agent text via `renderMarkdown()` but omit the outer bubble
    wrapper div, so `MessageRow` can supply its own bubble wrapper. `MessageRow` MUST
    use `<MessageBubble bare />` for the `agent` kind and MUST contain NO `{@html}`
    directive anywhere. (NFR-1, Req 11.7)
  - [x] 10.2 Add pure helpers to `src/ui/logic.ts`:
    `formatRelativeTime(nowMs, tsMs)` and `groupLabelVisible(prev, cur)` where grouping
    is on the `(kind, label)` PAIR — a row groups with the previous row IFF
    `kind === prev.kind AND label === prev.label`. (Req 11.3, 11.4)
  - [x] 10.3 Create `client/src/components/MessageRow.svelte` for the four message-
    bubble kinds ONLY: `agent`, `prompt`, `system`, `error`. Per the
    RenderItem→RowKind mapping in design.md: tool calls stay in `ToolCallCard.svelte`,
    permissions in `PermissionCard.svelte`, internal metadata in `InternalPill`, loading
    rows in `SkeletonBubble` — `MessageRow` does NOT replace those and has no collapse
    behavior. Implement the grammar table (agent RIGHT via `<MessageBubble bare />`; prompt
    LEFT; system CENTER no bubble; error RIGHT with Tailwind palette classes per NFR-2
    exception), label line + relative timestamp + `title`, grouping via `showLabel`,
    agent never centered, no `{@html}`. (Req 11.2, 11.3, 11.6, 11.7)
  - [x] 10.4 Update `ChatView.svelte` to render agent message bubbles plus prompt/
    system/error rows through `MessageRow` (replacing direct `MessageBubble`/
    `SystemPill` use for those kinds), keeping `ToolCallCard`/`PermissionCard`/
    `InternalPill`/`SkeletonBubble` for their kinds. Compute `showLabel` from
    `groupLabelVisible` on the `(kind, label)` pair; apply `mt-4` to the first row of a
    group and `mt-1` to subsequent rows in the same group. Keep `MessageBubble.svelte`
    and `SystemPill.svelte` as files. (Req 11.1, 11.4)

- [x] 11. Item 88 tests (vitest)
  - [x] 11.1 Pure: `parseHashRoute` for `#/`/``/`#/sessions`/`#/sessions/x`/`#/config`
    /junk; `routeTitle` per view. (Req 9.1, 9.2, 9.5)
  - [x] 11.2 Pure: `formatRelativeTime` (just now / Nm / Nh / Nd, injected clock,
    fast-check monotonicity ≥100 runs); `groupLabelVisible` groups only when
    `(kind, label)` matches (different tool names / different labels do NOT group).
    (Req 11.3, 11.4)
  - [x] 11.3 Component: `Header` shows "Agent Router", version, three tabs; active tab
    accent underline + `aria-current="page"`; backdrop-blur + `bg-[var(--header-bg)]`.
    (Req 10)
  - [x] 11.4 Component: `MessageRow` alignment/styling per kind (agent/prompt/system/
    error); agent never centered; no new `{@html}`; first-of-group row has `mt-4` and
    subsequent same-group rows have `mt-1`. (Req 11.2, 11.4, 11.6, 11.7)
  - [x] 11.5 Component: `ChatView` renders via `MessageRow`; existing streaming tests
    still pass. (Req 11.1)

---

## Group 3 — ROADMAP item 89: Overview page, Config cron status, empty states

- [ ] 12. Build the Overview page
  - [ ] 12.1 Create `client/src/components/StatCard.svelte` built on `Card` with
    props `{ label: string; value: string | number; badge?: { state: 'active' |
    'paused' | 'error'; label?: string } }`. When `badge` is provided, render
    `<StatusBadge state={badge.state} label={badge.label} />` below the value (the
    Health card needs a badge widget, which `value` alone cannot carry). (Req 12.3)
  - [ ] 12.2 Create `client/src/components/Overview.svelte` fetching `getOverview()` on
    mount with loading/error/empty handling; render a `PageHeader`. (Req 12.1, 14.3)
  - [ ] 12.3 Stat row: four `StatCard`s (Active Sessions, Queued Work, Recent PRs 24h
    count, Health) in `grid grid-cols-2 gap-4 lg:grid-cols-4`. The Health card uses
    `value="System"` and a `badge` derived from `health`:
    `healthy → {state:'active', label:'Healthy'}`, `degraded → {state:'paused',
    label:'Degraded'}` (no `error` health state — see HIGH-6). (Req 12.2)
  - [ ] 12.4 Recent Sessions: last five sessions via `SessionCard.svelte` (reuse the
    session-list API method, slice to 5). (Req 12.4)
  - [ ] 12.5 Cron Summary: compact rows (name, schedule, `StatusBadge` from
    `cron_summary[].state`, next fire). (Req 12.5)
  - [ ] 12.6 Skeleton loading state per section while in flight. (Req 12.6)
  - [ ] 12.7 Empty states (muted icon + message) per section. (Req 12.7, 14.1)
  - [ ] 12.8 Replace the Group-2 `overview` route placeholder in `App.svelte` with
    `Overview`. (Req 9.4)

- [ ] 13. Config cron status column
  - [ ] 13.1 Source the cron error state from the `/api/overview` `cron_summary` data,
    NOT from `GET /config` (which is out of scope and never sets `last_run_failed`).
    `ConfigView.svelte` fetches `/api/overview` once on mount (reusing the `getOverview()`
    API method) to obtain `cron_summary`, then uses the matching entry's `state` for the
    `StatusBadge`. No `last_run_failed` is read from `/config`. (Req 13.1)
  - [ ] 13.2 In `ConfigView.svelte` cron table, add a `StatusBadge` column BEFORE the
    Pause/Resume button; derive state from two sources matched by `name`:
    - **Error bit**: `cron_summary[name].state === 'error'` (from `/api/overview`).
    - **Paused bit**: `entry.paused || optimistic-paused` (from `GET /config` +
      local toggle).
    - Formula: `IF error THEN 'error' ELSE IF paused THEN 'paused' ELSE 'active'`.
    - Fallback when `/api/overview` fetch failed or `cron_summary` has no match for
      this name: derive from `entry.paused` only (no error bit).
    Keep the Pause/Resume button's neutral outline style. (Req 13.2, 13.3, 13.4, 13.5)

- [ ] 14. Empty states and remaining polish
  - [ ] 14.1 Add a muted icon + message empty state to `SessionList.svelte` and the
    chat view where data is empty. (Req 14.1)
  - [ ] 14.2 Add a paused indicator to `RepoGroup.svelte` when all sessions in the
    group are inactive. (Req 14.2)
  - [ ] 14.3 Ensure each primary view renders a `PageHeader`. (Req 14.3)
  - [ ] 14.4 Verify every badge has a text label and active nav carries
    `aria-current="page"`. (Req 14.4)

- [ ] 15. Item 89 tests (vitest)
  - [ ] 15.1 Component: `Overview` fetches on mount, renders four stat cards + recent
    sessions + cron summary; shows skeletons while loading and empty states when
    sections are empty. (Req 12)
  - [ ] 15.2 Component: `StatCard` renders label + value, and renders a `StatusBadge`
    below the value when the optional `badge` prop is supplied (Health card:
    `value="System"` + `{state:'active', label:'Healthy'}` or
    `{state:'paused', label:'Degraded'}`). (Req 12.3)
  - [ ] 15.3 Component: `ConfigView` cron table shows the `StatusBadge` column before
    the action; state derives error-first from the `/api/overview` `cron_summary`
    combined with the optimistic paused flag; optimistic toggle updates the badge.
    (Req 13)
  - [ ] 15.4 Component: `RepoGroup` paused indicator when all sessions inactive;
    empty states present on list/overview/chat. (Req 14.1, 14.2)

---

## Final verification (all items)

- [ ] 16. Feature-level checks
  - [ ] 16.1 `svelte-check` clean. (NFR-3)
  - [ ] 16.2 No NEW `{@html}` sink in any new/modified component; the only sanitized
    markdown path remains `renderMarkdown()` inside `MessageBubble.svelte`. (NFR-1)
  - [ ] 16.3 No hardcoded hex outside `app.css`; all colors `var(--token)`. (NFR-2)
  - [ ] 16.4 `MessageBubble.svelte` and `SystemPill.svelte` still exist. (NFR-5)
  - [ ] 16.5 All six issues verified by the vitest suites above; full client test run
    green.

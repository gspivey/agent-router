# SPA Operator Dashboard Restoration — Design

## Architecture Overview

The restoration adds features to the existing Svelte 5 SPA located at
`client/src/`. It does NOT touch the daemon (`src/`) beyond confirming that all
required API routes are already wired in `src/web-routes.ts` (they are). All
changes are client-side only.

The existing file structure:

```
client/src/
├── App.svelte                    ← routing shell; ADD Config route
├── app.css
├── main.ts
├── lib/
│   ├── api.ts                    ← ADD new endpoint functions + types
│   ├── types.ts                  ← ADD new DTO types
│   ├── logic.ts                  ← ADD duration formatter, ADD parseHashRoute #/config
│   ├── stores.svelte.ts
│   ├── chat-render.ts
│   ├── sse.ts
│   └── streaming-state.ts
├── components/
│   ├── Header.svelte             ← ADD Config nav link
│   ├── SessionCard.svelte        ← ADD PR links, short ID, termination, duration
│   ├── SessionList.svelte        ← REPLACE with repo-grouped data source
│   ├── ChatView.svelte           ← ADD metadata panel, internals toggle, kill
│   ├── ToolCallCard.svelte       ← ADD output truncation
│   ├── DetailBar.svelte          ← ADD Kill button
│   └── [NEW] RepoGroup.svelte
│   └── [NEW] SessionMeta.svelte
│   └── [NEW] ConfigView.svelte
│   └── [NEW] KillConfirmDialog.svelte
└── routes/
    └── router.svelte.ts          ← ADD #/config route parsing
```

---

## Data Models

### New types in `client/src/lib/types.ts`

```typescript
// Mirrors RepoGroupCron from src/web-routes.ts
export interface RepoGroupCron {
  readonly name: string;
  readonly schedule: string;
  readonly paused: boolean;
  readonly next_fire: string | null; // ISO string
}

// Mirrors RepoGroup from src/web-routes.ts
export interface RepoGroup {
  readonly repo: string;           // always "owner/name", never null
  readonly active_sessions: SessionSummary[];
  readonly terminal_sessions: SessionSummary[];
  readonly terminal_total: number;
  readonly cron: RepoGroupCron | null;
  readonly open_pr_count: number;
  readonly closed_pr_count: number;
}

// GET /repos/sessions response envelope
export interface RepoSessionsResponse {
  readonly repos: RepoGroup[];
}

// GET /repos/:repo/sessions response envelope (paged terminal sessions)
export interface RepoPageResponse {
  readonly sessions: SessionSummary[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

// Mirrors TokenHealthEntry from src/token-store.ts
export interface TokenHealthEntry {
  readonly project: string;
  readonly tokenName: string;
  readonly isSet: boolean;
  readonly expiry: string | null;
  readonly health: 'green' | 'red' | 'unknown';
}

// Mirrors CronScheduleEntry from src/cron-state.ts
export interface CronScheduleEntry {
  readonly name: string;
  readonly repo: string;
  readonly schedule: string;
  readonly nextFireTime: string | null;
  readonly paused: boolean;
}

// GET /config response shape
export interface ConfigResponse {
  sessionTimeouts: {
    inactivityMinutes: number;
    maxLifetimeMinutes: number;
    gracePeriodAfterMergeSeconds: number;
  };
  rateLimits: {
    perPRSeconds: number;
  };
  crons: CronScheduleEntry[];
  tokens: TokenHealthEntry[];
  repos: Array<{ name: string; webhookSecretName: string }>;
}

// POST /sessions/:id/kill response
export interface KillResponse {
  readonly ok: true;
}

// POST /crons/:name/pause and /resume response
export interface CronToggleResponse {
  readonly ok: true;
}
```

**Note on `RenderItem`:** The `RenderItem` type in `client/src/lib/chat-render.ts`
must be extended with an optional `rawSource?: string` field so that `ChatView`
can filter internal entries. The `buildRenderItems` function SHALL pass through
the `source` field from the underlying `StreamEntry` to `RenderItem.rawSource`
for every item. This change affects `client/src/lib/chat-render.ts` (add to
`files changed` list).

### New functions in `client/src/lib/api.ts`

All use the existing `authedFetch` + `readJson` helpers.

```typescript
// Additions to the `api` object:

/** GET /repos/sessions — sessions grouped by repo */
async listRepoSessions(): Promise<RepoSessionsResponse>

/** GET /repos/:repo/sessions?limit=N&offset=N — paginated terminal sessions */
async listRepoPagedSessions(repo: string, limit: number, offset: number): Promise<RepoPageResponse>

/** POST /sessions/:id/kill */
async kill(id: string): Promise<KillResponse>

/** GET /config */
async getConfig(): Promise<ConfigResponse>

/** POST /crons/:name/pause */
async pauseCron(name: string): Promise<CronToggleResponse>

/** POST /crons/:name/resume */
async resumeCron(name: string): Promise<CronToggleResponse>
```

---

## Routing Changes

### `client/src/routes/router.svelte.ts`

Extend `HashRoute` union and `parseHashRoute`:

```typescript
// Existing:
export type HashRoute =
  | { view: 'list' }
  | { view: 'detail'; sessionId: string };

// New:
export type HashRoute =
  | { view: 'list' }
  | { view: 'detail'; sessionId: string }
  | { view: 'config' };
```

`parseHashRoute` SHALL return `{ view: 'config' }` when the hash is `#/config`.

### `client/src/App.svelte`

Add the config route branch:

```svelte
{#if route.current.view === 'list'}
  <SessionList />
{:else if route.current.view === 'config'}
  <ConfigView />
{:else}
  <ChatView sessionId={route.current.sessionId} />
{/if}
```

Import `ConfigView` from `./components/ConfigView.svelte`.

---

## Component Designs

### `client/src/components/Header.svelte`

Replace the static `<h1>Sessions</h1>` with a two-link nav bar:

```svelte
<header ...>
  <nav aria-label="Main navigation" class="flex items-center gap-1">
    <a
      href="#/"
      class="nav-link {route.current.view === 'list' ? 'active' : ''}"
    >Sessions</a>
    <a
      href="#/config"
      class="nav-link {route.current.view === 'config' ? 'active' : ''}"
    >Config</a>
  </nav>
</header>
```

Active styling: `background: var(--surface-elevated)` or equivalent (match
old monolith `.nav-link.active` which used `background: #21262d`).

Import `route` from `../routes/router.svelte.js`.

---

### `client/src/lib/logic.ts` — helper additions

Add two pure functions (both unit-tested):

```typescript
/**
 * Format a duration in seconds as "Xm" (< 60 min) or "Xh Ym".
 * Returns "" for non-positive durations.
 */
export function formatDuration(seconds: number): string

/**
 * Build a GitHub PR URL from repo and pr_number.
 * repo is "owner/name".
 */
export function prUrl(repo: string, prNumber: number): string
// → `https://github.com/${repo}/pull/${prNumber}`
```

---

### `client/src/components/SessionCard.svelte`

The existing `SessionCard` root is a `<button>`. Placing `<a>` elements inside
`<button>` is invalid HTML and a Svelte 5 compile error (`node_invalid_placement`).

**Wrap the card in a `<div>`** and move PR links outside the inner `<button>`.
The `<button>` handles navigation; PR links appear below it in the same `<div>`:

```svelte
<div data-testid="session-card-wrapper" class="flex flex-col border-b border-[var(--border)]">
  <!-- existing button (navigation) -->
  <button type="button" data-testid="session-card" ... onclick={open}>
    <!-- short-id, status badge, repo, created-at, termination-reason, duration -->
    ...
  </button>
  <!-- PR links: OUTSIDE the button to avoid nesting interactive elements -->
  {#if session.prs.length > 0}
  <span
    data-testid="pr-links"
    class="flex flex-wrap gap-1 px-4 pb-2 text-xs"
  >
    {#each session.prs as pr, i}
      {#if i > 0}<span aria-hidden="true">,&nbsp;</span>{/if}
      <a
        data-testid="pr-link"
        href={prUrl(pr.repo, pr.pr_number)}
        target="_blank"
        rel="noopener noreferrer"
        class="text-[var(--accent)]"
      >PR #{pr.pr_number}</a>
    {/each}
  </span>
  {/if}
</div>
```

Add the remaining three elements inside the `<button>` body:

1. **Short ID** — `session.session_id.slice(0, 8)` in `font-mono text-xs
   text-[var(--text-muted)]` — `data-testid="short-id"`.

2. **Termination reason** — rendered when `session.termination_reason !== null`
   AND `session.status !== 'active'`:
   ```svelte
   <span data-testid="termination-reason"
         class="inline-block rounded-full bg-[var(--system-pill-bg)] px-2 py-0.5
                text-xs text-[var(--text-muted)]">
     {session.termination_reason}
   </span>
   ```

3. **Duration** — rendered when `session.status !== 'active'` AND
   `session.completed_at !== null`:
   ```svelte
   <span data-testid="session-duration"
         class="text-xs text-[var(--text-muted)]">
     {formatDuration(session.completed_at - session.created_at)}
   </span>
   ```

---

### `client/src/components/SessionList.svelte`

Replace the current implementation:

- On mount, call `api.listRepoSessions()`.
- Store result in a `$state<RepoGroup[]>` local variable `groups`.
- **To avoid duplicate identifier:** `import type { RepoGroup as RepoGroupData } from '../lib/types.js'`
  and `import RepoGroupComponent from './RepoGroup.svelte'`. Use `$state<RepoGroupData[]>` for the
  variable and `<RepoGroupComponent group={group} />` in the template.
- Render `{#each groups as group (group.repo)}` with `<RepoGroupComponent group={group} />`.
- Loading, error, and empty states remain (empty = no repos configured).
- Remove the existing `sessionList` store write (the store can be deprecated
  after this item lands, but that is out of scope).

**Note:** `sessionList` in `stores.svelte.ts` is used only by `SessionList.svelte`
and its tests. Keep the store for the test duration; once this item lands, the
store becomes unused but removal is a separate cleanup task.

---

### `client/src/components/RepoGroup.svelte` (new)

Props:
```typescript
interface Props {
  group: RepoGroup;
}
```

Internal state:
```typescript
let collapsed = $state(loadCollapsed(group.repo));
let terminalSessions = $state([...group.terminal_sessions]);
let terminalTotal = $state(group.terminal_total);
let loadingMore = $state(false);
let loadMoreError = $state<string | null>(null);
```

`loadCollapsed(repo: string): boolean`:
- Compute key: `'ar-repo-collapsed-' + encodeURIComponent(repo)`.
- Read `val = localStorage.getItem(key)`.
- If `val === '1'`: return true (explicitly collapsed).
- If `val === '0'`: return false (explicitly expanded — auto-collapse must not override).
- If `val === null` (key absent): apply auto-collapse rule:
  - Guard: if `group.terminal_sessions.length === 0`, return false.
  - Compute `maxCompleted = Math.max(...group.terminal_sessions.map(s => s.completed_at ?? 0))`.
  - If `maxCompleted === 0`: return false (no sessions with non-null completed_at).
  - Auto-collapse when `group.active_sessions.length === 0` AND
    `(Date.now() / 1000) - maxCompleted > 86400`.
  - Otherwise return false.

`toggleCollapsed()`:
- `collapsed = !collapsed`.
- Write `localStorage.setItem('ar-repo-collapsed-' + encodeURIComponent(group.repo), collapsed ? '1' : '0')`.

**Header layout (interactive elements OUTSIDE the toggle button):**

The RepoGroup header row is a flex container; the `<button>` handles only the
collapse toggle. PR badge, cron pill, and pulsing dot are sibling elements in
the same row, NOT inside the `<button>`, to satisfy the HTML constraint that
interactive elements cannot be nested inside `<button>`:

```svelte
<div class="repo-header flex items-center gap-2 px-3 py-2 ...">
  <!-- Collapse toggle occupies flex-1 to be the primary click target -->
  <button
    type="button"
    class="flex flex-1 items-center gap-2 text-left min-h-[44px]"
    onclick={toggleCollapsed}
    aria-expanded={!collapsed}
    aria-controls="repo-body-{encodedRepo}"
  >
    <span aria-hidden="true" class="collapse-icon text-xs">{collapsed ? '▸' : '▾'}</span>
    <span class="repo-name font-semibold text-sm">{group.repo}</span>
  </button>
  <!-- Siblings of the button, not children of it -->
  {#if group.active_sessions.length > 0}
    <span class="streaming-dot" aria-label="Active sessions"></span>
  {/if}
  {#if group.open_pr_count > 0}
    <a
      href="https://github.com/{group.repo}/pulls"
      target="_blank"
      rel="noopener noreferrer"
      class="pr-badge text-xs ..."
    >
      {group.open_pr_count} PR{group.open_pr_count > 1 ? 's' : ''}
    </a>
  {/if}
  {#if group.cron !== null}
    {#if group.cron.paused}
      <span class="badge badge-paused">paused</span>
    {:else if group.cron.next_fire !== null}
      <span class="cron-info text-xs text-[var(--text-muted)]">
        {group.cron.schedule} · next in {formatNextFire(group.cron.next_fire)}
      </span>
    {/if}
  {/if}
</div>
<!-- body -->
{#if !collapsed}
  <div id="repo-body-{encodedRepo}">
    {#each group.active_sessions as session (session.session_id)}
      <SessionCard {session} />
    {/each}
    {#each terminalSessions as session (session.session_id)}
      <SessionCard {session} />
    {/each}
    {#if terminalTotal > terminalSessions.length}
      <button
        type="button"
        class="show-more-btn"
        onclick={loadMore}
        disabled={loadingMore}
      >
        {loadingMore ? 'Loading…' : `Show ${terminalTotal - terminalSessions.length} more`}
      </button>
    {/if}
    {#if loadMoreError}
      <p data-testid="load-more-error" role="alert" class="text-xs text-[var(--error)] p-2">
        {loadMoreError}
      </p>
    {/if}
  </div>
{/if}
```

`formatNextFire(isoString: string): string`:
- Compute `diffMs = Date.parse(isoString) - Date.now()`.
- If `diffMs <= 0`: return `"soon"`.
- Delegate to `formatDuration(Math.round(diffMs / 1000))` from `logic.ts`.
- NOTE: The formatted value is computed once at render and will go stale.
  This is acceptable; operators can reload. A live ticker is out of scope.

`loadMore()`:
```typescript
async function loadMore(): Promise<void> {
  loadingMore = true;
  loadMoreError = null;
  try {
    const res = await api.listRepoPagedSessions(group.repo, 5, terminalSessions.length);
    // De-duplicate by session_id to handle sessions that ended between fetches
    const existingIds = new Set(terminalSessions.map(s => s.session_id));
    const newSessions = res.sessions.filter(s => !existingIds.has(s.session_id));
    terminalSessions = [...terminalSessions, ...newSessions];
    terminalTotal = res.total;
  } catch {
    loadMoreError = 'Failed to load more sessions.';
  } finally {
    loadingMore = false;
  }
}
```

---

### `client/src/components/SessionMeta.svelte` (new)

Props:
```typescript
interface Props {
  meta: SessionMeta;
}
```

Determines initial expand/collapse based on `window.innerWidth >= 768`.
User can toggle; state is local (not persisted).

Renders a `<details>`-like panel or a manual collapsible:

```
[▾ Session Info]  ← toggle button, always visible
[panel body — shown when expanded]
  Session ID: <UUID>  [Copy]
  Status:     <badge>
  Repo:       <link>
  Created:    <datetime>
  Completed:  <datetime> (if ended)
  Duration:   Xm / Xh Ym (if ended)
  Terminated: <reason> (if set)
  PRs:        PR #N, PR #M (if any)
```

Copy button: calls `navigator.clipboard.writeText(meta.session_id)`.

---

### `client/src/components/ChatView.svelte`

**Metadata panel integration:**
- Import the `SessionMeta` component with an alias to avoid shadowing the
  `SessionMeta` type from `types.ts`:
  `import SessionMetaPanel from './SessionMeta.svelte';`
- Render `<SessionMetaPanel meta={sessionMeta} />` above the log container,
  where `sessionMeta` is the existing `meta` variable loaded from `api.getSession`.
- Render only when `meta !== null`:
  ```svelte
  {#if meta !== null}
    <SessionMetaPanel {meta} />
  {/if}
  ```

**Show internals toggle:**
- Add `let showInternals = $state(typeof localStorage !== 'undefined' && localStorage.getItem('ar-show-internals') === '1')`.
- Render a `<label>` + `<input type="checkbox">` toggle in the stream toolbar.
- On change: `localStorage.setItem('ar-show-internals', showInternals ? '1' : '')`.
- Filter uses `item.rawSource` (the `rawSource?: string` field added to `RenderItem`
  by Task B-7; see Data Models section).
- Derive `visibleItems`:
  ```typescript
  const visibleItems = $derived(
    showInternals
      ? renderItems
      : renderItems.filter(item => !item.rawSource?.startsWith('_kiro.dev/'))
  );
  ```
- Replace all template references from `renderItems` to `visibleItems`.

**Kill button:**
- Pass `status` and session `id` into `DetailBar` as additional props.
- `DetailBar` renders the Kill button conditionally (see DetailBar section below).

---

### `client/src/components/DetailBar.svelte`

Current props: unknown (read file at implementation time).

**Extend the existing `Props` interface** — do NOT add a second `$props()` call.
Merge the new fields into DetailBar's existing single `Props` interface and
single `$props()` destructure:
```typescript
// Merged into the existing Props interface (no onKilled needed):
sessionId: string;
status: SessionStatus;
```

**Add Kill button rendering:**
```svelte
{#if status === 'active'}
  <button
    type="button"
    data-testid="kill-button"
    onclick={() => showConfirm = true}
    class="btn-kill min-h-[44px] rounded bg-[var(--error)] px-4 text-sm font-medium text-white"
  >Kill</button>
{/if}

{#if showConfirm}
  <KillConfirmDialog
    onConfirm={doKill}
    onCancel={() => showConfirm = false}
  />
{/if}
```

State:
```typescript
let showConfirm = $state(false);
let killError = $state<string | null>(null);
let killing = $state(false);

async function doKill(): Promise<void> {
  showConfirm = false;
  killing = true;
  killError = null;
  try {
    await api.kill(sessionId);
    // SSE delivers session_ended; no optimistic update needed
  } catch {
    killError = 'Failed to kill session.';
  } finally {
    killing = false;
  }
}
```

Render error inline:
```svelte
{#if killError}
  <p data-testid="kill-error" role="alert"
     class="text-xs text-[var(--error)]">{killError}</p>
{/if}
```

---

### `client/src/components/KillConfirmDialog.svelte` (new)

```svelte
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="kill-confirm-title"
  class="confirm-overlay"
>
  <div class="confirm-dialog">
    <p id="kill-confirm-title">
      Kill this session? This will terminate the agent process immediately
      and cannot be undone.
    </p>
    <button type="button" onclick={onConfirm}
      class="bg-[var(--error)] text-white ...">Kill</button>
    <button type="button" onclick={onCancel}
      class="bg-[var(--surface-elevated)] ...">Cancel</button>
  </div>
</div>
```

Focus management: on mount, focus the `"Cancel"` button (default-safe).
Trap focus within the dialog while open. `Escape` key SHALL call `onCancel`.

---

### `client/src/components/ToolCallCard.svelte`

Current prop: `updates: string` (full concatenated output).

Add truncation logic:

```typescript
const TRUNCATE_LINES = 20;

const lines = $derived(updates.split('\n'));
const isTruncated = $derived(lines.length > TRUNCATE_LINES);
let expanded = $state(false);

const visibleOutput = $derived(
  isTruncated && !expanded
    ? lines.slice(0, TRUNCATE_LINES).join('\n')
    : updates
);

const hiddenCount = $derived(
  isTruncated && !expanded ? lines.length - TRUNCATE_LINES : 0
);
```

Template change in the body `<pre>`:
```svelte
<pre ...>{visibleOutput}</pre>
{#if hiddenCount > 0}
  <button
    type="button"
    class="show-more-btn"
    onclick={() => expanded = true}
  >
    Show {hiddenCount} more lines
  </button>
{/if}
```

The `expanded` state is local to each card instance and resets when the card
is unmounted (no persistence).

---

### `client/src/components/ConfigView.svelte` (new)

Fetches `GET /config` on mount. Renders four sections:

**Token Health table:**
```svelte
<section>
  <h2>Token Health</h2>
  <div class="overflow-x-auto">
    <table class="config-table">
      <thead><tr><th>Project</th><th>Token Name</th><th>Status</th><th>Expiry</th></tr></thead>
      <tbody>
        {#each config.tokens as token (`${token.project}/${token.tokenName}`)}
          <tr class={token.health === 'red' ? 'row-error' : ''}>
            <td>{token.project}</td>
            <td class="font-mono text-xs">{token.tokenName}</td>
            <td>
              <span class="health-dot health-{token.health}" aria-label={token.health}></span>
            </td>
            <td>{token.expiry ? formatExpiry(token.expiry) : '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
```

**Cron Schedules table** with inline pause/resume. Cron state is stored as a
`SvelteMap<string, boolean>` (from `svelte/reactivity`) keyed by cron name,
initialized from the API response. `SvelteMap` is deeply reactive so `.set()`
triggers re-render. Per-row error state uses a second `SvelteMap<string, string>`:

```typescript
import { SvelteMap } from 'svelte/reactivity';
let cronPaused = new SvelteMap<string, boolean>();
let cronErrors = new SvelteMap<string, string>();
// Initialize:
for (const c of config.crons) cronPaused.set(c.name, c.paused);
```

Toggle:
```typescript
async function toggleCron(name: string): Promise<void> {
  const wasPaused = cronPaused.get(name) ?? false;
  cronPaused.set(name, !wasPaused); // optimistic
  cronErrors.delete(name);
  try {
    if (wasPaused) { await api.resumeCron(name); }
    else { await api.pauseCron(name); }
  } catch {
    cronPaused.set(name, wasPaused); // revert
    cronErrors.set(name, 'Failed to toggle.');
  }
}
```

`nextFireTime` display: format as `new Date(nextFireTime).toLocaleString()`.
When `null`, render `"—"`.

**Webhook configured** rule: `webhookSecretName === '[configured]'` (exact string
match) → green indicator; anything else → amber indicator.

**Session Timeouts card** and **Rate Limits card**: plain key-value display.

**Repositories table**: two-column (Owner/Repo, Webhook Configured).

Loading state: skeleton rows while the request is in flight.
Error state: retry button.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `GET /repos/sessions` fails | Show error banner in SessionList with retry button |
| `GET /repos/:repo/sessions` fails | Show error inline below the "Show more" button |
| `POST /sessions/:id/kill` fails | Close dialog; show inline error near Kill button |
| `POST /crons/:name/pause|resume` fails | Revert optimistic toggle; show inline error in row |
| `GET /config` fails | Show error banner in ConfigView with retry button |
| Clipboard write fails | Silently ignore (no error shown) |

Auth errors (401/403) from any new endpoint route through the existing
`enterExpiredState()` flow and do not need special handling per endpoint.

---

## localStorage Key Reference

| Key | Values | Default | Usage |
|-----|--------|---------|-------|
| `ar-repo-collapsed-<encodedRepo>` | `"1"` (collapsed), `"0"` (expanded), absent (never toggled) | auto-collapse logic or expanded | Repo group collapse state |
| `ar-show-internals` | `"1"` (on), `""` / absent (off) | OFF (hidden) | Internals toggle |

---

## Project Structure (files changed or added)

```
client/src/
├── App.svelte                       MODIFIED — add config route
├── lib/
│   ├── api.ts                       MODIFIED — add 6 new functions
│   ├── types.ts                     MODIFIED — add 9 new types
│   ├── logic.ts                     MODIFIED — add formatDuration, prUrl
│   ├── chat-render.ts               MODIFIED — add rawSource to RenderItem, pass through in buildRenderItems
├── components/
│   ├── Header.svelte                MODIFIED — add Config nav link
│   ├── SessionCard.svelte           MODIFIED — add PR links, short ID, etc.
│   ├── SessionList.svelte           MODIFIED — swap to repo-grouped data source
│   ├── ChatView.svelte              MODIFIED — add metadata, internals toggle
│   ├── DetailBar.svelte             MODIFIED — add Kill button
│   ├── ToolCallCard.svelte          MODIFIED — add output truncation
│   ├── RepoGroup.svelte             NEW
│   ├── SessionMeta.svelte           NEW
│   ├── ConfigView.svelte            NEW
│   └── KillConfirmDialog.svelte     NEW
└── routes/
    └── router.svelte.ts             MODIFIED — add config route
```

No daemon changes. No `src/` changes.

---

## Test File Plan

| Source file | Test file |
|-------------|-----------|
| `lib/logic.ts` additions | `lib/logic.test.ts` (extend existing) |
| `lib/api.ts` additions | `lib/api.test.ts` (extend existing) |
| `components/SessionCard.svelte` | `components/SessionCard.test.ts` (extend existing) |
| `components/RepoGroup.svelte` | `components/RepoGroup.test.ts` (new) |
| `components/ToolCallCard.svelte` | `components/ToolCallCard.test.ts` (new or extend) |
| `components/ConfigView.svelte` | `components/ConfigView.test.ts` (new) |
| `components/KillConfirmDialog.svelte` | `components/KillConfirmDialog.test.ts` (new) |
| `components/SessionMeta.svelte` | `components/SessionMeta.test.ts` (new) |
| `routes/router.svelte.ts` | `routes/router.test.ts` (extend existing) |

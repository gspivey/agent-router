# SPA Operator Dashboard Restoration — Tasks

## Overview

Split into three ROADMAP items (A, B, C) of roughly equal implementation size.
Each item is independently mergeable and leaves the SPA in a working state.

---

## ROADMAP Item A — Session List: Metadata + Repo Grouping

**Approximate scope:** 300–400 lines of implementation + tests.

**Status:** ✅ Complete (ROADMAP item 80, PR #145) — tasks A-1 through A-9 done.

### Task A-1: Add types for grouped-session API responses

**File:** `client/src/lib/types.ts`

Add the following types (all field names must match the backend exactly):

- `RepoGroupCron` (fields: `name`, `schedule`, `paused`, `next_fire: string | null`)
- `RepoGroup` (fields: `repo`, `active_sessions`, `terminal_sessions`,
  `terminal_total`, `cron: RepoGroupCron | null`, `open_pr_count`, `closed_pr_count`)
- `RepoSessionsResponse` (field: `repos: RepoGroup[]`)
- `RepoPageResponse` (fields: `sessions`, `total`, `offset`, `limit` — mirrors
  existing `SessionListResponse` shape but for per-repo pagination)

EARS: When the client receives a `GET /repos/sessions` response, the response
SHALL be parseable into `RepoSessionsResponse` without type errors.

---

### Task A-2: Add grouped-session API functions

**File:** `client/src/lib/api.ts`

Add to the `api` object:

```typescript
async listRepoSessions(): Promise<RepoSessionsResponse> {
  const res = await authedFetch('/repos/sessions');
  return readJson<RepoSessionsResponse>(res);
},

async listRepoPagedSessions(repo: string, limit: number, offset: number): Promise<RepoPageResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const res = await authedFetch(`/repos/${encodeURIComponent(repo)}/sessions?${params}`);
  return readJson<RepoPageResponse>(res);
},
```

EARS: When `listRepoSessions()` is called and the server returns HTTP 401,
the function SHALL call `enterExpiredState()` and throw `AuthError('expired')`.

**Tests:** Add to `client/src/lib/api.test.ts`:
- Mock fetch returning `{ repos: [] }` → resolves to `RepoSessionsResponse`.
- Mock fetch returning 401 → throws `AuthError('expired')`.
- `listRepoPagedSessions('owner/repo', 5, 10)` → request URL contains
  `encodeURIComponent('owner/repo')`, `limit=5`, `offset=10`.

---

### Task A-3: Add `formatDuration` and `prUrl` helpers

**File:** `client/src/lib/logic.ts`

```typescript
/**
 * Format a duration in seconds as "Xm" (< 3600s) or "Xh Ym" (≥ 3600s).
 * Returns "" for non-positive inputs.
 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '';
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Build a GitHub PR URL from repo ("owner/name") and pr_number.
 */
export function prUrl(repo: string, prNumber: number): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}
```

**Tests:** Add to `client/src/lib/logic.test.ts`:
- `formatDuration(0)` → `""`.
- `formatDuration(780)` → `"13m"` (780s = 13 min).
- `formatDuration(3900)` → `"1h 5m"`.
- `formatDuration(3600)` → `"1h"`.
- `formatDuration(-5)` → `""`.
- `prUrl('gspivey/agent-router', 42)` → `"https://github.com/gspivey/agent-router/pull/42"`.

---

### Task A-4: Extend `SessionCard` with metadata fields

**File:** `client/src/components/SessionCard.svelte`

Import `formatDuration` and `prUrl` from `../lib/logic.js`.

**CRITICAL:** The existing `SessionCard` root is a `<button>`. `<a>` elements
inside `<button>` are invalid HTML and a Svelte 5 compile error. Wrap the card
in a `<div>` and place PR links outside the inner `<button>`. See design.md
for the exact structure.

Implement as designed:
1. Inside the `<button>`: add `data-testid="short-id"`, `data-testid="termination-reason"`,
   `data-testid="session-duration"` elements.
2. Outside the `<button>` (sibling in the wrapping `<div>`): add `data-testid="pr-links"`
   containing `data-testid="pr-link"` anchors.
3. Do NOT use `onclick|stopPropagation` (Svelte 4 syntax). If stopping propagation is
   needed on the PR links wrapper, use `onclick={(e) => e.stopPropagation()}`.

**Tests:** Extend `client/src/components/SessionCard.test.ts`:
- Renders `data-testid="short-id"` with first 8 chars of UUID.
- `prs: [{repo: "o/r", pr_number: 5}]` renders `data-testid="pr-link"` with href
  `https://github.com/o/r/pull/5`.
- `prs: []` renders no `data-testid="pr-links"` element.
- `termination_reason: "merged"`, `status: "completed"` renders `data-testid="termination-reason"` with text `"merged"`.
- `termination_reason: "merged"`, `status: "active"` does NOT render termination pill.
- `status: "completed"`, `completed_at: created_at + 780` renders `"13m"` in `data-testid="session-duration"`.
- `status: "active"` does NOT render `data-testid="session-duration"`.
- PR link `<a>` is NOT a descendant of the `<button>` element (validate via DOM tree).

---

### Task A-5: Add `#/config` route to the router

**File:** `client/src/routes/router.svelte.ts`

1. Extend `HashRoute` type to include `| { view: 'config' }`.
2. Update `parseHashRoute` to return `{ view: 'config' }` when
   `trimmed === '/config'` (handles `#/config`).

**Tests:** Extend `client/src/routes/router.test.ts`:
- `parseHashRoute('#/config')` → `{ view: 'config' }`.
- `parseHashRoute('#/config/')` → `{ view: 'list' }` (trailing slash is not matched).
- Existing tests SHALL pass unchanged.

---

### Task A-6: Build `RepoGroup` component

**File:** `client/src/components/RepoGroup.svelte` (new)

Implement exactly as designed (see design.md RepoGroup section).

Key implementation notes:
- Use `$props()` for `group: RepoGroup`.
- `encodedRepo` = `encodeURIComponent(group.repo)` for localStorage key suffix
  and `aria-controls` target.
- **CRITICAL: Do NOT nest interactive elements (`<a>`, `<button>`) inside the
  collapse `<button>`.** PR badge and cron pill are siblings of the button in
  the row flex container, not children. See design.md for the exact structure.
- **CRITICAL: Use Svelte 5 event syntax.** All event handlers use `onclick={...}`,
  not legacy modifier syntax like `onclick|stopPropagation`. The PR badge and cron
  pill are siblings of the toggle button and do NOT need any `stopPropagation`
  handler — they are not inside the button so there is no event to stop.
- `loadCollapsed(repo: string): boolean`:
  - Key: `'ar-repo-collapsed-' + encodeURIComponent(repo)`.
  - `val = localStorage.getItem(key)`.
  - `val === '1'` → return true; `val === '0'` → return false.
  - `val === null`:
    - Guard: if `group.terminal_sessions.length === 0`, return false.
    - Compute `maxCompleted = Math.max(...group.terminal_sessions.map(s => s.completed_at ?? 0))`.
    - Auto-collapse when `group.active_sessions.length === 0` AND
      `maxCompleted > 0` AND `(Date.now() / 1000) - maxCompleted > 86400`.
    - Otherwise return false.
- `toggleCollapsed()`: write `'1'` or `'0'` to localStorage (not remove the key).
- `formatNextFire(isoString)`: delegate to `formatDuration` from `logic.ts` after
  checking for negative/zero (`return 'soon'` if past).
- `loadMore()`: de-duplicate by `session_id` when appending (see design.md).

**Tests:** `client/src/components/RepoGroup.test.ts` (new):
- Renders group repo name in header.
- `open_pr_count: 3` renders PR badge with href `https://github.com/<repo>/pulls`.
- `open_pr_count: 0` renders no PR badge.
- `active_sessions: [session]` renders pulsing dot; `active_sessions: []` does not.
- `cron: { paused: true }` renders "paused" pill.
- `cron: null` renders no cron info.
- Clicking header button toggles body visibility and updates `aria-expanded`.
- `terminal_total: 8`, `terminal_sessions.length: 5` renders "Show 3 more" button.
- `terminal_total: 3`, `terminal_sessions.length: 3` renders no show-more button.
- Show-more button is disabled while `loadingMore = true`.
- Auto-collapse: localStorage key absent, `active_sessions: []`, all `terminal_sessions`
  `completed_at` 48h ago → initial render collapsed.
- Auto-collapse: localStorage key `"0"` (explicitly expanded) → NOT collapsed.
- Auto-collapse: localStorage key `"1"` → collapsed, overriding any other logic.
- `loadMore` API error → renders `data-testid="load-more-error"`.
- `loadMore` success de-duplicates: if a session returned in load-more already
  exists in `terminalSessions`, it SHALL NOT appear twice.

---

### Task A-7: Rewrite `SessionList` to use grouped data

**File:** `client/src/components/SessionList.svelte`

Replace the current `GET /sessions` fetch with `api.listRepoSessions()`.
Render `<RepoGroupComponent>` per group instead of `<SessionCard>` per session.

**CRITICAL: Import alias.** The `RepoGroup` type and `RepoGroup.svelte` component
share the name. Use:
```typescript
import type { RepoGroup as RepoGroupData } from '../lib/types.js';
import RepoGroupComponent from './RepoGroup.svelte';
```

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, AuthError } from '../lib/api.js';
  import type { RepoGroup as RepoGroupData } from '../lib/types.js';
  import RepoGroupComponent from './RepoGroup.svelte';

  let groups = $state<RepoGroupData[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await api.listRepoSessions();
      groups = res.repos;
    } catch (err) {
      if (!(err instanceof AuthError)) {
        error = 'Could not load sessions.';
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => { void load(); });
</script>
```

Keep loading/error/empty states with the same `data-testid` attributes so
existing `SessionList.test.ts` tests pass after minimal adjustment:
- `data-testid="list-loading"` — same.
- `data-testid="list-error"` — same.
- `data-testid="list-empty"` — shown when `groups.length === 0` (no repos configured).
- `data-testid="list-retry"` — same.

**Tests:** Update `client/src/components/SessionList.test.ts`:
- Mock `api.listRepoSessions` returning `{ repos: [] }` → renders empty state.
- Mock returning `{ repos: [{repo: 'o/r', ...}] }` → renders a `RepoGroupComponent`.
- Mock throwing `AuthError('expired')` → does not render error state (auth handled globally).
- Mock throwing `ApiError` → renders error state with retry.
- Remove or update mocks for `api.listSessions` (old endpoint, no longer called).

---

### Task A-8: Update `Header` with Config nav link

**File:** `client/src/components/Header.svelte`

1. Import `route` from `../routes/router.svelte.js`.
2. Replace the `<h1>Sessions</h1>` with a `<nav>`:
   ```svelte
   <nav aria-label="Main navigation" class="flex items-center gap-1">
     <a href="#/"
        data-testid="nav-sessions"
        class="rounded px-3 py-2 text-sm font-medium transition-colors
               {route.current.view === 'list'
                 ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)]'
                 : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}">
       Sessions
     </a>
     <a href="#/config"
        data-testid="nav-config"
        class="rounded px-3 py-2 text-sm font-medium transition-colors
               {route.current.view === 'config'
                 ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)]'
                 : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}">
       Config
     </a>
   </nav>
   ```

3. Keep the wrapping `<header>` element and its existing class string unchanged.

**Tests:** New `client/src/components/Header.test.ts` (or integrate into existing
component tests):
- Renders `data-testid="nav-sessions"` linking to `#/`.
- Renders `data-testid="nav-config"` linking to `#/config`.
- When route is `{ view: 'list' }`, Sessions link has active styling class.
- When route is `{ view: 'config' }`, Config link has active styling class.

---

### Task A-9: Wire Config route in `App.svelte`

**File:** `client/src/App.svelte`

1. Import `ConfigView` from `./components/ConfigView.svelte`.
2. Add the config branch:
   ```svelte
   {#if route.current.view === 'list'}
     <SessionList />
   {:else if route.current.view === 'config'}
     <ConfigView />
   {:else}
     <ChatView sessionId={route.current.sessionId} />
   {/if}
   ```

Note: `ConfigView` is a stub at this point (implemented in Item C). For Item A,
create `ConfigView.svelte` as a placeholder:
```svelte
<!-- Placeholder — implemented in Item C -->
<section data-testid="config-view"><p>Config (coming soon)</p></section>
```

---

## ROADMAP Item B — Session Detail: Metadata + Internals + Truncation + Kill

**Approximate scope:** 300–400 lines of implementation + tests.

**Status:** ✅ Complete (ROADMAP item 81, PR #146) — tasks B-1 through B-8 done.

### Task B-1: Add Kill API function

**File:** `client/src/lib/api.ts`

Add to the `api` object:

```typescript
async kill(id: string): Promise<KillResponse> {
  const res = await authedFetch(`/sessions/${encodeURIComponent(id)}/kill`, {
    method: 'POST',
  });
  return readJson<KillResponse>(res);
},
```

Add `KillResponse` type to `types.ts`: `export interface KillResponse { ok: true; }`.

**Tests:** Extend `client/src/lib/api.test.ts`:
- Mock 200 `{ ok: true }` → resolves.
- Mock 409 (session not active) → throws `ApiError(409, ...)`.
- Mock 404 → throws `ApiError(404, ...)`.

---

### Task B-2: Build `KillConfirmDialog` component

**File:** `client/src/components/KillConfirmDialog.svelte` (new)

Props:
```typescript
interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}
```

Implementation notes:
- Renders a modal overlay (`position: fixed`, `z-index: 100`).
- Dialog text: `"Kill this session? This will terminate the agent process
  immediately and cannot be undone."`
- Two buttons: `"Kill"` (`data-testid="kill-confirm"`, red) and `"Cancel"`
  (`data-testid="kill-cancel"`, neutral).
- On mount, focus the `"Cancel"` button.
- `Escape` keydown calls `onCancel`.
- Focus trap: Tab/Shift-Tab cycle within the dialog.

**Tests:** `client/src/components/KillConfirmDialog.test.ts` (new):
- Renders dialog text.
- Clicking `data-testid="kill-confirm"` calls `onConfirm`.
- Clicking `data-testid="kill-cancel"` calls `onCancel`.
- `Escape` key calls `onCancel`.

---

### Task B-3: Add Kill button to `DetailBar`

**File:** `client/src/components/DetailBar.svelte`

1. Read current `DetailBar.svelte` props and structure at implementation time.
2. Add props:
   ```typescript
   interface KillProps {
     sessionId: string;
     status: SessionStatus;
   }
   ```
3. Add Kill button and `KillConfirmDialog` as designed (see design.md DetailBar section).
4. Import `KillConfirmDialog` and `api`.

**Tests:** Extend `DetailBar` tests (or add `client/src/components/DetailBar.test.ts`):
- `status: "active"` → renders `data-testid="kill-button"`.
- `status: "completed"` → no `data-testid="kill-button"`.
- Clicking kill button → renders `KillConfirmDialog` (mock it).
- `onConfirm` → calls `api.kill(sessionId)` (mock api).
- `onCancel` → dialog unmounts without API call.
- API error from kill → renders `data-testid="kill-error"` inline.

---

### Task B-4: Pass Kill props from `ChatView` to `DetailBar`

**File:** `client/src/components/ChatView.svelte`

1. Read `DetailBar`'s current usage in `ChatView` at implementation time.
2. Pass `sessionId={sessionId}` and `status={status}` to `<DetailBar>`.

---

### Task B-5: Build `SessionMeta` component

**File:** `client/src/components/SessionMeta.svelte` (new)

Implement as designed (see design.md SessionMeta section).

Key implementation notes:
- Use `typeof window !== 'undefined' && window.innerWidth >= 768` to determine
  initial expanded state (SSR-safe check).
- Copy button: wrap in a try-catch; silently ignore clipboard errors.
- Format `created_at` / `completed_at` (Unix seconds) with
  `new Date(ts * 1000).toLocaleString()`.
- Duration: use `formatDuration(meta.completed_at - meta.created_at)` when
  `meta.completed_at !== null`.
- PR links: use `prUrl(pr.repo, pr.pr_number)` from `logic.ts`.

**Tests:** `client/src/components/SessionMeta.test.ts` (new):
- Renders `data-testid="session-meta-panel"`.
- Toggle button shows/hides the panel body.
- Renders full UUID in `data-testid="session-id"`.
- Renders PR link with correct href when `prs` is non-empty.
- `termination_reason: "merged"` renders reason row; null does not.
- `completed_at: null` renders no completed/duration rows.

---

### Task B-6: Integrate `SessionMeta` into `ChatView`

**File:** `client/src/components/ChatView.svelte`

1. Import with alias to avoid shadowing the `SessionMeta` type from `types.ts`:
   `import SessionMetaPanel from './SessionMeta.svelte';`
2. Read existing `meta` state variable (from `api.getSession` response).
3. Add `<SessionMetaPanel meta={meta} />` between the `DetailBar` and the
   log container, rendered only when non-null:
   ```svelte
   {#if meta !== null}
     <SessionMetaPanel {meta} />
   {/if}
   ```

---

### Task B-7: Add Show Internals toggle to `ChatView`

**Files:** `client/src/lib/chat-render.ts` AND `client/src/components/ChatView.svelte`

**Step 1 — Extend `RenderItem` in `chat-render.ts`:**
Add optional `rawSource?: string` to the `RenderItem` type (or union discriminant
interface), and populate it in `buildRenderItems` from the underlying
`StreamEntry.source` field. Field name is `rawSource` (not `raw.source`).

Tests for `buildRenderItems`: add a case that a `StreamEntry` with
`source: '_kiro.dev/metadata'` produces a `RenderItem` with
`rawSource === '_kiro.dev/metadata'`.

**Step 2 — Add toggle to `ChatView.svelte`:**
1. Add `let showInternals = $state(typeof localStorage !== 'undefined' && localStorage.getItem('ar-show-internals') === '1')`.
2. Add a `<label>` + `<input type="checkbox">` toggle in the stream toolbar area:
   ```svelte
   <label class="flex items-center gap-2 text-xs text-[var(--text-muted)] cursor-pointer">
     <input
       type="checkbox"
       data-testid="show-internals-toggle"
       bind:checked={showInternals}
       onchange={() => {
         if (typeof localStorage !== 'undefined') {
           localStorage.setItem('ar-show-internals', showInternals ? '1' : '');
         }
       }}
     />
     Show internals
   </label>
   ```
3. Derive `visibleItems` from `renderItems`:
   ```typescript
   const visibleItems = $derived(
     showInternals
       ? renderItems
       : renderItems.filter(item => !item.rawSource?.startsWith('_kiro.dev/'))
   );
   ```
4. Replace all template references from `renderItems` to `visibleItems`.

Tests (extend `client/src/components/chat-entries.test.ts` or add
`ChatView.internals.test.ts`):
- With `showInternals = false`, internal entry (`rawSource: '_kiro.dev/meta'`)
  is filtered from `visibleItems`.
- With `showInternals = true`, internal entry is included.
- `localStorage.getItem('ar-show-internals') === '1'` on mount → toggle starts ON.
- Toggling writes `'1'` or `''` to `localStorage['ar-show-internals']`.

---

### Task B-8: Add output truncation to `ToolCallCard`

**File:** `client/src/components/ToolCallCard.svelte`

Implement exactly as designed (see design.md ToolCallCard section).

**Tests:** `client/src/components/ToolCallCard.test.ts` (new or extend):
- `updates` with 25 newline-separated lines → renders 20 lines + "Show 5 more lines" button.
- `updates` with 20 lines → no show-more button.
- `updates` with 0 lines → no show-more button.
- Clicking "Show N more lines" → expanded = true → all lines rendered, no button.
- `spinner: true` + 25 lines → body hidden (existing spinner behavior, no show-more).
- `spinner: false` after 25 lines → truncation applies.

---

## ROADMAP Item C — Config View

**Approximate scope:** 300–400 lines of implementation + tests.

### Task C-1: Add Config and Cron Toggle API functions

**File:** `client/src/lib/api.ts`

Add:
```typescript
async getConfig(): Promise<ConfigResponse> {
  const res = await authedFetch('/config');
  return readJson<ConfigResponse>(res);
},

async pauseCron(name: string): Promise<CronToggleResponse> {
  const res = await authedFetch(`/crons/${encodeURIComponent(name)}/pause`, { method: 'POST' });
  return readJson<CronToggleResponse>(res);
},

async resumeCron(name: string): Promise<CronToggleResponse> {
  const res = await authedFetch(`/crons/${encodeURIComponent(name)}/resume`, { method: 'POST' });
  return readJson<CronToggleResponse>(res);
},
```

Add `ConfigResponse`, `CronScheduleEntry`, `TokenHealthEntry`, `CronToggleResponse`
types to `types.ts` (see design.md Data Models section).

**Tests:** Extend `client/src/lib/api.test.ts`:
- `getConfig()` mock 200 → resolves `ConfigResponse`.
- `pauseCron('my-cron')` → URL path `/crons/my-cron/pause`, method POST.
- `resumeCron('my-cron')` → URL path `/crons/my-cron/resume`, method POST.
- 401 response → `AuthError('expired')`.

---

### Task C-2: Build `ConfigView` component (replace placeholder)

**File:** `client/src/components/ConfigView.svelte`

Replace the Item A-9 placeholder with the full implementation.

Implement all four sections as designed (see design.md ConfigView section).

Key implementation notes:
- Fetch `GET /config` on mount.
- Loading: render "Loading…" placeholder text or skeleton rows.
- Error: render `data-testid="config-error"` banner + retry button.
- Cron pause/resume state:
  - Import `SvelteMap` from `'svelte/reactivity'` — plain `Map` is NOT reactive
    in Svelte 5 (`.set()` won't trigger re-render).
  - `let cronPaused = new SvelteMap<string, boolean>()` — initialize from
    `config.crons` after load.
  - `let cronErrors = new SvelteMap<string, string>()` — per-row error state.
  - Toggle with optimistic update + revert on error (see design.md).
- `formatExpiry(isoString: string): string`:
  parse with `new Date(isoString)`, return `toLocaleDateString()`.
- `nextFireTime` display: `new Date(nextFireTime).toLocaleString()` when non-null;
  `"—"` when null.
- Webhook configured: `webhookSecretName === '[configured]'` (exact string match,
  NOT `startsWith`) → green indicator; anything else → amber indicator.
- All tables wrapped in `overflow-x: auto` container.

**Tests:** `client/src/components/ConfigView.test.ts` (new):
- Mock `api.getConfig()` loading → shows loading state.
- Mock resolved with full config → renders Token Health table with rows.
- Token with `health: "red"` → row has error-highlight class.
- Token with `expiry: null` → renders `"—"` in expiry cell.
- Two tokens with same `project` but different `tokenName` → both rows rendered
  (keyed by `project/tokenName`, no duplicate key error).
- Cron row: `paused: false` → "Pause" button; `paused: true` → "Resume" button.
- Clicking "Pause" → calls `api.pauseCron(name)` (mock); optimistically shows "Resume".
- API error on pause → reverts to "Pause", renders inline `data-testid="cron-error-<name>"`.
- Session timeouts section → renders `inactivityMinutes` value.
- Repositories section: `webhookSecretName === '[configured]'` → green indicator.
- Repositories section: `webhookSecretName !== '[configured]'` → amber indicator.
- Mock `api.getConfig()` throws `ApiError` → renders `data-testid="config-error"` retry button.

---

## Task Cross-Reference to Requirements

| Task | Requirements |
|------|-------------|
| A-1 | NFR-1 (types) |
| A-2 | FR-2.3, NFR-1 |
| A-3 | FR-1.4 (duration), FR-1.2 (prUrl) |
| A-4 | FR-1.1, FR-1.2, FR-1.3, FR-1.4 |
| A-5 | FR-7.1 (routing) |
| A-6 | FR-2.1, FR-2.2, FR-2.4, FR-2.5, FR-2.6 |
| A-7 | FR-2.1, FR-2.3, FR-2.4 |
| A-8 | FR-7.1 (nav link) |
| A-9 | FR-7.1 (routing) |
| B-1 | FR-6.2c, NFR-1 |
| B-2 | FR-6.2 |
| B-3 | FR-6.1, FR-6.2, FR-6.3 |
| B-4 | FR-6.1 |
| B-5 | FR-3.1, FR-3.2 |
| B-6 | FR-3.1, FR-3.2 |
| B-7 | FR-4.1, FR-4.2 |
| B-8 | FR-5.1, FR-5.2 |
| C-1 | NFR-1, FR-7.3, FR-7.7 |
| C-2 | FR-7.2, FR-7.3, FR-7.4, FR-7.5, FR-7.6, FR-7.7 |

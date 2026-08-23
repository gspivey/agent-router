# Tasks: Web UI Sessions Grouped by Repo

## Task 1: Implement `getNextCronFire()` utility
- [x] Create `src/cron-next.ts` with a `getNextCronFire(schedule: string): Date | null` function.
- [x] Parse standard 5-field cron expressions (minute, hour, day-of-month, month, day-of-week).
- [x] Handle wildcards (`*`), lists (`1,3,5`), ranges (`1-5`), and steps (`*/10`).
- [x] Return the next matching `Date` from `Date.now()`, or `null` if the expression is invalid.
- [x] Add unit tests in `tests/cron-next.test.ts` covering: every-minute, specific hour, day-of-week, step intervals, and invalid expressions.

## Task 2: Implement `groupSessionsByRepo()` helper
- [x] In `src/web-routes.ts`, add the `RepoGroup` interface:
  ```typescript
  interface RepoGroup {
    repo: string;
    active_sessions: SessionSummary[];
    terminal_sessions: SessionSummary[];
    terminal_total: number;
    cron: { name: string; schedule: string; paused: boolean; next_fire: string | null } | null;
    open_pr_count: number;
  }
  ```
- [x] Implement `groupSessionsByRepo(sessions, repos, cronEntries, cronStates, perRepoLimit, waitingForFn): RepoGroup[]`.
- [x] Group sessions by matching `meta.repo` to `${repo.owner}/${repo.name}`.
- [x] Split each group into active (`status === 'active'`) and terminal (all others), sort terminal by `created_at` desc.
- [x] Slice terminal to `perRepoLimit`, set `terminal_total` to full count.
- [x] Match cron entries where `entry.repo === repoFullName`, look up pause state from `cronStates`, compute `next_fire` via `getNextCronFire()`.
- [x] Compute `open_pr_count`: count PRs across all sessions for this repo where the PR has no `merged_at` and the session is active or the PR is unmerged.
- [x] Add unit tests in `tests/group-sessions.test.ts`.

## Task 3: Add `GET /repos/sessions` API endpoint
- [x] In `src/web-routes.ts`, add route handler for `GET /repos/sessions`.
- [x] Accept query param `per_repo_limit` (int 1-50, default 5). Validate and return 400 on invalid.
- [x] Call `groupSessionsByRepo()` with data from `sessionFiles.listSessions()`, config repos/cron, and `db.getAllCronStates()`.
- [x] Return JSON response `{ repos: RepoGroup[] }`.
- [x] In `src/web-server.ts`, update `createWebRoutes` deps to include `config` and `db`. Pass them through.
- [x] Mount `/repos/sessions` under the existing auth middleware.
- [x] Add integration test verifying response shape, auth enforcement, and param validation.

## Task 4: Add `GET /repos/:repo/sessions` API endpoint
- [x] In `src/web-routes.ts`, add route handler for `GET /repos/:repo/sessions`.
- [x] URL-decode `:repo` param. Validate it matches a configured repo; return 404 if not found.
- [x] Accept `limit` (1-50, default 5) and `offset` (≥0, default 0) query params.
- [x] Filter `sessionFiles.listSessions()` to the target repo, exclude active, sort by `created_at` desc, apply offset/limit.
- [x] Return `{ repo, sessions: SessionSummary[], total, offset, limit }`.
- [x] Mount under auth middleware in `src/web-server.ts`.
- [x] Add integration test for pagination and 404 on unknown repo.

## Task 5: Update web-server.ts route factory deps
- [x] Update the `createWebRoutes` function signature to accept `config: AgentRouterConfig` and `db: Database` in its deps object.
- [x] Update `createWebApp` in `src/web-server.ts` to pass `config` and `db` when calling `createWebRoutes()`.
- [x] Verify existing tests still pass with the expanded deps (update test mocks if needed).

## Task 6: Add CSS for grouped layout
- [x] In `src/web-ui.ts`, add CSS classes to the `<style>` block:
  - `.repo-section` — border, margin, border-radius for the group container.
  - `.repo-header` — flex row, cursor pointer, padding, hover highlight.
  - `.repo-header h2` — font size, weight, margin.
  - `.repo-header-info` — right-aligned, font-size 13px, color #8b949e.
  - `.repo-cron` — font-size 12px, color #8b949e, padding-left indent.
  - `.repo-body` — padding for session items within the section.
  - `.repo-section.collapsed .repo-body` — `display: none`.
  - `.streaming-dot` — 8px green circle with pulse animation.
  - `@keyframes pulse` — opacity 1→0.4→1 over 1.5s.
  - `.show-more-btn` — styled as subtle link-button.
  - `.collapse-icon` — rotate transform on collapse state.
- [x] Add responsive overrides in existing `@media` blocks for `.repo-header` flex-wrap on mobile.
- [x] Ensure touch targets on `.repo-header` and `.show-more-btn` are ≥44px.

## Task 7: Rewrite list-view JS to render grouped sections
- [x] Replace `loadAllSessions()` with `loadGroupedSessions()` in the `<script>` block.
- [x] `loadGroupedSessions()` calls `resilientFetch('/repos/sessions')`.
- [x] On success, iterate `repos[]` and render each with `renderRepoSection(repoGroup)`.
- [x] `renderRepoSection()` outputs:
  - Section wrapper with `data-repo` attribute.
  - Header with collapse icon, repo name `<h2>`, PR count badge, cron line.
  - Body with active sessions (using `renderSessionItem()` + streaming dot) and terminal sessions.
  - "Show more" button if `terminal_total > terminal_sessions.length`.
- [x] Implement `isAutoCollapsed(repoGroup)`: returns true if no active sessions and most recent terminal session `created_at` is >24h ago.
- [x] Read/write collapse state to `localStorage` (`repo-collapsed:<owner/name>` = `'1'` or `'0'`).
- [x] On header click, toggle `.collapsed` class and update `localStorage` + `aria-expanded`.
- [x] Handle error/auth states identically to existing `loadAllSessions()` error handling.
- [x] Handle empty state: "No repos configured" when `repos.length === 0`.

## Task 8: Implement "Show more" per-repo pagination
- [x] Attach click handler on `.show-more-btn` elements.
- [x] Track current offset per repo in a `Map<string, number>` (starts at initial `terminal_sessions.length`).
- [x] On click, call `resilientFetch('/repos/' + encodeURIComponent(repo) + '/sessions?offset=' + offset + '&limit=5')`.
- [x] Append returned sessions to the repo's `.repo-body` before the "Show more" button.
- [x] Update offset. If `offset >= total`, remove the "Show more" button.
- [x] Handle fetch errors gracefully (show inline error, allow retry).

## Task 9: Add accessibility attributes
- [ ] Repo section headers: `role="button"`, `aria-expanded="true|false"`, `aria-controls="repo-body-<id>"`.
- [ ] Repo body: `id="repo-body-<id>"` matching `aria-controls`.
- [ ] Streaming dot: `<span class="streaming-dot" aria-label="Active session streaming" role="img"></span>`.
- [ ] "Show more" buttons: `aria-label="Load more sessions for <repo>"`.
- [ ] Section headers use `<h2>` for semantic structure.

## Task 10: Update hash router for grouped view
- [ ] In `navigate()`, the `list` branch calls `loadGroupedSessions()` instead of `loadAllSessions()`.
- [ ] Remove `currentPage` and `PAGE_SIZE` global state (no longer used for global pagination).
- [ ] Keep `loadAllSessions()` function body commented or removed — the `GET /sessions` endpoint remains but the UI no longer calls it.
- [ ] Verify detail view navigation (`#/sessions/:id`) still works and back button returns to grouped view.

## Task 11: End-to-end verification
- [ ] Run the full test suite and fix any regressions.
- [ ] Manually verify: page loads with grouped sections, collapse/expand works, "Show more" loads additional sessions, detail view works, back navigation returns to grouped list.
- [ ] Verify mobile viewport rendering (narrow screen).
- [ ] Compare page load time: single `GET /repos/sessions` vs old multi-page `GET /sessions`. Confirm ≤ existing load time.
- [ ] Verify localStorage persistence: collapse a section, reload, confirm it stays collapsed.

# Tasks: Web UI Project Concept (Multi-Repo Grouping)

## Task 1: Add ProjectConfig type and config validation

**File**: `src/config.ts`

- [x] Add `ProjectConfig` interface: `{ name: string; repos: string[] }`
- [x] Add optional `projects?: ProjectConfig[]` field to `AgentRouterConfig`
- [x] Add validation in `validateConfig()`:
  - If `projects` is present, verify it's an array
  - Each project must have non-empty `name` (string) and non-empty `repos` (string array)
  - Project names must be unique (case-insensitive)
  - Each repo in `projects[].repos` must match a configured repo as `"owner/name"`
  - A repo cannot appear in more than one project
  - Throw `FatalError` with descriptive message on any violation
- [x] Ensure missing `projects` key passes validation without error (backward compat)

**Acceptance**: Config with valid projects loads; config with duplicate names, unknown repos, or cross-project duplicates throws FatalError with clear message; config without `projects` key works unchanged.

---

## Task 2: Create `src/projects.ts` pure logic module

**File**: `src/projects.ts` (new)

- [x] Export `computeProjectHealth(repoSessionCounts, projectRepos)` → `{ status, activeSessions, failedSessions }`
  - Session counts map shape: `Map<string, { active: number; failed: number; lastSessionAt: Date | null }>`
  - `green`: no failed/abandoned sessions across project repos
  - `partial`: at least one repo has failed/abandoned, others healthy
  - `paused`: zero active sessions AND no session has `lastSessionAt` within the last 24 hours (or all repos have `lastSessionAt: null`)
- [x] Export `computeTokenCoverage(projectRepos, repoConfigs, hasDefaultToken)` → `{ complete, missingRepos }`
  - A repo is covered if it has a per-repo token OR defaultGithubToken is set
- [x] Export `partitionRepos(allRepos, projects)` → `{ assigned: Set<string>, ungrouped: string[] }`
- [x] Export `validateProjects(projects, knownRepos)` → validation result with error messages

**Acceptance**: All functions are pure (no I/O), exported, and handle edge cases (empty arrays, undefined projects, repos with no session history).

---

## Task 3: Write unit tests for `src/projects.ts`

**File**: `test/projects.test.ts` (new)

- [x] Test `computeProjectHealth`:
  - All repos zero failed → green
  - One repo with failed session → partial
  - Zero active, no recent sessions → paused
  - Empty repo list → green (vacuous truth)
- [x] Test `computeTokenCoverage`:
  - All repos have token → complete
  - Missing token but defaultGithubToken set → complete
  - Missing token and no default → incomplete with repo listed
- [x] Test `partitionRepos`:
  - Repos split correctly between assigned and ungrouped
  - No projects → all ungrouped
- [x] Test `validateProjects`:
  - Valid config passes
  - Duplicate project name fails
  - Unknown repo fails
  - Repo in two projects fails

**Acceptance**: All tests pass. Coverage for happy path and error cases.

---

## Task 4: Add `GET /projects` API endpoint

**File**: `src/web-routes.ts`

- [x] Add `GET /projects` route handler
- [x] Accept config (projects + repos + defaultGithubToken) as dependency
- [x] Use `sessionFiles.listSessions()` to compute per-repo active/failed session counts
- [x] Call `partitionRepos`, `computeProjectHealth`, `computeTokenCoverage` from projects module
- [x] Return response matching the `ProjectsAPIResponse` shape from design doc
- [x] If no projects configured, return `{ projects: [], ungrouped: [...allRepos] }`

**Dependencies**: Task 1 (config types), Task 2 (projects module)

**File**: `src/web-server.ts`

- [x] Mount `/projects` under the auth middleware (same as `/sessions`)
- [x] Pass `config` to `createWebRoutes` deps (add to interface if needed)

**Acceptance**: `GET /projects` returns correct JSON with auth; returns 401 without auth; returns empty projects array when none configured.

---

## Task 5: Write integration tests for `GET /projects` endpoint

**File**: `test/web-routes-projects.test.ts` (new)

**Depends on**: Task 4

- [x] Test with projects configured: verify response shape, health, token coverage
- [x] Test with no projects: verify empty projects array, all repos in ungrouped
- [x] Test auth requirement: 401 without token
- [x] Test with mixed session states: verify health computation accuracy

**Acceptance**: All tests pass against the route handler with mocked dependencies.

---

## Task 6: Add projects panel to web UI

**File**: `src/web-ui.ts`

**Depends on**: Task 4 (API endpoint must exist)

- [x] Add CSS for `.projects-panel`, `.project-section`, `.project-header`, `.project-repos`, `.project-repo-item`, `.token-warning`
- [x] Add `.badge-paused` CSS class (gray background, distinguishable from `.badge-green`, `.badge-yellow`, `.badge-red`) for the paused aggregate health state
- [x] Add `<div id="projects-panel" class="projects-panel"></div>` above the session list in HTML
- [x] Add JS function `loadProjects()` that fetches `GET /projects` and renders the panel
- [x] On fetch failure: catch the error and hide the panel entirely (graceful degradation — do not show an error state, just omit the panel)
- [x] Render each project as a collapsible section with:
  - Project name as heading
  - Health badge using `.badge-green`, `.badge-yellow`, or `.badge-paused` (not `.badge-red` for paused)
  - Repo count
  - Token warning if `tokenCoverage.complete === false`
  - List of repos with active session count
- [x] Render "Ungrouped" section if ungrouped repos exist
- [x] Add collapse/expand toggle with `aria-expanded` attribute
- [x] Add `aria-label` to health badges
- [x] Add `role="region"` and `aria-labelledby` to project sections
- [x] Call `loadProjects()` in the list view navigation handler
- [x] If `/projects` returns empty projects and empty ungrouped, hide the panel entirely
- [x] Clicking a repo name filters sessions (sets `currentRepoFilter` and re-fetches session list)

**Acceptance**: Projects panel renders above sessions when projects configured; hidden when not configured or on API error; collapsible; accessible; clicking repo filters session list; paused projects show gray badge.

---

## Task 7: Add repo filter to session list

**File**: `src/web-routes.ts`

**Depends on**: Task 6 (UI that triggers the filter)

- [x] Add optional `repo` query parameter to `GET /sessions`
- [x] Filter sessions by `meta.repo === repoParam` when provided
- [x] Validate repo param format (must contain `/`)

**File**: `src/web-ui.ts`

- [x] When a repo is clicked in the projects panel, set a `currentRepoFilter` variable
- [x] Include `&repo=<fullName>` in the `/sessions` fetch URL when filter is active
- [x] Show active filter indicator with a "clear" button
- [x] Clearing the filter reloads unfiltered sessions

**Acceptance**: Clicking a repo in projects panel shows only that repo's sessions; clear button restores full list; direct URL with `?repo=` works.

---

## Task 8: End-to-end validation and backward compatibility

- [x] Test with a config.json that has NO `projects` key — verify startup succeeds and UI shows sessions as before
- [x] Test with a config.json that has `projects` defined — verify projects panel appears with correct data
- [x] Verify existing session list pagination still works with projects panel present
- [x] Verify SSE streaming to detail view still works unchanged
- [x] Verify auth flows (daemon token, trusted proxy) still apply to `/projects` endpoint
- [x] Run full test suite, ensure no regressions

**Acceptance**: All existing tests pass; new feature works end-to-end; no behavioral changes for users without projects configured.

# Tasks: Web UI Configuration View

## Task 1: Add `getTokenHealthSummary()` to token-store.ts
- [x] Inspect `src/token-store.ts` — determine whether `TokenEntry` currently stores an `expiry` field
- [x] Export a new function `getTokenHealthSummary(): TokenHealthEntry[]` in `src/token-store.ts`
- [x] Define the `TokenHealthEntry` interface: `{ project, tokenName, isSet, expiry, health }`
- [x] Implement health derivation: missing/expired → `red`, present + future expiry → `green`, present + unknown expiry → `green`
- [x] If `TokenEntry` has no expiry field, always return `expiry: null` — do NOT add expiry tracking in this task
- [x] Handle edge cases: empty token map, malformed expiry dates

**Requirements**: FR-5.1, FR-5.2, FR-5.3, NFR-5

## Task 1b: Unit tests for `getTokenHealthSummary()`
- [x] Test: token missing from map → `red`, `isSet: false`
- [x] Test: token present, no expiry → `green`, `expiry: null`
- [x] Test: token present, future expiry → `green`
- [x] Test: token present, past expiry → `red`
- [x] Test: empty token map → empty array

**Requirements**: FR-5.1, FR-5.2, FR-5.3

## Task 2: Create `src/cron-state.ts` with `getCronScheduleState()`
- [x] Create new file `src/cron-state.ts`
- [x] Export a new function `getCronScheduleState(): CronScheduleEntry[]`
- [x] Define the `CronScheduleEntry` interface: `{ name, repo, schedule, nextFireTime, paused }`
- [x] Read cron config from the passed-in `AgentRouterConfig.cron[]`
- [x] Compute `nextFireTime` from the cron expression — identify which cron library is already used in the project (check package.json) and use that; do not add a new dependency
- [x] Read pause state from the cron manager's runtime pause map (identify the export in `src/cron.ts` or equivalent)
- [x] Return `nextFireTime: null` if computation fails for an entry

**Requirements**: FR-4.1, FR-4.2, FR-4.3

## Task 2b: Unit tests for `getCronScheduleState()`
- [x] Test: cron expression with known next fire → correct ISO string returned
- [x] Test: invalid cron expression → `nextFireTime: null`, no throw
- [x] Test: paused cron → `paused: true` in output

**Requirements**: FR-4.1, FR-4.2, FR-4.3

## Task 3: Add `GET /api/config` route in web-routes.ts
**Depends on**: Task 1, Task 2

- [x] Add a new `app.get('/api/config', ...)` handler in `src/web-routes.ts`
- [x] Import and call `getConfig()`, `getTokenHealthSummary()`, `getCronScheduleState()`
- [x] Inspect `config.repos` structure to confirm field names before mapping — do not guess attribute names
- [x] Assemble response payload matching the design schema (sessionTimeouts, rateLimits, crons, tokens, repos)
- [x] Derive `webhookSecretName` from repo config (name only, never the value)
- [x] Return 500 with `{ error: "Failed to load configuration" }` on exceptions
- [x] Verify the route is behind existing auth middleware (no additional wiring needed since web-routes are already auth-gated)

**Requirements**: FR-2, FR-3, FR-4, FR-5, FR-6, NFR-1, NFR-5

## Task 4: Add Config tab navigation to web-ui.ts
- [x] Add `<a href="#config" class="nav-link">Config</a>` to the nav bar in `src/web-ui.ts`
- [x] Add a `<div id="config-view" class="view">` container (hidden by default)
- [x] Extend the `hashchange` event listener with a `#config` case that shows the config view and triggers data loading
- [x] Update the `showView()` helper to handle the `config` view alongside `sessions`

**Requirements**: FR-1.1, FR-1.2, FR-1.3

## Task 5: Implement Config tab rendering logic in web-ui.ts
**Depends on**: Task 3 (API endpoint), Task 4 (nav/container in place)
- [x] Add `loadConfig()` function that fetches `GET /api/config` with the embedded auth token
- [x] Add `renderConfigView(data)` function that builds the config page DOM:
  - Session Timeouts card (inactivityMinutes, maxLifetimeMinutes, gracePeriodAfterMergeSeconds)
  - Rate Limits card (perPRSeconds)
  - Cron Schedules table (name, repo, schedule, next fire time, paused badge)
  - Token Health table (project, token name, health dot, expiry)
  - Repositories table (name, webhook secret name)
- [x] Add `formatNextFire(isoString)` using `Intl.DateTimeFormat` for local timezone human-readable output
- [x] Add health dot rendering: green circle for healthy, red for unhealthy, gray for unknown
- [x] Add error state rendering if API call fails

**Requirements**: FR-2, FR-3, FR-4, FR-5, FR-6, NFR-4

## Task 6: Add Config tab CSS styles to web-ui.ts
- [x] Add `.config-grid` class for the side-by-side layout of Session Timeouts and Rate Limits cards
- [x] Add `.health-green`, `.health-red`, `.health-unknown` classes for token status dots
- [x] Add `.badge-paused` / `.badge-active` variants for cron pause state if not already covered by existing badge styles
- [x] Verify all new styles match existing design language (colors, spacing, border-radius, font sizes)

**Requirements**: NFR-2

## Task 7: Integration testing and verification
- [x] Start the daemon locally and confirm `GET /api/config` returns the expected JSON shape
- [x] Verify auth is enforced (401 without token)
- [x] Verify no secret values appear in the response (webhook secrets, token values)
- [x] Open the web UI, navigate to `#config`, confirm all sections render
- [x] Verify cron next-fire times display in local timezone
- [x] Verify token health dots show correct colors for green/red/unknown states
- [x] Test with missing tokens and expired tokens to confirm red indicators
- [x] Confirm no page reload occurs when switching between Sessions and Config tabs

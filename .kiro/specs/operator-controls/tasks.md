# Implementation Plan: Operator Controls

## Overview

Six features delivered as independent, dependency-ordered slices. Each task group is sized for
a single PR (~300–500 lines incl. tests) and leaves the tree green on its own. The two
restart-themed groups (5, 3) and the cron-reconcile in group 5 share `src/index.ts` startup and
`src/session-mgr.ts`; they are ordered late so the small independent items land first.

## Tasks

- [ ] 1. Child-environment secret hygiene (env-scrub)
  - [ ] 1.1 Pure `buildChildEnv(parentEnv, overrides, allowlist)` helper
    - Add to the spawn path module (`src/agent-adapter.ts` or `src/acp.ts`). Forward only an
      allowlist of parent env keys (PATH, HOME, LANG, `AGENT_ROUTER_*`, plus an optional extra
      allowlist), then apply `overrides` (the resolved `GITHUB_TOKEN`).
    - Tier 1: parent env with `GITHUB_TOKEN_DPDK`, `GITHUB_WEBHOOK_SECRET_*` yields a child env
      with none of them, the allowlisted keys present, and the `GITHUB_TOKEN` override applied.
    - _Requirements: 5.1, 5.2, 5.4_
  - [ ] 1.2 Wire the allowlist into the spawn path
    - Replace `spawnACPClient`'s `{ ...process.env, ...env }` with `buildChildEnv(...)` (or an
      option that disables the blanket `process.env` spread). Add optional
      `config.childEnvAllowlist`. Keep the per-repo `GITHUB_TOKEN` injection from the prior fix.
    - Tier 2: a spawned session's child env excludes other repos' secrets; the correct
      `GITHUB_TOKEN` is still present.
    - _Requirements: 5.1, 5.3_

- [ ] 2. Per-repo cron pause / resume
  - [ ] 2.1 `cron_state` persistence
    - Add `cron_state(name TEXT PRIMARY KEY, paused INTEGER NOT NULL, updated_at INTEGER)` to
      `src/db.ts` with `getCronState`/`setCronPaused` methods; absent row defaults to active.
    - Tier 1: default-active, set/clear paused, persistence round-trip.
    - _Requirements: 3.4_
  - [ ] 2.2 CLI control + scheduler honors state
    - `agent-router cron list|pause <name>|resume <name>` via the CLI/IPC server
      (`src/cli-server.ts`); handler updates `cron_state` and calls `.stop()`/`.start()` on the
      live `ScheduledTask`. `setupCronJobs` consults `cron_state` at registration (paused →
      created stopped). Unknown name → error listing known names.
    - Tier 2: paused cron does not fire; state survives a simulated restart; resume re-enables.
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6_

- [ ] 3. Session resumption across restart
  - [ ] 3.1 Persist `kiro_session_id` + new termination reason
    - Add `kiro_session_id?: string` to `SessionMeta` (`src/session-files.ts`); write it in
      `createSession` after `newSessionWithPrompt`. Add `terminated_by_restart` to the
      `termination_reason` closed union and handle it in every switch/surface.
    - Tier 1: meta round-trips `kiro_session_id`; union/validators accept the new reason.
    - _Requirements: 6.1, 6.5_
  - [ ] 3.2 Resume-or-terminate on startup
    - New startup scan in `src/index.ts`: for each on-disk `active` session, attempt ACP
      `loadSession(kiro_session_id)`; on success rebuild the `SessionHandle` (queues, timers)
      into the registry; on failure/missing id mark `terminated_by_restart` + write
      `session_ended`.
    - Tier 2: kill daemon mid-session, restart → resumed via fake `session/load`, or marked
      `terminated_by_restart`; never left corrupted.
    - _Requirements: 6.2, 6.3, 6.4, 6.6_

- [ ] 4. CI-reconciliation nudge (wake watchdog)
  - [ ] 4.1 Check-status fetch + nudge idempotency (pure parts)
    - GitHub client method for a PR head-sha's combined check conclusion; pure
      `nudgeKey(session, pr, headSha, conclusion)` and "all terminal?" predicate.
    - Tier 1: terminal/in-progress classification; idempotency key stability across re-poll and
      change across a new head sha.
    - _Requirements: 4.4, 4.5_
  - [ ] 4.2 `check-watchdog` loop + wake injection
    - New `src/check-watchdog.ts` interval (default 30s, configurable) over active sessions with
      an open registered PR that is idle/waiting; on terminal checks not yet nudged, inject a
      wake via `sessionMgr.injectPrompt(..., 'router')`. Best-effort on GitHub errors.
    - Tier 2: FakeGitHub terminal checks → exactly one wake; in-progress → no wake, session
      stays alive; GitHub error → logged, no crash, no false termination.
    - _Requirements: 4.1, 4.2, 4.3, 4.6_

- [ ] 5. Config hot-reload
  - [ ] 5.1 `classifyConfigChange(old, next)` pure partitioner
    - In `src/config.ts`: returns `{ reloadable, restartRequired }` changed-field lists.
      Restart-required: `port`, `controlPort`, `bindPublic`, `kiroPath`, `trustedProxy`.
    - Tier 1: each field classified correctly; no-change → empty lists.
    - _Requirements: 1.3, 1.4_
  - [ ] 5.2 `watchConfig` module (debounce, validate-or-retain)
    - New `src/config-watch.ts`: `fs.watch` + debounce (default 1000ms) → `loadConfig`; on
      validation failure call `onError` and retain previous; on success call `onReload(next)`.
    - Tier 1: debounce collapses rapid writes (injected timer); invalid config → onError, no
      throw.
    - _Requirements: 1.1, 1.2_
  - [ ] 5.3 Apply reload to running components
    - Route token resolver, wake policy inputs, and `sessionTimeout` through a mutable holder
      updated on reload; `reconcileCronJobs` stops/starts/replaces tasks (re-applying paused
      state from task 2); active sessions untouched.
    - Tier 2: reload adds a repo + cron and changes a timeout without dropping an active
      session; invalid reload is rejected and the daemon keeps running.
    - _Requirements: 1.3, 1.5, 1.6_

- [ ] 6. Restart-required surfacing (env caveat)
  - [ ] 6.1 `restart_required` condition + surfacing
    - Record `{ fields, since }` when a reload sees a restart-required field differ from the
      startup value; log `warn` each reload while it persists; expose `restart_required` on
      `/health` (if present) — otherwise log-only. Document the `EnvironmentFile`/`ENV:`
      limitation in README.
    - Tier 1: state set/clear logic. Tier 2: changing a restart-required field via reload sets
      the condition and is observable.
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

## Notes

- Group 6 surfaces best on the `/health` endpoint (separate ROADMAP item, `BACKLOG.md § P1.5`).
  If that has not merged when group 6 is picked, degrade to the logged warning and add the
  health field when `/health` lands.
- Group 5's cron reconciliation must re-apply group 2's persisted paused state after
  rebuilding tasks — pick group 2 before group 5.
- env-scrub (group 1) touches the same spawn path as the per-repo-token fix (PR #38); rebase on
  that before starting.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.2", "4.2", "5.2"] },
    { "id": 2, "tasks": ["5.3"] },
    { "id": 3, "tasks": ["6.1"] }
  ]
}
```

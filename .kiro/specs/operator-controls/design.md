# Design: Operator Controls

## Overview

Six features, each a focused change to existing daemon components. None introduce a new
dependency. The work is sequenced so the small, independent items land first and the two
restart-themed items (config reload, session resumption) — which both touch `src/index.ts`
startup and `src/session-mgr.ts` — land last to minimize churn.

Anchor points in the current code (verified):

- Config is loaded once at startup: `loadConfig(configPath)` in `src/index.ts` (~L345);
  `validateConfig`/`resolveEnvValues` live in `src/config.ts`.
- Cron is registered by `setupCronJobs` (`src/index.ts` ~L158) which builds a
  `cron.ScheduledTask[]` from `config.cron`; each task calls `handleCronFire` (~L173). The
  clean-state guard that blocks re-fire is at ~L190.
- The inactivity watchdog already runs `verify(sessionId)` before failing a session
  (`src/session-mgr.ts` ~L198); this is the seam the CI-nudge extends.
- The spawn env is composed in the `acpSpawner` closure in `src/index.ts` (the per-repo-token
  fix) and passed through `KiroAdapter.spawn` → `spawnACPClient(..., { ...process.env, ...env })`.
- `SessionMeta` (`src/session-files.ts`) holds session status/termination_reason; ACP
  `loadSession(sessionId)` → `session/load` exists at `src/acp.ts` but is never called.

---

## Feature 1 — Config hot-reload

**New module `src/config-watch.ts`** exporting `watchConfig(configPath, onReload, opts)` that
`fs.watch`es the file with a debounce (default 1000ms) and calls `onReload(newConfig)` with a
freshly `loadConfig`'d+validated config. Validation failures are caught and surfaced via an
`onError` callback; the previous config is retained.

**Reload application.** Introduce a small mutable holder the running components read through,
rather than capturing `config` by value at startup. Concretely:
- The token resolver is rebuilt from the new `repos`/`defaultGithubToken` and swapped behind a
  stable function reference (the `acpSpawner` closure and GitHub client call through a
  `getTokenResolver()` indirection).
- The wake policy reads `rateLimit`/`repos` from the holder, not a captured value.
- `sessionTimeout` updates apply to sessions created *after* the reload (active sessions keep
  their timers).
- Cron is reconciled (see below).

**Reloadable vs restart-required.** A pure function
`classifyConfigChange(old, next): { reloadable: string[], restartRequired: string[] }`
(in `src/config.ts`) compares the two configs and partitions changed top-level fields.
Restart-required set: `port`, `controlPort`, `bindPublic`, `kiroPath`, `trustedProxy`. Everything
else is reloadable. Pure → Tier 1 testable.

**Cron reconciliation.** `reconcileCronJobs(oldTasks, oldConfig, nextConfig, ...)` stops tasks
whose entry was removed or whose schedule changed, starts new/changed ones, and leaves
unchanged entries running. Returns the new `ScheduledTask[]`. Paused state (Feature 3) is
re-applied after reconciliation.

**Decision:** hot-reload deliberately does NOT re-resolve `ENV:` values against a changed
`EnvironmentFile` — `process.env` is fixed for the process lifetime. That limitation is the
subject of Feature 2.

---

## Feature 2 — Restart-required change surfacing

A `RestartRequiredState` (in the daemon state) records `{ fields: string[], since: number }`.
On each reload, `classifyConfigChange` results feed it: any restart-required field whose value
differs from the *startup* value is recorded; a `warn` is logged naming the fields.

For the env caveat specifically: `config-watch` cannot see `EnvironmentFile` edits (they are
not in `config.json`). The daemon SHALL document this in README and, where an `ENV:` token is
referenced, the health endpoint (`/health`, if present from the other spec) SHALL expose
`restart_required: string[]` so an operator/automation can detect drift. (If `/health` is not
yet merged, this degrades to the logged warning only.)

**Decision:** we do not attempt to diff the EnvironmentFile or auto-restart. Auto-restart is an
ops concern (systemd), out of scope; surfacing the condition is enough.

---

## Feature 3 — Per-repo cron pause / resume

**Persistence.** A new table `cron_state(name TEXT PRIMARY KEY, paused INTEGER NOT NULL,
updated_at INTEGER)` in SQLite (`src/db.ts`). Default (no row) = active.

**Runtime.** `setupCronJobs` consults `cron_state` when registering; a paused entry is created
with `cron.schedule(..., { scheduled: false })` or `.stop()` immediately after creation.

**Control plane.** New CLI subcommands routed through the existing CLI/IPC server
(`src/cli-server.ts`): `cron list`, `cron pause <name>`, `cron resume <name>`. The daemon
handler updates `cron_state` and calls `.stop()`/`.start()` on the live `ScheduledTask`. `list`
returns name/repo/schedule/paused.

**Decision:** pause is operator intent → persisted, so a restart preserves it. `handleCronFire`'s
existing clean-state guard is independent and unchanged (but see ROADMAP item 3 / P1.8 which
relaxes it for `abandoned`).

---

## Feature 4 — CI-reconciliation nudge (wake watchdog)

**Mechanism.** A daemon-level `checkWatchdog` (new `src/check-watchdog.ts`) runs on an interval
(default 30s, configurable). For each active session with ≥1 registered open PR that is **idle
and waiting** (no activity since last push / last wake), it calls the GitHub client for the PR's
combined check status (`GET /repos/{o}/{r}/commits/{sha}/check-runs` + status). When all checks
are terminal for the current head sha, it composes a wake prompt ("CI complete on PR #N:
<conclusion summary>. Read the posted report and proceed.") and calls
`sessionMgr.injectPrompt(sessionId, prompt, 'router')` — the exact path the manual nudge uses.

**Idempotency.** A `nudged_checks(session_id, pr_number, head_sha, conclusion)` record (table or
in-memory set keyed the same) prevents re-nudging for an outcome already delivered. A new push
(new head sha) is a fresh key, so re-runs are handled.

**Relationship to the inactivity watchdog.** The inactivity watchdog (session-mgr) fails a
silent session after the inactivity window; the check-watchdog runs sooner and *keeps the
session alive + nudges* when the silence is "correctly waiting for CI." Ordering: a session
waiting on an open PR with completed checks gets nudged (check-watchdog) before the inactivity
window would fail it. The existing `verify`-first inactivity path already avoids false
`timeout_inactivity` when the PR merged; this adds the not-yet-merged-but-CI-done case.

**Decision:** the agent prompt is unchanged — the no-poll contract holds because the daemon
does the polling. This is reliability glue, not a behavior change for the agent.

---

## Feature 5 — Child-environment secret hygiene (env-scrub)

Today `spawnACPClient` does `{ ...process.env, ...env }`, so the child inherits every
`GITHUB_TOKEN_*` and `GITHUB_WEBHOOK_SECRET*` the daemon holds. Change the spawn path to build
the child env from an **allowlist** of the parent env (PATH, HOME, LANG, the AGENT_ROUTER_*
vars, plus a configurable extra allowlist) merged with the explicit `env` overrides (the
resolved `GITHUB_TOKEN`).

**Implementation.** A pure `buildChildEnv(parentEnv, overrides, allowlist): Record<string,string>`
(co-located with the spawn path, e.g. `src/agent-adapter.ts` or `src/acp.ts`). `spawnACPClient`
takes the fully-built env instead of spreading `process.env` itself, OR gains an option to
disable the `process.env` spread. Tier 1 test: a parent env containing `GITHUB_TOKEN_DPDK`,
`GITHUB_WEBHOOK_SECRET_LLM_COURSE` yields a child env with only the allowlisted keys +
`GITHUB_TOKEN` override.

**Decision:** allowlist, not denylist — a newly-added daemon secret is excluded by default. The
allowlist must include whatever Kiro/`gh`/`git` genuinely need; the design names a conservative
default set and exposes an optional `config.childEnvAllowlist` for escape-hatch additions.

---

## Feature 6 — Session resumption across restart

**Persist.** Add `kiro_session_id?: string` to `SessionMeta` (`src/session-files.ts`). In
`createSession` (`src/session-mgr.ts`), after `newSessionWithPrompt` returns the ACP session id,
write it via `updateMeta`.

**Resume on startup.** A new startup step (in `src/index.ts`, before/after cron registration)
scans on-disk sessions with status `active`. For each:
- If `kiro_session_id` present: spawn an ACP client, `await acp.loadSession(kiro_session_id)`.
  On success, rebuild the `SessionHandle` (event/turn queues, timers) and add to the registry —
  status stays `active`.
- On failure or missing id: `updateMeta(status: 'abandoned'/terminal, termination_reason:
  'terminated_by_restart')` and write a `session_ended` stream entry.

**Closed union.** Add `terminated_by_restart` to the `termination_reason` union in
`SessionMeta` and handle it everywhere reasons are switched/surfaced (CLI pretty-print, web,
notification webhook if present).

**Decision:** resumption is attempted only for `active` sessions; terminal sessions are left
as-is. A bounded recency window MAY gate the attempt (skip `session/load` for sessions idle
longer than maxLifetime), but the default is to try and fall back to `terminated_by_restart`.
This folds in and supersedes the standalone P2.1 ROADMAP item.

---

## Testing strategy

- **Tier 1 (pure):** `classifyConfigChange`, `buildChildEnv`, cron-state defaulting, the
  nudge idempotency-key function, debounce logic (with injected timer).
- **Tier 2 (daemon against fakes):** config reload applies a new repo/cron without dropping an
  active session and rejects invalid config; cron pause stops firing and persists across a
  simulated restart; check-watchdog injects exactly one wake when FakeGitHub reports terminal
  checks and none while in-progress; env-scrub — spawned child env excludes other secrets;
  resumption — kill+restart resumes via fake `session/load` or marks `terminated_by_restart`.
- Tier 2 is required for every behavioral change per `AGENTS.md`.

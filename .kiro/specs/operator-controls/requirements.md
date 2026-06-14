# Requirements: Operator Controls

## Introduction

A group of operator-ergonomics and self-healing features for the agent-router daemon, all
sharing one theme: **the daemon should adapt and recover without a human poking it.** Today
an operator must restart the daemon to change config, manually re-trigger crons after a
restart, manually nudge sessions that are waiting on a CI signal that never arrived, and
accept that every spawned session inherits every repo's PAT. This spec closes those gaps.

Scope is the **non-web** operator surface. Web-client load failures are tracked separately in
`.kiro/specs/web-client/`. Session-id prefix matching (the "short hash shown, long hash
required" papercut) is already queued as a standalone ROADMAP item and is out of scope here.

## Requirements

### Requirement 1: Config hot-reload

**User story:** As an operator, I want the daemon to pick up `config.json` changes without a
restart, so I can add a repo, change a cron schedule, or tune timeouts without dropping
active sessions.

**Acceptance criteria:**
1. WHEN `config.json` is modified on disk THEN the daemon SHALL re-read and validate it within
   a bounded debounce window (default 1s after the last write).
2. WHEN the reloaded config fails validation THEN the daemon SHALL retain the previously
   loaded config, log the validation error, and SHALL NOT crash or drop sessions.
3. WHEN reloadable fields change — `repos`, `cron`, `rateLimit`, `sessionTimeout`,
   `defaultGithubToken`, `allowedEmails` — THEN the daemon SHALL apply them to the running
   components (token resolver, cron schedule, wake policy, timeout config) without a restart.
4. WHEN a restart-required field changes — `port`, `controlPort`, `bindPublic`, `kiroPath`,
   `trustedProxy` — THEN the daemon SHALL log a warning naming the field and SHALL continue
   using the value loaded at startup until an operator restarts.
5. A config reload SHALL NOT interrupt, re-spawn, or alter any already-active session.
6. WHEN a reload changes `cron` THEN newly-added jobs SHALL be scheduled, removed jobs SHALL
   be stopped, and changed schedules SHALL be re-registered — without double-firing.

### Requirement 2: Restart-required change surfacing (env caveat)

**User story:** As an operator, I want to be told clearly when a change I made cannot take
effect without a restart, so I'm not misled into thinking a token rotation or port change is
live when it isn't.

**Acceptance criteria:**
1. Because `ENV:`-prefixed config values are resolved against `process.env` at process start,
   the daemon SHALL document and surface that a changed `EnvironmentFile` value (e.g. a
   rotated `GITHUB_TOKEN_*`) does NOT take effect on a config hot-reload.
2. WHEN a hot-reload detects that a restart-required field (Requirement 1.4) differs from the
   running value THEN the daemon SHALL record a `restart_required` condition with the field
   name(s) and the time first observed.
3. The `restart_required` condition SHALL be observable by an operator (surfaced on the
   health endpoint if present, and logged at `warn` on each reload while it persists).
4. WHEN the daemon is restarted and the field now matches THEN the `restart_required`
   condition SHALL clear.

### Requirement 3: Per-repo cron pause / resume

**User story:** As an operator, I want to pause a specific repo's cron and later re-enable it,
so I can stop autonomous runs on one repo (e.g. while debugging) without disabling all crons
or editing and reloading config.

**Acceptance criteria:**
1. The CLI SHALL provide `agent-router cron list` showing each cron entry's name, repo,
   schedule, and paused/active state.
2. The CLI SHALL provide `agent-router cron pause <name>` and `agent-router cron resume
   <name>`.
3. WHEN a cron is paused THEN its scheduled job SHALL NOT fire until resumed.
4. The paused/active state SHALL persist across daemon restarts (it is operator intent, not
   ephemeral).
5. WHEN `pause`/`resume` targets an unknown cron name THEN the CLI SHALL error with the list
   of known names.
6. Pausing a cron SHALL NOT affect a session already running for that repo.

### Requirement 4: CI-reconciliation nudge (wake watchdog)

**User story:** As an operator, I want a session that is waiting for a CI result to be woken
automatically when its PR's checks complete, so I no longer have to manually inject "CI is
green, proceed."

**Acceptance criteria:**
1. WHEN a session has a registered PR and has gone idle waiting for a CI signal THEN the
   daemon SHALL poll that PR's check status via the GitHub API on a bounded interval.
2. WHEN the PR's checks reach a terminal conclusion (all complete: success or failure) AND no
   corresponding wake has been delivered THEN the daemon SHALL inject a wake prompt
   summarizing the check outcome into the session.
3. The agent's no-poll contract SHALL be preserved: the *daemon* polls, the *agent* still only
   reacts to delivered events. The prompt rules do not change.
4. The watchdog SHALL NOT inject a duplicate wake for a check outcome the session was already
   woken for (idempotent on `(pr, check_run conclusion, head_sha)`).
5. WHEN the PR's checks are still in progress THEN the watchdog SHALL leave the session
   waiting (not fail it on inactivity) and re-poll.
6. The watchdog SHALL be best-effort: a GitHub API error SHALL be logged and retried on the
   next interval, never crash the daemon or falsely terminate the session.

### Requirement 5: Child-environment secret hygiene (env-scrub)

**User story:** As the daemon, I want a spawned session to receive only the single GitHub
token it needs, so one repo's session cannot read another repo's PAT from its environment.

**Acceptance criteria:**
1. WHEN the daemon spawns a session for repo R THEN the child process SHALL receive the
   resolved token for R as `GITHUB_TOKEN` and SHALL NOT receive any other `GITHUB_TOKEN_*` /
   `GITHUB_WEBHOOK_SECRET*` daemon secrets in its environment.
2. The child SHALL still receive the non-secret environment it needs to run (PATH, HOME, the
   AGENT_ROUTER_* vars, and any explicitly allowlisted vars).
3. WHEN no token can be resolved for R THEN the existing behavior (Requirement from the
   per-repo-token fix) SHALL hold — no `GITHUB_TOKEN` override is injected — and no other
   repo's secret SHALL leak in as a fallback.
4. The scrub SHALL be implemented as an allowlist (forward only what is needed) rather than a
   denylist, so a newly-added secret env var is excluded by default.

### Requirement 6: Session resumption across daemon restart

**User story:** As an operator, I want active sessions to survive a daemon restart, so a deploy
or config restart does not orphan in-flight agent work and force a manual re-trigger.

**Acceptance criteria:**
1. WHEN the daemon creates an ACP session THEN it SHALL persist the Kiro session id
   (`kiro_session_id`) to that session's `meta.json`.
2. WHEN the daemon starts up THEN for each on-disk session still marked `active` it SHALL
   attempt ACP `session/load(kiro_session_id)`.
3. WHEN `session/load` succeeds THEN the session SHALL be returned to the active registry and
   keep status `active`.
4. WHEN `session/load` fails or no `kiro_session_id` is stored THEN the session SHALL be marked
   with a new terminal `termination_reason: "terminated_by_restart"` and SHALL NOT be left in a
   corrupted or perpetually-active state.
5. The new `terminated_by_restart` value SHALL be added to the `termination_reason` closed
   union and handled wherever termination reasons are surfaced.
6. This requirement supersedes the standalone ROADMAP item for P2.1 (which is folded into this
   spec).

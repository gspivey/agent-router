# Continuous Mode — Requirements

## Overview

Continuous mode allows agent-router to process ROADMAP items back-to-back without waiting for
the next cron tick. When a session completes with a merged PR, the daemon immediately starts a
fresh session for the next unchecked ROADMAP item, eliminating the idle gaps between scheduled
cron fires (observed range: 30–60 minutes per cycle).

## Background

Cron fires at a fixed interval (e.g. every hour at :37). A typical PR takes 50–90 minutes from
session start to merge. When a PR merges at :45, the next cron does not fire until :37 the
following hour — 52 minutes of pure idle. Analysis of October 2026 merges shows this scheduling
overhead reduces actual throughput by ~40% (≈10 PRs/day instead of ~16).

Continuous mode closes this gap entirely: each successful merge immediately triggers the next
item. The operator opts in per-repo via a config flag; existing cron behaviour is unchanged for
repos without the flag.

---

## Functional Requirements

### FR-1: Opt-in configuration

**REQ-1.1** The `RepoConfig` type SHALL gain a `continuous` boolean field (optional, default
`false`). When `true`, this repo participates in continuous mode.

**REQ-1.2** The `RepoConfig` type SHALL gain a `baseBranch` string field (optional, default
`"development"`). The daemon reads the ROADMAP file from this branch when deciding whether to
start the next session.

**REQ-1.3** `validateConfig` SHALL accept the new fields without error when they are present and
valid, and SHALL reject a `baseBranch` that is an empty string.

**REQ-1.4** Repos without `continuous: true` SHALL behave exactly as before. No existing cron
job, session, or webhook flow may be altered by the presence of this feature.

---

### FR-2: Continuous run lifecycle

**REQ-2.1** When cron fires for a repo with `continuous: true`, the daemon SHALL initiate a
_continuous run_ for that repo instead of a one-shot session. The first session is created
using the same prompt file and `composeCronPrompt` as today.

**REQ-2.2** A _continuous run_ is a named, in-memory state object bound to `(repo, cronName)`.
It tracks: `status` (`running` | `stopped`), `phase` (`session_active` | `pending` | `fetching` | `spawning`),
`stop_reason` (`operator_request` | `queue_empty` | `item_failed` | `no_progress` | `roadmap_fetch_failed`),
`stopRequested` flag, `items_completed` count, `current_session_id`, `unchecked_count_at_spawn` (for
no-progress detection), and `started_at` timestamp.

**REQ-2.3** Only one continuous run may be active per repo at a time. If cron fires while a
run is already active for that repo, the fire SHALL be skipped (same behaviour as the existing
collision guard for active sessions).

**REQ-2.4** When a session bound to a continuous run terminates with
`termination_reason: "merged"`, the daemon SHALL, after the session **leaves the registry**
(i.e. after the grace period expires and the Kiro process is killed):
  1. Fetch the ROADMAP file from GitHub at `baseBranch` (using the path in `RepoConfig.roadmapPath`,
     falling back to `"ROADMAP.md"`).
  2. Parse it with `parseRoadmap` and call `findNextTask`.
  3. **No-progress check:** If the number of unchecked items has not decreased since the session
     started, stop the run with `stop_reason: "no_progress"` and log at `warn` level.
  4. If an unchecked task exists, no stop has been requested, and the daemon is not shutting down,
     create a fresh session with the cron prompt for that repo and record the new unchecked count.
  5. If no unchecked task exists, stop the run with `stop_reason: "queue_empty"` and log at
     `info` level.

**REQ-2.5** When a session bound to a continuous run terminates with a reason other than
`"merged"` (i.e. `failed`, `timeout_inactivity`, `timeout_max_lifetime`, etc.), the daemon
SHALL stop the run with `stop_reason: "item_failed"` and log at `warn` level. It SHALL NOT
retry the failed item.

**REQ-2.6** Sessions created by a continuous run SHALL be subject to all existing guards:
  - Inactivity timeout and max-lifetime timeout apply unchanged (same values, same enforcement).
  - Rate limiting applies unchanged (same logic, same limits).
  - The full cron clean-state guard applies to the initial session created when cron fires; the
    runner's own spawn path bypasses the clean-state guard (the run itself IS the clean state).

---

### FR-3: Graceful stop

**REQ-3.1** The daemon SHALL expose a `stop_continuous` IPC operation that accepts a `repo`
parameter (`owner/name`) and marks the run for that repo with `stopRequested = true`.

**REQ-3.2** When `stopRequested` is `true`, the runner SHALL NOT start another session after
the current one ends. It SHALL set `status: "stopped"` and `stop_reason: "operator_request"`.

**REQ-3.3** The stop takes effect _between items_: the current session is never interrupted
mid-flight. If no run exists for the given repo, the operation SHALL return an error.

---

### FR-4: CLI surface

**REQ-4.1** A new CLI subcommand `agent-router stop-continuous --repo <owner/repo>` SHALL send
the `stop_continuous` IPC op and print a confirmation message on success.

**REQ-4.2** `agent-router ls` SHALL include a `continuous_runs` array in its output, each
entry containing: `repo`, `status`, `stop_reason` (if stopped), `items_completed`,
`current_session_id`, `started_at`, and `stopped_at` (if stopped). Additional internal fields
(like `phase`, `stopRequested`) SHALL NOT be exposed in the CLI output.

**REQ-4.3** The `ls` pretty-printer SHALL render active continuous runs visibly (e.g. a
`[CONT]` prefix or dedicated row) so an operator can see a run is in progress at a glance.

---

### FR-5: Visibility and logging

**REQ-5.1** The daemon SHALL log at `info` level when a continuous run starts, when each
subsequent session within the run starts, and when the run stops (with stop reason).

**REQ-5.2** The daemon SHALL log at `warn` level when a session fails and stops the chain.

**REQ-5.3** When a session is created as part of a continuous run, the runner SHALL log at `info`
level with `continuous_run_repo` and `items_completed_before_this_item` fields in its own log
entry (separate from `createSession`'s internal logging), for audit traceability.

---

## Non-Functional Requirements

**NFR-1: Backward compatibility.** All existing behaviour is preserved for repos without
`continuous: true`. No existing Tier 1 or Tier 2 tests may be broken.

**NFR-2: Failure isolation.** A failed item stops the chain but does not affect unrelated
sessions or repos.

**NFR-3: Single active run per repo.** The continuous runner uses the same collision detection
as the existing session manager to guarantee no two sessions run simultaneously on the same
repo.

**NFR-4: Resource limits honoured.** Sessions spawned by the runner are subject to all
existing timeouts, token limits, and rate limits. The runner adds no bypass.

**NFR-5: No persistent state.** Continuous run state is in-memory. A daemon restart stops
all active runs; the operator re-triggers via cron or `agent-router new`. (Persistence is
deferred to a future item aligned with ROADMAP item 19: session resumption.)

---

## Out of Scope

- Multi-repo continuous runs (runs spanning multiple repos simultaneously).
- Automatic retry of failed items.
- Changing the ordering of ROADMAP items processed.
- Priority queues or item filtering within a continuous run.
- Persistent run state across daemon restarts.
- Integration with external schedulers beyond the existing cron mechanism.

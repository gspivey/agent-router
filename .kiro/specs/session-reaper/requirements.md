# Requirements Document: Session Reaper

## Introduction

The Session Reaper is an in-process subsystem of the Agent Router daemon that automatically reclaims disk space consumed by two categories of session artifacts:

1. **Agent working directories** (`~/agent-runs/<timestamp>-<repo>/`) — full git clones with build artifacts (3.5–9 GB each, 65 GB total across 128 sessions).
2. **Session metadata directories** (`~/.agent-router/sessions/<uuid>/`) — stream logs, prompt logs, and meta.json (567 MB across 2,987 sessions).

The reaper runs inside the daemon process, using the daemon's own session state (in-memory registry + SQLite DB) as the authoritative source of truth for active vs. terminal sessions. It fires both event-driven (on session terminal state transition) and periodically (interval sweep), with configurable grace periods and retention windows.

This spec supersedes BACKLOG.md P1.4 (systemd-timer-based cleanup) with an in-process solution that also covers agent-runs/ worktrees.

## Glossary

- **Reaper**: The in-process subsystem responsible for deleting expired session artifacts
- **Agent_Runs_Dir**: The base directory at `~/agent-runs/` containing per-session working directories created by agent subprocesses
- **Worktree**: A per-session working directory under Agent_Runs_Dir, named `<timestamp>-<repo>/`, containing a git clone and build artifacts
- **Session_Metadata_Dir**: A per-session directory under `~/.agent-router/sessions/<uuid>/` containing `meta.json`, `stream.log`, and `prompts.log`
- **Terminal_State**: A session whose `meta.json` status is one of `completed`, `abandoned`, or `failed`
- **Terminal_At**: A Unix timestamp (`terminal_at` in `meta.json`) set on ANY transition to Terminal_State (completed, failed, or abandoned). This is the authoritative timestamp for grace-period and retention-window calculations. The session manager MUST populate `terminal_at` for all three terminal states.
- **Grace_Period**: The configurable duration (default 1 hour) after a session enters Terminal_State before its Worktree becomes eligible for deletion
- **Retention_Window**: The configurable duration (default 30 days) after a session enters Terminal_State before its Session_Metadata_Dir becomes eligible for deletion
- **Worktree_Path**: The filesystem path to a session's Worktree, either registered explicitly by the agent or discovered via naming convention
- **Sweep**: A periodic scan (default every 15 minutes) that identifies and deletes all eligible artifacts
- **Reaper_Config**: The configuration block controlling reaper behavior: enabled flag, grace period, retention window, agent-runs base path, sweep interval

## Requirements

### Requirement 1: Reaper Configuration

**User Story:** As an operator, I want to configure the reaper's behavior via config.json, so that I can tune retention policies and disable reaping if needed.

#### Acceptance Criteria

1. THE Daemon SHALL accept an optional `reaper` object in the Config_File with fields `enabled` (boolean, default `true`), `gracePeriodMinutes` (positive integer, default `60`), `retentionDays` (positive integer, default `30`), `agentRunsDir` (string, default `~/agent-runs`), and `sweepIntervalMinutes` (positive integer, default `15`)
2. WHEN the `reaper` key is absent from the Config_File, THE Daemon SHALL use all default values and enable the reaper
3. WHEN `reaper.enabled` is `false`, THE Daemon SHALL skip all reaper initialization and perform no artifact deletion
4. IF any `reaper` field fails validation (non-positive integer, non-boolean enabled, non-string path), THEN THE Daemon SHALL throw a `FatalError` with a descriptive message identifying the invalid field
5. THE Daemon SHALL resolve the `agentRunsDir` path by expanding a leading `~` to `$HOME`

### Requirement 2: Worktree Path Registration

**User Story:** As a developer, I want sessions to track the path to their agent working directory, so that the reaper knows which directory to delete.

#### Acceptance Criteria

1. THE Session Manager SHALL accept an optional `worktreePath` parameter when creating a session, stored in `meta.json` as the `worktree_path` field
2. THE MCP server SHALL expose a `register_worktree` tool that accepts a `path` argument and writes it to the session's `meta.json` via the daemon socket
3. WHEN no `worktree_path` is registered for a terminal session, THE Reaper SHALL attempt discovery by scanning Agent_Runs_Dir for directories whose name matches the format `<YYYYMMDD-HHMMSS>-<repo>`, where the parsed timestamp is within a 5-minute window of the session's `created_at` and the `<repo>` suffix matches the session's bound repo slug
4. IF discovery finds zero or multiple matching directories, THE Reaper SHALL log the ambiguity at `warn` level (multiple) or `debug` level (zero) and skip Worktree deletion for that session

### Requirement 3: Event-Driven Worktree Reaping

**User Story:** As an operator, I want agent working directories to be cleaned up shortly after a session completes, so that disk space is reclaimed without manual intervention.

#### Acceptance Criteria

1. WHEN a session transitions to a Terminal_State, THE Reaper SHALL schedule a deferred deletion of the session's Worktree after the configured Grace_Period elapses
2. THE Reaper SHALL verify that the target session is still in Terminal_State before executing the deletion, to guard against race conditions with session resurrection
3. WHEN the Grace_Period timer fires, THE Reaper SHALL verify that the session is NOT in the in-memory active session registry before deleting
4. THE Reaper SHALL delete the Worktree using a recursive directory removal (`rm -rf` equivalent)
5. IF the Worktree_Path does not exist on disk at deletion time, THE Reaper SHALL log at `debug` level and skip without error
6. IF the Worktree deletion fails due to filesystem errors (permissions, device busy), THE Reaper SHALL log the error at `error` level and continue processing other sessions
7. AFTER successful Worktree deletion, THE Reaper SHALL update the session's `meta.json` to set `worktree_reaped_at` to the current Unix timestamp

### Requirement 4: Periodic Metadata Sweep

**User Story:** As an operator, I want session metadata older than the retention window to be automatically pruned, so that the sessions directory does not grow unbounded.

#### Acceptance Criteria

1. WHEN the reaper is enabled, THE Daemon SHALL start a periodic sweep timer at the configured `sweepIntervalMinutes` interval
2. ON each sweep, THE Reaper SHALL enumerate all session directories under `~/.agent-router/sessions/`
3. FOR each session directory, THE Reaper SHALL read `meta.json` and determine eligibility: status is Terminal_State AND `terminal_at` is non-null AND `(now - terminal_at)` exceeds the Retention_Window
4. THE Reaper SHALL NOT delete Session_Metadata_Dir for any session whose `session_id` is present in the daemon's in-memory active session registry
5. WHEN a session is eligible, THE Reaper SHALL delete the entire Session_Metadata_Dir recursively
6. IF `meta.json` is unreadable or unparseable for a session directory, THE Reaper SHALL log a warning and skip that directory
7. THE Reaper SHALL log a summary at `info` level after each sweep: number of sessions scanned, number pruned, bytes reclaimed (if measurable)

### Requirement 5: Periodic Worktree Sweep

**User Story:** As an operator, I want a periodic sweep to catch any worktrees that were missed by event-driven reaping (e.g., daemon restart during grace period), so that no orphaned worktrees accumulate.

#### Acceptance Criteria

1. ON each periodic sweep, THE Reaper SHALL also scan for Worktrees whose grace period has elapsed but were not reaped by the event-driven path
2. FOR each terminal session with a known `worktree_path` where `worktree_reaped_at` is null AND `terminal_at + Grace_Period < now`, THE Reaper SHALL delete the Worktree following the same safety checks as Requirement 3
3. FOR sessions without a registered `worktree_path`, THE Reaper SHALL attempt the discovery heuristic described in Requirement 2.3–2.4
4. THE Reaper SHALL NOT delete any directory that is not under the configured `agentRunsDir` path (path-prefix safety check)

### Requirement 6: Safety Invariants

**User Story:** As an operator, I want absolute guarantees that the reaper will never delete artifacts belonging to active sessions, so that running agents are never disrupted.

#### Acceptance Criteria

1. THE Reaper SHALL NEVER delete a Worktree or Session_Metadata_Dir for a session whose `session_id` appears in the daemon's in-memory active session registry
2. THE Reaper SHALL NEVER delete a directory outside of the configured `agentRunsDir` or the daemon's `sessions/` root directory
3. THE Reaper SHALL perform a freshness check immediately before each deletion: re-read `meta.json` to confirm the session is still in Terminal_State
4. IF a session's status has changed to `active` between scheduling and execution of a deletion, THE Reaper SHALL abort the deletion and log at `warn` level
5. THE Reaper SHALL use the daemon's authoritative session state (in-memory registry + SQLite), NOT filesystem mtime, to determine whether a session is active
6. THE Reaper SHALL NOT follow symlinks when resolving paths for deletion

### Requirement 7: Graceful Lifecycle Management

**User Story:** As an operator, I want the reaper to start and stop cleanly with the daemon, so that shutdown is not blocked by cleanup operations.

#### Acceptance Criteria

1. WHEN the daemon starts with reaping enabled, THE Reaper SHALL initialize after the session manager is ready, and run an initial sweep immediately
2. WHEN the daemon receives a shutdown signal, THE Reaper SHALL cancel all pending grace-period timers and stop the periodic sweep timer
3. THE Reaper SHALL NOT block daemon shutdown; any in-progress deletion SHALL be allowed to complete but no new deletions SHALL be initiated after shutdown begins
4. WHEN the reaper is disabled via config, THE Daemon SHALL not instantiate the reaper module and no cleanup code SHALL run

### Requirement 8: Observability

**User Story:** As an operator, I want to observe what the reaper is doing via structured logs, so that I can audit deletions and diagnose issues.

#### Acceptance Criteria

1. WHEN the reaper deletes a Worktree, THE Reaper SHALL log at `info` level with fields: `sessionId`, `path`, `size_bytes` (if measurable without traversal), `age_hours`
2. WHEN the reaper deletes a Session_Metadata_Dir, THE Reaper SHALL log at `info` level with fields: `sessionId`, `age_days`
3. WHEN the reaper skips a session (active, missing path, discovery ambiguity), THE Reaper SHALL log at `debug` level with the skip reason
4. THE Reaper SHALL emit a `reaper_sweep` stream entry to the daemon's own log after each sweep with counts: `worktrees_reaped`, `metadata_pruned`, `skipped`, `errors`

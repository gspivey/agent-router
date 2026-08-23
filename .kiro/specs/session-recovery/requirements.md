# Requirements Document: Session Recovery

## Introduction

Session Recovery is an automatic startup-time mechanism in the Agent Router daemon that restores in-flight sessions after a daemon restart. When the daemon exits (planned restart, crash, deploy), active Kiro agent sessions are orphaned — the subprocess is gone but on-disk state (`meta.json` with `status: active`, registered PRs in SQLite, stream logs) remains intact. Without recovery, subsequent CI webhooks for those PRs route to nothing and the PR stalls until the cron circuit breaker fires a new session.

Session Recovery scans for sessions with `status: active` on startup, spawns a fresh `kiro-cli acp` subprocess for each, resumes the Kiro session via `session/load` using the persisted `kiro_session_id`, and re-registers the session in the in-memory registry so webhook routing resumes immediately.

## Glossary

- **Active_Session**: A session whose `meta.json` has `status: active` — it was in-flight when the daemon last exited
- **Kiro_Session_ID**: The ACP-level session identifier (`kiro_session_id` in `meta.json`) returned by `session/new` during original session creation; required for `session/load` resume
- **Session_Load**: The ACP JSON-RPC method `session/load` that re-attaches a Kiro agent process to a previously created session by its ID
- **Terminated_By_Restart**: The `termination_reason` value applied to sessions that cannot be resumed (missing kiro_session_id or load failure)
- **Resume_Result**: The aggregate outcome of the recovery pass — counts of successfully resumed and terminated sessions

## Requirements

### Requirement 1: Automatic Recovery on Startup

**User Story:** As an operator, I want sessions that were active before a daemon restart to automatically resume when the daemon comes back up, so that in-flight PRs continue being serviced without manual intervention.

#### Acceptance Criteria

1. WHEN the daemon starts and the session manager is initialized, THE Daemon SHALL invoke the session recovery procedure exactly once before accepting webhooks or starting cron jobs
2. THE Recovery Procedure SHALL scan all session directories via `sessionFiles.listSessions()` and identify sessions with `status: active`
3. FOR each active session with a valid `kiro_session_id`, THE Recovery Procedure SHALL spawn a fresh ACP subprocess via the configured `acpSpawner`, call `acp.initialize()`, then call `acp.loadSession(kiroSessionId)` to resume the agent's context
4. WHEN `session/load` succeeds, THE Recovery Procedure SHALL register the session in the in-memory registry with a fully-wired handle (event queue, turn queue, notification consumer, subprocess exit monitor, inactivity timer, lifetime timer)
5. THE Recovery Procedure SHALL log each successful resumption at INFO level with the session ID and kiro_session_id

### Requirement 2: Graceful Failure Handling

**User Story:** As an operator, I want sessions that cannot be resumed to be cleanly abandoned so that the cron circuit breaker can refire a new session for the affected PR.

#### Acceptance Criteria

1. WHEN a session has no `kiro_session_id` (undefined or empty string), THE Recovery Procedure SHALL skip the spawn attempt and immediately mark the session as abandoned
2. WHEN `acp.initialize()` or `acp.loadSession()` throws an error (Kiro rejects the session ID, subprocess exits immediately, protocol error), THE Recovery Procedure SHALL catch the error and mark the session as abandoned
3. WHEN marking a session abandoned, THE Recovery Procedure SHALL write a `session_ended` stream entry with `reason: terminated_by_restart`, update `meta.json` with `status: abandoned`, `completed_at`, and `termination_reason: terminated_by_restart`, and set `terminal_at` for the reaper
4. THE Recovery Procedure SHALL log each failed resumption at WARN level with the session ID and the error message
5. THE Recovery Procedure SHALL continue processing remaining active sessions after any individual failure — one session's failure MUST NOT prevent recovery of other sessions

### Requirement 3: Webhook Routing Continuity

**User Story:** As an operator, I want webhooks received after a restart to route to the recovered session, so that CI results and review comments reach the agent without interruption.

#### Acceptance Criteria

1. THE SQLite `sessions` table (which maps `(repo, pr_number)` → `session_id`) SHALL persist across restarts, providing the routing lookup for webhook events
2. WHEN a session is successfully resumed, THE Wake Policy SHALL find the session via the existing `sessions` table row and the session manager SHALL return the active handle from the in-memory registry
3. THE Daemon SHALL NOT accept or process webhook events until the recovery procedure completes, ensuring no race between incoming events and partially-restored session state

### Requirement 4: Timer Reset Behavior

**User Story:** As an operator, I want recovered sessions to have fresh timeout windows so that sessions are not immediately killed after resumption due to elapsed time during the restart.

#### Acceptance Criteria

1. WHEN a session is successfully resumed, THE Session Manager SHALL start a fresh inactivity timer from zero (the configured `inactivityMinutes` value)
2. WHEN a session is successfully resumed, THE Session Manager SHALL start a fresh max-lifetime timer from zero (the configured `maxLifetimeMinutes` value)
3. THE original `created_at` timestamp in `meta.json` SHALL NOT be modified — it reflects the true session creation time for diagnostics

### Requirement 5: No Regression on Clean Startup

**User Story:** As an operator, I want the daemon to complete startup with no added latency observable at the INFO log level when there are no sessions with `status: active` on disk, so that the recovery path is zero-cost in the common case.

#### Acceptance Criteria

1. WHEN no sessions have `status: active`, THE Recovery Procedure SHALL return immediately with `{ resumed: 0, terminated: 0 }` and log nothing beyond the standard startup sequence
2. THE Recovery Procedure SHALL NOT throw or cause a `FatalError` when the sessions directory is empty or does not exist
3. THE overall startup time SHALL add ≤50 ms latency when zero sessions require recovery

### Requirement 6: Observability

**User Story:** As an operator, I want to see the recovery outcome in the daemon logs so that I can confirm sessions were properly restored after a deploy.

#### Acceptance Criteria

1. WHEN at least one session was resumed or terminated, THE Daemon SHALL log a summary at INFO level with the counts: `{ resumed: <n>, terminated: <n> }`
2. EACH individual session recovery attempt SHALL produce exactly one log entry: INFO on success, WARN on failure
3. THE stream.log of a recovered session SHALL NOT contain a synthetic `session_started` entry for the recovery — the original `session_started` from initial creation remains the first entry

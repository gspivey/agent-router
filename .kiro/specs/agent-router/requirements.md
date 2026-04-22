# Requirements Document

## Introduction

Agent Router is a single-user daemon that replaces Anthropic Routines for local async AI development. It listens for GitHub webhooks and cron triggers, decides whether to wake an ACP-compatible coding agent (Kiro CLI), and drives the agent over stdio. It runs on the developer's own machine behind a cloudflared tunnel. This is a TypeScript MVP proof of concept; once validated, it will be rewritten in Rust.

## Glossary

- **Daemon**: The long-running Agent Router process that listens for webhooks and cron triggers
- **Webhook**: An HTTP POST request sent by GitHub to the Daemon when a repository event occurs
- **Wake**: The act of spawning a Kiro CLI subprocess and sending it a prompt derived from an event
- **Session**: A mapping between a GitHub PR number and an ACP agent session identifier, stored in SQLite
- **ACP**: Agent Client Protocol — a JSON-RPC-over-stdio protocol for communicating with coding agents
- **Kiro_CLI**: The command-line coding agent spawned by the Daemon via ACP
- **Router**: The decision logic that determines whether an incoming event should trigger a Wake
- **Config_File**: A JSON file at `./config.json` containing all Daemon configuration
- **Roadmap_File**: A markdown file containing a task list, referenced by cron jobs
- **Rate_Limit**: A per-PR cooldown of 60 seconds between consecutive Wakes
- **Command_Trigger**: The literal string `/agent` appearing as the first token in an issue comment body, followed by whitespace or end-of-string
- **HMAC_Signature**: The `X-Hub-Signature-256` header value GitHub attaches to webhook payloads, computed using HMAC-SHA256 with a shared secret
- **Event_Log**: The `events` table in SQLite that records every received webhook payload and its processing status
- **Sessions_Table**: The `sessions` table in SQLite that maps (repo, pr_number) to an ACP session ID
- **Event_Queue**: A single in-memory FIFO queue of pending events awaiting processing by the worker
- **Stream_File**: The `stream.log` file in a session directory, containing newline-delimited JSON Stream_Entries written by the Daemon
- **Stream_Entry**: A single-line JSON object representing one router or agent event, as specified in Requirement 19
- **Prompt_Entry**: A single-line JSON object representing one prompt injected into a session, written to `prompts.log`
- **Meta_File**: The `meta.json` file in a session directory, containing session state as specified in Requirement 20
- **SessionMeta**: The JSON structure stored in a Meta_File
- **Test_Harness**: The collection of test infrastructure under `test/harness/` that allows the daemon to be exercised against either fake or real external systems via a common backend interface
- **GitHubBackend**: An interface defining the operations the Test_Harness needs from a GitHub-like system; implemented by both FakeGitHubBackend and RealGitHubBackend
- **KiroBackend**: An interface defining how the Test_Harness spawns and observes an ACP-compatible agent; implemented by both FakeKiroBackend and RealKiroBackend
- **Local_Git_Fixture**: A bare git repository at `test/fixtures/repos/integration-test-repo.git` that backs the FakeGitHubBackend
- **Tier_1_Test**: A unit or property test that exercises a single module in isolation
- **Tier_2_Test**: A "mocked integration" test that exercises the full daemon against fake backends
- **Tier_3_Test**: A "real integration" test that exercises the full daemon against real GitHub and real Kiro
- **Scenario_Script**: A declarative specification of how FakeKiroBackend should behave in response to ACP messages during a test

## Requirements

### Requirement 1: HTTP Server Initialization

**User Story:** As a developer, I want the Daemon to start an HTTP server on a configured port, so that GitHub webhooks can reach my machine through a cloudflared tunnel.

#### Acceptance Criteria

1. WHEN the Daemon starts, THE Daemon SHALL read the Config_File from `./config.json` and bind an HTTP server to the port specified in the `port` field
2. WHEN the Config_File contains values prefixed with `ENV:`, THE Daemon SHALL resolve those values from the corresponding environment variables
3. IF the Config_File is missing or contains invalid JSON, THEN THE Daemon SHALL log a descriptive error message and exit with a non-zero exit code
4. IF a required environment variable referenced by an `ENV:` prefix is not set, THEN THE Daemon SHALL log the missing variable name and exit with a non-zero exit code

### Requirement 2: Webhook Endpoint Routing

**User Story:** As a developer, I want the Daemon to expose a single webhook endpoint at a well-known path, so that GitHub can deliver events and all other requests are rejected.

#### Acceptance Criteria

1. THE Daemon SHALL register a single HTTP POST handler at the path `/webhook`
2. WHEN an HTTP request arrives at any path other than `/webhook`, THE Daemon SHALL respond with HTTP 404 and take no further action
3. WHEN a non-POST HTTP request arrives at the path `/webhook`, THE Daemon SHALL respond with HTTP 405 and include an `Allow: POST` header
4. WHEN an HTTP POST request arrives at `/webhook`, THE Daemon SHALL determine the event type from the `X-GitHub-Event` header

### Requirement 3: Webhook Signature Verification

**User Story:** As a developer, I want the Daemon to verify GitHub webhook signatures, so that only authentic GitHub payloads are processed.

#### Acceptance Criteria

1. WHEN an HTTP POST request arrives at the webhook endpoint, THE Daemon SHALL extract the `X-Hub-Signature-256` header and verify the request body against the configured `webhookSecret` using HMAC-SHA256
2. IF the `X-Hub-Signature-256` header is missing, THEN THE Daemon SHALL respond with HTTP 401 and discard the request
3. IF the HMAC_Signature verification fails, THEN THE Daemon SHALL respond with HTTP 401 and discard the request
4. WHEN the HMAC_Signature verification succeeds, THE Daemon SHALL insert the event into the Event_Log synchronously, respond with HTTP 200, and enqueue the event onto the Event_Queue for asynchronous processing
5. THE Daemon SHALL complete the HTTP response within 5 seconds of receiving the request
6. THE Daemon SHALL NOT block the HTTP response on agent subprocess operations or downstream event processing

### Requirement 4: Event Logging

**User Story:** As a developer, I want every incoming webhook to be recorded in SQLite, so that I can audit and debug agent behavior.

#### Acceptance Criteria

1. WHEN a webhook passes signature verification, THE Daemon SHALL insert a row into the Event_Log with the repo name, PR number (if present), event type, raw JSON payload, and the current Unix timestamp as `received_at`
2. THE Daemon SHALL store the raw JSON payload without modification in the `payload` column of the Event_Log
3. WHEN event processing completes, THE Daemon SHALL update the Event_Log row by setting `processed_at` to the current Unix timestamp and `wake_triggered` to 1 if a Wake occurred or 0 if not

### Requirement 5: Event Processing Model

**User Story:** As a developer, I want events to be processed sequentially from a FIFO queue, so that the Daemon handles events in order without concurrency issues.

#### Acceptance Criteria

1. THE Daemon SHALL maintain a single in-memory FIFO Event_Queue of pending events
2. THE Daemon SHALL run a single worker that dequeues and processes events sequentially from the Event_Queue
3. WHEN the Daemon starts, THE Daemon SHALL query the Event_Log for events where `processed_at` is NULL and `received_at` is older than 5 minutes, and mark each as processed with `wake_triggered` set to 0
4. WHILE the worker is busy processing an event, new events SHALL accumulate on the Event_Queue without blocking the HTTP response

### Requirement 6: Wake Policy — Event Type Filtering

**User Story:** As a developer, I want the Router to ignore irrelevant GitHub events, so that agents are only woken for actionable situations.

#### Acceptance Criteria

1. WHEN a `check_run` event arrives with `action` equal to `completed` and `conclusion` equal to `failure`, THE Router SHALL classify the event as wakeable
2. WHEN a `pull_request_review_comment` event arrives with `action` equal to `created`, THE Router SHALL classify the event as wakeable
3. WHEN an `issue_comment` event arrives with `action` equal to `created` and the comment body matches the Command_Trigger regex `^/agent(\s|$)`, THE Router SHALL classify the event as wakeable
4. WHEN an event does not match any of the three wakeable patterns, THE Router SHALL mark the event as processed in the Event_Log with `wake_triggered` set to 0 and take no further action

### Requirement 7: PR Number Resolution

**User Story:** As a developer, I want the Router to extract the correct PR number from each event type, so that events are associated with the right session.

#### Acceptance Criteria

1. WHEN a `pull_request_review_comment` event is received, THE Router SHALL extract the PR number from the `pull_request.number` field of the payload
2. WHEN an `issue_comment` event is received, THE Router SHALL verify that the `issue.pull_request` field is present in the payload; IF the field is absent, THEN THE Router SHALL log a message indicating the comment is not on a pull request, mark the event as processed with `wake_triggered` set to 0, and take no further action
3. WHEN an `issue_comment` event has the `issue.pull_request` field present, THE Router SHALL extract the PR number from the `issue.number` field of the payload
4. WHEN a `check_run` event is received, THE Router SHALL extract the PR number from the first entry of the `check_run.pull_requests` array
5. IF the `check_run.pull_requests` array is empty, THEN THE Router SHALL log a message indicating no associated pull request, mark the event as processed with `wake_triggered` set to 0, and take no further action
6. THE Router SHALL populate the `pr_number` column in the Event_Log from the resolved PR number, or set it to NULL if PR number resolution fails

### Requirement 8: Wake Policy — Session Lookup

**User Story:** As a developer, I want the Router to only wake agents for PRs that have a registered session, so that the Daemon does not attempt to create sessions on its own.

#### Acceptance Criteria

1. WHEN a wakeable event is received, THE Router SHALL query the Sessions_Table for a row matching the event's repo and PR number
2. IF no session row exists for the event's repo and PR number, THEN THE Router SHALL log a message indicating no session is registered, mark the event as processed with `wake_triggered` set to 0, and take no further action
3. WHEN a session row exists, THE Router SHALL use the stored `session_id` to load the agent session during the Wake

### Requirement 9: Wake Policy — Rate Limiting

**User Story:** As a developer, I want a per-PR rate limit on agent wakes, so that a flood of events does not spawn excessive agent processes.

#### Acceptance Criteria

1. WHEN a wakeable event has a matching session, THE Router SHALL check the `last_waked_at` timestamp in the Sessions_Table for that repo and PR number
2. IF the difference between the current Unix timestamp and `last_waked_at` is less than the configured `rateLimit.perPRSeconds` value, THEN THE Router SHALL log a rate-limit message, mark the event as processed with `wake_triggered` set to 0, and take no further action
3. IF `last_waked_at` is NULL or the difference is greater than or equal to `rateLimit.perPRSeconds`, THEN THE Router SHALL proceed with the Wake
4. WHEN a Wake is triggered, THE Router SHALL update `last_waked_at` in the Sessions_Table to the current Unix timestamp

### Requirement 10: ACP Agent Wake

**User Story:** As a developer, I want the Daemon to spawn Kiro CLI via ACP and send it a prompt derived from the event, so that the agent can act on the GitHub event.

#### Acceptance Criteria

1. WHEN a Wake is triggered, THE Daemon SHALL spawn a Kiro_CLI subprocess using the path from `kiroPath` in the Config_File with arguments `['acp']` and stdio configured as `['pipe', 'pipe', 'inherit']`
2. WHEN the Kiro_CLI subprocess is spawned, THE Daemon SHALL send an ACP `initialize` request over stdin declaring client capabilities `fs.readTextFile`, `fs.writeTextFile`, and `terminal`, with protocol version `1`, and wait for the initialize response on stdout
3. IF the Kiro_CLI subprocess does not respond to the `initialize` request within 30 seconds, THEN THE Daemon SHALL send SIGTERM to the subprocess, wait 5 seconds, send SIGKILL if the subprocess has not exited, log the timeout, and mark the event as processed with `wake_triggered` set to 1
4. IF the initialize response indicates a protocol version mismatch, THEN THE Daemon SHALL close the subprocess stdin pipe, wait for the subprocess to exit, log the mismatch, and mark the event as processed with `wake_triggered` set to 0
5. WHEN the Daemon receives a `session/request_permission` notification from the Kiro_CLI subprocess, THE Daemon SHALL automatically approve the request
6. WHEN the ACP initialize handshake completes, THE Daemon SHALL send a `session/load` request with the `session_id` from the Sessions_Table
7. WHEN the session is loaded, THE Daemon SHALL send a `session/prompt` request containing a prompt composed from the event payload
8. WHILE the Kiro_CLI subprocess is running, THE Daemon SHALL read `session/notification` messages from stdout, translate each notification into a Stream_Entry, and append it to the session's Stream_File as specified in Requirement 18
9. WHEN the session prompt completes, THE Daemon SHALL close the stdin pipe and wait for the subprocess to exit
10. IF the Kiro_CLI subprocess fails to spawn, THEN THE Daemon SHALL log the spawn error and mark the event as processed with `wake_triggered` set to 1
11. IF the Kiro_CLI subprocess exits with a non-zero code, THEN THE Daemon SHALL log the exit code and mark the event as processed with `wake_triggered` set to 1
12. THE Daemon SHALL enforce a maximum wake duration of 10 minutes; WHEN the duration is exceeded, THE Daemon SHALL send SIGTERM to the Kiro_CLI subprocess, wait 5 seconds, and send SIGKILL if the subprocess has not exited
13. WHEN the Daemon spawns a Kiro_CLI subprocess, THE Daemon SHALL capture the subprocess's stderr and append each line to the session's Stream_File with source: "agent" and type: "stderr"
14. THE Daemon SHALL NOT stream agent output to the terminal of the CLI invocation; CLI clients SHALL read the Stream_File independently as specified in Requirement 21

### Requirement 11: Prompt Composition

**User Story:** As a developer, I want the Daemon to compose meaningful prompts from event payloads, so that the agent has enough context to act.

#### Acceptance Criteria

1. WHEN composing a prompt for a `check_run` failure event, THE Daemon SHALL include the check run name, the repository full name, the PR number, and the check run output summary in the prompt text
2. WHEN composing a prompt for a `pull_request_review_comment` event, THE Daemon SHALL include the comment body, the file path, the diff hunk, the repository full name, and the PR number in the prompt text
3. WHEN composing a prompt for an `issue_comment` Command_Trigger event, THE Daemon SHALL include the comment body with the `/agent` token stripped, the repository full name, and the PR number in the prompt text
4. WHEN composing a prompt for a cron-triggered roadmap task, THE Daemon SHALL include the task text, the repository full name, and the roadmap file path in the prompt text

### Requirement 12: SQLite Database Initialization

**User Story:** As a developer, I want the Daemon to automatically create the SQLite schema on startup, so that I do not need to run manual migration scripts.

#### Acceptance Criteria

1. WHEN the Daemon starts, THE Daemon SHALL open or create a SQLite database file at a path derived from the working directory
2. WHEN the database is opened, THE Daemon SHALL execute the DDL statements to create the `sessions` table, the `events` table, and the associated indexes using `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
3. THE Daemon SHALL use WAL journal mode for the SQLite database to allow concurrent reads during writes

### Requirement 13: Cron Scheduled Triggers

**User Story:** As a developer, I want the Daemon to run cron-scheduled tasks that pick work from a roadmap file, so that agents can make progress on planned work without manual intervention.

#### Acceptance Criteria

1. WHEN the Daemon starts, THE Daemon SHALL register a cron job for each entry in the `cron` array of the Config_File using the specified `schedule` expression
2. WHEN a cron job fires, THE Daemon SHALL read the Roadmap_File specified in the matching repo configuration
3. WHEN the Roadmap_File is read, THE Daemon SHALL parse the markdown content and identify the first unchecked task item matching the pattern `- [ ]` or `* [ ]`
4. IF no unchecked task is found in the Roadmap_File, THEN THE Daemon SHALL log a message indicating all tasks are complete and take no further action
5. WHEN an unchecked task is found, THE Daemon SHALL compose a prompt from the task text and trigger a Wake for the configured repo

### Requirement 14: Roadmap File Parsing

**User Story:** As a developer, I want the Daemon to parse markdown task lists from a roadmap file, so that cron jobs can identify the next piece of work.

#### Acceptance Criteria

1. WHEN the Daemon reads a Roadmap_File, THE Daemon SHALL parse each line and identify task items matching the regex pattern `^[\-\*]\s+\[\s\]` as unchecked tasks
2. WHEN the Daemon reads a Roadmap_File, THE Daemon SHALL identify task items matching the regex pattern `^[\-\*]\s+\[x\]` (case-insensitive) as checked tasks
3. THE Daemon SHALL return the first unchecked task item's text content (excluding the checkbox marker) as the next task
4. IF the Roadmap_File does not exist or is unreadable, THEN THE Daemon SHALL log a descriptive error and skip the cron trigger
5. FOR ALL Roadmap_File content, parsing the task list and reconstructing the markdown from the parsed structure SHALL produce equivalent task items (round-trip property)

### Requirement 15: Configuration Validation

**User Story:** As a developer, I want the Daemon to validate the Config_File on startup, so that misconfiguration is caught early rather than at runtime.

#### Acceptance Criteria

1. WHEN the Daemon reads the Config_File, THE Daemon SHALL validate that `port` is a positive integer between 1 and 65535
2. WHEN the Daemon reads the Config_File, THE Daemon SHALL validate that `webhookSecret` is a non-empty string or a valid `ENV:` reference
3. WHEN the Daemon reads the Config_File, THE Daemon SHALL validate that each entry in the `repos` array contains non-empty `owner` and `name` fields
4. WHEN the Daemon reads the Config_File, THE Daemon SHALL validate that each entry in the `cron` array contains a non-empty `name`, a valid cron `schedule` expression, and a `repo` value matching an entry in the `repos` array
5. WHEN the Daemon reads the Config_File, THE Daemon SHALL validate that `kiroPath` points to an executable file on disk
6. IF any validation check fails, THEN THE Daemon SHALL log a descriptive error identifying the invalid field and exit with a non-zero exit code

### Requirement 16: Graceful Shutdown

**User Story:** As a developer, I want the Daemon to shut down gracefully, so that in-flight events complete and the database is left in a consistent state.

#### Acceptance Criteria

1. WHEN the Daemon receives a SIGTERM or SIGINT signal, THE Daemon SHALL stop accepting new HTTP requests
2. WHILE an event is being processed at the time of shutdown, THE Daemon SHALL wait up to 30 seconds for the in-flight event to complete
3. IF the 30-second shutdown timeout is exceeded, THEN THE Daemon SHALL send SIGTERM to the active Kiro_CLI subprocess, wait 5 seconds, and send SIGKILL if the subprocess has not exited
4. WHEN the Daemon is shutting down, THE Daemon SHALL perform a WAL checkpoint on the SQLite database before exiting
5. IF the Daemon receives a second SIGTERM or SIGINT signal during the shutdown grace period, THEN THE Daemon SHALL immediately send SIGKILL to any active subprocess and exit with code 130
6. WHEN the Daemon shuts down, THE Daemon SHALL close the Unix domain socket listener before terminating sessions
7. WHEN the Daemon shuts down with active sessions, THE Daemon SHALL update each active session's `meta.json` to `status: "abandoned"` before the process exits

### Requirement 17: Logging

**User Story:** As a developer, I want structured JSON logs written to stdout, so that I can monitor and debug the Daemon using standard log tooling.

#### Acceptance Criteria

1. THE Daemon SHALL write all log output as newline-delimited JSON to stdout
2. THE Daemon SHALL include the fields `timestamp` (ISO 8601 UTC), `level`, `message`, and any additional structured fields in each log entry
3. WHEN logging a webhook-related event, THE Daemon SHALL include `repo`, `pr_number`, `event_type`, and `event_id` as structured fields
4. WHEN logging a wake-related event, THE Daemon SHALL include `session_id`, `repo`, `pr_number`, and `duration_ms` as structured fields
5. THE Daemon SHALL NOT include secrets, tokens, or credentials in any log entry
6. THE Daemon SHALL read the `LOG_LEVEL` environment variable on startup and filter log output to the specified level; supported levels are `debug`, `info`, `warn`, and `error`, with `info` as the default

### Requirement 18: Filesystem Layout

**User Story:** As a developer, I want session output written to a predictable directory structure, so that I can tail files, grep history, and attach multiple terminals to running sessions.

#### Acceptance Criteria

1. THE Daemon SHALL maintain a root directory at `$AGENT_ROUTER_HOME` or, if unset, at `$HOME/.agent-router`
2. WHEN the Daemon starts, THE Daemon SHALL create the root directory, a `sessions` subdirectory, and a `daemon.log` file if they do not exist
3. WHEN a new session is created, THE Daemon SHALL create a directory at `<root>/sessions/<session_id>/` containing files `meta.json`, `stream.log`, and `prompts.log`
4. THE Daemon SHALL write the Stream_File as newline-delimited JSON, one Stream_Entry per line
5. THE Daemon SHALL append to `stream.log` and `prompts.log` without ever truncating or rewriting their contents
6. THE Daemon SHALL flush each write to `stream.log` and `prompts.log` before returning control from the write call, so that tailers observe output without buffering delay
7. THE Daemon SHALL write `meta.json` atomically using a temp-file-plus-rename pattern so that readers never observe partial content
8. IF the session directory cannot be created due to filesystem permissions or disk space, THEN THE Daemon SHALL refuse to start the session, return an error to the caller, and log the failure to `daemon.log`

### Requirement 19: Stream Entry Format

**User Story:** As a developer, I want a structured, machine-readable stream format, so that I can grep, filter, and pretty-print session activity programmatically.

#### Acceptance Criteria

1. EACH Stream_Entry SHALL be a single-line JSON object with no embedded newlines in string values
2. EACH Stream_Entry SHALL include fields `ts` (ISO 8601 UTC timestamp), `source` (one of `router`, `agent`), and `type` (a short string identifying the entry kind)
3. Router-origin Stream_Entries SHALL use types from the set `session_started`, `session_ended`, `webhook_received`, `event_routed`, `event_dropped`, `prompt_injected`, `pr_registered`, `mcp_call`
4. Agent-origin Stream_Entries SHALL use types from the set `message`, `tool_call`, `tool_result`, `stderr`, `session_update`
5. Stream_Entry objects MAY include additional type-specific fields (e.g., `tool_call` entries include `tool` and `args`; `webhook_received` entries include `event_type`, `pr_number`, `event_id`)
6. THE Daemon SHALL NOT include webhook secrets, GitHub tokens, or raw webhook payloads in Stream_Entries; only metadata sufficient for debugging SHALL be logged
7. THE Daemon SHALL append Prompt_Entries to `prompts.log` whenever a prompt is sent to the agent, with fields `ts`, `source` (one of `cli`, `webhook`, `cron`, `mcp`), and `prompt` (the full prompt text)

### Requirement 20: Session Metadata File

**User Story:** As a developer, I want a single queryable source of session state, so that I can list running sessions, see associated PRs, and inspect session status without reading the full stream.

#### Acceptance Criteria

1. THE Daemon SHALL write `meta.json` containing fields `session_id` (string), `original_prompt` (string), `status` (one of `active`, `completed`, `abandoned`, `failed`), `created_at` (Unix timestamp), `completed_at` (Unix timestamp or null), and `prs` (array of `{repo, pr_number, registered_at}` objects)
2. WHEN a session is created, THE Daemon SHALL write `meta.json` with `status: "active"`, an empty `prs` array, and `completed_at: null`
3. WHEN a PR is registered to a session via MCP, THE Daemon SHALL update `meta.json` atomically to append the new PR entry
4. WHEN a session completes normally (agent exits with code 0 after acknowledging completion), THE Daemon SHALL update `meta.json` with `status: "completed"` and the current timestamp in `completed_at`
5. WHEN a session fails (agent crashes, protocol error, timeout), THE Daemon SHALL update `meta.json` with `status: "failed"` and the current timestamp in `completed_at`
6. WHEN a session is explicitly terminated via CLI, THE Daemon SHALL update `meta.json` with `status: "abandoned"` and the current timestamp in `completed_at`
7. THE Daemon SHALL NOT modify `meta.json` for sessions with a non-active status

### Requirement 21: CLI-to-Daemon IPC and Tailing

**User Story:** As a developer, I want a local CLI that can start sessions, list sessions, and tail their output independently, so that I can manage multiple concurrent sessions across terminals.

#### Acceptance Criteria

1. THE Daemon SHALL expose a Unix domain socket at `<root>/sock` for CLI communication
2. THE Daemon SHALL accept socket messages as newline-delimited JSON with an `op` field and op-specific parameters
3. WHEN the CLI sends `{"op": "new_session", "prompt": "..."}`, THE Daemon SHALL create a new session and return `{"session_id": "...", "stream_path": "...", "prompts_path": "..."}`
4. WHEN the CLI sends `{"op": "list_sessions"}`, THE Daemon SHALL return `{"sessions": [SessionMeta, ...]}` with the contents of all `meta.json` files, sorted by `created_at` descending
5. WHEN the CLI sends `{"op": "terminate_session", "session_id": "..."}`, THE Daemon SHALL send SIGTERM to the session's agent subprocess, wait up to 5 seconds, SIGKILL if needed, update `meta.json` to `status: "abandoned"`, and return `{"ok": true}`
6. THE CLI SHALL support a `prompt --new` subcommand that reads from stdin or an optional `--file <path>` argument and sends a `new_session` op
7. THE CLI SHALL support a `prompt --session-id <id>` subcommand that sends additional prompt text to an existing active session via a new op `inject_prompt`
8. THE CLI SHALL support a `tail <session_id>` subcommand that reads the session's `stream.log` with follow semantics and pretty-prints each Stream_Entry to the terminal
9. THE CLI SHALL support a `tail <session_id> --raw` flag that outputs the raw NDJSON without pretty-printing
10. THE CLI SHALL support a `tail <session_id> --prompts` flag that tails `prompts.log` instead of `stream.log`
11. THE CLI SHALL support an `ls` subcommand that displays session ID, status, age, registered PRs, and a truncated prompt preview in a human-readable table
12. THE CLI SHALL support a `prompt --new --quiet` flag that creates the session, prints the `session_id` to stdout, and exits without tailing
13. WHEN the CLI is tailing a session and receives SIGINT (Ctrl-C), THE CLI SHALL stop tailing and exit with code 0; the underlying session SHALL continue running

### Requirement 22: Backend Interface Abstraction

**User Story:** As a developer, I want a single interface for each external system (GitHub, Kiro) that fake and real implementations both satisfy, so that the same test assertions can run against either backend.

#### Acceptance Criteria

1. THE Test_Harness SHALL define a GitHubBackend interface covering webhook dispatch, PR state queries, comment retrieval, and API call recording; both FakeGitHubBackend and RealGitHubBackend SHALL implement this interface with identical method signatures
2. THE Test_Harness SHALL define a KiroBackend interface covering agent process spawn parameters, scenario loading (fake-only, no-op for real), and action observation; both FakeKiroBackend and RealKiroBackend SHALL implement this interface with identical method signatures
3. THE Daemon under test SHALL NOT be aware of which backend implementation is in use; backend selection SHALL happen entirely in test setup
4. WHEN a test is tagged [fake], the Test_Harness SHALL instantiate FakeGitHubBackend and FakeKiroBackend
5. WHEN a test is tagged [integration], the Test_Harness SHALL instantiate RealGitHubBackend and RealKiroBackend
6. IF a test requires specific backend behavior that only one implementation can provide, the test SHALL be tagged with exactly one of [fake] or [integration]

### Requirement 23: Local Git Fixture Repository

**User Story:** As a developer, I want the fake GitHub backend to be fronted by a real local git repository, so that git operations are tested against real git behavior without network access.

#### Acceptance Criteria

1. THE Test_Harness SHALL maintain a bare git repository at `test/fixtures/repos/integration-test-repo.git`
2. THE Test_Harness SHALL provide a setup script that deletes and recreates the Local_Git_Fixture with a seeded initial commit containing at minimum a README.md, a trivial source file, and a trivial test file
3. WHEN a test suite begins, THE Test_Harness SHALL invoke the setup script to guarantee a fresh Local_Git_Fixture
4. THE FakeGitHubBackend SHALL perform all git operations against the Local_Git_Fixture as real git commands, not as in-memory simulations
5. THE FakeGitHubBackend SHALL maintain in-memory state only for GitHub-product-layer concepts that do not exist in bare git: pull request records, comment threads, check run history, review state, webhook delivery history, installation identity
6. THE FakeGitHubBackend SHALL expose the Local_Git_Fixture path to the Daemon so that git clone operations performed by the agent succeed against `file://` URLs

### Requirement 24: Three-Tier Test Execution

**User Story:** As a developer, I want distinct test invocations for each tier of testing, so that the fast dev loop, the thorough pre-commit check, and the slow real-service validation can be run independently.

#### Acceptance Criteria

1. THE Test_Harness SHALL support Tier_1, Tier_2, and Tier_3 test categorization via test tags or suite separation
2. THE project SHALL expose an `npm test` script that runs Tier_1 and Tier_2 tests only, completing in under 60 seconds
3. THE project SHALL expose an `npm run test:watch` script that runs Tier_1 tests only with file watching
4. THE project SHALL expose an `npm run test:integration` script that runs Tier_3 tests only
5. THE project SHALL expose an `npm run test:all` script that runs all three tiers sequentially
6. Tier_2 tests SHALL NOT require network access, real API tokens, real Kiro installation, or any environment state beyond Node.js and git
7. Tier_3 tests SHALL require `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and `KIRO_PATH` env vars; tests SHALL skip with a clear message if unset
8. THE project SHALL document Tier_3 prerequisites in the operational guide
9. Tier_2 and Tier_3 tests exercising the same behavior SHALL share assertion logic where possible

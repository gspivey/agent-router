# Requirements Document

## Introduction

This feature adds a localhost-bound HTTP control plane to the existing agent-router daemon, exposing session observability and control through both a REST API and a minimal web UI. The web server is purely additive — it wraps the existing webhook-driven session loop without modifying core daemon behavior. Read paths (session listing, detail, live stream) ship first; write paths (prompt injection, interrupt, kill) follow.

Remote access is handled externally via a reverse proxy with identity forwarding (Cloudflare Access is the reference deployment but not a hard dependency). The daemon validates forwarded identity using a shared-secret proof-of-origin mechanism, not by trusting headers at face value. JWT/cryptographic proof is a future pluggable upgrade.

## Glossary

- **Web_Server**: The HTTP server module added to the daemon, serving API endpoints and static UI assets on a configurable control port
- **Session_API**: The set of HTTP endpoints for reading and writing session data
- **SSE_Stream**: A Server-Sent Events connection delivering real-time stream.log entries to connected clients
- **Daemon_Token**: A per-daemon-lifetime bearer token stored at `$rootDir/daemon-token` with mode 0600, used for local API authentication. Already exists in the codebase.
- **Forwarded_Identity**: The identity of a remote user forwarded by a trusted reverse proxy via a configurable HTTP header (e.g., `Cf-Access-Authenticated-User-Email` for Cloudflare Access). Trusted only when accompanied by a valid shared-secret proof header.
- **Proxy_Secret**: A shared secret known to both the reverse proxy and the daemon, sent by the proxy in a configurable proof header and validated with timing-safe comparison. Stored on disk with mode 0600.
- **Bind_Address**: The network interface address the web server listens on (127.0.0.1 by default, 0.0.0.0 with explicit opt-in)
- **Session_Meta**: The `meta.json` file containing session metadata (status, timestamps, PRs, repo, termination reason)
- **Stream_Log**: The append-only NDJSON file (`stream.log`) recording all router and agent events for a session
- **Web_UI**: A single static HTML file serving a mobile-friendly interface for session observation and control
- **Actor_Log**: A record in stream.log identifying who performed a write operation (email from Forwarded_Identity or "local" for bearer-token auth)
- **Session_Status**: Closed union: `active | completed | abandoned | failed`. Terminal statuses: `completed | abandoned | failed`.
- **Termination_Reason**: Closed union: `timeout_inactivity | timeout_max_lifetime | completed | failed | terminated_cli | terminated_web | shutdown | merged | closed_without_merge`. Channel-specific reasons (`terminated_cli`, `terminated_web`) encode where the kill originated; the actor field encodes who.
- **Prompt_Source**: Closed union: `cli | webhook | cron | mcp | web`. Extended with `web` for prompts injected via the control plane.
- **Error_Envelope**: Standardized JSON error response shape: `{ error: { code: string, message: string, details?: unknown } }`. All endpoints use this shape for 4xx/5xx responses.

## Requirements

### Requirement 1: Server Binding and Startup

**User Story:** As a daemon operator, I want the web server to bind only to localhost by default, so that it is not exposed to the network without explicit intent.

#### Acceptance Criteria

1. THE Web_Server SHALL bind to 127.0.0.1 on the port specified by the `controlPort` config key (integer, 1–65535, default: 3100) at daemon startup
2. WHERE the `--bind-public` CLI flag or `bindPublic: true` config setting is provided, THE Web_Server SHALL bind to 0.0.0.0 on the configured control port; IF both the CLI flag and config setting are present, THEN the CLI flag SHALL take precedence
3. IF `controlPort` equals the existing webhook server `port`, THEN THE Web_Server SHALL throw a FatalError at startup with a message indicating the port conflict
4. IF the Web_Server fails to bind to the configured address and port, THEN THE Web_Server SHALL throw a FatalError with a message that includes the attempted address and port
5. WHEN the daemon shuts down, THE Web_Server SHALL close the HTTP listener and drain active connections within 5 seconds as a sub-step of the graceful shutdown sequence (Requirement 15)

### Requirement 2: Bearer Token Authentication

**User Story:** As a daemon operator, I want the web server to authenticate requests using the existing daemon-token mechanism, so that only authorized local processes can access the API.

#### Acceptance Criteria

1. WHEN a request includes an `Authorization: Bearer <token>` header whose `<token>` value is an exact, case-sensitive match of the current Daemon_Token, THE Session_API SHALL treat the request as authenticated with actor identity "local"
2. IF a request does not contain a valid bearer token and no valid Forwarded_Identity is present, THEN THE Session_API SHALL respond with HTTP 401 using the Error_Envelope format
3. IF the `Authorization` header is present but malformed (missing the `Bearer ` prefix, empty token value, or non-matching token), THEN THE Session_API SHALL treat it as an invalid bearer token for the purposes of authentication
4. THE Session_API SHALL use timing-safe comparison (crypto.timingSafeEqual) when validating bearer tokens to prevent timing side-channel attacks
5. WHEN the daemon restarts (generating a new Daemon_Token), existing bearer-token-authenticated connections SHALL fail with 401 on their next request — no session stickiness across daemon lifetimes

### Requirement 3: Trusted Proxy Authentication

**User Story:** As a remote user accessing via a Zero Trust reverse proxy, I want the daemon to verify my identity using a shared-secret proof mechanism, so that local processes cannot forge my identity by sending fake headers.

#### Acceptance Criteria

1. WHERE the `trustedProxy` config object is provided with `identityHeader` (string, the header name carrying the user email), `proofHeader` (string, the header name carrying the shared secret), and `proofSecret` (string, path to a file containing the secret), THE Session_API SHALL enable forwarded-identity authentication
2. WHEN a request includes both the configured identity header (non-empty, valid email format: 1–254 chars, exactly one `@` with non-empty local and domain parts) and the configured proof header whose value passes timing-safe comparison against the loaded Proxy_Secret, THE Session_API SHALL treat the request as authenticated using the identity header value as the actor identity
3. IF the proof header is missing or its value does not match the Proxy_Secret, THE Session_API SHALL NOT trust the identity header and SHALL fall back to bearer-token authentication for that request
4. IF `trustedProxy` is configured but `proofSecret` file does not exist or is not readable, THEN THE Web_Server SHALL throw a FatalError at startup indicating the missing secret file
5. IF `trustedProxy` is configured without all three required fields (`identityHeader`, `proofHeader`, `proofSecret`), THEN THE Web_Server SHALL throw a FatalError at startup indicating the incomplete configuration
6. THE Proxy_Secret file SHALL be validated at startup to have file permissions no more permissive than 0600; IF permissions are more permissive, THEN THE Web_Server SHALL log a warning but continue startup
7. IF `trustedProxy` is not configured, THEN THE Session_API SHALL require bearer-token authentication for all requests regardless of any identity-like headers present
8. IF the proof header is present and valid but the identity header is empty, missing, or does not match a valid email format, THEN THE Session_API SHALL reject the request with HTTP 401 using the Error_Envelope format with code `"invalid_identity"` — the proof validates the proxy is real, but the identity is unusable

### Requirement 4: Session Listing API

**User Story:** As an operator, I want to list all sessions with filtering, so that I can see what the daemon has been doing across all projects.

#### Acceptance Criteria

1. WHEN a GET request is made to `/sessions`, THE Session_API SHALL return an HTTP 200 response containing a JSON array of session summaries sorted by `created_at` descending
2. WHERE the `status` query parameter is provided with a valid Session_Status value (active, completed, abandoned, failed), THE Session_API SHALL filter results to sessions matching the specified status value
3. WHERE the `since` query parameter is provided as a Unix timestamp (a non-negative integer), THE Session_API SHALL filter results to sessions with `created_at` greater than or equal to the specified value
4. WHERE the `limit` query parameter is provided as a positive integer no greater than 500, THE Session_API SHALL return at most that many results; IF `limit` is not provided, THEN THE Session_API SHALL default to 50 results
5. THE Session_API SHALL include in each session summary: session_id (string), repo (string or null), status (Session_Status string), created_at (Unix timestamp integer), completed_at (Unix timestamp integer or null), termination_reason (Termination_Reason string or null), and prs (array of objects each containing repo: string, pr_number: number, registered_at: number)
6. IF the sessions directory does not exist or is empty, THEN THE Session_API SHALL return an empty JSON array with HTTP 200
7. IF a query parameter value is invalid (status not in the Session_Status union, since is not a non-negative integer, or limit is not an integer between 1 and 500), THEN THE Session_API SHALL return HTTP 400 using the Error_Envelope format indicating which parameter is invalid

### Requirement 5: Session Detail API

**User Story:** As an operator, I want to view a single session's full metadata and recent stream entries, so that I can understand what happened in a session.

#### Acceptance Criteria

1. WHEN a GET request is made to `/sessions/:id`, THE Session_API SHALL return HTTP 200 with a JSON object containing a `meta` field holding the full Session_Meta object and an `entries` field holding the stream log entries array
2. WHERE the `lines` query parameter is provided as a positive integer between 1 and 2000, THE Session_API SHALL return that many stream entries from the end of stream.log (default 200 when the parameter is omitted)
3. IF the `lines` query parameter is present but is not a positive integer or exceeds 2000, THEN THE Session_API SHALL respond with HTTP 400 using the Error_Envelope format indicating the valid range
4. IF the `:id` path parameter does not conform to UUID v4 format (the session ID format generated by the daemon), THEN THE Session_API SHALL respond with HTTP 400 using the Error_Envelope format before any filesystem access
5. IF the specified session ID does not correspond to an existing session directory, THEN THE Session_API SHALL respond with HTTP 404 using the Error_Envelope format
6. THE Session_API SHALL return stream entries as a JSON array in chronological order (oldest first), returning all available entries when stream.log contains fewer lines than requested
7. IF stream.log contains lines that are not valid JSON, THEN THE Session_API SHALL skip those lines and include a `skipped_lines` integer field in the response indicating how many malformed lines were encountered

### Requirement 6: Session Stream API (SSE)

**User Story:** As an operator, I want to watch a session's activity in real time via SSE, so that I can observe agent behavior as it happens.

#### Acceptance Criteria

1. WHEN a GET request is made to `/sessions/:id/stream`, THE SSE_Stream SHALL open a Server-Sent Events connection and emit all existing stream.log entries followed by new entries as they are appended
2. THE SSE_Stream SHALL emit each NDJSON line from stream.log as an SSE event with `event: log`, `id:` set to the line number (1-indexed, monotonically increasing), and `data:` containing the JSON line
3. THE SSE_Stream SHALL send a heartbeat comment (`:heartbeat`) every 30 seconds to keep the connection alive through proxies
4. THE SSE_Stream SHALL detect new entries by polling the file at an interval no greater than 300 milliseconds; a single timer SHALL be shared across all subscribers to the same session (not one timer per client)
5. WHEN multiple clients subscribe to the same session stream, THE SSE_Stream SHALL deliver entries independently to each client without shared cursor state
6. IF the `:id` path parameter does not conform to UUID v4 format, THEN THE SSE_Stream SHALL respond with HTTP 400 before opening the SSE connection
7. IF the specified session ID does not exist, THEN THE SSE_Stream SHALL respond with HTTP 404 before opening the SSE connection
8. WHEN a `session_ended` entry is appended to stream.log (regardless of which terminal status triggered it), THE SSE_Stream SHALL emit it as a final event with `event: session_ended` and then close the connection
9. IF the session is already in a terminal status when the client connects, THEN THE SSE_Stream SHALL emit all existing stream.log entries, emit the last entry as `event: session_ended`, and then close the connection
10. WHERE a `Last-Event-ID` request header is present and contains a valid line number, THE SSE_Stream SHALL resume emission from the line after the specified ID (supporting client reconnection without duplication)

### Requirement 7: Static Web UI Serving

**User Story:** As an operator, I want a web-based UI accessible from my phone, so that I can monitor sessions without SSH access.

#### Acceptance Criteria

1. WHEN a GET request is made to `/` or `/ui`, THE Web_Server SHALL serve the HTML page WITHOUT requiring authentication (unauthenticated endpoint)
2. WHILE the Web_Server is bound to 127.0.0.1 (loopback), THE served HTML SHALL include the current Daemon_Token embedded in a JavaScript variable, enabling the Web_UI to use it as a bearer token for same-origin API calls
3. WHILE the Web_Server is bound to 0.0.0.0 (public) OR when the request arrives with a valid proxy proof header, THE served HTML SHALL NOT embed the Daemon_Token — remote clients authenticate via Forwarded_Identity (proxy injects identity+proof on every fetch)
4. THE Web_UI SHALL display a list view showing paginated sessions (20 sessions per page) with status badges (green for active, gray for completed, yellow for abandoned, red for failed), repo name, and timestamps
5. THE Web_UI SHALL display a detail view showing session metadata (session ID, status, creation time, repo, associated PRs as deep links to GitHub, termination reason if ended) and a live-streaming log fed by an SSE connection to the session's stream endpoint
6. THE Web_UI SHALL use hash-based client-side routing to switch between the list view (`#/`) and the detail view (`#/sessions/<id>`) without requiring additional server requests for navigation
7. THE Web_UI SHALL render with a minimum tap-target size of 44×44 CSS pixels, a minimum body font size of 16px, and a single-column layout at viewport widths of 480px or below
8. THE Web_UI SHALL use vanilla JavaScript or a single framework file loaded from CDN (no build system required)
9. IF an SSE connection is lost, THEN THE Web_UI SHALL reconnect with exponential backoff starting at 1 second, doubling on each failed attempt, up to a maximum interval of 30 seconds, supplying the last received event ID for resumption
10. THE Web_UI SHALL display the authenticated identity ("logged in as <email>" or "local auth") in a header banner so the operator knows which auth path is active
11. THE Web_UI SHALL display a deep link to the associated GitHub PR in each session's detail view and list entry (when PRs are registered)

### Requirement 8: Message Injection API

**User Story:** As an operator, I want to inject a prompt into a running session via HTTP, so that I can direct agent behavior from the web UI or API.

#### Acceptance Criteria

1. WHEN a POST request is made to `/sessions/:id/inject` with a JSON body containing a `prompt` string field of 1 to 10,000 characters (after trimming leading and trailing whitespace), THE Session_API SHALL enqueue the prompt for delivery to the active session and respond immediately with HTTP 202 and a JSON body containing `{ "accepted": true }`
2. THE Session_API SHALL deliver the prompt via the session manager's per-session turn queue, which serializes all prompt delivery (from any source: webhook, web, cron) so that at most one `sendPrompt` call is in-flight per session at any time. The 202 response is returned before delivery completes.
3. IF a turn is already in-flight when the inject is received, THE turn queue SHALL hold the prompt in FIFO order and deliver it after the current turn completes — the inject still returns 202 immediately (accepted for delivery, not yet dispatched)
4. WHEN delivery succeeds, THE Session_API SHALL append a stream.log entry with `source: "router"`, `type: "prompt_injected"`, `prompt_source: "web"`, and an `actor` field containing the operator identity; the prompt SHALL also be recorded in prompts.log via `appendPrompt`
5. IF delivery fails after the 202 response (session dies mid-turn, ACP rejects the prompt, or subprocess exits), THE Session_API SHALL append a stream.log entry with `source: "router"`, `type: "prompt_injection_failed"`, `prompt_source: "web"`, `actor` field, and an `error` field describing the failure — ensuring the outcome is always observable on the SSE stream
6. IF the specified session is not in `active` status on disk (meta.json), THEN THE Session_API SHALL respond with HTTP 409 using the Error_Envelope format indicating the session is not injectable
7. IF the session is `active` on disk but has no live handle in the session registry (non-resident), THEN THE Session_API SHALL respond with HTTP 409 using the Error_Envelope format with code `"session_not_resident"` indicating the session has no live process
8. IF the `prompt` field is missing, not a string, or contains only whitespace after trimming, THEN THE Session_API SHALL respond with HTTP 400 using the Error_Envelope format
9. IF the trimmed `prompt` field exceeds 10,000 characters, THEN THE Session_API SHALL respond with HTTP 400 using the Error_Envelope format indicating the prompt exceeds the maximum allowed length
10. IF the `:id` path parameter does not conform to UUID v4 format, THEN THE Session_API SHALL respond with HTTP 400 before any filesystem access
11. IF the specified session ID does not exist, THEN THE Session_API SHALL respond with HTTP 404 using the Error_Envelope format
12. THE Session_API SHALL extend the Prompt_Source union with the value `"web"` and update all exhaustiveness checks accordingly

### Requirement 9: Session Interrupt API (Stop)

**User Story:** As an operator, I want to interrupt a running session's current turn without killing it, so that I can redirect the agent's attention.

#### Acceptance Criteria

1. WHEN a POST request is made to `/sessions/:id/interrupt`, THE Session_API SHALL send an ACP `session/cancel` notification to the active session's subprocess, causing the in-flight turn to resolve with `stopReason: "cancelled"`
2. THE session SHALL remain in `active` status after a successful interrupt — the session is not terminated
3. WHEN interrupt succeeds, THE Session_API SHALL respond with HTTP 200 and a JSON body containing `{ "ok": true }`
4. WHEN interrupt succeeds, THE Session_API SHALL append a stream.log entry with `source: "router"`, `type: "web_interrupt"`, and an `actor` field containing the operator identity
5. IF the specified session is not in `active` status, THEN THE Session_API SHALL respond with HTTP 409 using the Error_Envelope format
6. IF the session is `active` on disk but has no live handle in the session registry, THEN THE Session_API SHALL respond with HTTP 409 using the Error_Envelope format with code `"session_not_resident"`
7. IF the specified session ID does not exist, THEN THE Session_API SHALL respond with HTTP 404 using the Error_Envelope format
8. IF the `:id` path parameter does not conform to UUID v4 format, THEN THE Session_API SHALL respond with HTTP 400
9. THE ACP client interface SHALL be extended with a `cancel(): void` method (no parameters — uses the client's internal `acpSessionId`, mirroring the pattern of `sendPrompt` and `kill`) that sends a `session/cancel` JSON-RPC notification targeting the ACP session ID (no response expected). The caller routes through the in-memory session handle's ACP client instance.
10. IF the session is active but no turn is currently in-flight (idle), THE interrupt SHALL still return 200 — `session/cancel` is a no-op in this state and is not an error condition

### Requirement 10: Session Kill API

**User Story:** As an operator, I want to kill a running session via HTTP, so that I can stop a misbehaving agent from the web UI.

#### Acceptance Criteria

1. WHEN a POST request is made to `/sessions/:id/kill`, THE Session_API SHALL delegate to `terminateSession` on the session manager (which handles SIGTERM → 5s → SIGKILL, timer cleanup, and registry removal)
2. WHEN termination succeeds, THE Session_API SHALL record `termination_reason: "terminated_web"` and `status: "abandoned"` in the session's meta.json with a `completed_at` timestamp
3. WHEN termination succeeds, THE Session_API SHALL append a `session_ended` stream.log entry containing `reason: "terminated_web"` and an `actor` field with the operator identity
4. WHEN termination succeeds, THE Session_API SHALL respond with HTTP 200 and a JSON body containing `{ "ok": true }`
5. IF the specified session ID does not exist, THEN THE Session_API SHALL respond with HTTP 404 using the Error_Envelope format
6. IF the specified session exists but is not in `active` status, THEN THE Session_API SHALL respond with HTTP 409 using the Error_Envelope format including the current session status
7. IF the session is `active` on disk but has no live handle, THEN THE Session_API SHALL respond with HTTP 409 using the Error_Envelope format with code `"session_not_resident"`
8. IF the ACP subprocess does not exit within 10 seconds of the initial termination signal, THEN THE Session_API SHALL respond with HTTP 502 using the Error_Envelope format indicating the termination timed out
9. IF the `:id` path parameter does not conform to UUID v4 format, THEN THE Session_API SHALL respond with HTTP 400
10. THE Termination_Reason union SHALL be extended with `"terminated_web"` (and `"terminated_cli"` for CLI-originated kills) and all exhaustiveness checks SHALL be updated accordingly
11. THE `terminateSession` method SHALL accept an optional `termination_reason` parameter (defaulting to `"terminated_cli"`) and an optional `actor` string (defaulting to `"local"`), and all exhaustiveness checks SHALL be updated accordingly

### Requirement 11: Interactive Web UI

**User Story:** As an operator, I want to inject prompts, interrupt, and kill sessions from the web UI, so that I have full control from my phone.

#### Acceptance Criteria

1. THE Web_UI SHALL display a multi-line text input (minimum 3 visible rows) and a submit button in the session detail view for prompt injection, with the text input accepting up to 10,000 characters
2. WHEN the user submits a prompt via the Web_UI, THE Web_UI SHALL disable the submit button, POST to `/sessions/:id/inject`, and upon 202 display a confirmation indicator; upon error display the error message from the Error_Envelope response
3. THE Web_UI SHALL display a "Stop" button (styled as a warning/amber action) in the session detail view for active sessions, POSTing to `/sessions/:id/interrupt` on click
4. THE Web_UI SHALL display a "Kill" button (styled as a destructive/red action) in the session detail view for active sessions
5. WHEN the user clicks the Kill button, THE Web_UI SHALL display a confirmation dialog requiring explicit user approval before POSTing to `/sessions/:id/kill`
6. IF the session is not in `active` status, THEN THE Web_UI SHALL hide the Stop button, Kill button, and prompt injection controls
7. THE Web_UI SHALL handle all four Session_Status values for display purposes (active, completed, abandoned, failed) with appropriate badge colors and control visibility

### Requirement 12: Write Endpoint Authorization Logging

**User Story:** As a daemon operator, I want all write operations to log who performed them, so that I have forensic clarity on who directed agent behavior.

#### Acceptance Criteria

1. WHEN a write endpoint (inject, interrupt, or kill) is called with Forwarded_Identity authentication, THE Session_API SHALL include the validated email in the `actor` field of the stream.log entry
2. WHEN a write endpoint is called with bearer-token authentication, THE Session_API SHALL record the actor as the literal string "local" in the stream.log entry
3. THE Actor_Log entry SHALL include: an ISO 8601 `ts` timestamp, an `actor` field (email string or "local"), a `type` field set to `"web_inject"` for injection, `"web_interrupt"` for interrupt, or `"web_kill"` for termination, and the `session_id` of the affected session
4. THE Session_API SHALL write the Actor_Log entry to stream.log before returning the HTTP response to the client
5. IF the Actor_Log entry cannot be written to stream.log, THEN THE Session_API SHALL reject the write operation with HTTP 500 using the Error_Envelope format indicating a logging failure

### Requirement 13: Write Endpoint Allowlist

**User Story:** As a daemon operator, I want a configurable allowlist for write operations, so that I can restrict which remote users can inject prompts or kill sessions.

#### Acceptance Criteria

1. WHERE the `allowedEmails` config setting is provided as a non-empty array of strings, THE Session_API SHALL reject write-endpoint requests (inject, interrupt, kill) from Forwarded_Identity-authenticated users whose email does not case-insensitively match any entry in the allowlist, responding with HTTP 403 using the Error_Envelope format
2. THE Session_API SHALL allow all write operations from bearer-token authenticated requests regardless of the allowlist (bearer-token implies physical host access)
3. IF `allowedEmails` is absent from the config, THEN THE Session_API SHALL allow write operations from any authenticated user
4. IF `allowedEmails` contains a value that is not a non-empty string or contains a value longer than 254 characters, THEN THE Session_API SHALL reject the config at startup with a FatalError indicating the invalid entry

### Requirement 14: Mobile Polish

**User Story:** As a mobile user, I want the streaming log to be readable and the UI to handle reconnection gracefully, so that I can monitor sessions effectively on a phone.

#### Acceptance Criteria

1. WHILE the viewport width is 768 CSS pixels or narrower, THE Web_UI SHALL render stream log entries with a minimum font size of 14px and a horizontally scrollable container that prevents line wrapping
2. WHEN the browser regains focus after being backgrounded, THE Web_UI SHALL reconnect the SSE stream and supply the `Last-Event-ID` from the last received event, allowing the server to resume without duplication (per Requirement 6 AC 10)
3. WHEN the Web_UI reconnects and receives resumed entries, THE Web_UI SHALL append them in chronological order without duplicating entries already displayed
4. THE Web_UI SHALL use touch-friendly target sizes (minimum 44x44 CSS pixels) for all interactive elements
5. THE Web_UI SHALL display a "waiting for" summary line in the session list (e.g., "waiting: PR review" or "waiting: turn complete") derived from the last stream entry type, so an operator glancing at their phone immediately sees what each session needs

### Requirement 15: Graceful Shutdown

**User Story:** As a daemon operator, I want the daemon to drain active sessions cleanly on SIGTERM, so that a restart doesn't leave ghost-active sessions or lose in-flight work.

#### Acceptance Criteria

1. WHEN the daemon process receives SIGTERM, THE daemon SHALL immediately stop accepting new webhook events and new HTTP write requests (reads remain served during drain)
2. THE daemon SHALL give active sessions up to `shutdownDrainSeconds` (configurable, default 60) to finish their in-flight turns and flush outbound work
3. IF a session does not reach a terminal state within the drain budget, THEN THE daemon SHALL SIGKILL the session subprocess and write terminal state with `termination_reason: "shutdown"` and `status: "abandoned"` to meta.json, AND append a `session_ended` stream.log entry with `reason: "shutdown"` (ensuring SSE clients observe the transition)
4. AFTER all sessions have terminated (or been killed), THE daemon SHALL close the web server listener within 5 seconds and exit
5. THE daemon SHALL persist each session's terminal state to meta.json before exiting, ensuring no session remains with `status: "active"` on disk after a graceful shutdown
6. Active sessions with no turn currently in-flight (idle) SHALL be terminated promptly at the start of the drain phase — the drain budget is for sessions with in-flight turns, not for idle-active sessions to sit waiting

### Requirement 16: Request Hygiene

**User Story:** As a daemon operator, I want POST endpoints to enforce basic request hygiene, so that malformed or oversized payloads don't cause unexpected behavior.

#### Acceptance Criteria

1. THE Session_API SHALL enforce a maximum request body size of 64 KB on all POST endpoints; requests exceeding this limit SHALL receive HTTP 413 using the Error_Envelope format
2. THE Session_API SHALL require `Content-Type: application/json` on all POST endpoints; requests with a missing or non-JSON content type SHALL receive HTTP 415 using the Error_Envelope format
3. THE Session_API SHALL validate the `:id` path parameter against UUID v4 format on all `/sessions/:id/*` endpoints; non-conforming values SHALL receive HTTP 400 before any filesystem access or registry lookup
4. THE Session_API SHALL resolve authentication BEFORE performing any resource existence or status checks — an unauthenticated request SHALL always receive HTTP 401, never HTTP 404 or 409 (preventing session enumeration)

## Correctness Properties

### P1: Loopback-Default Invariant
THE Web_Server SHALL never bind to a non-loopback address unless explicitly configured via `--bind-public` or `bindPublic: true`. Verifiable: startup with default config binds only to 127.0.0.1.

### P2: Proof-Before-Trust Invariant
THE Session_API SHALL never trust a Forwarded_Identity header without first validating the accompanying proof header via timing-safe comparison. Verifiable: forged identity header without correct proof secret is rejected (401 or falls through to bearer).

### P3: Write Operations Are Audited
Every successful write operation (inject, interrupt, kill) SHALL produce an Actor_Log entry in stream.log before the HTTP response is sent. Verifiable: property test asserting no 2xx write response exists without a corresponding stream entry.

### P4: Terminal Sessions Are Immutable
No write endpoint (inject, interrupt, kill) SHALL succeed against a session in a terminal status. Verifiable: property test over all terminal statuses × all write endpoints → 409.

### P5: SSE Event IDs Are Monotonic
THE SSE_Stream SHALL emit strictly increasing integer `id:` values corresponding to line numbers. Verifiable: property test asserting no gaps or reversals in a stream of events.

### P6: Graceful Shutdown Leaves No Active Sessions
After a graceful shutdown sequence completes, no session directory on disk SHALL contain a meta.json with `status: "active"`. Verifiable: integration test that starts sessions, sends SIGTERM, and asserts all meta.json are terminal.

### P7: Every Terminal Transition Emits session_ended
Every transition from `active` to any terminal status (completed, abandoned, failed) SHALL produce exactly one `session_ended` entry in stream.log — whether triggered by normal completion, timeout, kill, interrupt+complete, or graceful shutdown. Verifiable: property test over all termination paths asserting stream.log contains a session_ended entry.

### P8: Authentication Precedes Resource Resolution
For all authenticated endpoints, an unauthenticated request SHALL receive HTTP 401 regardless of whether the referenced session exists or its status. No 404 or 409 SHALL be returned to an unauthenticated caller. Verifiable: property test with invalid/missing credentials against existing and non-existing session IDs.

### P9: Turn Queue Serialization
For any session, at most one `sendPrompt` call SHALL be in-flight at any time. Concurrent inject requests (from any combination of webhook and web sources) SHALL be serialized in FIFO order. Verifiable: integration test with rapid concurrent injects asserting sequential delivery.

## Out of Scope

- Multi-user concurrency (multiple humans in the same session view simultaneously)
- Persistent storage beyond the existing meta.json + stream.log per-session files
- WebSocket transport — using SSE
- Push notifications to phone
- Multi-tenancy or per-user ACLs beyond the simple email allowlist
- Session branching, replay, or non-trivial session manipulation beyond inject, interrupt, and kill
- Real frontend build system (single static HTML file suffices for v1)
- JWT/cryptographic proof-of-origin (future upgrade to the shared-secret proof mechanism)
- SQLite-backed session listing (viable but introduces dual-write concerns; decide in design.md)
- Crash recovery (persist PID/pgid, reap orphans, reconnectable socket transport) — deferred to backlog P2.1
- Conversation-history editing ("pop the last message" / rehydrate a session)

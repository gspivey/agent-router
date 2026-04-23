# Implementation Plan: Agent Router

## Overview

Incremental build of the Agent Router daemon in TypeScript with test infrastructure built before production code. Weekend 1 delivers a Tier 2 test harness capable of exercising the full daemon against fake backends; every subsequent feature ships with harness-driven integration tests. Around Week 6, real-backend implementations are added so critical tests can also run against real GitHub and real Kiro as Tier 3.

Each task builds on the previous, starting with pure-logic modules before wiring up I/O-heavy components. Property-based tests validate correctness properties; unit tests cover edge cases; Tier 2 tests validate full daemon behavior against the harness; Tier 3 tests validate against real services. All code targets Node.js 20+, strict TypeScript, with Hono, better-sqlite3, Vitest, and fast-check.

Logging discipline: Every module that produces runtime behavior accepts a Logger as a constructor dependency. Direct console.log is prohibited outside the CLI client's pretty-printer. Tests assert on log entries where log output is the most reliable observable signal.

Testing discipline: Production code tasks are not complete until their Tier 2 tests are green. The harness exists specifically to make this cheap; skipping Tier 2 tests negates the harness's value.

## Tasks

- [x] 1. Project scaffolding and core types
  - [x] 1.1 Initialize project structure with `package.json`, `tsconfig.json` (strict mode), and install dependencies: `hono`, `@hono/node-server`, `better-sqlite3`, `node-cron`, `tsx`, `vitest`, `fast-check`, `@types/better-sqlite3`
    - Create `src/` directory with placeholder files matching the design layout: `index.ts`, `config.ts`, `db.ts`, `log.ts`, `session-files.ts`, `server.ts`, `cli-server.ts`, `queue.ts`, `session-mgr.ts`, `router.ts`, `acp.ts`, `prompt.ts`, `mcp-server.ts`
    - Define shared TypeScript interfaces and types in each module header as specified in the design: `AgentRouterConfig`, `RepoConfig`, `CronConfig`, `NewEvent`, `Session`, `QueuedEvent`, `StreamEntry`, `SessionMeta`, `PromptSource`, `SessionPaths`, `ACPNotification`, `WakeDecision`, `CliRequest`
    - Define error classes `FatalError`, `EventError`, `WakeError`
    - _Requirements: 1.1, 15.1_

- [x] 2. Tier 2 integration test harness (Weekend 1)
  - [x] 2.1 Create `test/harness/interfaces.ts` defining GitHubBackend, KiroBackend, TestDaemon interfaces
    - _Requirements: 22.1, 22.2_
  - [x] 2.2 Create `test/harness/scripts/make-fixture-repo.sh` — recreate Local_Git_Fixture with seeded initial commit
    - _Requirements: 23.1, 23.2, 23.3_
  - [x] 2.3 Implement `test/harness/fake-github.ts` HTTP server — GitHub API subset, in-memory state, HMAC webhook signing, API call recording
    - _Requirements: 22.1, 23.4, 23.5_
  - [x] 2.4 Wire FakeGitHubBackend to Local_Git_Fixture — real git commands for PR creation, merge, clone URLs
    - _Requirements: 23.4, 23.5, 23.6_
  - [x] 2.5 Implement `test/harness/fake-kiro.ts` — scriptable ACP subprocess reading FAKE_KIRO_SCENARIO env var
    - _Requirements: 22.2_
  - [x] 2.6 Create initial scenario set at `test/scenarios/`: simple-echo, create-pr, create-pr-fix-ci-merge, hang-then-exit, crash-mid-turn
    - _Requirements: 22.2_
  - [x] 2.7 Implement `test/harness/test-daemon.ts` — TestDaemon spawning daemon as child process in temp dir with injected config
    - _Requirements: 24.6_
  - [x] 2.8 Implement `test/harness/test-cli.ts` — programmatic CLI client with typed methods
    - _Requirements: 24.6_
  - [x] 2.9 Configure Vitest project structure — three projects for tier1/tier2/tier3, npm script entries
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5_
  - [x] 2.10 Write smoke test — `test/tier2/smoke.test.ts` exercising full daemon with fake backends
    - _Requirements: 24.6_

- [x] 3. Configuration loading and validation (`config.ts`)
  - [x] 3.1 Implement `resolveEnvValues` — recursively walk a config object and replace `ENV:X` string values with `process.env[X]`, throwing `FatalError` if the env var is unset
    - _Requirements: 1.2, 1.4_
  - [x] 3.2 Implement `validateConfig` — validate `port` ∈ [1, 65535], non-empty `webhookSecret`, non-empty `owner`/`name` in each repo, valid cron entries with matching repo, and `kiroPath` pointing to an executable file; throw `FatalError` with descriptive message on failure
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_
  - [x] 3.3 Implement `loadConfig` — read `./config.json`, parse JSON (throw `FatalError` on missing/invalid), call `resolveEnvValues`, call `validateConfig`, return typed `AgentRouterConfig`
    - _Requirements: 1.1, 1.3_
  - [ ]* 3.4 Write property test for ENV: value resolution
    - **Property 1: ENV: Value Resolution**
    - **Validates: Requirements 1.2**
  - [ ]* 3.5 Write property test for configuration validation
    - **Property 12: Configuration Validation**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**
  - [ ]* 3.6 Write unit tests for config error paths
    - Test missing config file throws FatalError
    - Test invalid JSON throws FatalError
    - Test missing env var throws FatalError with variable name
    - _Requirements: 1.3, 1.4, 15.6_
  - [x] 3.7 Tier 2 test asserting daemon refuses to start with invalid config
    - _Requirements: 15.6, 24.6_

- [x] 4. Structured logger (`log.ts`)
  - [x] 4.1 Implement `createLogger` — read `LOG_LEVEL` env var (default `info`), return `Logger` that writes NDJSON to stdout with `timestamp` (ISO 8601 UTC), `level`, `message`, and merged fields; implement `child()` for field inheritance
    - _Requirements: 17.1, 17.2, 17.6_
  - [x] 4.2 Implement secret filtering — ensure no log entry contains `webhookSecret`, resolved ENV values, or common secret patterns
    - _Requirements: 17.5_
  - [ ]* 4.3 Write property test for log entry structure
    - **Property 13: Log Entry Structure**
    - **Validates: Requirements 17.1, 17.2, 17.3, 17.4**
  - [ ]* 4.4 Write property test for no secrets in log output
    - **Property 14: No Secrets in Log Output**
    - **Validates: Requirements 17.5**
  - [ ]* 4.5 Write property test for log level filtering
    - **Property 15: Log Level Filtering**
    - **Validates: Requirements 17.6**

- [x] 5. Prompt composition (`prompt.ts`)
  - [x] 5.1a Implement `composeCheckRunPrompt` — extract check run name, repo full name, PR number, and output summary from check_run payload
    - _Requirements: 11.1_
  - [x] 5.1b Implement `composeReviewCommentPrompt` — extract comment body, file path, diff hunk, repo full name, PR number
    - _Requirements: 11.2_
  - [x] 5.1c Implement `composeCommandTriggerPrompt` — extract comment body, strip leading `/agent` token per regex `^/agent(\s|$)`, include repo full name and PR number
    - _Requirements: 11.3_
  - [x] 5.1d Implement `composeCronTaskPrompt` — pure function taking (task, repo, roadmapPath) returning structured prompt string
    - _Requirements: 11.4_
  - [ ]* 5.2a Property test for `composeCheckRunPrompt` completeness
    - Validates: Requirements 11.1
  - [ ]* 5.2b Property test for `composeReviewCommentPrompt` completeness
    - Validates: Requirements 11.2
  - [ ]* 5.2c Property test for `composeCommandTriggerPrompt` completeness and `/agent` stripping
    - Validates: Requirements 11.3
  - [ ]* 5.2d Property test for `composeCronTaskPrompt` completeness
    - Validates: Requirements 11.4

- [x] 6. Roadmap parsing (`roadmap.ts`)
  - [x] 6.1 Create `roadmap.ts` — implement `parseRoadmap(content: string): RoadmapTask[]` parsing markdown lines matching `^[-*]\s+\[\s\]` as unchecked and `^[-*]\s+\[x\]` (case-insensitive) as checked
    - _Requirements: 14.1, 14.2_
  - [x] 6.2 Implement `findNextTask(tasks: RoadmapTask[]): RoadmapTask | null` returning the first unchecked task
    - _Requirements: 14.3_
  - [x] 6.3 Implement `markTaskChecked(content: string, taskLine: number): string` — return updated content with target line's `[ ]` replaced by `[x]`, preserving all other content
    - _Requirements: 14.5_
  - [ ]* 6.4 Property test for roadmap task parsing
    - Validates: Requirements 14.1, 14.2, 14.3
  - [ ]* 6.5 Property test for parse/reconstruct round-trip
    - Validates: Requirements 14.5
  - Note: roadmap.ts is consumed by the agent during its prompt, not by the daemon itself. The daemon ships it as a utility library.

- [x] 7. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Wake policy and event routing (`router.ts`)
  - [x] 8.1 Implement `filterEventType` — classify events as wakeable per the three patterns: `check_run` completed+failure, `pull_request_review_comment` created, `issue_comment` created with `/agent` command trigger matching `^/agent(\s|$)`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [x] 8.2 Implement `resolvePRNumber` — extract PR number from payload per event type: `pull_request.number` for review comments, `issue.number` for issue comments (with `issue.pull_request` presence check), first entry of `check_run.pull_requests` for check runs; return null on failure
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - [x] 8.3 Implement `evaluateWakePolicy` — orchestrate the pipeline: filter event type → resolve PR → lookup session in DB → check rate limit via `db.tryAcquireWakeSlot`; return `WakeDecision` with reason string for logging
    - _Requirements: 6.4, 8.1, 8.2, 9.1, 9.2, 9.3_
  - [ ]* 8.4 Write property test for event type filtering
    - **Property 6: Event Type Filtering**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
  - [ ]* 8.5 Write property test for PR number resolution
    - **Property 7: PR Number Resolution**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**
  - [ ] 8.6 Tier 2 test sending each wakeable event type through fake GitHub
    - _Requirements: 6.1, 6.2, 6.3, 24.6_

- [ ] 9. SQLite database layer (`db.ts`)
  - [-] 9.1 Implement `initDatabase` — open/create SQLite file, enable WAL mode, execute DDL for `sessions` and `events` tables with indexes using `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
    - _Requirements: 12.1, 12.2, 12.3_
  - [ ] 9.2a Implement event-related helpers — `insertEvent`, `updateEventProcessed`, `markStaleEvents`
    - _Requirements: 4.1, 4.2, 4.3, 5.3_
  - [ ] 9.2b Implement session lookup + atomic rate limit — `findSession`, `tryAcquireWakeSlot` (single-transaction check-and-update)
    - _Requirements: 8.1, 8.2, 9.1, 9.2, 9.3, 9.4_
  - [ ] 9.2c Implement lifecycle helpers — `walCheckpoint`, `shutdown` (checkpoint + close)
    - _Requirements: 16.4_
  - [ ]* 9.3 Write property test for event storage round-trip
    - **Property 4: Event Storage Round-Trip**
    - **Validates: Requirements 4.1, 4.2**
  - [ ]* 9.4 Write property test for atomic rate limit acquisition
    - **Property 8: Atomic Rate Limit Acquisition**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
  - [ ]* 9.5 Write unit tests for stale event cleanup and session lookup
    - Test `markStaleEvents` marks old unprocessed events
    - Test `findSession` returns null when no session exists
    - _Requirements: 5.3, 8.2_

- [ ] 10. Event queue (`queue.ts`)
  - [ ] 10.1 Implement `createEventQueue` — array-based FIFO queue with `enqueue`, `startWorker` (sequential async processor), `shutdown` (wait for in-flight event up to timeout), and `length` getter
    - _Requirements: 5.1, 5.2, 5.4_
  - [ ]* 10.2 Write property test for FIFO queue ordering
    - **Property 5: FIFO Queue Ordering**
    - **Validates: Requirements 5.1**

- [ ] 11. Session file I/O (`session-files.ts`)
  - [ ] 11.1 Implement `createSessionFiles` — resolve root dir from `$AGENT_ROUTER_HOME` or `$HOME/.agent-router`; create root, `sessions/`, and `daemon.log` on init if missing
    - _Requirements: 18.1, 18.2_
  - [ ] 11.2 Implement `createSession` — create `<root>/sessions/<session_id>/` with `meta.json` (atomic write, status `active`, empty `prs`, null `completed_at`), `stream.log`, and `prompts.log`; return `SessionPaths`; throw on filesystem errors
    - _Requirements: 18.3, 18.8, 20.1, 20.2_
  - [ ] 11.3 Implement `appendStream` — append single-line NDJSON `StreamEntry` to `stream.log` with `fs.appendFileSync` + `fsync`; enforce no embedded newlines in string values
    - _Requirements: 18.4, 18.5, 18.6, 19.1, 19.2_
  - [ ] 11.4 Implement `appendPrompt` — append `PromptEntry` to `prompts.log` with `ts`, `source`, `prompt` fields; same flush semantics
    - _Requirements: 19.7_
  - [ ] 11.5 Implement `updateMeta` — atomic temp-file-plus-rename pattern; refuse to modify non-active sessions; validate status transitions (`active` → `completed` | `failed` | `abandoned`)
    - _Requirements: 18.7, 20.3, 20.4, 20.5, 20.6, 20.7_
  - [ ] 11.6 Implement `readMeta`, `listSessions`, `sessionExists` helpers
    - _Requirements: 20.1, 21.4_
  - [ ]* 11.7 Write property test for stream entry structure
    - **Property 16: Stream Entry Structure**
    - **Validates: Requirements 19.1, 19.2**
  - [ ]* 11.8 Write property test for meta file atomic writes
    - **Property 17: Meta File Atomic Writes**
    - **Validates: Requirements 18.7**
  - [ ]* 11.9 Write property test for session status transitions
    - **Property 18: Session Status Transitions**
    - **Validates: Requirements 20.4, 20.5, 20.6, 20.7**
  - [ ]* 11.10 Write property test for prompt log completeness
    - **Property 19: Prompt Log Completeness**
    - **Validates: Requirements 19.7**
  - [ ]* 11.11 Write unit tests for session file edge cases
    - Test session directory creation failure returns error
    - Test no secrets in stream entries
    - Test meta.json initial state
    - _Requirements: 18.8, 19.6, 20.2_
  - [ ] 11.12 Tier 2 test asserting session directory structure and atomic meta updates
    - _Requirements: 18.3, 18.7, 24.6_

- [ ] 12. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. HTTP server (`server.ts`)
  - [ ] 13.1 Implement Hono app with `POST /webhook` handler: extract raw body, verify HMAC-SHA256 via `verifySignature`, extract `X-GitHub-Event` header, insert event into DB, enqueue onto event queue, respond 200
    - _Requirements: 2.1, 2.4, 3.1, 3.4, 3.5, 3.6_
  - [ ] 13.2 Implement catch-all 404 for non-`/webhook` paths and 405 with `Allow: POST` header for non-POST on `/webhook`
    - _Requirements: 2.2, 2.3_
  - [ ] 13.3 Implement `verifySignature` — HMAC-SHA256 comparison using `crypto.timingSafeEqual`; return false on missing/malformed signature header
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ]* 13.4 Write property test for HMAC-SHA256 verification correctness
    - **Property 3: HMAC-SHA256 Verification Correctness**
    - **Validates: Requirements 3.1, 3.3**
  - [ ]* 13.5 Write property test for unknown paths returning 404
    - **Property 2: Unknown Paths Return 404**
    - **Validates: Requirements 2.2**
  - [ ]* 13.6 Write unit tests for HTTP routing edge cases
    - Test 405 for GET, PUT, DELETE, PATCH on `/webhook` with `Allow: POST` header
    - Test 401 for missing `X-Hub-Signature-256` header
    - _Requirements: 2.3, 3.2_
  - [ ] 13.7 Tier 2 test for signed/unsigned webhooks
    - _Requirements: 3.1, 3.2, 3.3, 24.6_

- [ ] 14. ACP client (`acp.ts`)
  - [ ] 14.1a Implement subprocess wrapper — `spawnACPClient` wrapping `child_process.spawn` with stdio `['pipe', 'pipe', 'inherit']`, stderr line capture, process-level `close()` and `kill()` primitives
    - _Requirements: 10.1, 10.3, 10.9_
  - [ ] 14.1b Implement JSON-RPC 2.0 framing layer — newline-delimited read/write over subprocess stdio, request/response correlation by id, expose notifications as `AsyncIterable<ACPNotification>`
    - _Requirements: 10.7_
  - [ ] 14.2 Implement `initialize` — send ACP `initialize` request with `protocolVersion: 1` and client capabilities `['fs.readTextFile', 'fs.writeTextFile', 'terminal']`; handle version mismatch by closing subprocess
    - _Requirements: 10.2, 10.4_
  - [ ] 14.3 Implement `loadSession` and `sendPrompt` — send `session/load` and `session/prompt` JSON-RPC requests; expose `notifications` as `AsyncIterable<ACPNotification>` for the session manager to consume
    - _Requirements: 10.6, 10.7, 10.8_
  - [ ] 14.4 Implement auto-approval of `session/request_permission` notifications
    - _Requirements: 10.5_
  - [ ] 14.5 Implement stderr line capture — translate each stderr line into a StreamEntry with source: "agent", type: "stderr"
    - _Requirements: 10.13_
  - [ ]* 14.6 Write unit tests for ACP error paths
    - Test protocol version mismatch handling
    - Test spawn failure handling
    - Test non-zero exit code handling
    - _Requirements: 10.4, 10.10, 10.11_
  - [ ] 14.7 Tier 2 test running simple-echo scenario
    - _Requirements: 10.2, 10.6, 10.7, 24.6_

- [ ] 15. Session manager (`session-mgr.ts`)
  - [ ] 15.1a Implement session registry — in-memory `Map<sessionId, SessionHandle>` with add, remove, get, list, has methods
    - _Requirements: supports 18.3, 20.2_
  - [ ] 15.1b Implement `createSession` — orchestrate session file creation, ACP subprocess spawn, initialize, new per-session event queue + worker; insert into registry; return SessionHandle
    - _Requirements: 18.3, 20.2_
  - [ ] 15.2 Implement `injectPrompt` — send `session/prompt` to active session's ACP client, append to `prompts.log`, append `prompt_injected` stream entry
    - _Requirements: 10.7, 19.7, 21.7_
  - [ ] 15.3 Implement `registerPR` — insert/update session-PR mapping in DB, update `meta.json` atomically to append PR entry
    - _Requirements: 20.3_
  - [ ] 15.4 Implement `terminateSession` — SIGTERM → 5s → SIGKILL, update `meta.json` to `status: "abandoned"`
    - _Requirements: 20.6, 21.5_
  - [ ] 15.5a Implement notification → stream entry translation — consume `AsyncIterable<ACPNotification>`, translate each to StreamEntry, write via `sessionFiles.appendStream`
    - _Requirements: 10.8, 19.1_
  - [ ] 15.5b Implement completion detection — subprocess exit 0 after `complete_session` MCP call → update meta.json to status: "completed"
    - _Requirements: 20.4_
  - [ ] 15.5c Implement failure detection and timeout enforcement — subprocess crash/non-zero exit → status: "failed"; 10-minute max wake duration, on expiry SIGTERM → 5s → SIGKILL
    - _Requirements: 10.11, 10.12, 20.5_
  - [ ] 15.6 Implement `shutdown` — update all active sessions' `meta.json` to `status: "abandoned"`, terminate subprocesses
    - _Requirements: 16.7_
  - [ ] 15.7 Tier 2 tests for session creation, PR registration, termination
    - _Requirements: 18.3, 20.3, 20.6, 24.6_

- [ ] 16. CLI IPC server (`cli-server.ts`)
  - [ ] 16.1a Implement socket listener and NDJSON request framing — Unix domain socket at `<root>/sock`, accept one connection at a time, parse NDJSON requests; implement read-only op `list_sessions`
    - _Requirements: 21.1, 21.2, 21.4_
  - [ ] 16.1b Implement mutation ops — `new_session`, `inject_prompt`, `terminate_session`
    - _Requirements: 21.3, 21.5, 21.7_
  - [ ]* 16.2 Write unit tests for CLI IPC ops
    - Test new_session returns session_id and paths
    - Test list_sessions returns sorted SessionMeta array
    - Test terminate_session returns ok
    - Test inject_prompt dispatches to session manager
    - _Requirements: 21.3, 21.4, 21.5, 21.7_
  - [ ] 16.3 Tier 2 test for each op
    - _Requirements: 21.3, 21.4, 21.5, 21.7, 24.6_

- [ ] 17. MCP server (`mcp-server.ts`)
  - [ ] 17.1a Implement MCP server plumbing and read-only tool — read `AGENT_ROUTER_SESSION_ID` from env, connect to daemon socket, implement MCP JSON-RPC handler, expose `session_status` tool
    - _Requirements: 21.1_
  - [ ] 17.1b Implement mutation tools — `register_pr` and `complete_session`
    - _Requirements: 20.3, 20.4_
  - [ ]* 17.2 Write unit tests for MCP tool dispatch
    - Test register_pr, session_status, complete_session return expected results
    - _Requirements: 20.3_
  - [ ] 17.3 Tier 2 test for register_pr
    - _Requirements: 20.3, 24.6_

- [ ] 18. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18.5 Tier 3 real-backend harness
  - [ ] 18.5.1 Implement `test/harness/real-github.ts` — RealGitHubBackend using Octokit
    - _Requirements: 22.1, 24.7_
  - [ ] 18.5.2 Implement artifact cleanup — reset() closes PRs, deletes test branches
    - _Requirements: 22.1_
  - [ ] 18.5.3 Implement webhook delivery polling with 30-second timeout
    - _Requirements: 24.7_
  - [ ] 18.5.4 Implement rate-limit detection — fail clearly on 403
    - _Requirements: 24.7_
  - [ ] 18.5.5 Implement `test/harness/real-kiro.ts` — real kiro-cli spawn, getActions from stream.log
    - _Requirements: 22.2, 24.7_
  - [ ] 18.5.6 Port smoke test to Tier 3
    - _Requirements: 24.9_
  - [ ] 18.5.7 Port 3-5 critical Tier 2 tests to Tier 3
    - _Requirements: 24.9_
  - [ ] 18.5.8 Update operational guide with Tier 3 setup instructions
    - _Requirements: 24.8_
  - [ ] 18.5.9 Configure CI — Tier 1+2 on every push, Tier 3 nightly
    - _Requirements: 24.1, 24.7_

- [ ] 19. Entry point and orchestration (`index.ts`)
  - [ ] 19.1a Implement foundation startup — load config → init logger → init database (WAL mode) → mark stale events
    - _Requirements: 1.1, 5.3, 12.1, 12.2, 12.3_
  - [ ] 19.1b Implement session infrastructure startup — create session files root → create session manager → wire per-session event queue factory
    - _Requirements: 18.1, 18.2_
  - [ ] 19.1c Implement server surfaces startup — bind Hono HTTP server → start CLI IPC server on Unix socket → register cron jobs if retained
    - _Requirements: 1.1, 13.1, 13.2, 21.1_
  - [ ] 19.2 Wire webhook event processing: on dequeue, run `evaluateWakePolicy` → if wake, compose prompt → call `sessionMgr.injectPrompt` → update event row with `processed_at` and `wake_triggered`
    - _Requirements: 3.4, 4.3, 6.4, 8.3, 9.4, 10.7_
  - [ ] 19.3 Wire cron triggers: on cron fire, read roadmap file → parse first unchecked task → compose prompt → create new session or inject into existing session
    - Note: If the team adopts the "cron invokes CLI" simplification from the design, this task becomes a no-op.
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_
  - [ ] 19.4 Implement graceful shutdown: on SIGTERM/SIGINT stop HTTP server, close CLI server socket, wait up to 30s for in-flight events, SIGTERM → 5s → SIGKILL active subprocesses, update active sessions to `abandoned`, WAL checkpoint, exit 0; second signal → immediate SIGKILL + exit 130
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7_
  - [ ] 19.5 End-to-end Tier 2 test for full webhook → wake → session loop
    - _Requirements: 3.4, 6.1, 8.3, 10.7, 24.6_

- [ ] 20. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 21. CLI client binary (`bin/agent-router.ts`)
  - [ ] 21.1 Implement CLI entry point and command dispatch — parse argv, dispatch to subcommand handlers, connect to daemon socket
    - _Requirements: 21.6, 21.7_
  - [ ] 21.2 Implement `prompt --new` subcommand — read from stdin or `--file`, send `new_session` op, by default tail stream log and pretty-print
    - _Requirements: 21.3, 21.6, 21.8_
  - [ ] 21.3 Implement `prompt --session-id <id>` subcommand — send additional prompt text via `inject_prompt` op
    - _Requirements: 21.7_
  - [ ] 21.4 Implement `prompt --new --quiet` flag — create session, print session_id, exit without tailing
    - _Requirements: 21.12_
  - [ ] 21.5 Implement `ls` subcommand — send `list_sessions`, format as human-readable table
    - _Requirements: 21.11_
  - [ ] 21.6 Implement `tail <session_id>` subcommand — follow `stream.log` with pretty-printing (router events gray, agent messages default, tool calls cyan, errors red)
    - _Requirements: 21.8_
  - [ ] 21.7 Implement tail flags — `--raw` (NDJSON unchanged), `--prompts` (tail `prompts.log`)
    - _Requirements: 21.9, 21.10_
  - [ ] 21.8 Implement `terminate <session_id>` subcommand — send `terminate_session` op
    - _Requirements: 21.5_
  - [ ] 21.9 Implement CLI SIGINT handling — on Ctrl-C during tail, stop file watching and exit 0; session continues
    - _Requirements: 21.13_
  - [ ]* 21.10 Unit tests for pretty-print formatting and flag handling
  - [ ] 21.11 Tier 2 test invoking CLI as subprocess
    - _Requirements: 21.3, 21.4, 21.5, 24.6_

- [ ] 22. Operational setup
  - [ ] 22.1 Write `scripts/setup-tunnel.sh` — detect platform, install cloudflared, create named tunnel, print stable HTTPS URL
  - [ ] 22.2 Write `scripts/install-mcp-config.sh` — append Agent Router MCP server entry to Kiro's MCP config
  - [ ] 22.3 Write README.md operational section — step-by-step first-run guide
  - [ ] 22.4 Document LEARNINGS.md starter template
  - [ ] 22.5 Document manual session cleanup — one-line find command to prune old session directories

## Notes

- Tasks marked with `*` are optional. Tier 2 tests written during each feature task are NOT optional.
- Each task references specific requirements for traceability
- Checkpoints at Tasks 7, 12, 18, and 20 force incremental validation including Tier 2 tests
- Task 18.5 (Tier 3) assumes scratch repo and tunnel infrastructure exist before starting
- Tier 3 tests are slow and cost real LLM tokens. Run before shipping, not on every change.
- Runtime: `tsx` for dev, `vitest run --project tier1 --project tier2` for standard tests, `vitest run --project tier3` for real-service tests
- Target commit size: ~500 lines per task. Task 2 (harness) may reach ~1000 lines; accept the overage for Weekend 1.
- Total: ~38 non-optional tasks plus 4 checkpoints. Realistic completion: 12-16 weekends.

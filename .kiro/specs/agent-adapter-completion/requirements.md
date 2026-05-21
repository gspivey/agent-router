# Requirements: Agent-Adapter Pattern + GitHub-Verified Completion Loop

## Introduction

Today the completion path is implicit and Kiro-specific: `spawnACPClient` is called inline from `src/index.ts`, completion-reason values are accepted from agent-side tool calls without external verification, and the only completion trigger is the agent's own `complete_session` MCP call. The recent `merge_pr` / open-PR-check work (fix/merge-pr-completion-validation) closed the worst version of this bug — agents can no longer claim merge while a PR is still open — but the verification logic is one-shot, embedded in `complete_session`, and unreachable from any other trigger.

This feature replaces those assumptions with three structural changes:

1. **An `AgentAdapter` interface** with one concrete implementation (`KiroAdapter`). The daemon core stops importing Kiro-specific code directly, so adding a second agent (Claude Code, OpenCode, Codex) later becomes a single new file.
2. **A `verifySession(sessionId)` core** that is the single source of truth for "did the work happen on GitHub." Pluggable triggers (HTTP `/hooks/event`, ACP-layer events, manual `complete_session` calls) all funnel into it; the verification logic itself is identical regardless of trigger.
3. **An HTTP `/hooks/event` endpoint** authenticated via a daemon-issued bearer token, so any adapter (or future cron job, or hand-installed hook) can fire a verification.

The user explicitly chose to defer one piece of the original spec — automatic Kiro hook installation and agent-profile prompt mutation — until real usage demonstrates the latency win matters. The verification still works end-to-end via the ACP-layer fallback; hook installation becomes a documented manual step the user can run by hand or wire up later.

Two additional small hardening fixes for `merge_pr` ride along because they're localized to `src/github.ts` and are required to make `merge_pr` reliable enough to recommend in the prompt.

## Out of Scope

The following items were debated and explicitly excluded:

- **Automatic `~/.kiro/agents/agent-router.json` mutation** — installing hooks and updating the system prompt via `KiroAdapter.installHooks`. Deferred because the ACP-layer fallback provides correctness, and seconds-of-latency post-merge is acceptable given agent-router's async-primary usage model.
- **Other adapters** — ClaudeCodeAdapter, OpenCodeAdapter, CodexAdapter. The interface exists so the next one is a single new file; we don't write that file until there is a real second agent to test against.
- **Cron mode activation.** Out of scope; this work is what cron mode is gated on. A separate PR enables it.
- **Branch protection on `development`.** GitHub-side configuration; not in this codebase.
- **PR #59 / session 95a59ed3 cleanup** — deferred as a one-off `jq` fix that doesn't block the architecture. (Note: PR #59 itself lives in `dpdk-stdlib-rust`, but session 95a59ed3's `meta.json` is in `~/.agent-router/sessions/` and *is* agent-router runtime state. We're deferring the cleanup because it's a manual one-shot, not because it lives elsewhere.)

## Glossary

- **AgentAdapter** — TypeScript interface (`src/agent-adapter.ts`) describing how the daemon spawns an agent and exposes its capabilities. Replaces the inline `acpSpawner` lambda.
- **KiroAdapter** — One concrete `AgentAdapter` implementation (`src/adapters/kiro.ts`). Spawns `kiro acp`. Hook installation is **documented only** in this PR, not implemented.
- **verifySession** — The single verification core. Takes a `sessionId`, queries GitHub for each registered PR, computes a `termination_reason` from real state, and writes `meta.json` idempotently.
- **Hooks endpoint** — `POST /hooks/event` on the daemon's HTTP server. Authenticated via a bearer token written to `$rootDir/daemon-token` at startup. Triggers `verifySession`.
- **Daemon token** — A 32-byte random token regenerated on every daemon start. Written to `$rootDir/daemon-token` with `0600` permissions. Adapters / hand-installed hooks read it from that file at fire time.
- **ACP fallback** — Wiring on the existing ACP client so that prompt-end and inactivity-watchdog events trigger `verifySession`. Provides verification without any hook installation.

## Requirements

### Requirement 1: Hooks HTTP Endpoint

**User Story:** As an agent adapter (or a hand-installed Kiro hook, or a future cron job), I want to POST a normalized event to the daemon so that the daemon verifies the session against GitHub.

#### Acceptance Criteria

1. WHEN the daemon starts, THE daemon SHALL generate a 32-byte random token and write it to `$rootDir/daemon-token` with `0600` permissions, overwriting any existing token.
2. WHEN a `POST /hooks/event` request arrives with header `Authorization: Bearer <correct-token>` and a valid JSON body, THE daemon SHALL dispatch to `verifySession(session_id)` and return `202 Accepted`.
3. WHEN a `POST /hooks/event` request arrives without an `Authorization` header, with a malformed bearer string, or with an incorrect token, THE daemon SHALL return `401 Unauthorized` and SHALL NOT call `verifySession`.
4. WHEN a `POST /hooks/event` request arrives with a JSON body missing `session_id` or with a non-string `session_id`, THE daemon SHALL return `400 Bad Request`.
5. THE daemon SHALL accept the following `event_type` values: `session.start`, `tool.post`, `turn.end`, `session.end`. Unknown values SHALL be accepted (forward-compat) but logged at `warn`.
6. THE endpoint SHALL respond within 100ms by deferring the actual verification to an async task — the trigger fires; the verification runs without blocking the HTTP response.

### Requirement 2: verifySession Core

**User Story:** As the daemon, I want one single verification routine that reads GitHub state and writes session terminal status, so that every trigger path produces identical results.

#### Acceptance Criteria

1. WHEN `verifySession(sessionId)` is called, THE daemon SHALL read `meta.json` for the session. If the session does not exist, the call SHALL be a no-op (logged at `debug`).
2. WHEN the session has zero registered PRs, THE daemon SHALL NOT write a `termination_reason` and SHALL log "no registered PRs, skipping verification" at `info`.
3. WHEN the session has one or more registered PRs, THE daemon SHALL query `GitHubClient.getPullState` for each PR.
4. WHEN every registered PR has `state == 'closed'` AND `merged == true`, THE daemon SHALL write `termination_reason: 'merged'` to `meta.json` along with `status: 'completed'` and `completed_at` (unix seconds).
5. WHEN no registered PR is `state == 'open'` AND at least one PR is `state == 'closed'` with `merged == false`, THE daemon SHALL write `termination_reason: 'closed_without_merge'`, `status: 'completed'`, and `completed_at`.
6. WHEN at least one registered PR is `state == 'open'`, THE daemon SHALL NOT write any terminal state and SHALL leave the session `active`.
7. WHEN `verifySession` is called a second time for the same session AND `termination_reason` is already set in `meta.json`, THE daemon SHALL log "already verified" at `debug` and SHALL NOT re-write any field.
8. WHEN `verifySession` completes a write, THE daemon SHALL append a stream entry `{ type: 'session_verified', termination_reason, prs: [...] }` to `stream.log`.
9. THE daemon SHALL guarantee no double-write of `meta.json` when two `verifySession` calls overlap for the same session (single-flight via a per-session promise map is sufficient).
10. WHEN any GitHub API call fails (network, 5xx, timeout), `verifySession` SHALL log the error at `error`, append a `verification_failed` stream entry with the error message, leave `meta.json` unchanged, and resolve with a result object `{ verified: false, reason: 'github_error', error }` rather than throwing. Subsequent triggers re-try the verification.
11. THE `verifySession` return type SHALL be `Promise<VerifyResult>` where `VerifyResult = { verified: true, termination_reason } | { verified: false, reason: 'github_error' | 'prs_still_open' | 'already_verified' | 'no_prs' }`. Callers (notably the inactivity watchdog) use this to distinguish "verified that the session shouldn't terminate yet" from "couldn't verify because GitHub is down."

### Requirement 3: AgentAdapter Interface

**User Story:** As a future agent maintainer, I want a typed interface to implement so that adding a second agent doesn't require changes to the daemon core.

#### Acceptance Criteria

1. THE codebase SHALL define `AgentAdapter` in `src/agent-adapter.ts`, exporting `AgentAdapter`, `AdapterCapabilities`, and `SpawnOpts` types.
2. `AgentAdapter` SHALL expose: `name: string`, `capabilities(): AdapterCapabilities`, `spawn(opts: SpawnOpts): ACPClient`, `installHooks(daemonUrl: string, token: string): Promise<void>`, `uninstallHooks(): Promise<void>`.
3. `AdapterCapabilities` SHALL include: `events: ReadonlyArray<HookEventType>`, `perToolMatching: boolean`.
4. THE daemon's session manager and `src/index.ts` SHALL accept an `AgentAdapter` instance rather than a raw `acpSpawner` lambda.
5. AFTER this change, `src/index.ts` SHALL NOT import `spawnACPClient` directly — only through the adapter.

### Requirement 4: KiroAdapter

**User Story:** As the daemon, I want a working concrete adapter so that Kiro continues to spawn correctly under the new abstraction.

#### Acceptance Criteria

1. THE codebase SHALL provide `src/adapters/kiro.ts` implementing `AgentAdapter`.
2. `KiroAdapter.name` SHALL return `"kiro"`.
3. `KiroAdapter.spawn(opts)` SHALL invoke `spawnACPClient(config.kiroPath, ['acp'], { ...opts.env, AGENT_ROUTER_SESSION_ID: opts.sessionId })`. This is a direct refactor of the existing `acpSpawner` lambda — behavior must be byte-identical.
4. `KiroAdapter.capabilities()` SHALL return `{ events: ['session.start', 'tool.post', 'turn.end', 'session.end'], perToolMatching: true }` — describing what Kiro **could** drive if hooks were installed, even though `installHooks` is stubbed.
5. `KiroAdapter.installHooks(daemonUrl, token)` SHALL be a stub that:
   - Logs `"installHooks is documentation-only in this version; see docs/kiro-hooks.md"` at `info`.
   - Does NOT write to `~/.kiro/` or any user-controlled file.
   - Returns successfully.
6. `KiroAdapter.uninstallHooks()` SHALL be a no-op stub matching the same documented contract.
7. THE PR SHALL include `docs/kiro-hooks.md` documenting the JSON payload `POST /hooks/event` expects, the bearer-token convention, and a copy-pasteable example hook entry the user can paste into `~/.kiro/agents/agent-router.json` by hand.

### Requirement 5: ACP-Layer Fallback Triggers

**User Story:** As the daemon, I want verification to fire even when no Kiro hooks are installed, so that the system is correct out of the box.

#### Acceptance Criteria

1. WHEN `injectPrompt` resolves after `await acp.sendPrompt(prompt)` (i.e., the ACP `session/prompt` JSON-RPC response has arrived from the agent), THE daemon SHALL fire `void verifySession(sessionId)`. This is the post-prompt fast trigger — the agent has finished processing the injected prompt at the protocol level. Note: this differs from the original spec's "ACP prompt-end notification" wording because investigation of the current ACP client showed no streaming turn-end marker exists; the JSON-RPC response to `session/prompt` is the actual turn-end signal.
2. WHEN the existing inactivity watchdog fires for a session, THE daemon SHALL call `await verifySession(sessionId)` **before** killing the subprocess. The watchdog SHALL inspect the returned `VerifyResult`:
   - `{ verified: true, termination_reason: 'merged' | 'closed_without_merge' }` → terminal state already written; skip the timeout-failed write and proceed to grace-period kill.
   - `{ verified: false, reason: 'prs_still_open' }` → genuine timeout; write `termination_reason: 'timeout_inactivity'` and kill (existing behavior).
   - `{ verified: false, reason: 'github_error' }` → **do not** write `timeout_inactivity`; instead reset the watchdog for another inactivity window. This is the GitHub-outage protection: a transient GitHub failure mid-watchdog must not flip a successful session into a false timeout failure.
   - `{ verified: false, reason: 'no_prs' | 'already_verified' }` → fall through to existing timeout-failed behavior (no PRs to verify, or session was already finalized).
3. THE ACP fallback SHALL not duplicate hook-path verifications — the single-flight guarantee from Requirement 2.9 covers both trigger paths.
4. WHEN no `AgentAdapter` is wired and `injectPrompt` is never called, the fallback SHALL still fire on inactivity-watchdog expiry.

### Requirement 6: merge_pr Hardening

**User Story:** As an agent, I want `merge_pr` to succeed cleanly when the PR is already merged or when a race window opens between merge and verify, so that I'm not stuck retrying a doomed call.

#### Acceptance Criteria

1. THE `PullState` type SHALL include a `mergeCommitSha: string | null` field populated from the GitHub `merge_commit_sha` response field.
2. WHEN `mergePullRequest` receives `HTTP 405` from `PUT /repos/.../merge` AND a subsequent `getPullState` reports `merged: true`, THE client SHALL return a successful `MergeResult` with `sha = pullState.mergeCommitSha ?? ''` (never silently empty when GitHub knows the SHA) and `message: 'already merged'`.
3. WHEN `mergePullRequest` receives `HTTP 405` AND `getPullState` reports `merged: false` (regardless of state value), THE client SHALL re-throw the original `GitHubApiError` with status `405`.
4. WHEN `mergePullRequest` receives `HTTP 200`, THE client SHALL poll `getPullState` up to 10 times at 300ms intervals (max 3 seconds total) until `merged: true` is observed, then return.
5. WHEN the polling loop in Req 6.4 exhausts its budget without observing `merged: true`, THE client SHALL return the original 200-response `MergeResult` (best-effort — better to return success than to invent a failure when GitHub said 200) AND SHALL log at `warn`.
6. THE polling delay SHALL be configurable for tests (so unit tests run in milliseconds, not seconds).

### Requirement 7: Backwards Compatibility

**User Story:** As a maintainer, I want existing tier1 and tier2 tests to keep passing without modification (except where they touch directly affected code), so that the refactor doesn't regress the rest of the system.

#### Acceptance Criteria

1. ALL tests on the base branch HEAD SHALL continue to pass after this work lands. (The exact count varies as the base branch evolves; the rule is "no regressions," not a snapshot number.)
2. WHERE a test directly exercises `acpSpawner` (e.g., `test/tier2/session-mgr.test.ts`, `test/tier2/cli-server.test.ts`, `test/tier2/merge-pr.test.ts`), it MAY be updated to construct a `KiroAdapter` (or test stub adapter) instead. This is the only allowable test-side change.
3. NO existing public function signature visible from outside `src/index.ts` SHALL break, except `acpSpawner` which is internal.
4. THE existing `complete_session` response contract — `{ ok: true }` on success, `{ error, open_prs: [...] }` on open-PR rejection — SHALL be preserved bit-for-bit through the new `verifySession` wiring. The existing 14 `merge-pr.test.ts` cases that assert this shape SHALL pass unmodified except for the mechanical adapter wiring in setup.

### Requirement 8: GitHubClient Request Timeout

**User Story:** As the daemon, I want every GitHub API call to have a bounded wall-clock budget so that a hung response doesn't deadlock callers (verifySession, the inactivity watchdog, `complete_session`).

#### Acceptance Criteria

1. THE `GitHubClient` SHALL apply a per-request timeout to every `fetch` call (both `getPullState` and `mergePullRequest`).
2. THE default timeout SHALL be 5 seconds, configurable via `GitHubClientOptions.requestTimeoutMs`.
3. WHEN a timeout fires, the underlying `fetch` SHALL be aborted via `AbortController` and the call SHALL throw a `GitHubApiError` with `status: 0` and `message: 'request timeout after Xms'`.
4. THE polling loop in `mergePullRequest` (Req 6.4) SHALL use the same per-request timeout for each poll, not a global budget — a slow GitHub response should not consume the entire 3-second polling window in a single call.

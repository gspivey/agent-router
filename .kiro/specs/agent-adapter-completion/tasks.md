# Implementation Plan: Agent-Adapter Pattern + GitHub-Verified Completion Loop

## Overview

This plan implements `AgentAdapter` + `KiroAdapter`, a single `verifySession(sessionId)` verification core, an authenticated `POST /hooks/event` HTTP surface, ACP-layer fallback triggers, and two `merge_pr` hardening fixes. The Kiro hook-installation work and agent-profile prompt mutation are explicitly deferred — the adapter ships with a stub for `installHooks` and a doc page describing the contract.

## Scope Decisions (carried from design)

- Verification authority lives in `verifySession`; `termination_reason` is computed from GitHub state, never from agent input.
- Triggers (HTTP endpoint, ACP signals, MCP `complete_session`) are pluggable but always funnel through `verifySession`.
- `KiroAdapter.installHooks` is a documentation-only stub; real hook installation deferred per async-primary usage decision.
- Single-flight per session prevents double-writes across overlapping triggers.
- `merge_pr` is hardened in `src/github.ts` only — no surface changes to MCP layer.

## Tasks

- [ ] 1. Add daemon token store and HTTP endpoint
  - [ ] 1.1 Create `src/daemon-token.ts`
    - Export `createDaemonTokenStore(deps: { rootDir: string; log: Logger })` returning `{ read(): string; rotate(): string }`.
    - On construction: generate 32 random bytes (`crypto.randomBytes(32).toString('hex')`), write to `path.join(rootDir, 'daemon-token')` with mode `0o600`. Cache the value in memory.
    - `read()` returns the cached token.
    - `rotate()` regenerates, rewrites the file, updates the cache, returns the new value (used by `index.ts` on daemon start).
    - _Requirements: 1.1_

  - [ ] 1.2 Add `POST /hooks/event` route in `src/server.ts`
    - Accept `tokenStore` and `verifySession` as dependencies in `createApp`.
    - Validate `Authorization: Bearer <token>` header; return `401` if missing or wrong.
    - Parse JSON body; return `400` if missing or non-string `session_id`.
    - Fire `void verifySession(session_id)` (no await) and return `202` immediately.
    - Log the event at `info` with `event_type`, `session_id`, `agent_name`.
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ] 1.3 Wire token store and endpoint in `src/index.ts`
    - Instantiate `createDaemonTokenStore({ rootDir, log })` after `rootDir` is established.
    - Pass it (and `verifySession`) into `createApp`.
    - Log `"Daemon hook token written to <path>"` at `info` (do not log the token itself).
    - _Requirements: 1.1_

  - [ ] 1.4 Unit test `src/daemon-token.ts`
    - File created with mode `0o600`.
    - Token is 64 hex chars (32 bytes).
    - `read()` returns the cached value, doesn't re-read the file.
    - `rotate()` produces a different token and overwrites the file.
    - _Requirements: 1.1_

  - [ ] 1.5 Tier 2 test for `/hooks/event`
    - Correct token → `202` and observable side effect (e.g., `verifySession` spy called with the session_id).
    - Missing header → `401`, spy not called.
    - Wrong token → `401`, spy not called.
    - Malformed JSON → `400`.
    - Missing `session_id` → `400`.
    - Endpoint responds within 50ms even when `verifySession` is slow (proves fire-and-forget).
    - _Requirements: 1.2, 1.3, 1.4, 1.6_

- [ ] 2. Implement `verifySession` core
  - [ ] 2.1 Create `src/verify-session.ts`
    - Export `VerifyResult` discriminated union type and `createVerifier(deps: { sessionFiles, github, log })` returning `verifySession(sessionId: string): Promise<VerifyResult>`.
    - Implement the single-flight `Map<sessionId, Promise<VerifyResult>>` dedup.
    - On GitHub error: append a `verification_failed` stream entry AND return `{ verified: false, reason: 'github_error', error }`.
    - Pseudocode from design.md §2.
    - Use `nowSecs()` and `nowIso()` helpers consistent with the rest of the codebase.
    - _Requirements: 2.1–2.11_

  - [ ] 2.2 Wire `verifySession` into `cli-server.complete_session` (CRITICAL — contract preservation)
    - Replace the existing `OpenPRsError` branch and direct `meta.json` write with `const result = await verifySession(sessionId)`.
    - If `result.verified === true` → return `{ ok: true }`.
    - If `result.verified === false && result.reason === 'prs_still_open'` → re-read `meta.prs`, query their states (or stash from verifier — TBD during impl), return `{ error: '<existing message>', open_prs: [...] }` in the **exact shape** the prior `OpenPRsError` branch produced. The existing tier2 tests in `merge-pr.test.ts` assert this shape and MUST pass without modification.
    - If `result.verified === false && result.reason === 'github_error'` → return `{ error: 'GitHub verification failed: <msg>' }`. Session stays active.
    - If `result.verified === false && result.reason === 'no_prs' | 'already_verified'` → return `{ ok: true }`.
    - **Validation step:** Run `npx vitest run test/tier2/merge-pr.test.ts` with NO changes to that test file beyond the mechanical adapter wiring from Task 3.4. All 18 tests must pass. This is the single most likely place for a silent regression.
    - _Requirements: 2.4, 2.5, 2.6, 7.4_

  - [ ] 2.3 Wire `verifySession` into `src/index.ts`
    - Create the verifier after `sessionMgr` is created (uses the same `sessionFiles` and `github` deps).
    - Pass the function reference into `createApp` (for the HTTP endpoint) and into `sessionMgr` (for the ACP fallback in Task 4).
    - _Requirements: 2.1_

  - [ ] 2.4 Tier 1 tests for `verifySession`
    - All PRs merged → writes `termination_reason: 'merged'`, returns `{verified: true, termination_reason: 'merged'}`.
    - All PRs closed-unmerged → writes `closed_without_merge`, returns appropriately.
    - Mixed (some merged, some closed-unmerged) → `closed_without_merge`.
    - Any PR open → no write, returns `{verified: false, reason: 'prs_still_open'}`.
    - No registered PRs → no write, returns `{verified: false, reason: 'no_prs'}`.
    - Already verified → no write, returns `{verified: false, reason: 'already_verified'}`.
    - Two concurrent calls → one write; both promises resolve with identical results.
    - GitHub query throws → no terminal write; `verification_failed` stream entry appended; returns `{verified: false, reason: 'github_error', error}`.
    - Stream entry `session_verified` is appended on every successful terminal write.
    - _Requirements: 2.1–2.11_

- [ ] 3. AgentAdapter interface + KiroAdapter
  - [ ] 3.1 Create `src/agent-adapter.ts`
    - Export `HookEventType`, `AdapterCapabilities`, `SpawnOpts`, `AgentAdapter` per design.md §3.
    - No implementation — interface and types only.
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 3.2 Create `src/adapters/kiro.ts`
    - Export `createKiroAdapter(deps: { kiroPath: string; log: Logger })`.
    - `spawn(opts)` delegates to `spawnACPClient(deps.kiroPath, ['acp'], { ...opts.env, AGENT_ROUTER_SESSION_ID: opts.sessionId })`.
    - `capabilities()` returns `{ events: ['session.start', 'tool.post', 'turn.end', 'session.end'], perToolMatching: true }`.
    - `installHooks` and `uninstallHooks` are no-op stubs that log informationally.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ] 3.3 Refactor `src/index.ts` to use `KiroAdapter` (via adapter shim)
    - Replace the inline `acpSpawner` lambda with `const adapter = createKiroAdapter({ kiroPath: config.kiroPath, log })`.
    - `adapter.spawn(opts: SpawnOpts)` takes an object; `acpSpawner: (sessionId: string) => ACPClient` takes a bare string. Wrap with a shim: `const acpSpawner = (sessionId: string) => adapter.spawn({ sessionId });` — pass that to `createSessionManager`.
    - Remove the now-unused `spawnACPClient` direct import from `src/index.ts`.
    - _Requirements: 3.4, 3.5, 4.3_

  - [ ] 3.4 Update tier 2 test setup
    - `test/tier2/session-mgr.test.ts`, `test/tier2/cli-server.test.ts`, `test/tier2/merge-pr.test.ts` — wherever the inline `acpSpawner` lambda is constructed, switch to constructing a small inline test adapter (or wire `createKiroAdapter` if it's clean to do so).
    - Existing test behavior must not change; this is mechanical.
    - _Requirements: 7.1, 7.2_

  - [ ] 3.5 Create `docs/kiro-hooks.md`
    - Document the `POST /hooks/event` JSON contract.
    - Document the bearer-token convention and where to find the token (`$rootDir/daemon-token`).
    - Provide a copy-pasteable `~/.kiro/agents/agent-router.json` snippet showing how to hand-wire the `PostToolUse` and `Stop` hooks pointing at the daemon URL.
    - Note explicitly: "Automatic installation is deferred. Edit this file by hand if you want sub-second verification triggers."
    - _Requirements: 4.7_

  - [ ] 3.6 Tier 1 test for `KiroAdapter`
    - `name === 'kiro'`.
    - `capabilities()` returns the expected shape.
    - `spawn(opts)` calls a stubbed spawn function with the right args (use DI: pass the spawn function as a dep for testability).
    - `installHooks` logs and resolves without writing to disk.
    - `uninstallHooks` resolves without error.
    - _Requirements: 4.1–4.6_

- [ ] 4. ACP-layer fallback triggers
  - [ ] 4.1 Wire post-`sendPrompt` → verifySession in `session-mgr.injectPrompt`
    - Pre-flight investigation confirmed: ACP has no streaming "turn-end" notification. The JSON-RPC response to `session/prompt` (i.e., resolution of `await acp.sendPrompt(prompt)`) IS the turn-end signal.
    - In `injectPrompt`, after `await handle.acp.sendPrompt(prompt)` and the existing stream-entry writes, fire `void verifySession(sessionId).catch(err => log.error(...))`.
    - Single-flight handles dedup against the hook path or `complete_session`.
    - _Requirements: 5.1, 5.3_

  - [ ] 4.2 Wire inactivity-watchdog → verifySession-first with GitHub-outage protection
    - In `resetInactivityTimer`, before the existing `updateMeta({ status: 'failed', termination_reason: 'timeout_inactivity' })` write, call `const result = await verifySession(sessionId)`.
    - Branch on `result.verified` and `result.reason`:
      - `verified: true` → terminal state already written; skip timeout-failed write, proceed to grace-period kill.
      - `reason: 'github_error'` → **reset the watchdog and return**. Do NOT write `timeout_inactivity` (false-failure guard). Log at `warn`.
      - `reason: 'prs_still_open' | 'no_prs' | 'already_verified'` → proceed with existing timeout-failed path.
    - _Requirements: 5.2, 5.3_

  - [ ] 4.3 Tier 2 test for ACP fallback
    - Post-`sendPrompt` trigger fires verifySession: drive a fake session with a fake GitHubClient that has the PR pre-set to merged, call `injectPrompt`, assert `meta.termination_reason === 'merged'` (via the post-sendPrompt fallback alone, no hook event, no `complete_session`).
    - Inactivity watchdog with merged PR → `completed:merged`, NOT `failed:timeout_inactivity`.
    - Inactivity watchdog with open PR → existing `failed:timeout_inactivity` behavior.
    - **NEW: Inactivity watchdog with GitHub error** → the watchdog does NOT write `timeout_inactivity`. Use a `failNextGetPullState` mode on the fake GitHubClient to simulate the outage. Assert the session stays `active` and the watchdog logs a warning.
    - _Requirements: 5.1, 5.2_

- [ ] 5. Harden `merge_pr` and `GitHubClient` in `src/github.ts`
  - [ ] 5.1 Extend `PullState` with `mergeCommitSha`
    - Add `mergeCommitSha: string | null` to the `PullState` interface.
    - `getPullState` populates from GitHub's `merge_commit_sha` response field (snake_case → null if absent).
    - Existing callers and tests that destructure only `{number, state, merged}` continue to work; the new field is purely additive.
    - _Requirements: 6.1_

  - [ ] 5.2 Add 405 → already-merged success path
    - In `mergePullRequest`, wrap the PUT in a try/catch.
    - On `GitHubApiError` with `status === 405`: call `getPullState(owner, repo, prNumber)`. If `merged === true`, return `{ sha: state.mergeCommitSha ?? '', merged: true, message: 'already merged' }`. Otherwise re-throw the original 405.
    - _Requirements: 6.2, 6.3_

  - [ ] 5.3 Add post-merge polling
    - After PUT returns 200, before returning, poll `getPullState` in a loop.
    - Defaults: `pollAttempts = 10`, `pollIntervalMs = 300`. Total budget ~3 seconds.
    - Return as soon as `merged: true` is observed (use `state.mergeCommitSha ?? sha` for the response SHA).
    - If the loop exhausts without seeing `merged: true`, log `warn` and return the original 200 response (best-effort fallback per design.md).
    - _Requirements: 6.4, 6.5_

  - [ ] 5.4 Add per-request timeout via `AbortController`
    - Inside the `request` helper, create an `AbortController`, set a `setTimeout(() => ac.abort(), requestTimeoutMs)`, pass `signal: ac.signal` to `fetch`.
    - On `AbortError`: throw `new GitHubApiError('request timeout after Xms', 0, '')`.
    - `clearTimeout` in a `finally`.
    - Default `requestTimeoutMs = 5000`, configurable via `GitHubClientOptions`.
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ] 5.5 Expose all knobs via `GitHubClientOptions`
    - Add `pollAttempts?: number`, `pollIntervalMs?: number`, `requestTimeoutMs?: number`.
    - Tests pass small values for fast execution.
    - _Requirements: 6.6, 8.2_

  - [ ] 5.6 Tier 1 tests for hardening
    - `getPullState` returns `mergeCommitSha` populated for a merged PR and `null` for an unmerged PR.
    - 405 → state.merged=true → returns success with `sha === state.mergeCommitSha`.
    - 405 → state.merged=false → re-throws original 405.
    - 200 → first poll says merged=false, second poll says merged=true → returns success with the merge_commit_sha from the polling response.
    - 200 → all polls say merged=false → returns original 200 response and logs warn.
    - Request timeout: simulate a fetch that never resolves; assert the call rejects with `status: 0` and message matching `/timeout/`.
    - Per-request timeout applies to each poll iteration, not the whole loop.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 8.1, 8.3_

- [ ] 6. Final validation
  - [ ] 6.1 Run full test suite
    - `npm test` → all tests on base-branch HEAD continue to pass, plus new tests from Tasks 1.4, 1.5, 2.4, 3.6, 4.3, 5.6.
    - `npm run typecheck` → no errors.
    - _Requirements: 7.1_

  - [ ] 6.2 Verify no regression in existing surfaces
    - `complete_session` returns identical responses to the prior bug-fix version (verified by Tier 2 `merge-pr.test.ts` continuing to pass without modification beyond Task 3.4's mechanical adapter wiring).
    - `merge_pr` still succeeds on the happy path (verified by existing tests).
    - `src/index.ts` no longer directly imports `spawnACPClient`.
    - _Requirements: 7.1, 7.3, 7.4, 3.5_

  - [ ] 6.3 Manual validation step (record in PR description)
    - Document, in the PR description, the steps to: paste the example from `docs/kiro-hooks.md` into a real `~/.kiro/agents/agent-router.json`, run a session, confirm a `tool.post` event reaches `/hooks/event` and that `verifySession` ran (visible in the stream log as `session_verified`).
    - This is not automated — it validates that the documentation is actually correct, which is the only way to catch "I documented something that doesn't compile" before a user hits it.
    - _Requirements: 4.7_

- [ ]* 7. Post-merge follow-up tracking
  - [ ]* 7.1 Open a backlog item for "implement real KiroAdapter.installHooks"
    - Add to `BACKLOG.md` with priority P2 — the latency win can be revisited once production usage data shows the ACP fallback is too slow for some workflow.
  - [ ]* 7.2 Open a backlog item for "second-adapter implementation (Claude Code or OpenCode)"
    - Add to `BACKLOG.md` with priority P3 — write this when there is a real second-agent need.

## Notes

- Tasks marked with `*` are optional / post-merge bookkeeping.
- Task 2.2 (wiring `verifySession` into `complete_session`) supersedes the open-PR check from the prior `fix/merge-pr-completion-validation` work. The user-facing behavior is unchanged; the implementation is centralized.
- The ACP-fallback work in Task 4 depends on the existing `startNotificationConsumer` and inactivity-watchdog implementations in `session-mgr.ts`. The exact ACP protocol field for "turn end" needs verification against the live ACP client — task 4.1 includes an "inspect existing notification surface" step.
- Single-flight via `Map<sessionId, Promise>` is the simplest concurrency guard. Entries are removed in a `finally` block on settlement, so the map cannot grow unbounded.

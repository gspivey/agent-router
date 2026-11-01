# Continuous Mode — Tasks

Implementation is structured into two PRs. PR A ships the config, core runner, session-mgr
wiring, and critical Tier 2 tests for coverage (the functional backbone). PR B ships the CLI
surface and remaining Tier 2 tests. Both PRs must pass `npm run typecheck` and `npm test`
before push.

**Note:** T2-CONT-1 (happy path) and T2-CONT-2 (item failure) are moved to PR A to ensure the
core runner has end-to-end test coverage before the CLI surface is added.

---

## PR A: Config, core runner, and session-mgr wiring

### Task 1.1 — Extend `RepoConfig` with `continuous` and `baseBranch`

**File:** `src/config.ts`

- Add `continuous?: boolean` and `baseBranch?: string` to the `RepoConfig` interface.
- In `validateConfig`, inside the `repos` loop:
  - If `repo['continuous']` is present and not a `boolean`, throw `FatalError`.
  - If `repo['baseBranch']` is present and is not a non-empty string, throw `FatalError`.
  - Write both fields to the `entry` when valid.

**Acceptance:**
- `validateConfig` passes with `continuous: true` and `baseBranch: "development"` present.
- `validateConfig` throws `FatalError` on `continuous: 42` or `baseBranch: ""`.

- [x] Complete

---

### Task 1.2 — Add `getFileContents` to `GitHubClient`

**File:** `src/github.ts`

- Add `getFileContents(owner: string, name: string, filePath: string, ref: string): Promise<string>`
  to the `GitHubClient` interface.
- Implement: `GET /repos/{owner}/{name}/contents/{filePath}?ref={ref}` with
  `Accept: application/vnd.github.raw` header to get raw content directly.
  URL-encode the `filePath` and `ref` parameters.
- If using the JSON response format (fallback), validate `type === 'file'` and
  `encoding === 'base64'`. Files over 1 MB return `content: ""` with `encoding: "none"` —
  throw `Error('File too large for contents API')` in this case.
- Throw a descriptive `Error` on 404 or non-2xx response.
- Any `FakeGitHubBackend` used in Tier 2 tests needs a corresponding stub/mock for this endpoint.

**Acceptance:**
- A unit test (Tier 1, if a fake HTTP server is available, else Tier 2 harness mock)
  confirms the method returns decoded file text on success, throws on 404, and throws on
  oversized files (encoding: 'none').

- [x] Complete

---

### Task 1.3 — Create `src/continuous-runner.ts`

**File:** `src/continuous-runner.ts` (new)

Implement the full module as specified in `design.md` under "Continuous run state".

Key points:

1. Export `ContinuousRunStopReason`, `ContinuousRunPhase`, `ContinuousRunState`, `ContinuousRunner` types.
2. Export `createContinuousRunner(deps)` factory.
3. **`startRun` (async):**
   - Guards against double-start on same repo.
   - Fetches ROADMAP to get initial `unchecked_count_at_spawn` for no-progress detection.
   - Creates state with `phase: 'spawning'`, `stopRequested: false`.
   - Calls `await sessionMgr.createSession`; updates state on success.
   - **On error:** logs, calls `_stopRun('item_failed')`, and **re-throws** to surface to caller.
4. **`notifySessionEnded`:**
   - Increments `items_completed` on every notification (before deciding to continue).
   - Routes `merged` to `_continueRun` (via `setTimeout(0)`, sets `phase: 'pending'`) or
     `_stopRun('item_failed')` for other reasons.
   - Checks `stopRequested` and `shuttingDown` before scheduling continuation.
   - Ignores sessions not belonging to this run.
5. **`_continueRun` (private async):**
   - **Re-checks** `status`, `stopRequested`, `shuttingDown` at entry, after fetch await, and before spawn.
   - Sets `phase` at each stage: `fetching` → `spawning` → `session_active`.
   - Stores promise in `inFlightContinuations` for shutdown to await.
   - Distinguishes 429/5xx (`roadmap_fetch_failed`) from other errors (`item_failed`).
   - **No-progress check:** If unchecked count hasn't decreased, stop with `no_progress`.
   - **Collision check:** Calls `sessionMgr.hasActiveSessionForRepo(repo)` before `createSession`.
   - Updates `unchecked_count_at_spawn` for next iteration.
6. **`_stopRun`:** Sets state fields. Logs `warn` for `item_failed`, `no_progress`, `roadmap_fetch_failed`.
7. **`requestStop`:**
   - Throws if no run exists for repo.
   - **Throws if run already stopped** (prevents overwriting `queue_empty`/`item_failed`).
   - Sets `stopRequested = true`.
   - **Phase-aware:** If `phase === 'pending'`, clears timer and stops immediately.
8. **`listRuns`:** Maps to DTO (only fields in REQ-4.2, plus `stopped_at`).
9. **`shutdown` (async):**
   - Sets `shuttingDown = true`.
   - Clears all pending timers.
   - Awaits `Promise.all([...inFlightContinuations.values()])` to prevent createSession after sessionMgr.shutdown().

The callback into `notifySessionEnded` is the entry point for all end-notifications
from the session manager. It MUST never throw (wrap body in try/catch and log).

**Acceptance:**
- Module exports compile without errors under `tsc --noEmit`.
- Tier 1 tests (see Task 1.6) pass.
- Tier 2 tests T2-CONT-1 and T2-CONT-2 (moved to PR A) pass.

- [x] Complete

---

### Task 1.4 — Add `onSessionEnded` callback to `SessionManager`

**File:** `src/session-mgr.ts`

1. Add `onSessionEnded?: (sessionId: string, repo: string | undefined, reason: string) => void`
   to the `createSessionManager` deps type.

2. **Fire the callback at `registry.remove` sites, NOT at meta-write sites.** This ensures the
   Kiro process has been killed before the next session can start. Identify all `registry.remove`
   call sites and add the callback call **just before** each:

   | Site | `termination_reason` source |
   |---|---|
   | Grace timer expiry (in `completeSession`) | Read from `sessionFiles.readMeta(sessionId)` |
   | `monitorSubprocessExit` — already-terminal branch | Read from `sessionFiles.readMeta(sessionId)` |
   | `monitorSubprocessExit` — normal exit branch | `'completed'` or read from meta |
   | Inactivity timer | `'timeout_inactivity'` |
   | Max-lifetime timer | `'timeout_max_lifetime'` |
   | `terminateSession` | the `reason` parameter |
   | Shutdown loop (graceful) | Read from `sessionFiles.readMeta(sessionId)` |
   | Shutdown loop (forced) | `'daemon_shutdown'` |

3. Implementation pattern at each site:

   ```typescript
   // Just before registry.remove(sessionId)
   const meta = sessionFiles.readMeta(sessionId);
   const reason = meta?.termination_reason ?? 'unknown';
   try { deps.onSessionEnded?.(sessionId, handle.repo, reason); } catch (e) {
     log.error('onSessionEnded callback threw', { sessionId, error: String(e) });
   }
   registry.remove(sessionId);
   ```

4. **Do NOT remove the session from registry early in `completeSession`.** The registry removal
   happens naturally after the grace timer expires and `acp.kill()` runs.

5. Every callback call site must be wrapped so a throw from the callback never propagates.

**Acceptance:**
- `npm run typecheck` passes.
- Existing Tier 1 and Tier 2 tests still pass (callback is optional; no existing tests provide it).
- The callback fires ONCE per session, after the process is killed, not when meta is written.

- [x] Complete

---

### Task 1.5 — Wire continuous runner in `src/index.ts`

**File:** `src/index.ts`

1. Import `createContinuousRunner` from `./continuous-runner.js`.

2. After `createSessionManager` is constructed, create the runner:
   ```typescript
   const continuousRunner = createContinuousRunner({
     config,
     sessionMgr,
     github,
     sessionFiles,
     log,
   });
   ```

3. Pass `onSessionEnded` to `createSessionManager`:
   ```typescript
   onSessionEnded: (sessionId, repo, reason) => {
     continuousRunner.notifySessionEnded(sessionId, repo, reason);
   },
   ```
   (Because `continuousRunner` is created after `sessionMgr`, use a forward-ref pattern:
   declare `let continuousRunner: ContinuousRunner;` before `createSessionManager`, assign
   after creation, and the closure captures by reference.)

4. **Update `handleCronFire` signature** to receive `config` and `continuousRunner`:
   ```typescript
   async function handleCronFire(
     cronEntry: CronConfig,
     config: AgentRouterConfig,
     sessionMgr: SessionManager,
     sessionFiles: SessionFiles,
     continuousRunner: ContinuousRunner,
     log: Logger
   ): Promise<void>
   ```

5. **Update `setupCronJobs` signature** to receive `config` and `continuousRunner`, and
   pass them through to `handleCronFire`.

6. In `handleCronFire`, branch on `repoConfig.continuous`:
   ```typescript
   const repoConfig = config.repos.find(r => `${r.owner}/${r.name}` === cronEntry.repo);
   if (repoConfig?.continuous === true) {
     try {
       await continuousRunner.startRun(cronEntry, repoConfig);
       cronLog.info('Continuous run initiated', { cronName: cronEntry.name, repo: cronEntry.repo });
     } catch (err) {
       cronLog.error('Continuous run failed to start', { cronName: cronEntry.name, error: String(err) });
     }
   } else {
     const handle = await sessionMgr.createSession(prompt, cronEntry.repo);
     cronLog.info('Cron session created', { session_id: handle.sessionId });
   }
   ```

7. Pass `continuousRunner` to `createCliServer` (Task 2.1 will consume it).

8. Add `await continuousRunner.shutdown()` to the graceful-shutdown sequence,
   **before** `sessionMgr.shutdown()`. Note there are two `sessionMgr.shutdown()` call sites
   (`src/index.ts:254` and `:301`); the runner's shutdown must come before both.

**Acceptance:**
- `npm run typecheck` passes.
- Daemon starts without error on a config with and without `continuous: true`.

- [x] Complete

---

### Task 1.6 — Tier 1 tests for config and runner

**File:** `test/tier1/continuous-runner.test.ts` (new)  
**File:** `test/tier1/config-continuous.test.ts` (new, or add to existing config tests)

Config validation tests:

- `continuous: true` is accepted.
- `continuous: 42` throws `FatalError`.
- `baseBranch: "development"` is accepted.
- `baseBranch: ""` throws `FatalError`.
- Absence of both fields leaves them `undefined` in the returned config.

Runner unit tests (use a minimal stub for `sessionMgr`, `github`, `sessionFiles`, `log`):

- `notifySessionEnded` with `reason: 'merged'` increments `items_completed` and schedules
  `_continueRun` (spy on `sessionMgr.createSession`; use fake timers to advance the event loop).
- `notifySessionEnded` with a non-`merged` reason stops the run with `item_failed` and
  still increments `items_completed`.
- `notifySessionEnded` for an unknown repo is a no-op.
- `notifySessionEnded` for a session not matching `current_session_id` is a no-op.
- `requestStop` on a running run sets the `stopRequested` flag.
- `requestStop` during `pending` phase clears the timer and stops immediately with `operator_request`.
- `requestStop` on an already-stopped run throws.
- Subsequent `notifySessionEnded('merged')` after `requestStop` stops with `operator_request`.
- `requestStop` for an unknown repo throws.
- `_continueRun` with an empty ROADMAP (no unchecked tasks) stops with `queue_empty`.
- `_continueRun` when `github.getFileContents` throws 429/5xx stops with `roadmap_fetch_failed`.
- `_continueRun` when `github.getFileContents` throws other error stops with `item_failed`.
- `_continueRun` when unchecked count hasn't decreased stops with `no_progress`.
- `_continueRun` re-checks `stopRequested` after fetch and before spawn.
- `listRuns` returns all states mapped to DTO (no internal fields like `phase`, `stopRequested`).
- `startRun` when `createSession` throws: logs error, calls `_stopRun('item_failed')`, re-throws.
- `shutdown` awaits in-flight continuations and sets `shuttingDown` flag.

**Acceptance:**
- All tests pass with `vitest run --project tier1`.

- [x] Complete

---

### Task 1.7 — Tier 2: happy path and failure (moved from PR B for early coverage)

**File:** `test/tier2/continuous-mode.test.ts` (new)

Use the Tier 2 harness (`TestDaemonImpl`, `FakeKiroBackend`, `FakeGitHubBackend`).

**Config note:** Set `gracePeriodAfterMergeSeconds` to 1 to avoid 60s waits.

**T2-CONT-1: happy path (two items)**

Setup:
- Repo config: `continuous: true, baseBranch: 'development'`.
- `FakeGitHubBackend` serves a ROADMAP: first fetch returns 2 unchecked, second returns 1,
  third returns 0.
- `FakeKiroBackend` scenario for each session: sends `complete_session` with reason `"merged"`.

Test:
1. Trigger cron for the repo.
2. Wait for S1 to complete (meta has `termination_reason: 'merged'`).
3. Wait for S1 to leave registry (grace period).
4. Assert S2 is created (poll `sessionFiles.listSessions()` or use a short sleep).
5. Wait for S2 to complete with `'merged'`.
6. Wait for S2 to leave registry.
7. Assert no S3 is created within a short window (ROADMAP empty after S2).
8. Assert `continuousRunner.getRunState(repo).stop_reason === 'queue_empty'`.
9. Assert `continuousRunner.getRunState(repo).items_completed === 2`.

**T2-CONT-2: item failure stops chain**

Test:
1. S1 completes with `'merged'` and leaves registry; S2 times out (inactivity) or `FakeKiro`
   exits without calling `complete_session`.
2. Assert run stops with `stop_reason: 'item_failed'`.
3. Assert `items_completed === 2` (both sessions counted).
4. Assert no S3 is created.

**Acceptance:**
- Tests pass with `vitest run --project tier2`.

- [x] Complete

---

## PR B: CLI surface and Tier 2 tests

### Task 2.1 — Add `stop_continuous` op to CLI server

**File:** `src/cli-server.ts`

1. Add `continuousRunner?: ContinuousRunner` to the `createCliServer` deps interface.

2. Add `'stop_continuous'` to the `CliRequest['op']` union.

3. Implement the handler:
   ```typescript
   async stop_continuous(req: CliRequest): Promise<Record<string, unknown>> {
     const repo = req['repo'];
     if (typeof repo !== 'string' || repo.length === 0) {
       throw new Error('Missing or empty "repo" parameter');
     }
     if (!deps.continuousRunner) {
       throw new Error('Continuous runner not configured');
     }
     deps.continuousRunner.requestStop(repo);
     return { ok: true };
   }
   ```

4. Enhance the `list_sessions` handler:
   ```typescript
   async list_sessions(): Promise<Record<string, unknown>> {
     const sessions = sessionFiles.listSessions();
     const continuous_runs = deps.continuousRunner?.listRuns() ?? [];
     return { sessions, continuous_runs };
   }
   ```

**Acceptance:**
- `npm run typecheck` passes.
- Existing `list_sessions` tests still pass (no `continuousRunner` provided → empty array).

- [x] Complete

---

### Task 2.2 — Add `stop-continuous` subcommand to CLI binary

**File:** `bin/agent-router.ts`

1. Add a `stop-continuous` (or `stopContinuous`) subcommand handler.

2. Required flag: `--repo <owner/repo>`. Validate format (must contain exactly one `/`).

3. Send `{ op: 'stop_continuous', repo }` over the Unix socket.

4. On `{ ok: true }`: print `Continuous run for <repo> will stop after the current item completes.`

5. On error response: print the error message and exit 1.

**Acceptance:**
- `agent-router stop-continuous --repo owner/name` compiles and exits 0 when daemon responds `{ ok: true }`.
- Missing `--repo` prints usage and exits 1.

- [x] Complete

---

### Task 2.3 — Update `ls` display

**File:** `bin/agent-router.ts`

1. In the `ls` command handler, after receiving the response, extract `continuous_runs` from
   the payload (type: `ContinuousRunState[]`, default `[]`).

2. If `continuous_runs` is non-empty, print a section header `Continuous runs:` and a row per
   run:
   ```
     owner/repo   RUNNING   3 items  session 4c1e8b2a   since 14:02
     owner/repo2  STOPPED   queue_empty   2 items   stopped 14:47
   ```
   Format: align columns, truncate session ID to 8 chars, format timestamps as `HH:MM`.

3. In the session list table, append a `[CONT]` badge to the `session_id` column for any
   session whose `sessionId` matches a `current_session_id` in `continuous_runs`.

**Acceptance:**
- With a mocked response containing one active run and one stopped run, the output includes
  both rows under the header.
- Session rows for sessions matching a continuous run show `[CONT]`.

- [x] Complete

---

### Task 2.4 — Tier 2: `stop-continuous` between items

**File:** `test/tier2/continuous-mode.test.ts`

Test:
1. S1 completes with `'merged'` and leaves registry.
2. In the `pending` phase (during the `setTimeout(0)` window before `_continueRun` fires),
   send `stop_continuous` for the repo.
3. Assert no S2 is created.
4. Assert run stops with `stop_reason: 'operator_request'`.
5. The phase model makes this deterministic, not flaky — `requestStop` during `pending` phase
   clears the timer synchronously.

**Acceptance:**
- Test passes with `vitest run --project tier2`.

- [x] Complete

---

### Task 2.5 — Tier 2: item failure stops chain (moved to PR A as Task 1.7)

This test was moved to PR A (Task 1.7) to provide early coverage.

- [x] Complete (see Task 1.7)

---

### Task 2.6 — Tier 2: non-continuous repo unaffected

**File:** `test/tier2/continuous-mode.test.ts`

Test:
1. Two repos in config: A (`continuous: true`) and B (no flag).
2. Cron fires for B; FakeKiro completes session with `'merged'`.
3. Assert no second session is created for B (it leaves registry, but no continuation).
4. Assert B's `list_sessions` count stays at 1 (only the original session).
5. Cron fires for A; verify A chains normally (items_completed > 1).

**Acceptance:**
- Test passes with `vitest run --project tier2`.

- [x] Complete

---

### Task 2.7 — Tier 2: `ls` includes continuous run state

**File:** `test/tier2/continuous-mode.test.ts`

Test:
1. Start a continuous run; query `list_sessions` via CLI.
2. Assert: response contains `continuous_runs` with at least one entry matching the run.
3. Assert: DTO contains only REQ-4.2 fields (no `phase`, `stopRequested`, `cronName`, `promptFile`).

**Acceptance:**
- Test passes with `vitest run --project tier2`.

- [x] Complete

---

## Completion checklist

Before opening PR A:
- [x] `npm run typecheck` passes on the PR branch.
- [x] `npm test` (Tier 1 + Tier 2) passes, including T2-CONT-1 and T2-CONT-2.
- [x] `continuous-runner.ts` has no `any` types, no `as` casts except for narrowing.
- [x] All new log calls use the structured `Logger`, not `console.log`.
- [x] `onSessionEnded` fires at `registry.remove` sites, NOT at meta-write sites.
- [x] `startRun` is async and handles `createSession` failure.
- [x] `_continueRun` re-checks `stopRequested`/`shuttingDown` at entry, after fetch, before spawn.
- [x] `no_progress` detection is implemented (compare unchecked counts).
- [x] `shutdown` is async and awaits in-flight continuations.

Before opening PR B:
- [x] `npm run typecheck` passes.
- [x] `npm test` passes including new Tier 2 tests (T2-CONT-3 through T2-CONT-7).
- [x] `agent-router stop-continuous --help` (or equivalent usage) prints without crashing.

Before merging each PR:
- [x] ROADMAP item ticked with PR number.
- [x] README updated if any operator-visible behaviour changed (config fields, new subcommand).

# Continuous Mode — Design

## Architecture overview

Continuous mode is implemented as a new `src/continuous-runner.ts` module that sits above
`SessionManager` and below `index.ts`. It receives a callback from the session manager when a
session **leaves the registry** (i.e. when `registry.remove` is called), decides whether to
continue the chain, and calls back into `sessionMgr.createSession` for the next item.

```
index.ts
  │
  ├─ setupCronJobs / handleCronFire
  │       │ (on repo.continuous===true)
  │       └──> continuousRunner.startRun(cronEntry, repoConfig)
  │
  └─ createSessionManager({ onSessionEnded })
          │ (fires when session leaves the registry, after grace period)
          └──> continuousRunner.notifySessionEnded(sessionId, repo, reason)
                  │ (if reason==="merged" && !stopRequested && !shuttingDown)
                  └──> fetchRoadmap() → findNextTask() → sessionMgr.createSession()
```

**Key design principle:** The callback fires when the session leaves the registry, NOT when
the terminal meta is written. This ensures the previous session's Kiro process has been
killed before the next session starts, preventing two agents from running on the same repo.

No new persistence layer is added. Continuous run state lives in `Map<repo,
ContinuousRunState>` inside the runner. A daemon restart clears all runs.

---

## Config changes (`src/config.ts`)

### `RepoConfig` additions

```typescript
export interface RepoConfig {
  owner: string;
  name: string;
  roadmapPath?: string;
  token?: string;
  webhookSecret?: string;
  /** Enable continuous mode: on merge, immediately start the next ROADMAP item. */
  continuous?: boolean;
  /**
   * Branch the daemon reads the ROADMAP from when picking the next item.
   * Defaults to "development".
   */
  baseBranch?: string;
}
```

### Validation additions (in `validateConfig`, inside the `repos` loop)

- `continuous`: if present, must be a boolean. Any other type is a `FatalError`.
- `baseBranch`: if present, must be a non-empty string. Empty string is a `FatalError`.

---

## GitHub file fetch (`src/github.ts`)

A new method is added to the `GitHubClient` interface and implementation:

```typescript
interface GitHubClient {
  // ... existing methods ...
  /**
   * Fetch the raw text content of a file from a repo at a given ref.
   * Throws if the file is not found, is too large, or the request fails.
   */
  getFileContents(owner: string, name: string, filePath: string, ref: string): Promise<string>;
}
```

Implementation notes:
- Use `GET /repos/{owner}/{name}/contents/{filePath}?ref={ref}` with `Accept: application/vnd.github.raw`
  header to get raw content directly, avoiding base64 encoding issues.
- URL-encode the `filePath` and `ref` parameters.
- **Validate the response:** If using the JSON response format, require `type === 'file'` and
  `encoding === 'base64'`. Files over 1 MB return `content: ""` with `encoding: "none"` —
  throw an error in this case rather than returning an empty string.
- Throw on 404, non-2xx, or invalid response shape.

---

## Continuous run state (`src/continuous-runner.ts`)

### Types

```typescript
export type ContinuousRunStopReason =
  | 'operator_request'
  | 'queue_empty'
  | 'item_failed'
  | 'no_progress'
  | 'roadmap_fetch_failed';

/** Internal phase tracking for race-condition-safe stop handling */
export type ContinuousRunPhase =
  | 'session_active'  // A session is running
  | 'pending'         // setTimeout(0) queued, waiting to fire
  | 'fetching'        // Awaiting GitHub ROADMAP fetch
  | 'spawning';       // Awaiting createSession

export interface ContinuousRunState {
  repo: string;
  cronName: string;
  promptFile: string;
  status: 'running' | 'stopped';
  phase: ContinuousRunPhase;
  stop_reason?: ContinuousRunStopReason;
  stopRequested: boolean;  // Set by requestStop, checked throughout _continueRun
  items_completed: number;
  current_session_id: string | null;
  /** Number of unchecked items when current session started, for no_progress detection */
  unchecked_count_at_spawn: number;
  started_at: number;  // Unix seconds
  stopped_at?: number; // Unix seconds, set on stop
}

export interface ContinuousRunner {
  /** Called by cron handler to initiate a new run. Async to handle createSession failures. */
  startRun(cronEntry: CronConfig, repoConfig: RepoConfig): Promise<void>;
  /** Called by session-mgr when a session leaves the registry. */
  notifySessionEnded(sessionId: string, repo: string | undefined, reason: string): void;
  /** Request a graceful stop after the current item. */
  requestStop(repo: string): void;
  /** Returns the run state for a repo, or null if no run is active or recorded. */
  getRunState(repo: string): ContinuousRunState | null;
  /** All known runs (active and recently stopped, for ls output). */
  listRuns(): ContinuousRunState[];
  /** Called during daemon shutdown. Async to wait for in-flight continuations. */
  shutdown(): Promise<void>;
}
```

### `createContinuousRunner(deps)`

Dependencies injected:

```typescript
{
  config: AgentRouterConfig;
  sessionMgr: SessionManager;
  github: GitHubClient;
  sessionFiles: ReturnType<typeof createSessionFiles>;
  log: Logger;
}
```

Internal state:

```typescript
const runs = new Map<string, ContinuousRunState>();  // keyed by repo ("owner/name")
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightContinuations = new Map<string, Promise<void>>();  // For shutdown to await
let shuttingDown = false;
```

#### `startRun(cronEntry, repoConfig)` — async

1. If `runs.has(repo)` and `runs.get(repo).status === 'running'`, log warn and return (run
   already active — collision guard).
2. Read the prompt file (`fs.readFileSync(cronEntry.promptFile, 'utf-8')`).
3. Fetch ROADMAP to get initial unchecked count for no_progress detection.
4. Create a `ContinuousRunState` with `status: 'running'`, `phase: 'spawning'`,
   `items_completed: 0`, `stopRequested: false`, `unchecked_count_at_spawn: count`.
5. Store in `runs`.
6. **try:** Call `await sessionMgr.createSession(composeCronPrompt(promptContent, repo), repo)`.
7. On success, update `state.current_session_id`, `state.phase = 'session_active'`.
8. **catch:** Log `error`, call `_stopRun(repo, 'item_failed')`, and re-throw to surface to caller.
9. Log `info` with `{ repo, cronName, sessionId }`.

#### `notifySessionEnded(sessionId, repo, reason)`

Called by the session-manager when a session **leaves the registry** (after grace period,
inactivity timeout, max-lifetime timeout, or explicit termination).

1. If `repo` is undefined or no run exists for it, return early (session not part of a run).
2. Fetch `state = runs.get(repo)`. If `state.status !== 'running'`, return.
3. If `state.current_session_id !== sessionId`, return (stale notification from a non-run session).
4. **Increment `state.items_completed`** (on every end-notification, before deciding to continue).
5. Clear `state.current_session_id`.

**If `reason === 'merged'`:**
  - If `state.stopRequested` or `shuttingDown`: call `_stopRun(repo, 'operator_request')` and return.
  - Otherwise, set `state.phase = 'pending'`, schedule `_continueRun(repo)` via `setTimeout(0)`.
    Store the timer in `pendingTimers`.

**Otherwise (any other terminal reason):**
  - Call `_stopRun(repo, 'item_failed')`.

#### `_continueRun(repo)` (private async)

1. Remove from `pendingTimers`.
2. Get `state = runs.get(repo)`. **Re-check:** if `state.status !== 'running'` or
   `state.stopRequested` or `shuttingDown`, call `_stopRun(repo, 'operator_request')` and return.
3. Set `state.phase = 'fetching'`. Store the continuation promise in `inFlightContinuations`.
4. **try:** Fetch the ROADMAP file from GitHub:
   ```
   github.getFileContents(owner, name, repoConfig.roadmapPath ?? 'ROADMAP.md', repoConfig.baseBranch ?? 'development')
   ```
   **catch:** If 429/5xx, log and call `_stopRun(repo, 'roadmap_fetch_failed')`; otherwise
   `_stopRun(repo, 'item_failed')`. Remove from `inFlightContinuations` and return.
5. **Re-check after await:** if `state.stopRequested` or `shuttingDown`,
   call `_stopRun(repo, 'operator_request')`, remove from `inFlightContinuations`, and return.
6. Parse: `const tasks = parseRoadmap(content)`.
7. Count unchecked items: `const uncheckedCount = tasks.filter(t => !t.checked).length`.
8. **No-progress check:** If `uncheckedCount >= state.unchecked_count_at_spawn`, the previous
   session didn't tick its item. Log `warn` and call `_stopRun(repo, 'no_progress')`. Return.
9. `const nextTask = findNextTask(tasks)`.
10. If `nextTask === null`:
    - Call `_stopRun(repo, 'queue_empty')`.
    - Remove from `inFlightContinuations` and return.
11. **Re-check before spawn:** if `state.stopRequested` or `shuttingDown`,
    call `_stopRun(repo, 'operator_request')`, remove from `inFlightContinuations`, and return.
12. **Collision check (NFR-3):** if `sessionMgr.hasActiveSessionForRepo(repo)`,
    log `warn` and call `_stopRun(repo, 'item_failed')`. Return.
13. Set `state.phase = 'spawning'`, `state.unchecked_count_at_spawn = uncheckedCount`.
14. Read the prompt file for this cron entry (same file as the initial session).
15. **try:** Call `await sessionMgr.createSession(composeCronPrompt(promptContent, repo), repo)`.
    - On success: `state.phase = 'session_active'`, `state.current_session_id = handle.sessionId`.
    - Log `info` with `{ repo, itemsCompleted: state.items_completed, nextTask: nextTask.text, sessionId }`.
16. **catch:** Log `error` and call `_stopRun(repo, 'item_failed')`.
17. Remove from `inFlightContinuations`.

#### `_stopRun(repo, stopReason)` (private)

1. Get state; if not found, return.
2. Set `state.status = 'stopped'`, `state.stop_reason = stopReason`, `state.stopped_at = now`,
   `state.phase` to undefined (or remove from state object).
3. Log `info` (or `warn` for `item_failed`, `no_progress`, `roadmap_fetch_failed`)
   with `{ repo, stopReason, itemsCompleted: state.items_completed }`.

#### `requestStop(repo)`

1. Get state; if not found, throw `Error('No active continuous run for repo …')`.
2. **If `state.status !== 'running'`, throw** `Error('Run already stopped')` (prevents
   overwriting `queue_empty`/`item_failed` with `operator_request`).
3. Set `state.stopRequested = true`.
4. Log `info` with `{ repo }`.
5. **Phase-aware immediate stop:**
   - If `state.phase === 'pending'`: clear the timer from `pendingTimers`, call
     `_stopRun(repo, 'operator_request')` immediately.
   - If `state.phase === 'session_active'`: do nothing more; wait for the session to end.
   - If `state.phase === 'fetching'` or `'spawning'`: the flag is set; `_continueRun` will
     check it after its next `await` and stop.

#### `listRuns()`

Returns `[...runs.values()]` mapped to a DTO containing only the fields specified in REQ-4.2:
`repo`, `status`, `stop_reason` (if stopped), `items_completed`, `current_session_id`,
`started_at`, plus `stopped_at` for display.

#### `shutdown()` — async

1. Set `shuttingDown = true`.
2. Clear all `pendingTimers`.
3. **Await all in-flight continuations:** `await Promise.all([...inFlightContinuations.values()])`.
   This ensures no `_continueRun` calls `createSession` after `sessionMgr.shutdown()` runs.

---

## Session manager changes (`src/session-mgr.ts`)

### New dep

```typescript
onSessionEnded?: (sessionId: string, repo: string | undefined, reason: string) => void;
```

Added to the `createSessionManager` deps parameter.

### When to fire

The callback fires **once per session**, when the session **leaves the registry**. This means
it fires at `registry.remove(sessionId)` call sites, NOT when the terminal meta is written.
By firing at registry removal, we guarantee:
1. The Kiro process has been killed (the grace timer has completed).
2. `hasActiveSessionForRepo` returns `false` for the repo.
3. No orphaned processes can act on the repo while the next session runs.

Call sites for `registry.remove` (each fires the callback):

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

Implementation pattern at each site:

```typescript
// Just before registry.remove(sessionId)
const meta = sessionFiles.readMeta(sessionId);
const reason = meta?.termination_reason ?? 'unknown';
try { deps.onSessionEnded?.(sessionId, handle.repo, reason); } catch (e) {
  log.error('onSessionEnded callback threw', { sessionId, error: String(e) });
}
registry.remove(sessionId);
```

The callback must never throw. Wrap in a try/catch; log and swallow on error.

---

## Cron handler changes (`src/index.ts`)

### `handleCronFire` patch

The function signature must change to receive `config` and `continuousRunner`:

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

After the existing guards (active-session check, clean-state check, prompt-file read)
and instead of the current `sessionMgr.createSession(...)` call:

```typescript
const repoConfig = config.repos.find(r => `${r.owner}/${r.name}` === cronEntry.repo);

if (repoConfig?.continuous === true) {
  // Delegate session creation to the continuous runner
  try {
    await continuousRunner.startRun(cronEntry, repoConfig);
    cronLog.info('Continuous run initiated', { cronName: cronEntry.name, repo: cronEntry.repo });
  } catch (err) {
    cronLog.error('Continuous run failed to start', { cronName: cronEntry.name, error: String(err) });
    // Run is already stopped with 'item_failed' inside startRun
  }
} else {
  // Existing one-shot path
  const handle = await sessionMgr.createSession(prompt, cronEntry.repo);
  cronLog.info('Cron session created', { session_id: handle.sessionId });
}
```

### `setupCronJobs` patch

The function signature must also change to receive `config` and `continuousRunner`,
and pass them through to `handleCronFire`.

### Wiring in `main()`

After `createSessionManager(...)`, before `setupCronJobs`:

```typescript
const continuousRunner = createContinuousRunner({
  config,
  sessionMgr,
  github,
  sessionFiles,
  log,
});
```

Pass `continuousRunner.notifySessionEnded` as `onSessionEnded` to
`createSessionManager`:

```typescript
const sessionMgr = createSessionManager({
  ...
  onSessionEnded: (sessionId, repo, reason) => {
    continuousRunner.notifySessionEnded(sessionId, repo, reason);
  },
});
```

Pass `continuousRunner` to `createCliServer`:

```typescript
const cliServer = createCliServer({
  socketPath,
  sessionMgr,
  sessionFiles,
  continuousRunner,
  log,
});
```

Add `await continuousRunner.shutdown()` to the graceful-shutdown sequence, before
`sessionMgr.shutdown()`. Note there are two `sessionMgr.shutdown()` call sites
(`src/index.ts:254` and `:301`); the runner's shutdown must come before both.

---

## CLI server changes (`src/cli-server.ts`)

### New optional dep

```typescript
export function createCliServer(deps: {
  socketPath: string;
  sessionMgr: SessionManager;
  sessionFiles: SessionFiles;
  continuousRunner?: ContinuousRunner;
  log: Logger;
}): CliServer
```

The `continuousRunner` dep is optional to preserve backward compat for tests that construct a
`CliServer` without wiring a runner.

### New op: `stop_continuous`

```typescript
async stop_continuous(req: CliRequest): Promise<Record<string, unknown>> {
  const repo = req['repo'];
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error('Missing or empty "repo" parameter');
  }
  if (!deps.continuousRunner) {
    throw new Error('Continuous runner not available');
  }
  deps.continuousRunner.requestStop(repo);
  return { ok: true };
}
```

Add `stop_continuous` to the `CliRequest['op']` union.

### Enhanced `list_sessions`

```typescript
async list_sessions(): Promise<Record<string, unknown>> {
  const sessions = sessionFiles.listSessions();
  const continuous_runs = deps.continuousRunner?.listRuns() ?? [];
  return { sessions, continuous_runs };
}
```

---

## CLI binary changes (`bin/agent-router.ts`)

### New subcommand `stop-continuous`

```
agent-router stop-continuous --repo <owner/repo>
```

Sends `{ op: 'stop_continuous', repo }` over the Unix socket, prints `Continuous run for
<repo> will stop after the current item.` on success, or the error message on failure.

### `ls` display

When `continuous_runs` is non-empty in the `list_sessions` response, render them above the
session list:

```
Continuous runs:
  owner/repo   RUNNING   3 items completed   session 4c1e8b2a   started 14:02
  owner/repo2  STOPPED   queue_empty          2 items completed  stopped 14:47
```

A `[CONT]` badge is also added to sessions in the session list whose `session_id` matches any
`current_session_id` from the runs array.

---

## Data flow: end-to-end merged → next session

```
1. Session S1 completes (merged):
   ├─ verify() writes termination_reason: "merged" to meta.json
   ├─ grace period timer starts
   └─ (S1 process still alive for gracePeriodAfterMergeSeconds)

2. Grace period expires:
   ├─ acp.kill() → S1 process terminates
   ├─ sessionMgr reads meta.termination_reason ("merged")
   ├─ sessionMgr fires onSessionEnded("s1", "owner/repo", "merged")
   │      └─> continuousRunner.notifySessionEnded(...)
   │              ├─> state.items_completed++
   │              └─> schedules _continueRun("owner/repo") via setTimeout(0)
   └─ registry.remove("s1")  ← S1 is now fully gone

3. _continueRun fires (async, next event loop tick):
   ├─ Re-check: status=running, stopRequested=false, shuttingDown=false ✓
   ├─ github.getFileContents("owner", "repo", "ROADMAP.md", "development")
   ├─ Re-check after await ✓
   ├─ parseRoadmap(content) → count unchecked items
   ├─ No-progress check: uncheckedCount < unchecked_count_at_spawn ✓
   ├─ findNextTask(tasks) → nextTask found: "Implement foo"
   ├─ Re-check before spawn ✓
   ├─ Collision check: hasActiveSessionForRepo(repo) = false ✓
   ├─ read promptFile content
   ├─ sessionMgr.createSession(composeCronPrompt(content, repo), repo)
   │     └─ new session S2 created and running
   └─ state.current_session_id = "s2", state.unchecked_count_at_spawn = current count
```

**Key invariant:** S2 is NEVER created until S1's process has been killed and S1 has been
removed from the registry. This eliminates all overlap between agents on the same repo.

**Cost:** At most 60s of added latency per item (the grace period), against 50–90 min items.
This is acceptable; the alternative (parallel agents) violates the core safety invariant.

---

## Error handling

| Error site | Behaviour |
|---|---|
| `github.getFileContents` throws (429/5xx) | Log `error`, call `_stopRun(repo, 'roadmap_fetch_failed')` |
| `github.getFileContents` throws (other) | Log `error`, call `_stopRun(repo, 'item_failed')` |
| `parseRoadmap` / `findNextTask` throws | Log `error`, call `_stopRun(repo, 'item_failed')` |
| `sessionMgr.createSession` throws in `startRun` | Log `error`, call `_stopRun(repo, 'item_failed')`, re-throw to caller |
| `sessionMgr.createSession` throws in `_continueRun` | Log `error`, call `_stopRun(repo, 'item_failed')` |
| `onSessionEnded` callback throws | Log `error`, swallow — never propagate into session-mgr |
| `requestStop` called for unknown repo | Throw `Error` (propagates to CLI as error response) |
| `requestStop` called on already-stopped run | Throw `Error` (prevents overwriting stop_reason) |
| Same item selected twice (no ROADMAP tick) | Log `warn`, call `_stopRun(repo, 'no_progress')` |
| Daemon shuts down mid-run | `await continuousRunner.shutdown()` waits for in-flight continuations, then clears timers |

---

## Testing strategy

### Tier 1 (pure / unit)

- `validateConfig` rejects invalid `continuous` / `baseBranch` values.
- `ContinuousRunState` transitions: `notifySessionEnded` with `'merged'` advances
  `items_completed`; non-`merged` stops with `item_failed`; `requestStop` before next item
  stops with `operator_request`.
- `requestStop` on missing repo throws.
- `requestStop` on already-stopped run throws.
- Phase-aware stop: `requestStop` during `pending` phase clears timer and stops immediately.
- `listRuns` returns all states mapped to DTO.

### Tier 2 (full daemon vs fake backends)

**Config note:** Tier 2 tests should set `gracePeriodAfterMergeSeconds` to a low value (e.g. 1s)
to avoid 60s waits between items.

Scenario files for `FakeKiroBackend` drive the sessions:

**T2-CONT-1: happy path (two items)** — moved to PR A for early coverage
  1. Config: one repo with `continuous: true`; fake ROADMAP returns 2 unchecked, then 1, then 0.
  2. Cron fires → S1 starts.
  3. FakeKiro for S1 runs complete-session hook with reason `"merged"`.
  4. After grace period: S2 starts automatically.
  5. S2 completes with `"merged"`.
  6. After grace period: ROADMAP has no unchecked items → run stops with `queue_empty`.
  7. Assert: `items_completed === 2`, `stop_reason === 'queue_empty'`.

**T2-CONT-2: item failure stops chain** — moved to PR A for early coverage
  1. Same setup; S1 completes with `"merged"`; S2 times out (inactivity).
  2. Assert: run stops with `stop_reason === 'item_failed'`, `items_completed === 2`.

**T2-CONT-3: `stop-continuous` between items**
  1. S1 completes with `"merged"`; in the `pending` phase (setTimeout(0) window), CLI sends `stop_continuous`.
  2. Assert: no S2 created; run stops with `stop_reason === 'operator_request'`.
  3. Phase model makes this deterministic, not flaky.

**T2-CONT-4: non-continuous repo unaffected**
  1. Two repos in config: A with `continuous: true`, B without.
  2. Cron fires for both; B's cron creates one session and stops; A's creates a chain.
  3. Assert: B's session count is 1 at end; A's items_completed > 1.

**T2-CONT-5: `ls` includes continuous run state**
  1. Start a continuous run; query `list_sessions`.
  2. Assert: response contains `continuous_runs` with at least one entry matching the run.

---

## Open questions (deferred)

1. **Persistent run state.** If the daemon restarts mid-run, the run is lost. Future work:
   persist `ContinuousRunState` to SQLite and resume on restart (aligns with ROADMAP item 19).

2. **Max-items guard.** The brief specifies "run until empty." A future `maxItems?: number`
   field on `CronConfig` could add a safety cap. Not implemented now.

3. **Multi-repo run.** Out of scope; a single `ContinuousRunner` instance already handles
   multiple repos independently (one `Map` entry per repo), so the architecture supports it
   when needed.

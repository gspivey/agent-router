# Design: task-attempt-outcome

## Overview

This feature layers a **task / attempt / outcome** model onto the existing agent-router daemon. It adds three SQLite tables, a versioned `/v1/` REST + SSE API, a closed outcome contract, an agent outcome-reporting channel, crash-recovery semantics, two-phase transcript retention, per-repo concurrency with a circuit breaker, and a ROADMAP.md intake adapter.

The design deliberately keeps agent-router an **execution and observation primitive**. It does not judge quality, decide when to retry, or schedule globally. It executes a task as attempts, records a structured outcome per attempt, and emits a monotonic, replayable event stream that an orchestrator (and the web UI) consume through the public API only.

### Design goals

- **The web UI consumes only `/v1/`.** No private side channels.
- **State and events are transactionally consistent.** Every state change and its event are written in one SQLite transaction, so the stream can never disagree with persisted state.
- **Closed enums everywhere.** `task.state`, `attempt.outcome`, `failure_class`, `reason_code`, and `blocked.needs` are closed TypeScript unions and SQLite `CHECK` constraints.
- **Never parse free text.** Outcome comes from a structured tool call, a schema-validated file, or mechanical classification — in that priority order.
- **Follow existing conventions.** DI over singletons, pure functions exported for test, prepared-statement DB pattern, Hono route factories, the existing SSE replay model, the existing error-class taxonomy, unix-ms storage / ISO-8601 serialization.

### How this maps onto existing machinery

The daemon already spawns agent sessions (`session-mgr.ts`, `acp.ts`, adapters), writes per-session NDJSON (`session-files.ts`), serves a control-plane HTTP API (`web-server.ts`, `web-routes.ts`) with bearer/proxy auth (`web-auth.ts`), tails session logs over SSE (`sse-broker.ts`), exposes MCP tools to the agent (`mcp-server.ts`), and stores state in `better-sqlite3` (`db.ts`). This feature adds a parallel task layer that **drives** the existing session machinery: a task's attempt is executed as a session, and the session's transcript (`stream.log`) is the attempt's transcript.

---

## Architecture

```
                         ┌──────────────────────────────────────────┐
   orchestrator ───────► │  /v1 REST + SSE  (v1-routes.ts)           │
   (and web UI)          │  auth: createAuthMiddleware (reused)      │
                         └───────────────┬──────────────────────────┘
                                         │
                 ┌───────────────────────┼───────────────────────────┐
                 ▼                       ▼                           ▼
         ┌──────────────┐       ┌─────────────────┐        ┌──────────────────┐
         │ TaskService  │       │ RepoScheduler    │        │ TaskEventBroker  │
         │ submit/get/  │       │ per-repo slots + │        │ SSE replay from  │
         │ list/cancel/ │◄─────►│ circuit breaker  │        │ task_events(seq) │
         │ retry        │       └────────┬─────────┘        └────────▲─────────┘
         └──────┬───────┘                │                           │
                │ starts attempt         ▼                           │ emitEvent()
                │                 ┌───────────────┐                  │
                ▼                 │ AttemptRunner  │──────────────────┘
         ┌──────────────┐         │ runs a session │
         │ TaskDatabase │◄────────┤ heartbeat,     │
         │ tasks/       │  txn     │ outcome resolve│
         │ attempts/    │         └───────┬────────┘
         │ task_events  │                 │ spawn/inject/terminate
         └──────┬───────┘                 ▼
                │                  ┌────────────────┐
                │                  │ SessionManager │ (existing)
                │                  │ + AgentAdapter │
                │                  └───────┬────────┘
                │                          │ report_outcome tool
                ▼                          ▼
         ┌──────────────┐          ┌────────────────┐
         │ Transcript   │          │ mcp-server.ts  │ (extended)
         │ Retention    │          │ report_outcome │
         │ (zstd)       │          └────────────────┘
         └──────────────┘

   RoadmapImporter ──► TaskService.submitTask()   (one intake adapter among many)
```

### New modules (src/)

| File | Role |
|---|---|
| `src/task-db.ts` | `TaskDatabase` interface + `initTaskDatabase(db)`; DDL for `tasks`, `attempts`, `task_events`, `repo_state`; prepared statements; transactional helpers (`createTaskWithEvent`, `startAttemptWithEvent`, `endAttemptWithEvent` [conditional UPDATE], `setRepoStateWithEvent`, `appendEvent`). Shares the open `better-sqlite3` handle with `src/db.ts`. |
| `src/ulid.ts` | Monotonic ULID generator (pure, no new dependency). `ulid(seedTime?)` and a factory for monotonic sequences. |
| `src/task-types.ts` | Closed unions and record types: `TaskState`, `AttemptOutcome`, `FailureClass`, `ReasonCode`, `BlockedNeeds`, `TaskRecord`, `AttemptRecord`, `TaskEventRecord`, `Budget`, `Artifacts`, `Usage`. |
| `src/task-errors.ts` | `TaskError`, `AttemptError` (analogous to `errors.ts`). |
| `src/task-service.ts` | `TaskService`: `submitTask`, `getTask`, `listTasks`, `cancelTask`, `retryTask`. Pure validation functions exported (`validateSubmitBody`, `validateTaskState`, `parseBudget`). Owns task state machine. |
| `src/attempt-runner.ts` | `AttemptRunner`: starts an attempt (spawns a session via `SessionManager`/`AgentAdapter`), drives heartbeats, resolves the outcome (tool → file → mechanical), ends the attempt. Pure outcome-resolution and reason-code functions exported. |
| `src/repo-scheduler.ts` | `RepoScheduler`: per-repo concurrency slots, queue draining, circuit-breaker state (`closed`/`open`), consecutive-failure counting, status snapshot for `/v1/repos/:owner/:name/status`; persists breaker state in `repo_state` and reloads it on startup. Pure breaker-transition functions exported. |
| `src/task-event-broker.ts` | `TaskEventBroker`: SSE fan-out reading from `task_events` by `seq`, replay for `since`/`Last-Event-ID`, heartbeats. Pure helpers (`envelopeFromRow`, `resolveSince`) exported. |
| `src/transcript-retention.ts` | Two-phase retention: `archiveTranscript` (zstd via `node:zlib`), `deleteExpiredTranscripts`, `readTranscript` (transparent decompress). Pure `classifyRetentionPhase(now, endedAt, grace, ttl)` exported. |
| `src/v1-routes.ts` | Hono route factory `createV1Routes(deps)` mounting all `/v1/` endpoints. Pure validators + envelope serializers exported. |
| `src/roadmap-importer.ts` | `RoadmapImporter`: parse ROADMAP.md checklist lines, read/write `<!-- ar:<ULID> -->` annotations, call `TaskService.submitTask`, tick checkboxes on `succeeded`. Pure parse/annotate functions exported. |

### Extended modules

| File | Change |
|---|---|
| `src/mcp-server.ts` | Add `report_outcome` to `MCP_TOOLS`; add a `tools/call` branch that forwards `op: 'report_outcome'` to the daemon over the Unix socket. |
| `src/cli-server.ts` | Handle the `op: 'report_outcome'` socket message, routing it to the active `AttemptRunner`. |
| `src/config.ts` | Add optional per-repo `concurrency` and circuit-breaker settings on `RepoConfig`; add an optional top-level `taskTranscript` retention block; add an optional `setup_timeout_s` knob (default `120`, bounds the attempt setup phase — Requirement 4.1c / HIGH-D); add validation. |
| `src/web-server.ts` | Mount `createV1Routes` under `/v1`, applying the existing `authMiddleware` to `/v1/*` (and the write guard to the `/v1` POST routes). |
| `src/index.ts` | Wire up `TaskDatabase`, `TaskService`, `RepoScheduler`, `AttemptRunner`, `TaskEventBroker`, retention sweeper, and run restart recovery + emit `daemon.started`. |

---

## Components and Interfaces

### 1. Identifiers — `src/ulid.ts`

The brief requires ULID primary keys. `package.json` has no ULID dependency, and `AGENTS.md` says to justify any new dependency. A ULID is small and well-specified (48-bit ms timestamp + 80 bits randomness, Crockford base32, lexicographically sortable), so we implement it inline rather than add a dependency.

```ts
/** Generate a ULID. Lexicographically sortable; encodes unix-ms time in the first 10 chars. */
export function ulid(now?: number): string;

/** Monotonic factory: within the same millisecond, increments the random component
 *  so successive ids remain strictly increasing. */
export function monotonicUlidFactory(): (now?: number) => string;
```

Monotonicity matters because `attempts` and `task_events` benefit from sortable ids even when generated inside the same millisecond. `task_events.seq` (AUTOINCREMENT) remains the authoritative replay cursor; the ULID `id` is a stable public identifier.

### 2. Types — `src/task-types.ts`

```ts
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
export type AttemptState = 'running' | 'ended';
export type AttemptOutcome =
  | 'succeeded' | 'failed' | 'blocked' | 'cancelled'
  | 'timed_out' | 'budget_exceeded' | 'interrupted';
export type FailureClass = 'infra';           // only when outcome ∈ {'failed'(infra cause),'interrupted'}; else null
export type ReasonCode =
  | 'spawn_failed' | 'auth_failed' | 'rate_limited' | 'git_push_failed' | 'adapter_crash'
  | 'no_changes' | 'agent_reported_failure' | 'agent_error' | 'agent_blocked'
  | 'budget_exceeded' | 'timed_out' | 'interrupted'
  | 'cancelled_by_api' | 'cancelled_by_breaker';
// ACP stop reasons consumed by the ordered classification list (CRITICAL-1).
// This is the real ACP protocol enum — NOT invented values.
export type StopReason =
  | 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
export type BlockedNeeds = 'credential' | 'decision' | 'access' | 'other';
export type TaskSource = 'api' | 'roadmap';
export type AgentKind = 'kiro' | 'claude';

export interface Budget {
  max_wall_s?: number;
  max_tokens?: number;
  max_turns?: number;
  heartbeat_interval_s?: number;   // default 30
  allow_resume?: boolean;          // default false
}
export interface Artifacts {
  branch?: string; base_sha?: string; head_sha?: string; pr_url?: string;
  diff_stats?: { files: number; insertions: number; deletions: number };
  transcript_ref?: string;         // path to active stream.log or archived .zst
}
export interface Usage {
  wall_ms: number; input_tokens?: number; output_tokens?: number; cost_usd?: number;
}
export interface Blocked { question: string; needs: BlockedNeeds; }

// Enforcer-set termination intent (HIGH-2). In-memory only; never a column on `attempts`.
// Carries the full triple so a breaker cancel can express reason_code + failure_class,
// which a bare AttemptOutcome string could not.
export interface TerminationIntent {
  outcome: AttemptOutcome;
  reasonCode: ReasonCode;
  failureClass: FailureClass | null;
}

// Full end state passed to teardownAttempt() (HIGH-1). A superset of TerminationIntent:
// the enforcer/cancel/breaker/lease paths supply only {outcome, reasonCode, failureClass}
// (blocked/artifacts/usage omitted → optional), while a NATURAL end (resolveOutcome) supplies
// the full state including the agent-reported pr_url, artifacts, and usage. A TerminationIntent
// is therefore assignable to AttemptEndState unchanged, so every existing enforcer caller keeps
// working without modification.
export interface AttemptEndState {
  outcome: AttemptOutcome;
  reasonCode: ReasonCode;
  failureClass: FailureClass | null;
  // HIGH-4 / H4: whether this end increments the repo's consecutive_failures (circuit breaker).
  // Optional; defaults to `true` when omitted. The outcome classifier sets it `false` for the
  // single carve-out of Req 22.8 — a `git_push_failed` end whose remote-ref check failed because
  // `git ls-remote` itself errored (remoteBranchExists === null, a transient network fault that
  // must not trip the breaker). teardownAttempt forwards this flag to RepoScheduler.onAttemptEnded.
  countsTowardBreaker?: boolean;
  blocked?: { question: string; needs: BlockedNeeds };
  artifacts?: {
    branch?: string;
    head_sha?: string;
    pr_url?: string;
    diff_stats?: object;
    transcript_ref?: string;
  };
  usage?: { wall_ms: number; input_tokens?: number; output_tokens?: number; cost_usd?: number };
}

export interface TaskRecord {
  id: string; externalId: string | null; repo: string; source: TaskSource;
  sourceRef: string | null; title: string; spec: string; baseRef: string | null;
  agent: AgentKind; budget: Budget | null; metadata: unknown;
  state: TaskState; createdAt: number; updatedAt: number;   // unix ms
}
export interface AttemptRecord {
  id: string; taskId: string; attemptNo: number; sessionId: string | null;
  worktreeBranch: string | null;    // 'agent/<attempt_id>' (fresh) or 'agent/<original_attempt_id>' (resume) — HIGH-4
  worktreePath: string | null;      // '/tmp/agent-runs/<attempt_id>'; a resume reuses the interrupted attempt's path — H2
  state: AttemptState; leaseExpiresAt: number | null;
  outcome: AttemptOutcome | null; failureClass: FailureClass | null;
  reasonCode: ReasonCode | null; reason: string | null;
  artifacts: Artifacts | null; usage: Usage | null;
  agentVersion: string | null; model: string | null; promptHash: string | null;
  startedAt: number; endedAt: number | null;
}
export interface TaskEventRecord {
  seq: number; id: string; ts: number; type: string;
  repo: string | null; taskId: string | null; attemptId: string | null; data: unknown;
}
```

### 3. Database — `src/task-db.ts`

Follows the `src/db.ts` pattern exactly: DDL as module-scope template strings, `initTaskDatabase(db: BetterSqlite3.Database)` prepares statements and returns a `TaskDatabase` object closing over them. It reuses the already-open database handle created by `initDatabase`, so WAL mode is already set. All timestamps are unix **ms**.

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  repo        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('api','roadmap')),
  source_ref  TEXT,
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,
  base_ref    TEXT,
  agent       TEXT NOT NULL CHECK (agent IN ('kiro','claude')),
  budget      TEXT,
  metadata    TEXT,
  state       TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','blocked','cancelled')),
  resume_session_id TEXT,        -- set when an allow_resume session is interrupted; reused ONCE by the startup resume then cleared to NULL (HIGH-5(b))
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_repo_state ON tasks(repo, state);

CREATE TABLE IF NOT EXISTS attempts (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  attempt_no       INTEGER NOT NULL,
  session_id       TEXT,
  state            TEXT NOT NULL CHECK (state IN ('running','ended')),
  lease_expires_at INTEGER,
  outcome          TEXT CHECK (outcome IN
                     ('succeeded','failed','blocked','cancelled','timed_out','budget_exceeded','interrupted')),
  failure_class    TEXT CHECK (failure_class IN ('infra') OR failure_class IS NULL),
  reason_code      TEXT,
  reason           TEXT,
  blocked          TEXT DEFAULT NULL,  -- JSON {question, needs} ONLY when outcome='blocked'; NULL for every other outcome (HIGH-10)
  artifacts        TEXT,
  usage            TEXT,
  agent_version    TEXT,
  model            TEXT,
  prompt_hash      TEXT,
  worktree_branch     TEXT,            -- the git branch this attempt pushes to: 'agent/<attempt_id>' for a fresh attempt, 'agent/<original_attempt_id>' for a resume (HIGH-4). The post-exit remote-ref push check (Req 22.5) and buildPromptPreamble both read this so the agent and the router agree on the branch.
  worktree_path       TEXT,            -- absolute worktree dir, set at attempt start to '/tmp/agent-runs/<attempt_id>' (H2). A resume attempt (Req 18.6) reuses the retained worktree_path of the interrupted attempt and does NOT run `git worktree add`.
  pid                 INTEGER,         -- agent process id, recorded at spawn (HIGH-8: startup orphan reap)
  pgid                INTEGER,         -- agent process-group id (HIGH-8: group-kill on orphan reap)
  process_start_time  INTEGER,         -- /proc/<pid>/stat field 22 (clock ticks since boot) at spawn; used to verify PID identity before killing on reboot (HIGH-8)
  process_cmdline     TEXT,            -- stored agent command-line prefix (e.g. 'kiro-cli'/'node'); verified against /proc/<pid>/cmdline before killing (HIGH-8)
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  UNIQUE(task_id, attempt_no),
  -- CRITICAL-1 rule: failure_class is 'infra' exactly when outcome='failed' with an infra cause
  -- OR when outcome='interrupted'; NULL for every other outcome. Reason-code membership
  -- (the infra set) is enforced in application code; the table-level invariant below guarantees
  -- failure_class can only be non-NULL for the two outcomes that permit it.
  CHECK (
    (failure_class = 'infra' AND outcome IN ('failed','interrupted'))
    OR failure_class IS NULL
  )
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_attempts_running ON attempts(state) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS task_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  repo       TEXT,
  task_id    TEXT,
  attempt_id TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);

-- Persisted per-repo circuit-breaker state (Requirement 19). Loaded on daemon startup so a
-- repo paused before a restart stays paused. consecutive_failures and paused_until survive crashes.
CREATE TABLE IF NOT EXISTS repo_state (
  repo                 TEXT PRIMARY KEY,     -- 'owner/name'
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  breaker              TEXT NOT NULL DEFAULT 'closed' CHECK (breaker IN ('closed','open','half-open')),  -- HIGH-11
  paused_at            INTEGER,              -- unix ms when the breaker last opened; NULL when not paused (drives the time-based probe, Req 12.11/12.12)
  paused_until         INTEGER,              -- unix ms; optional explicit cooldown deadline; NULL when not paused
  updated_at           INTEGER NOT NULL
);
```

> **Table naming:** The brief names the event table `events`, but `src/db.ts` already owns an `events` table (GitHub webhook events). To avoid a collision in the same database, the new monotonic event log is named **`task_events`**. This is the one deliberate rename from the brief.

Transactional helpers (each wraps a `db.transaction(...)` so Requirement 15 holds):

```ts
export interface TaskDatabase {
  // tasks
  createTaskWithEvent(task: TaskInsert, event: EventInsert): { task: TaskRecord; created: boolean };
  // ^ UNIQUE(external_id) idempotency: if external_id exists, returns existing task with created=false and emits NO event
  getTask(id: string): TaskRecord | null;
  getTaskByExternalId(externalId: string): TaskRecord | null;
  listTasks(filter: { repo?: string; state?: TaskState }): TaskRecord[];
  setTaskState(id: string, state: TaskState, updatedAt: number, event?: EventInsert): void;

  // attempts
  // startAttemptWithEvent performs the HIGH-4 atomic claim-and-create in ONE transaction:
  // (1) conditional UPDATE tasks SET state='running' WHERE id=? AND state='queued' (0 rows → throws/returns null, caller skips),
  // (2) INSERT the attempt row (including worktree_branch = 'agent/<attempt_id>' fresh / 'agent/<original_attempt_id>' resume — HIGH-4),
  //     (3) emit attempt.started. The worktree is created by the caller AFTER this commits, using `git worktree add ... -b <worktree_branch>` read from the inserted column.
  startAttemptWithEvent(attempt: AttemptInsert, taskState: TaskState, event: EventInsert): AttemptRecord | null;
  // endAttemptWithEvent uses a CONDITIONAL UPDATE guarding against the attempt-end race (see below);
  // returns true if this call ended the attempt, false if it had already ended (0 rows affected → skip event).
  endAttemptWithEvent(id: string, patch: AttemptEndPatch, taskState: TaskState, event: EventInsert): boolean;
  refreshLeaseWithHeartbeat(id: string, leaseExpiresAt: number, event: EventInsert): void;
  getAttempt(id: string): AttemptRecord | null;
  getLatestAttempt(taskId: string): AttemptRecord | null;
  maxAttemptNo(taskId: string): number;
  findRunningAttempts(): AttemptRecord[];

  // repo circuit-breaker state (Requirement 19) — persisted, loaded on startup
  getRepoState(repo: string): RepoStateRecord | null;
  listRepoStates(): RepoStateRecord[];
  setRepoStateWithEvent(repo: string, patch: RepoStatePatch, event?: EventInsert): void;  // one txn (Req 19.3)

  // events
  appendEvent(event: EventInsert): TaskEventRecord;         // standalone (daemon.started, repo.paused/resumed)
  getEventsSince(seq: number, limit: number): TaskEventRecord[];
  maxEventSeq(): number;
}
```

`AttemptEndPatch` carries `outcome`, `failure_class`, `reason_code`, `reason`, optional `blocked` (JSON `{question, needs}`, persisted to the `attempts.blocked` column — HIGH-7), `artifacts` (JSON including `pr_url`, sourced from `endState.artifacts.pr_url` — HIGH-1/HIGH-5), `usage`, `agent_version`, `model`, and `ended_at`. It is the on-the-wire DB-write projection of the `AttemptEndState` passed to `teardownAttempt` (HIGH-1): `teardownAttempt` builds the `AttemptEndPatch` from `endState`, copying every present field including `artifacts.pr_url`. The `artifacts` field is **merged** into the attempt's existing stored `artifacts` (not overwritten) at write time (HIGH-C), so start-time artifacts (`branch`, `base_sha`, `transcript_ref`) survive an enforcer end that supplies `artifacts: undefined`.

#### Termination intent (HIGH-1 / HIGH-2)

Each enforcer — the wall-clock `timed_out` enforcer, the token/turn `budget_exceeded` enforcer, the API `cancel` path, **and the circuit-breaker cancel path** — **atomically sets an in-memory `termination_intent` on the attempt BEFORE it signals the process** (before closing the ACP connection / sending `SIGTERM`). What it does next depends on where the attempt is in its lifecycle, governed by the setup-window state machine of Requirement 4.1a (Rules 1–5):

- The **time-based enforcers** (`timed_out`, `budget_exceeded`) only ever run against an attempt that is already running with a recorded `pid`, so they set the intent and call `teardownAttempt(attempt_id, intent, /* skipKill */ false)` directly.
- The **cancel and breaker paths** are Rule 1 callers: they SHALL atomically set `termination_intent` FIRST (compare-and-set: only set if currently null — first-writer-wins, Rule 4), THEN read `pid` from the attempt row. IF `pid IS NOT NULL` they call `teardownAttempt(attempt_id, intent, /* skipKill */ false)`. IF `pid IS NULL` (the setup window is still open) they return without calling `teardownAttempt`; the spawner's post-spawn re-check (AttemptRunner start, step 6 — Rule 3) consumes the intent and performs the single real teardown once the `pid` exists. This SET-INTENT-FIRST-THEN-READ-PID ordering avoids the TOCTOU race in which the spawner records the pid between the read and the set.

**`teardownAttempt` itself NEVER inspects `termination_intent` and never branches on `attempts.pid` to decide whether to run (HIGH-A).** The decision to defer a pidless teardown lives in the *callers* (Rule 1 for cancel/breaker; Rule 2 for the lease checker and idle-timeout enforcer), not inside `teardownAttempt`. A setup that hangs past `setup_timeout_s` is reaped by Rule 2 (the next lease-checker or idle-timeout pass tears it down with `skipKill = false` once `now() >= attempts.started_at + setup_timeout_s × 1000`, so that an agent process that spawned just before the window expired is still reaped; `teardownAttempt` internally skips its kill steps when `pid IS NULL`), not by any logic inside `teardownAttempt`. `resolveOutcome` checks `terminationIntent` first (rule 0 in the ordered list): when it is set, the enforcer's outcome wins over any agent self-report or mechanical classification, closing the race where the agent emits a late `report_outcome` between the enforcer's decision and process exit.

**Rule 3 — the spawner's pid-record UPDATE also refreshes the lease (HIGH-2).** When the spawner records the process identity it refreshes `lease_expires_at` in the SAME transaction, anchored to `now()` rather than to `started_at`:

```sql
UPDATE attempts
   SET pid = ?, pgid = ?, process_start_time = ?, process_cmdline = ?,
       lease_expires_at = (? + 3 * heartbeat_interval_ms)   -- second ? is now() in ms
 WHERE id = ? AND state = 'running';
```

Heartbeats do not begin until after the agent spawns, so without this refresh the default lease (90 s) would expire before the `setup_timeout_s` budget (120 s) elapses, and the lease checker could mark a still-setting-up attempt `interrupted` at ~90 s. Setting `lease_expires_at = now() + 3 × heartbeat_interval_ms` at the moment the pid is recorded guarantees the lease outlives the setup window and only begins counting from the point the process actually exists.

`termination_intent` is a full `TerminationIntent | null`, not a bare outcome string (HIGH-2). A bare `AttemptOutcome` could carry only `'failed'` — it could not express the `reason_code`/`failure_class` that a breaker cancel needs (`{ outcome: 'failed', reasonCode: 'cancelled_by_breaker', failureClass: 'infra' }`). Carrying the full triple lets every enforcer-set intent name its exact outcome, reason code, and failure class:

```ts
export interface TerminationIntent {
  outcome: AttemptOutcome;                  // 'timed_out' | 'budget_exceeded' | 'cancelled' | 'failed'
  reasonCode: ReasonCode;                   // e.g. 'timed_out' | 'budget_exceeded' | 'cancelled_by_api' | 'cancelled_by_breaker'
  failureClass: FailureClass | null;        // 'infra' for cancelled_by_breaker; null for timed_out/budget_exceeded/cancelled_by_api
}

// in-memory only — NOT a column on `attempts` (Req 16.9)
interface RunningAttemptState {
  attemptId: string;
  pid: number;                              // for orphan cleanup (HIGH-8)
  pgid: number;                             // process-group id (HIGH-8)
  processStartTime: number;                 // /proc/<pid>/stat field 22 at spawn — PID-identity check on reboot (HIGH-8)
  processCmdline: string;                   // agent cmdline prefix at spawn — PID-identity check on reboot (HIGH-8)
  lastActivityTs: number;                   // last ACP tool call / message (drives idle timeout, HIGH-4)
  terminationIntent: TerminationIntent | null; // enforcer-set intent (HIGH-1 / HIGH-2)
  reported: ReportOutcomePayload | null;    // agent's report_outcome / outcome.json payload, incl. pr_url (HIGH-5)
}

// Decoded report_outcome payload (MCP tool args / outcome.json), carried over the socket wire
// payload { op:'report_outcome', ... } and recorded on RunningAttemptState (HIGH-5).
interface ReportOutcomePayload {
  outcome: 'succeeded' | 'failed' | 'blocked';
  reason_code?: ReasonCode;
  reason?: string;
  blocked?: Blocked;
  pr_url?: string;                          // HIGH-5: forwarded end-to-end into artifacts.pr_url
}
```

Enforcer intents by path:

| Path | `termination_intent` |
|---|---|
| wall-clock / idle `timed_out` enforcer | `{ outcome: 'timed_out', reasonCode: 'timed_out', failureClass: null }` |
| token/turn `budget_exceeded` enforcer | `{ outcome: 'budget_exceeded', reasonCode: 'budget_exceeded', failureClass: null }` |
| API `cancel` | `{ outcome: 'cancelled', reasonCode: 'cancelled_by_api', failureClass: null }` |
| **circuit-breaker cancel** (HIGH-2 / Req 12.9) | `{ outcome: 'failed', reasonCode: 'cancelled_by_breaker', failureClass: 'infra' }` |

`terminationIntent` lives only for the running attempt's lifetime; the exactly-once write is still guaranteed by the conditional UPDATE below. The two mechanisms are complementary: `terminationIntent` decides *which outcome/reason/class* a racing end carries; the conditional UPDATE decides *which caller* actually writes it. Because the breaker cancel sets a `termination_intent`, a breaker-killed attempt whose ACP returns `stopReason = 'cancelled'` is classified as `failed`/`cancelled_by_breaker` (retry-eligible, breaker-counted) rather than terminal `cancelled` — the intent at rule 0 wins over the ACP stop reason at step 4.

#### Attempt-end race condition (HIGH-5)

Several code paths can try to end the same attempt concurrently: the agent reporting its outcome, the budget enforcer (timeout / token limit), the lease checker, a cancel, and the circuit breaker. To make attempt-end exactly-once, `endAttemptWithEvent` performs a **conditional UPDATE**:

```sql
UPDATE attempts
   SET state = 'ended', outcome = ?, failure_class = ?, reason_code = ?, reason = ?,
       blocked = ?, artifacts = ?, usage = ?, agent_version = ?, model = ?, ended_at = ?
 WHERE id = ? AND state = 'running';
```

The `artifacts = ?` bind value is the **merge** of `endState.artifacts` over the attempt's existing stored `artifacts` (`{ ...JSON.parse(attempt.artifacts ?? '{}'), ...endState.artifacts }`, HIGH-C), computed inside the same transaction before the UPDATE binds, so start-time artifacts (`branch`, `base_sha`, `transcript_ref`) are never dropped by an enforcer end that supplies no `artifacts`. If the UPDATE affects **0 rows**, the attempt has already ended; the helper returns `false` and the caller **skips** emitting `attempt.ended` and skips the task-state transition. The whole operation (UPDATE + the task-state write + the `attempt.ended` event) runs inside one `db.transaction(...)`, so a losing racer observes 0 rows and makes no changes at all.

Idempotent submission (Requirement 1.3/1.4) is implemented inside `createTaskWithEvent` as a single transaction: `SELECT ... WHERE external_id = ?`; if found, return it with `created = false` and emit nothing; else `INSERT` the task and the `task.queued` event. The `UNIQUE(external_id)` constraint is the backstop against a concurrent double-insert; the transaction catches the constraint error and re-reads.

#### `teardownAttempt` — the single running→ended transition (Requirement 16.10)

`teardownAttempt(attemptId, endState: AttemptEndState, skipKill = false)` is the single end path (tasks.md 5.3a). It performs the running→ended transition, the process kill, worktree cleanup, and event emission in exactly one place. **It NEVER inspects `termination_intent` and never branches on `attempts.pid` to decide whether to run** — those decisions belong to the callers (Requirement 4.1a Rules 1–2). The function is four steps:

```ts
function teardownAttempt(attemptId: string, endState: AttemptEndState, skipKill = false): void {
  // Step 0 — conditional end-claim: the ONLY running -> ended transition.
  const claimed = db.transaction(() => {
    const rows = endAttemptWithEvent(attemptId, endState);  // UPDATE ... WHERE id=? AND state='running'
    return rows === 1;                                       // merges endState.artifacts over existing (HIGH-C)
  });
  if (!claimed) return;                                      // already ended by another path — no kill/worktree/event

  // Step 1 — kill the process (skippable).
  if (!skipKill && attempt.pid != null) {
    closeAcp(attemptId);
    verifyPidIdentity(attempt);                              // HIGH-8
    killProcessGroup(attempt.pgid, 'SIGTERM');               // 5s grace, then SIGKILL (Req 16.7)
  }

  // Step 2 — worktree cleanup (Req 18 rules; retain on git_push_failed / interrupted+allow_resume).
  cleanupWorktree(attempt, endState);                        // git worktree remove --force

  // Step 3 — emit attempt.ended (same transaction as Step 0's end-claim).
  // Step 4 — onAttemptEnded: update breaker (Req 12.5, honoring countsTowardBreaker) + release slot + task-state transition.
  onAttemptEnded(endState);
}
```

- **Step 0 — Conditional end-claim.** `UPDATE attempts SET state='ended', outcome=…, … WHERE id=? AND state='running'`. IF 0 rows change, return immediately — another concurrent path already ended the attempt. This is the only place that moves an attempt from `running` to `ended`. The `artifacts` bind value is the **merge** of `endState.artifacts` over the attempt's existing stored `artifacts` (HIGH-C), so start-time artifacts (`branch`, `base_sha`, `transcript_ref`) survive an enforcer end that supplies no `artifacts`.
- **Step 1 — Kill the process (skippable).** Runs only when `skipKill === false` AND `attempt.pid != null`: close the ACP connection, verify PID identity (HIGH-8), `SIGTERM` the process group, 5s grace, `SIGKILL` (Req 16.7). `skipKill === true` and `pid == null` (no process ever spawned) both skip this step. `skipKill === true` is passed by exactly two kinds of caller, both where no agent process can meaningfully be killed: (1) **restart recovery** (Req 13.12), where the process is already dead post-reboot and the stored `process_start_time` can never match a recycled PID; and (2) **pre-session infra failures** (`spawn_failed`/`auth_failed`/`rate_limited`; Req 22.8a / AttemptRunner start step 7), where fork/exec or GitHub setup validation failed before any process was created. The Rule 2 setup-window-expiry paths (lease checker / idle-timeout, Req 4.1a / 4.5 / 17.6) and the setup-timeout hang path (Req 4.1c) pass `skipKill = false` because a spawned process may already be alive; when they target a still-pidless attempt the `pid == null` guard skips the kill anyway, but once a pid is recorded the kill steps reap it.
- **Step 2 — Worktree cleanup.** `git worktree remove --force` per the Requirement 18 rules, EXCEPT the Requirement 18.4 retention cases (`reason_code === 'git_push_failed'`, or `outcome === 'interrupted'` with `allow_resume === true`). `--force` cleans a partially-created worktree from a mid-setup `spawn_failed` (HIGH-3).
- **Step 3 — Emit `attempt.ended`**, in the same SQLite transaction as Step 0.
- **Step 4 — `onAttemptEnded(endState)`** updates the circuit breaker (honoring `endState.countsTowardBreaker`, H4), releases the repo slot, and emits the task-state transition.

Steps 0, 3, and 4 are one SQLite transaction (Requirement 15.1); Steps 1–2 are the process/filesystem side effects run only when Step 0 claimed the end. The function is idempotent and race-safe by virtue of Step 0.

Because `teardownAttempt` does not defer pidless calls, a cancel/breaker that must not tear down an attempt still in the setup window makes that decision in Rule 1 (atomically set intent via compare-and-set FIRST, THEN read `pid`; return if `pid IS NULL`), and the lease checker / idle-timeout enforcer make it in Rule 2 (skip while the window is open, else tear down with `skipKill = false`, since an agent process may already be alive at window expiry; `teardownAttempt` internally skips its kill steps when `pid IS NULL`). A setup that hangs past `setup_timeout_s` is reaped by Rule 2, and the spawner's conditional `pid` UPDATE (AttemptRunner start step 5 — Rule 3) handles the lost race if its setup completes after that teardown.

### 4. Task service — `src/task-service.ts`

Owns the task state machine (Requirement 3) and submission validation (Requirement 1). Pure functions are exported for Tier 1 testing:

```ts
export function validateSubmitBody(body: unknown, configuredRepos: Set<string>):
  | { valid: true; value: NormalizedSubmit }
  | { valid: false; code: string; message: string };
export function parseBudget(raw: unknown): { valid: true; value: Budget } | { valid: false; message: string };
export function nextTaskStateForOutcome(outcome: AttemptOutcome): TaskState;
// Req 3.3–3.6: succeeded→succeeded; failed/timed_out/budget_exceeded/interrupted→failed;
// blocked→blocked; cancelled→cancelled. interrupted maps to failed (reason_code='interrupted'),
// NOT queued — an interruption is infrastructural but is never auto-retried (CRITICAL-3 /
// Req 3.4 / Req 5.3 / Req 13.9); the orchestrator retries explicitly via POST /v1/tasks/:id/attempts.
export function canRetry(state: TaskState): boolean;    // failed | blocked
export function canCancel(state: TaskState): boolean;   // not succeeded/cancelled
```

`submitTask` composes validation → `createTaskWithEvent` → hand to `RepoScheduler.enqueue`. `cancelTask` and `retryTask` enforce the 409 rules (Requirement 5).

**`cancelTask` with a running attempt is a Rule 1 caller of the setup-window state machine (Requirement 4.1a / 5.4).** The cancel SHALL atomically set `termination_intent = { outcome: 'cancelled', reasonCode: 'cancelled_by_api', failureClass: null }` FIRST (compare-and-set: only set if currently null — first-writer-wins, Rule 4), THEN read `pid` from the attempt row. IF `pid IS NOT NULL` it calls `teardownAttempt(attempt_id, intent, /* skipKill */ false)` directly, which tears the running process down immediately (close ACP, `SIGTERM`→5s→`SIGKILL`, worktree cleanup, `attempt.ended` + `task.cancelled`). IF `pid IS NULL` (the setup window is still open) it returns `202` WITHOUT calling `teardownAttempt`; Rule 3 consumes the intent on the pid record — the spawner's post-spawn re-check (AttemptRunner start, step 6 — Rule 3) performs the single real teardown once the `pid` exists. Setting the intent BEFORE reading `pid` avoids the TOCTOU race in which the spawner records the pid between the read and the set: were the order reversed, a pidless cancel could read `pid IS NULL`, the spawner could then record the `pid` and find no intent, and the cancel would be lost while the process ran on unattended. The breaker cancel in `RepoScheduler` (above) is the identical Rule 1 pattern with the breaker intent.

**Retry does not start an attempt directly (CRITICAL-2).** `retryTask` only validates that the task is `failed`/`blocked`, moves it back to `queued` (via `setTaskState`), returns `202`, and calls `RepoScheduler.enqueue`. The new attempt row is created **only** when the scheduler claims the task — exactly like a first run. This guarantees the per-repo concurrency guard (Requirement 12.2) and the circuit breaker (Requirement 12.6) are always consulted before a retry attempt starts, so a retry can never bypass a full slot or an open breaker.

### 5. Attempt runner — `src/attempt-runner.ts`

Starts and finishes attempts; it is the only component that drives the existing `SessionManager`/`AgentAdapter`.

Start (Requirement 4.1–4.2, HIGH-4). The claim-and-create order is **attempt-row-first, worktree-after-commit** — matching Requirement 22.7a so that even a pre-session setup/spawn failure (which happens before any worktree exists) has an attempt row to record its outcome against:

1. **Claim the task atomically:** `UPDATE tasks SET state='running', updated_at=? WHERE id=? AND state='queued'` (Requirement 12.13). IF 0 rows change, the task was already claimed or cancelled — skip, create no attempt row.
2. **Insert the attempt row** (`state='running'`, `attempt_no` = max + 1, `lease_expires_at`, `started_at`, `prompt_hash = sha256(task.spec)`) — in the **same transaction** as step 1.
3. **Emit `attempt.started`** — in the same transaction as steps 1–2 (`startAttemptWithEvent` performs steps 1–3 as one `db.transaction`).
4. **Create (or reuse) the worktree AFTER the transaction commits** (see **Worktree lifecycle** below): for a **fresh (non-resume) attempt** run `git worktree add /tmp/agent-runs/<attempt_id> -b <worktree_branch> <base_ref>` — the `-b <worktree_branch>` flag names the new branch, where `worktree_branch` is the value read from the attempt's `attempts.worktree_branch` column set during `startAttemptWithEvent` (`agent/<attempt_id>` for a fresh attempt; the spawner SHALL NOT hardcode `agent/<attempt_id>`), then record `base_sha` and set `attempts.worktree_path = /tmp/agent-runs/<attempt_id>`; for a **resume attempt** (Req 18.6) do NOT run `git worktree add` — reuse the interrupted attempt's retained `worktree_path` and copy `worktree_branch`/`artifacts.base_sha` forward. Then delete any stale `.agent-router/outcome.json`; then run the GitHub setup validation and spawn the agent process.
5. **Record the agent process identity AND refresh the lease via a conditional UPDATE (Requirement 4.1a Rule 3).** As soon as the process is spawned the spawner SHALL write `pid`, `pgid`, `process_start_time` (`/proc/<pid>/stat` field 22), and `process_cmdline` to the attempt row AND refresh `lease_expires_at` in the SAME transaction with a conditional UPDATE guarded on the still-running state:

   ```sql
   UPDATE attempts
      SET pid=?, pgid=?, process_start_time=?, process_cmdline=?,
          lease_expires_at = (? + 3 * heartbeat_interval_ms)   -- second ? is now() in ms
    WHERE id=? AND state='running';
   ```

   Refreshing `lease_expires_at` to `now() + 3 × heartbeat_interval_ms` at the moment the pid is recorded (anchored to NOW, not to `started_at`) prevents a premature lease expiry: heartbeats do not begin until after the agent spawns, so the default 90 s lease would otherwise elapse before the 120 s `setup_timeout_s` budget and the lease checker could mark a still-setting-up attempt `interrupted` at ~90 s. This also atomically disarms the `setup_timeout_s` timer (Rule 5): once the pid is recorded, any timeout that fires afterward is a no-op. Recording the pid before the step-6 intent re-check guarantees that a `termination_intent` set by a Rule 1 cancel during the setup window has a `pid`/`pgid` to signal when the spawner tears the attempt down.

   **Lost-race detection (Rule 3).** The lease checker / idle-timeout enforcer can end an attempt *while its setup is still in flight* — once `now() >= started_at + setup_timeout_s × 1000`, Rule 2 ends the attempt with `skipKill = false` (so a process that spawned just before the window expired is reaped; `teardownAttempt` internally skips its kill steps while `pid` is still NULL) even though `pid` may still be NULL. The conditional `pid` UPDATE is how the spawner detects it lost that race: **IF the UPDATE affects 0 rows** (the attempt is already `ended`), the spawner SHALL kill its own just-spawned child (`kill(pgid, SIGKILL)`), run `git worktree remove --force` on the worktree it created, and **return without sending the prompt and without re-checking `termination_intent`** — cleaning up its own child and worktree instead of orphaning them. Only when the UPDATE affects 1 row (the attempt is still `running`) does the spawner proceed to step 6.
6. **Re-check `termination_intent`, before sending the initial prompt (Requirement 4.1a Rule 3).** Between the step-1 claim (which set `tasks.state='running'`) and this point, a Rule 1 cancel or breaker cancel may have set `termination_intent` on the attempt (it set the intent and returned without calling `teardownAttempt` because `pid` was NULL). With the `pid`/`pgid` now recorded (step 5), the spawner re-reads `termination_intent`. IF it is set, the spawner **immediately calls `teardownAttempt(attempt_id, intent, /* skipKill */ false)` WITHOUT sending the prompt** — the pid recorded in step 5 means teardown has a process to kill via the normal SIGTERM→5s→SIGKILL path — and returns; the agent never runs against an already-cancelled attempt and nothing is orphaned. **This re-check is the sole place a Rule 1 setup-window cancel is actually torn down.** IF it is unset, the spawner sends `buildPromptPreamble(task, attempt_id, worktree_branch) + "\n\n" + task.spec` as the prompt, where `worktree_branch` is the value stored in the attempt's `attempts.worktree_branch` column (the attempt id and `worktree_branch` are passed so the preamble can print the exact `git push origin <worktree_branch>` command, HIGH-4/HIGH-7 — `agent/<attempt_id>` fresh, `agent/<original_attempt_id>` resume). (A cancel/breaker that arrives after the `pid` is recorded is a Rule 1 `pid IS NOT NULL` call: it tears the attempt down directly, and this re-check then simply finds the attempt already `ended` and the spawner stops.)
7. **IF worktree creation (or the setup/spawn) fails:** end the already-created attempt by routing through `teardownAttempt`, but **first check `termination_intent` to decide the endState (HIGH-B).** A setup/spawn failure can race a Rule 1 cancel: an API or breaker cancel may already have set `termination_intent` on the attempt during the setup window (Req 4.1a Rule 1 / 5.4 / 12.9). If the spawner then constructed a plain infra-failure endState and passed it to teardown, the pending cancellation would be silently dropped and the attempt would end `failed`/retry-eligible instead of `cancelled`. To prevent that, the spawner SHALL pass the **higher-priority of (`termination_intent`, the infra-failure endState)** to teardown, with `termination_intent` taking precedence via nullish coalescing:

   ```ts
   const infraFailure = { outcome: 'failed', reasonCode: <code>, failureClass: 'infra' } as const;
   await teardownAttempt(attempt_id, terminationIntent ?? infraFailure, /* skipKill */ true);
   ```

   where `<code>` is the infra reason code (`spawn_failed` for a worktree/spawn error; `auth_failed`/`rate_limited` for a setup HTTP error) and `terminationIntent` is the attempt's in-memory intent (or `null` when no cancel landed). The nullish coalescing ensures a pending cancellation intent wins over the infra failure outcome: a cancel landing during the setup window ends the attempt `cancelled`/`cancelled_by_api` (or `failed`/`cancelled_by_breaker` for a breaker cancel), and only when no intent is pending does the attempt end with the infra failure. The attempt row from step 2 is what the end is recorded against. **This path MUST NOT call `endAttemptWithEvent` directly (HIGH-2).** A direct `endAttemptWithEvent` would write the end row and emit `attempt.ended`, but it would **never call `RepoScheduler.onAttemptEnded`** — so the circuit-breaker counter would not increment (the breaker could never open on repeated setup failures) and the repo slot would not be released (slot leak). Routing through `teardownAttempt` fixes both: its step 8 calls `onAttemptEnded(endState)`, which increments `consecutive_failures` for the infra reason code (Requirement 12.5) and frees the slot. `skipKill = true` is correct here because the spawn failed before any (live) process existed to kill, so `teardownAttempt`'s SIGTERM/SIGKILL/ACP-close steps (2–5) and the PID-identity check are skipped; its conditional end-claim (step 1), `attempt.ended` + task-state events (steps 7–8), and worktree cleanup (step 6) still run. A `spawn_failed` here may leave a **partially-created worktree**; `teardownAttempt` step 6 removes it with `git worktree remove --force` (HIGH-3) even though `skipKill = true`.

This is the single ordering used throughout the spec (Requirements 4.1, 12.13, 22.7a); the worktree is never created before the attempt row exists.

**Bounded setup window (Requirement 4.1c).** Steps 4–6 (worktree creation through agent spawn and the intent re-check) are the *setup phase*. If a setup step hangs indefinitely — `git worktree add` blocked on a lock, a GitHub setup token fetch that never returns — the attempt would sit with `pid IS NULL` forever, holding its repo slot and blocking every queued task for that repo. Two cooperating mechanisms bound this (together with the spawner's lost-race detection in step 5 they form a closed loop — setup is time-bounded, Rule 2 reaps a hung setup, and the spawner handles the lost race):

1. **The spawner wraps the entire setup phase in a `try/finally` governed by a `setup_timeout_s` deadline** (config, default `120`; see `src/config.ts`). The setup work (worktree add, setup validation, spawn) races a timer of `setup_timeout_s`. IF the setup phase exceeds `setup_timeout_s`, OR any setup step throws, THEN the `finally` block ends the attempt by routing through `teardownAttempt` with the infra-failure endState (preferring any set `termination_intent` via the nullish-coalescing rule of step 7 — HIGH-B):

   ```ts
   const infraFailure = { outcome: 'failed', reasonCode: 'spawn_failed', failureClass: 'infra' } as const;
   await teardownAttempt(attempt_id, terminationIntent ?? infraFailure, /* skipKill */ false);
   ```

   `skipKill = false` here (Req 4.1c): a setup-timeout hang may leave an agent process alive, so `teardownAttempt` MUST run its kill steps to reap it (those steps are internally skipped when `pid IS NULL`). This differs from the step-7 pre-session infra path (`spawn_failed`/`auth_failed`/`rate_limited` before any process exists), which passes `skipKill = true`. So the setup phase can never hang indefinitely — it either spawns within the window or is torn down `failed`/`spawn_failed`/`infra` at the deadline, which (via `teardownAttempt` Step 4 → `onAttemptEnded`) frees the repo slot and increments the breaker counter.

2. **The lease checker and idle-timeout enforcer reap a hung setup via Rule 2** (Requirement 4.1a): a pidless attempt is SKIPPED while `now() < started_at + setup_timeout_s × 1000`, and once that window elapses it is torn down with `skipKill = false` (so a process that spawned just before the window expired is reaped; `teardownAttempt` internally skips its kill steps while `pid` is NULL). This is the independent backstop if the spawner's own `try/finally` timer never fires (e.g. the spawner process is itself wedged). The spawner's conditional `pid` UPDATE (step 5 above) is how a spawner that finishes setup *after* a Rule 2 teardown observes 0 rows, kills its own child, removes its worktree, and returns.

Heartbeat and lease window (Requirement 4.3–4.5, HIGH-4): a timer firing every `heartbeat_interval_s` (`budget.heartbeat_interval_s ?? 30`) calls `refreshLeaseWithHeartbeat`, which in one transaction writes `attempt.heartbeat` and sets

```
lease_expires_at = now + (3 × heartbeat_interval_s × 1000)
```

The lease window is **three** heartbeat intervals so the attempt tolerates up to two consecutive missed heartbeats before the lease is treated as expired. The initial lease is set the same way at attempt start. `turns_so_far`/`tokens_so_far`/`last_activity_ts` are tracked from ACP stream activity.

A **background lease checker** (own interval of `heartbeat_interval_s`) is a Rule 2 caller of Requirement 4.1a. It scans `state = 'running'` attempts: an attempt with `pid IS NULL` (still in the setup window) is handled by Rule 2 — SKIPPED while `now() < started_at + setup_timeout_s × 1000`, else torn down with `endState = terminationIntent ?? { outcome: 'failed', reasonCode: 'spawn_failed', failureClass: 'infra' }` and `skipKill = false` (an agent process may already be alive at window expiry; `teardownAttempt` internally skips its kill steps while `pid` is NULL). An attempt with `pid IS NOT NULL` whose `lease_expires_at < now` is ended via `teardownAttempt(id, { outcome: 'interrupted', reasonCode: 'interrupted', failureClass: 'infra' }, /* skipKill */ false)` (HIGH-3) — so it kills the still-running agent process (Step 1), not just the DB row, and races safely against a late heartbeat or a normal end through the Step 0 conditional UPDATE.

**Idle timeout — stuck agent (HIGH-4, Requirement 17.6).** Separately from the lease checker, the runner tracks `last_activity_ts` (the timestamp of the last ACP tool call or message). It is also a Rule 2 caller: a pidless attempt in the setup window is skipped-or-timed-out exactly as the lease checker handles it. For a running attempt (`pid IS NOT NULL`), when `now() - last_activity_ts > idle_timeout_s` (configurable, default `900`), the agent is treated as **stuck** (still connected but producing nothing): the runner sets `termination_intent = { outcome: 'timed_out', reasonCode: 'timed_out', failureClass: null }` (HIGH-2) and calls `teardownAttempt(id, intent, /* skipKill */ false)` (HIGH-3 — SIGTERM, 5s grace, SIGKILL, Req 16.7). This is distinct from the lease: the **lease expiry** detects a *daemon stall* (the daemon stopped writing heartbeats), while the **idle timeout** detects an *agent stall* (the daemon is healthy and heartbeating, but the agent itself has gone quiet). A `timed_out` idle end does not increment `consecutive_failures`.

Outcome resolution (Requirement 7), in strict priority:

```ts
// pure, exported
export function resolveOutcome(inputs: {
  terminationIntent?: TerminationIntent | null; // HIGH-1/HIGH-2: enforcer-set {outcome,reasonCode,failureClass}; when set, wins over everything below
  reported?: ReportOutcomePayload;          // from report_outcome tool (succeeded|failed|blocked only)
  outcomeFile?: unknown;                     // parsed .agent-router/outcome.json (succeeded|failed|blocked only)
  stopReason?: StopReason | null;            // real ACP enum: 'end_turn'|'max_tokens'|'max_turn_requests'|'refusal'|'cancelled' (or null)
  exitCode: number | null;                   // process exit code (null until process exit — ACP may end first, CRITICAL-1)
  hasDiff: boolean;                          // git rev-list --count <base_sha>..HEAD > 0 (CRITICAL-1)
  remoteBranchExists?: boolean | null;       // post-exit git ls-remote vs HEAD (HIGH-7): true=ref present AND SHA===HEAD→succeeded; false=absent or SHA≠HEAD→git_push_failed (counts); null=ls-remote itself failed→git_push_failed (does NOT count, Req 22.8)
}): { outcome: AttemptOutcome; failureClass: FailureClass | null; reasonCode: ReasonCode | null; reason: string; blocked?: Blocked; countsTowardBreaker?: boolean };
// countsTowardBreaker is omitted (⇒ treated as true) for every outcome EXCEPT the `git_push_failed`
// end where remoteBranchExists === null (ls-remote itself failed), for which it is explicitly `false`
// (Req 22.8 / H4). The non-counting outcomes (cancelled_by_api, timed_out, budget_exceeded,
// interrupted, no_changes, etc.) are already excluded by RepoScheduler's reason-code set, so they
// need not set this flag; it exists solely to express the ls-remote-null carve-out WITHIN the
// otherwise-counting git_push_failed reason code.
```

These outcomes are never **agent-declarable**: `timed_out`, `budget_exceeded`, `interrupted`, and `cancelled` cannot be supplied by the agent via `report_outcome` / `outcome.json` — any such attempt is rejected and falls through to mechanical classification (Requirement 7.1a, 7.7). The router still sets them itself: `timed_out`/`budget_exceeded` from the budget enforcer, `interrupted` from the lease checker / restart recovery, `cancelled` from an API cancel, and — within mechanical classification — `budget_exceeded` from an undeclared `max_turns` stop reason (rule 3 below). The agent-declarable set remains exactly `succeeded | failed | blocked`.

#### Infra-failure classification (CRITICAL-3, Requirement 22)

The circuit breaker only counts the infra reason-code set `{ spawn_failed, auth_failed, rate_limited, git_push_failed, adapter_crash }` (Requirement 12.5). Nothing produced those codes before, so the breaker could never open. Two cooperating checks produce them: `classifyPreSessionInfra` detects the **pre-session / adapter** infra failures (`spawn_failed`, `auth_failed`, `rate_limited`, `adapter_crash`) that happen before any agent self-report is possible, and a separate **post-exit remote-ref check** detects `git_push_failed` after the agent exits. `classifyPreSessionInfra` runs **after the agent session exits and before the self-report / mechanical classification**, taking the `SessionResult` (spawn error, exit code, captured stderr, ACP event count, and the result of any GitHub setup calls):

```ts
// classifyPreSessionInfra produces only the pre-session / adapter infra codes.
// git_push_failed is NOT produced here — it is a post-exit, post-self-report remote-ref
// check (step 5 of the merged order; Req 22.5 / 22.9).
export type PreSessionInfraReasonCode =
  | 'spawn_failed' | 'auth_failed' | 'rate_limited' | 'adapter_crash';

export interface SessionResult {
  spawnError?: NodeJS.ErrnoException;   // fork/exec error (ENOENT/EACCES/EPERM) when the agent CLI could not start
  exitCode: number | null;
  stderrTail?: string;                  // tail of agent stderr for auth-message detection
  acpEventCount: number;                // # of ACP events received before exit (0 ⇒ adapter never connected)
  setupHttpStatus?: number | null;      // HTTP status of GET /repos/:owner/:repo during session setup (401/403/429)
}

// pure, exported — returns a pre-session infra reason code or null (fall through to self-report / mechanical classification)
export function classifyPreSessionInfra(r: SessionResult): PreSessionInfraReasonCode | null;
```

Detection rules (first match wins):

| Condition | returns |
|---|---|
| `spawnError` is set — fork/exec threw `ENOENT`, `EACCES`, or `EPERM` (HIGH-3) | `spawn_failed` |
| `setupHttpStatus === 401` or `=== 403` (validated by `GET /repos/:owner/:repo` before the session starts), or `stderrTail` matches an auth-error pattern | `auth_failed` |
| `setupHttpStatus === 429` | `rate_limited` |
| `acpEventCount === 0` and `exitCode` is non-zero (ACP stdio closed with a non-zero exit before the first event — adapter never came up) | `adapter_crash` |
| otherwise | `null` |

> **`git_push_failed` is a post-exit remote-ref check at step 5, not part of `classifyPreSessionInfra` (CRITICAL-2 / HIGH-1 / HIGH-7).** Requirement 16.4 forbids the router from pushing; the agent pushes. So the router cannot observe the agent's push exit code. Instead, after the agent exits, after honoring any `termination_intent`, after the self-report, and after the ACP `stopReason` — i.e. at **step 5** of the merged order — and only when `hasDiff === true`, the runner runs `git ls-remote origin refs/heads/<worktree_branch>` in the worktree (`<worktree_branch>` = the attempt's stored `worktree_branch`: `agent/<attempt_id>` fresh, `agent/<original_attempt_id>` resume — HIGH-4), compares the returned SHA to the worktree `HEAD` (`git rev-parse HEAD`), and sets the three-valued `remoteBranchExists` (HIGH-7): **`true`** = ref present AND SHA equals `HEAD` → push fully landed → may be classified `succeeded`; **`false`** = ref absent OR SHA differs from `HEAD` (the agent pushed only partial work, or pushed early then committed more) → `git_push_failed` (increments the breaker counter); **`null`** = the `ls-remote` call itself failed (network/transport error, non-zero exit, no SHA) → `git_push_failed` but **does NOT** increment the counter (Req 22.8 — a transient check failure must not trip the breaker) and is never classified `succeeded`. `git_push_failed` is therefore **not** produced by `classifyPreSessionInfra` and never overrides a self-reported `succeeded` from steps 1–3. This check runs **before worktree removal**, and when it fires the worktree is **retained** for retry (Requirement 18.4 exception) rather than removed. The `spawn_failed`/`auth_failed`/`rate_limited`/`adapter_crash` conditions are evaluated first (steps 1–2) because they short-circuit before any commits could exist or any self-report could be made.

**Merged classification order (HIGH-2, Requirement 22.9).** The `AttemptRunner` end path evaluates a single fixed order and stops at the first producing step:

0. **`termination_intent`** (HIGH-1) — if an enforcer set it, that outcome wins over everything.
1. **spawn_failed / adapter_crash** — pre-start infra failures (the agent never ran / the adapter never connected), so no self-report was possible.
2. **auth_failed / rate_limited** — setup-phase infra failures detected by the pre-session GitHub `GET /repos/:owner/:repo` validation (before the agent starts).
3. **Self-report** via `report_outcome` or `.agent-router/outcome.json` (`resolveOutcome` rules 1–2).
4. **ACP `stopReason`** (`resolveOutcome` rule 3).
5. **git_push_failed** post-exit remote-ref check (`resolveOutcome` rule 4 / Requirement 22.5).
6. **`hasDiff` + `cleanEnd`** terminal checks (`resolveOutcome` rules 4–7).

So steps 1–2 (setup failures) **override** a self-report because they happen before any self-report could exist, while a self-report (step 3) **overrides** the mechanical steps 4–6. Concretely, `classifyPreSessionInfra` produces **only** the pre-session / adapter codes (`spawn_failed`/`adapter_crash` at step 1, `auth_failed`/`rate_limited` at step 2), both consulted *before* the self-report; `git_push_failed` is a **separate post-exit remote-ref check consulted at step 5** — after the self-report and the ACP `stopReason` — so it can never override a genuine self-reported `succeeded` (HIGH-1). Any infra end sets `outcome = 'failed'`, the infra `reason_code`, `failure_class = 'infra'`, and `RepoScheduler.onAttemptEnded` increments `consecutive_failures` (Requirement 12.5), which is what lets the breaker open. This resolves the earlier contradiction where a single `classifyInfraFailure` ran unconditionally after exit and could have overridden a genuine self-report.

#### Success path and mechanical classification (CRITICAL-1 + CRITICAL-2, Requirement 16)

An attempt ends when the ACP session reports a `stopReason` **or** the agent process exits, whichever comes first. Because the ACP `stopReason` can fire *before* the process exits, `exitCode` may be `null` at classification time; the ordered list below handles that case explicitly rather than assuming a non-null exit code.

At end, the runner computes `hasDiff` by **counting commits the agent made on top of the attempt's base commit**: `git rev-list --count <base_sha>..HEAD` in the worktree, where `<base_sha>` is the commit recorded at worktree creation (Requirement 18.2). `hasDiff = true` when that count is `> 0`. The daemon does **not** use `git status` / working-tree dirtiness (CRITICAL-1): a correct agent commits its work, leaving the tree clean, so a `git status` check would wrongly return no changes and no committing agent could ever reach `succeeded`.

`resolveOutcome` is an **ordered first-match list**. The first rule whose condition holds wins; evaluation stops there. This closes the gaps the old 5-row table left — `exit=0` + commits present + no self-report is covered (rule 4), a `null` exitCode is covered (rule 7 catch-all), and the rules no longer overlap.

Define `cleanEnd = (stopReason === 'end_turn') || (exitCode === 0)`.

| # | Condition (first match wins) | `outcome` | `reason_code` | `failure_class` |
|---|---|---|---|---|
| 1 | `report_outcome` tool declared a valid `succeeded`\|`failed`\|`blocked` | *(declared)* | per declared outcome¹ | per Req 6.8 |
| 2 | `.agent-router/outcome.json` declared a valid `succeeded`\|`failed`\|`blocked` | *(declared)* | per declared outcome¹ | per Req 6.8 |
| 3 | `stopReason` present AND no outcome declared: `max_tokens` or `max_turn_requests` | `budget_exceeded`² | `budget_exceeded` | `null` |
| 3 | `stopReason` present AND no outcome declared: `refusal` | `failed` | `agent_reported_failure` | `null` |
| 3 | `stopReason` present AND no outcome declared AND no `termination_intent`: `cancelled` | `failed`³ | `agent_error` | `null` |
| 3 | `stopReason` present AND no outcome declared: any other value | `failed` | `agent_error` | `null` |
| 3 | `stopReason` present AND no outcome declared: `end_turn` | *(fall to rule 4)* | — | — |
| 4 | `hasDiff` (`git rev-list` count `> 0`) — commits exist locally: run remote-ref+SHA check (Req 22.5) BEFORE worktree removal. `remoteBranchExists=false` (ref absent OR SHA ≠ `HEAD`) → push did not fully land, **retain worktree**, increments breaker | `failed` | `git_push_failed` | `'infra'` |
| 4 | `hasDiff` AND `remoteBranchExists=null` (`git ls-remote` itself failed — transient network error) → **retain worktree**, `countsTowardBreaker=false` so it does NOT increment the breaker (Req 22.8 / H4) | `failed` | `git_push_failed` | `'infra'` |
| 4 | `hasDiff` AND `remoteBranchExists=true` (ref present AND SHA === `HEAD` → full work pushed) | `succeeded` | `null` | `null` |
| 5 | `cleanEnd` AND no commits (`hasDiff = false`) AND no outcome declared | `failed` | `no_changes` | `null` |
| 6 | `exitCode !== null` AND `exitCode !== 0` AND no outcome declared | `failed` | `agent_error` | `null` |
| 7 | Catch-all (`exitCode === null` AND `stopReason` absent, ACP never connected) | `failed` | `agent_error` | `null` |

¹ Declared `succeeded` → `reason_code = null`; declared `failed` → `agent_reported_failure`; declared `blocked` → `agent_blocked` (`outcome = 'blocked'`, with the `{question, needs}` payload).

² `max_tokens` / `max_turn_requests` are budget overruns, recorded as the `budget_exceeded` outcome (the same outcome the budget enforcer of Requirement 17 emits), keeping the closed `outcome`→`reason_code` pairing of Requirement 6.8 intact. The parent task still lands in `failed` via `nextTaskStateForOutcome` (Req 3.4), so it is retry-eligible like any other failure.

³ A bare ACP `stopReason = 'cancelled'` with **no** `termination_intent` set maps to `failed`/`agent_error` (HIGH-2), **not** terminal `cancelled`: the agent must not be able to self-cancel into a terminal task state, and a legitimate cancel always arrives via an enforcer that sets `termination_intent` first (API cancel → `cancelled_by_api`; breaker cancel → `failed`/`cancelled_by_breaker`), which wins at rule 0 before this rule is ever reached. So the only way to reach this row is an agent-originated `cancelled` stop reason with no daemon-side intent, which is treated as an agent error.

The ACP `stopReason` enum is the real protocol enum: `end_turn | max_tokens | max_turn_requests | refusal | cancelled`. During normal ACP operation `exitCode` is `null` until the process exits, so the rules use `cleanEnd` (rule 5), an explicit `exitCode !== null` guard (rule 6), and an `exitCode === null && stopReason absent` catch-all (rule 7). Rules 1–2 are the agent-declared path (self-report wins over everything mechanical). Rule 3 interprets the ACP `stopReason` when the agent did not self-declare — note that `cancelled` without a `termination_intent` maps to `failed`/`agent_error` (footnote ³), since the agent cannot self-cancel. Rule 4 is the "committed" path, gated on a post-exit remote-ref check (CRITICAL-2). Rules 5–7 are terminal failure classifications.

**Process termination (CRITICAL-1, Req 16.7).** When budget limits are hit, `cancel` is called, or the `timed_out` enforcer fires, the daemon closes the ACP connection and sends `SIGTERM`, then waits up to 5 seconds for a clean exit before escalating to `SIGKILL`.

#### Single teardown path — `teardownAttempt()` (HIGH-3)

Every way an attempt can end — a normal `end_turn`, lease expiry, idle timeout, the `timed_out` enforcer, the `budget_exceeded` enforcer, an API `cancel`, and a circuit-breaker cancel — routes through **one** function so that process-kill, worktree cleanup, and event emission are specified in exactly one place. Previously these were scattered: the lease checker ended the attempt but never killed the agent; the normal `end_turn` path removed the worktree before the process had closed; and the breaker cancel had no specified kill mechanism. `teardownAttempt` unifies them.

```ts
// Idempotent and race-safe by virtue of ONE guard: the Step 0 conditional UPDATE
// (WHERE id=? AND state='running'), which makes the first caller win and every later caller a
// no-op. teardownAttempt does the running->ended transition only; it does NOT defer pidless
// calls — a caller that must not tear down an attempt still in the setup window makes that
// decision itself (Req 4.1a Rule 1 for cancel/breaker, Rule 2 for lease/idle) and does not call
// teardownAttempt at all until a pid exists.
//
// `endState` (HIGH-1) is the full AttemptEndState, not a bare TerminationIntent. Enforcer /
// cancel / breaker / lease paths pass only {outcome, reasonCode, failureClass} (a
// TerminationIntent, which is assignable to AttemptEndState since blocked/artifacts/usage are
// optional); the NATURAL end path (resolveOutcome) passes the full endState including the
// agent-reported pr_url inside `artifacts`, plus diff_stats/head_sha/transcript_ref and usage.
// endAttemptWithEvent (Step 0) writes ALL fields present on endState into the attempt row and
// the attempt.ended event payload.
//
// teardownAttempt NEVER inspects termination_intent and never branches on attempts.pid to decide
// whether to run — the setup-window deferral lives in the callers (Req 4.1a Rules 1-2), not here.
// `skipKill` (HIGH-2, default false) controls the process-kill of Step 1. When false (runtime
// teardowns) the PID-identity check and SIGTERM/SIGKILL run normally. When true (startup
// restart-recovery, where the process is already dead after a reboot and the stored
// process_start_time cannot match a recycled PID) Step 1 is SKIPPED, but worktree cleanup (Step 2)
// and the DB end-claim + events (Steps 0, 3, 4) still run.
export async function teardownAttempt(
  attemptId: string,
  endState: AttemptEndState,
  skipKill: boolean = false,
): Promise<void>;
```

Steps, in order. `teardownAttempt` NEVER inspects `termination_intent` and never branches on `attempts.pid` to decide whether to run — the setup-window deferral is the callers' responsibility (Req 4.1a Rules 1–2):

0. **Conditional end-claim — the ONLY running→ended transition.** Run `endAttemptWithEvent`'s conditional `UPDATE attempts SET state='ended', ... WHERE id=? AND state='running'`, writing **every field present on `endState`** — `outcome`, `reason_code`, `failure_class`, the `blocked` JSON (only when `outcome='blocked'`), and the `artifacts` JSON (including `endState.artifacts.pr_url`, HIGH-1) and `usage` JSON — into the attempt row (HIGH-1). IF **0 rows** change, the attempt has already ended — **return immediately** (another end path won the race); emit nothing, kill nothing, touch no worktree. **The `artifacts` write MERGES `endState.artifacts` into the existing stored `artifacts` rather than overwriting it (HIGH-C):**

   ```ts
   const existing = JSON.parse(attempt.artifacts ?? '{}');
   const merged = { ...existing, ...endState.artifacts };
   // UPDATE attempts SET artifacts = JSON.stringify(merged), ... WHERE id=? AND state='running'
   ```

   This preserves the `branch`, `base_sha`, and `transcript_ref` written into `artifacts` at attempt start (Worktree lifecycle "Create") when an enforcer path (`timed_out`, `cancelled`, lease expiry) calls `teardownAttempt` with `endState.artifacts === undefined` — a raw overwrite would lose those start-time artifacts. A natural end's `endState.artifacts` (carrying `pr_url`, `head_sha`, `diff_stats`) is layered on top of the start-time artifacts.
1. **Kill the process (skippable).** Runs only when `skipKill === false` AND `attempt.pid != null`: (a) close the ACP stdio connection; (b) verify PID identity (the HIGH-8 `/proc/<pid>/stat` field-22 start-time + `/proc/<pid>/cmdline` prefix check) and `SIGTERM` the process group via the stored `pid`/`pgid` so child processes die too; (c) wait up to 5 seconds for a clean exit; (d) `SIGKILL` the `pgid` if still alive (Req 16.7). WHEN `skipKill === true` (startup restart recovery, where the process is already dead after a reboot and the stored `process_start_time` cannot match a recycled PID) OR `pid == null` (no process was ever spawned) this entire step — including the PID-identity check — is SKIPPED.
2. **Remove the worktree** (`git worktree remove --force`) — the `--force` flag handles a **partially-created worktree** from a mid-setup `spawn_failed` (HIGH-3). EXCEPT the Req 18.4 retention cases: `endState.reasonCode === 'git_push_failed'`, or `endState.outcome === 'interrupted'` with the task's `allow_resume === true` (HIGH-5). In those cases the worktree is retained for retry/resume. *(Runs regardless of `skipKill`.)*
3. **Emit `attempt.ended`** with the full `endState` payload — `outcome`/`reasonCode`/`failureClass` plus `blocked`/`artifacts` (incl. `pr_url`)/`usage` when present (HIGH-1) — written in the same transaction as Step 0's UPDATE.
4. **Emit the task state transition** (`nextTaskStateForOutcome(endState.outcome)` → `task.*` event), also in the Step 0 transaction, and notify `RepoScheduler.onAttemptEnded(endState)` so the slot frees and the breaker counter updates. **`teardownAttempt` SHALL forward `endState.countsTowardBreaker` (defaulting to `true` when omitted) to `onAttemptEnded` (H4)**, so that the circuit-breaker increment logic can honor the Req 22.8 carve-out: a `git_push_failed` end with `countsTowardBreaker === false` (its `remoteBranchExists` was `null` — a transient `ls-remote` failure) frees the slot and transitions the task like any other failure but does NOT increment `consecutive_failures`. For every other end `countsTowardBreaker` is `true`/omitted and the existing reason-code set (`{spawn_failed, auth_failed, rate_limited, git_push_failed, adapter_crash}`) governs whether the counter increments.

Steps 0, 3, and 4 are the single `db.transaction(...)` (Requirement 15.1); Steps 1–2 are the out-of-transaction process/filesystem effects that run only when Step 0 claimed the end (and Step 1 only when `skipKill === false` and a `pid` exists). A normal `end_turn` end is just `teardownAttempt(id, endStateFromClassification)` where the `endState` is the full outcome produced by the ordered classifier (carrying the agent-reported `pr_url`/artifacts/usage, HIGH-1) rather than an enforcer intent; the enforcer/cancel/breaker/lease paths pass the `TerminationIntent` they set at rule 0 (which is assignable to `AttemptEndState`, blocked/artifacts/usage omitted). For a normal end the agent process has usually already exited, so Step 1's signals are no-ops.

The **agent** is responsible for committing its work, pushing the branch, and opening the PR. The router does not commit/push/open-PR for attempt work; it only *observes* `pr_url` from the `report_outcome` payload or `.agent-router/outcome.json` and stores it in `artifacts.pr_url` (null when absent).

`failureClass = 'infra'` is derived from the infra reason-code set (`spawn_failed, auth_failed, rate_limited, git_push_failed, adapter_crash`, plus `cancelled_by_breaker`), and additionally for `outcome = 'interrupted'` (`reason_code = 'interrupted'`), per Requirement 6.2/6.3/6.8.

#### Budget enforcement — timed_out and budget_exceeded (HIGH-3, Requirement 17)

The runner evaluates the task's budget on every heartbeat tick (and on ACP token/turn activity):

- **Wall clock:** when `usage.wall_ms > budget.max_wall_s × 1000`, close the ACP connection, send `SIGTERM` to the agent process, wait up to 5s for a clean exit then `SIGKILL` (Req 16.7), and end the attempt with `outcome = 'timed_out'`, `reason_code = 'timed_out'`, `failure_class = null`.
- **Tokens / turns:** when tokens exceed `budget.max_tokens` or turns exceed `budget.max_turns`, close the ACP connection and send `SIGTERM` (5s grace then `SIGKILL`, Req 16.7) and end the attempt with `outcome = 'budget_exceeded'`, `reason_code = 'budget_exceeded'`, `failure_class = null`.

Absent limits are treated as unbounded. Both budget-enforced ends transition the task to `failed` (retry-eligible) and do **not** increment `consecutive_failures` (Requirement 12.5). Both go through the conditional-UPDATE `endAttemptWithEvent`, so they race safely against a normal end.

#### Worktree lifecycle (HIGH-11, Requirement 18)

- **Create (attempt start):** `git worktree add /tmp/agent-runs/<attempt_id> -b <worktree_branch> <base_ref>`, where `<base_ref>` is `task.base_ref` or the repo default branch when absent, and `<worktree_branch>` is the value read from the attempt's `attempts.worktree_branch` column (set during `startAttemptWithEvent`): `agent/<attempt_id>` for a fresh attempt or `agent/<original_attempt_id>` for a resume (HIGH-4). The `-b <worktree_branch>` flag both creates and checks out that branch from `<base_ref>`; the spawner SHALL NOT hardcode `agent/<attempt_id>`. The same branch name is recorded in `artifacts.branch` (equal to the `attempts.worktree_branch` column, HIGH-4), and the resolved base commit (`git rev-parse HEAD` in the fresh worktree) is recorded in `artifacts.base_sha` so attempt-end can compute `hasDiff` via `git rev-list --count <base_sha>..HEAD` (CRITICAL-1). **Resume exception (HIGH-5(c) / HIGH-4 / H2):** a `resuming` attempt (`tasks.resume_session_id IS NOT NULL`) does NOT run `git worktree add` at all — running `git worktree add -b <branch>` would fail because `agent/<original_attempt_id>` already exists, ending the attempt `spawn_failed`. Instead it reuses the retained worktree directory (read from the interrupted attempt's `attempts.worktree_path`, retained via the Req 18.4 `interrupted` + `allow_resume` exception) and the original branch `agent/<original_attempt_id>`; the resume attempt row copies `worktree_branch`, `worktree_path`, and `artifacts.base_sha` forward from the interrupted attempt (so `base_sha` is NOT re-derived as `HEAD` — pre-crash commits still count toward `hasDiff` and the resume is not misclassified `no_changes`). Both `attempts.worktree_branch` and `artifacts.branch` for the resume attempt therefore record the original branch, which is the single value fed to `buildPromptPreamble` (so the agent is told the right push target) and to the post-exit push check (so the router inspects the branch the agent actually pushed to).
- **Anti-spoof:** before the session starts, delete any pre-existing `.agent-router/outcome.json` in the worktree so a stale file cannot spoof the outcome.
- **Cleanup:** `teardownAttempt` Step 2 (HIGH-3) removes the worktree (`git worktree remove --force`) after the end is claimed — EXCEPT (Req 18.4): when the end was `failed`/`git_push_failed` (commits exist locally but the remote branch is absent, CRITICAL-2) the worktree is **retained** so a retry can re-push the already-committed work; and when `outcome = 'interrupted'` AND `allow_resume = true` the worktree is retained for the resumed session (HIGH-5).

End (Requirement 4.6): every end path routes through `teardownAttempt` (HIGH-3), whose Step 0 transaction writes the attempt end patch (including the `blocked` JSON when `outcome = 'blocked'`), the task's next state (`nextTaskStateForOutcome` — note `interrupted` maps the task to `failed` with `reason_code = 'interrupted'`, NOT back to `queued`; CRITICAL-3 / Req 3.4 / Req 13.9), and the `attempt.ended` event. Only when that transaction claims the end does `teardownAttempt` close the ACP connection, kill the agent process (SIGTERM→5s→SIGKILL, when `skipKill === false` and a `pid` exists), clean up the worktree (subject to the Req 18.4 retention exceptions), and notify `RepoScheduler` (freeing the slot and updating the breaker counter per Requirement 12.5). An `interrupted` end does NOT re-enqueue the task — it waits for an explicit `POST /v1/tasks/:id/attempts` retry, so a poison-pill task cannot crash-loop the daemon.

### 6. Repo scheduler + circuit breaker — `src/repo-scheduler.ts`

In-memory per-repo state keyed by `owner/name`:

```ts
interface RepoSlotState {
  inUse: number; limit: number;                        // Req 12.1 (in-memory slot count)
  breaker: 'closed' | 'open' | 'half-open';            // mirrored from repo_state (persisted, HIGH-11)
  consecutiveFailures: number;                         // mirrored from repo_state (persisted)
  pausedAt: number | null;                             // when the breaker last opened; drives the probe window (HIGH-11)
  pausedUntil: number | null;                          // optional explicit cooldown deadline; mirrored from repo_state
}
```

Slot counts are in-memory (rebuilt from the DB on restart). Breaker state (`consecutiveFailures`, `breaker`, `pausedAt`, `pausedUntil`) is the mirror of the persisted `repo_state` row (HIGH-9); every breaker transition writes `repo_state` and the `repo.paused`/`repo.resumed` event in the same transaction (`setRepoStateWithEvent`, Requirement 19.3).

- `enqueue(task)` and `onAttemptEnded(repo, attemptEnd)` drive slot acquisition and breaker transitions.
- Pure `breakerTransition(state, attemptEnd, threshold)` → next breaker state + whether to emit `repo.paused`/`repo.resumed`. The counter increments **only when `attemptEnd.reasonCode` is in the infra reason-code set** `{ spawn_failed, auth_failed, rate_limited, git_push_failed, adapter_crash }` (CRITICAL-3 / Requirement 12.5) **AND `attemptEnd.countsTowardBreaker !== false`** (H4): such an end increments `consecutiveFailures`, and reaching `threshold` opens the breaker (records `pausedAt = now`) and emits `repo.paused`. Ends with `cancelled_by_api`, `cancelled_by_breaker`, `timed_out`, `budget_exceeded`, `interrupted`, or `no_changes` leave the counter unchanged (their reason codes are outside the infra set). The `attemptEnd` input carries the `countsTowardBreaker` flag forwarded by `teardownAttempt` from `AttemptEndState` (H4): it defaults to `true` (omitted ⇒ true), and is set **`false` only for a `git_push_failed` whose `remoteBranchExists === null`** (the transient `ls-remote` failure of HIGH-7 / Req 22.8), so `breakerTransition` leaves the counter unchanged in that one case even though the reason code is `git_push_failed`. `onAttemptEnded` receives the full `AttemptEndState` so it can read `reasonCode` and `countsTowardBreaker` together.
- **Success-driven auto-reset (HIGH-11 / Requirement 12.10).** An `outcome = 'succeeded'` end resets `consecutiveFailures` to 0; if the breaker was `open` or `half-open`, it transitions to `closed`, clears `pausedAt`/`pausedUntil`, and emits `repo.resumed` with `reset_by = 'auto'`.
- **Time-based probe (HIGH-11 / Requirement 12.11).** After `circuit_breaker_timeout_s` (default 3600) since `pausedAt`, the scheduler MAY move an `open` breaker to `half-open` and admit exactly **one** probe attempt. A `succeeded` probe closes the breaker (above); a probe that fails with an infra reason code returns the breaker to `open` and resets `pausedAt = now`. At most one in-flight probe is allowed while `half-open`.
- `statusSnapshot(repo)` feeds `GET /v1/repos/:owner/:name/status` and returns the **flat** shape of Requirement 21.2 (HIGH-10) — not a nested `breaker` object: `{ repo, circuit_breaker_state: 'closed'|'open'|'half-open', consecutive_failures, paused_until: number|null, slots_total, slots_in_use }`. The single-repo status endpoint returns one such object; `GET /v1/repos` returns an array of them. Both come from the same `statusSnapshot`, so the shapes stay in lock-step.
- `resetBreaker(repo, by)` closes the breaker (clears `pausedAt`/`pausedUntil`, zeroes the counter) and emits `repo.resumed` with `reset_by` `'api'` or `'auto'`.
- **Breaker cancel does not permanently block retry (CRITICAL-3 / Requirement 12.9 / HIGH-2).** When the breaker opens with an attempt in flight, the scheduler is a **Rule 1 caller** of the setup-window state machine (Req 4.1a). It SHALL atomically set that attempt's in-memory `termination_intent = { outcome: 'failed', reasonCode: 'cancelled_by_breaker', failureClass: 'infra' }` FIRST (HIGH-2 — compare-and-set, only set if currently null, first-writer-wins Rule 4; BEFORE signaling, exactly like the other enforcers), THEN read `pid` from the attempt row. IF `pid IS NOT NULL` it calls `teardownAttempt(attempt_id, termination_intent, /* skipKill */ false)` directly, tearing the running process down immediately. IF `pid IS NULL` (the setup window is still open) it returns WITHOUT calling `teardownAttempt`; Rule 3 consumes the intent on the pid record — the spawner's post-spawn re-check (AttemptRunner start, step 6 — Rule 3) performs the single real teardown once the `pid` exists. Setting the intent BEFORE reading `pid` avoids the TOCTOU race in which the spawner records the pid between the read and the set: were the order reversed, a pidless cancel could read `pid IS NULL`, the spawner could then record the `pid` and find no intent, and the breaker cancel would be lost while the agent ran on — or, symmetrically, a pidless teardown could win the conditional end-claim with no process to kill, so the spawner's later re-check teardown would find 0 rows and return early, orphaning both the just-spawned process and the worktree. In both the setup-window and the running case, because the intent is set first, even if the agent's ACP returns `stopReason = 'cancelled'` during teardown, `resolveOutcome` honors the intent at rule 0 and ends the attempt `failed`/`cancelled_by_breaker`/`infra` — **not** terminal `cancelled`. The task therefore lands in `failed` and stays retry-eligible. This breaker-induced end does not itself increment `consecutiveFailures` (the counter already crossed the threshold from the real infra failures).

Concurrency defaults to 1 (Requirement 12.1). Over-limit tasks stay `queued` (Requirement 12.2); the scheduler drains the queue when a slot frees and the breaker is closed. On startup, the scheduler calls `listRepoStates()` to restore paused repos so a repo paused before a crash stays paused (Requirement 19.2).

**Atomic task claim (HIGH-8, Requirement 12.13–12.14).** When the scheduler decides to start a task it claims it with a **conditional UPDATE** rather than a plain state write:

```sql
UPDATE tasks SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued';
```

If the UPDATE affects **0 rows**, the task was already claimed by a concurrent scheduler pass (or was cancelled in the meantime), so the scheduler skips it and creates no attempt row. In addition, the scheduler keeps an in-memory `claiming: Set<taskId>`: a task id is added to the set before the UPDATE and removed after the attempt row is created or the claim fails, so a single process cycle (e.g. a slot-free event firing twice) cannot double-dispatch the same task before the UPDATE commits. The DB conditional UPDATE is the cross-cycle/cross-process guard; the `claiming` set is the within-cycle guard. The attempt row (and `attempt.started`) is created only after a successful claim.

### 7. Event broker (SSE) — `src/task-event-broker.ts`

Mirrors the proven `sse-broker.ts` replay model, but the backing store is the `task_events` table (ordered by `seq`) rather than a file. The envelope is assembled by joining the event's `task_id` to its task for `external_id` and `metadata` (Requirement 8.2–8.4).

```ts
export function resolveSince(sinceParam: string | undefined, lastEventIdHeader: string | undefined):
  { valid: true; since: number } | { valid: false };   // larger of the two; Req 9.3
export function envelopeFromRow(row: TaskEventRecord, task: Pick<TaskRecord,'externalId'|'metadata'> | null): V1EventEnvelope;
```

Live delivery: the broker exposes `emit(event)` called by the DB helpers after each successful commit; subscribers receive events in increasing `seq`, de-duplicated against their cursor (`seq`). On subscribe, it first replays `getEventsSince(since, batch)` in pages until caught up, then switches to live. SSE framing reuses the `event:`/`id:`/`data:` shape and periodic `:heartbeat` comments.

### 8. Transcript retention — `src/transcript-retention.ts`

An attempt's transcript is its session `stream.log`. Phases (Requirement 11):

```ts
export type RetentionPhase = 'active' | 'archived' | 'deleted';
export function classifyRetentionPhase(now: number, endedAt: number | null, graceMs: number, ttlMs: number): RetentionPhase;
```

- **active**: raw `stream.log` on disk, served directly.
- **archived**: after `endedAt + grace`, compress to `stream.log.zst` using `node:zlib` `zstdCompressSync`/`zstdDecompressSync` (available on the project's Node 22.15+/24 runtime — no new dependency), delete the raw file, set `artifacts.transcript_ref` to the `.zst` path.
- **deleted**: after `endedAt + ttl`, remove the archived file.

`readTranscript(ref)` returns a stream: if `ref` ends in `.zst`, pipe through a zstd decompressor transparently (Requirement 10.4); if the file is missing, the caller returns 404. A periodic sweeper (same cadence pattern as the existing reaper) advances phases. This TTL is independent of the reaper's `agentRunsDir` TTL (Requirement 11.4).

**Transcript endpoint content negotiation (HIGH-13, Requirement 21.3).** `GET /v1/attempts/:id/transcript` branches on the `Accept` header:

- `Accept: text/event-stream` → the handler streams **new** `stream.log` lines as SSE (tailing the active file, mirroring the existing `sse-broker.ts` line-tail model); when the attempt has already ended it still replays remaining lines then closes.
- otherwise → it returns the **full** transcript as `text/plain`, served raw for an active transcript or zstd-decompressed for an archived one, and `404` once the transcript has been deleted.

### 9. MCP `report_outcome` tool — `src/mcp-server.ts` (extended)

Add to `MCP_TOOLS`:

```jsonc
{
  "name": "report_outcome",
  "description": "Report the structured outcome of this attempt. Preferred over any free-text summary.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "outcome":     { "type": "string", "enum": ["succeeded","failed","blocked"], "description": "agent-declarable outcome only" },
      "reason_code": { "type": "string", "description": "closed reason-code enum" },
      "reason":      { "type": "string", "description": "free text for humans" },
      "blocked":     { "type": "object", "description": "when outcome=blocked: {question, needs}" },
      "pr_url":      { "type": "string", "format": "uri", "description": "optional: the PR URL if you opened a pull request (HIGH-6)" }
    },
    "required": ["outcome"]
  }
}
```

**Agent prompt preamble (HIGH-6 / HIGH-7 / HIGH-4, Requirement 23).** The tool is useless if the agent is never told to call it. `AttemptRunner.start` composes the session's initial prompt as `buildPromptPreamble(task, attemptId, branchName) + "\n\n" + task.spec`, where `buildPromptPreamble` is a pure, exported function (so it is unit-testable). 

```ts
// pure, exported — HIGH-4: receives branchName explicitly, NOT always `agent/<attemptId>`.
export function buildPromptPreamble(task: TaskRecord, attemptId: string, branchName: string): string;
```

**The preamble receives `branchName` as an explicit parameter (HIGH-4), not always `agent/<attempt_id>`.** For a **fresh (non-resume) attempt** `branchName = agent/<attempt_id>`; for a **resume attempt** (`allow_resume = true`) `branchName = agent/<original_attempt_id>` — the branch of the first attempt that opened this session (Req 13.6, HIGH-5(c)) — because the resume reuses the retained worktree and the original branch rather than minting a new `agent/<new_attempt_id>`. The caller passes the attempt's stored `worktree_branch` column value. This closes the HIGH-4 bug where the preamble always told the agent `git push origin agent/<new_attempt_id>` on a resume, so the agent pushed to the wrong branch and the router's post-exit remote-ref check (Req 22.5, which inspects the SAME `worktree_branch`) raised a false `git_push_failed`.

The preamble tells the agent: (1) a `report_outcome` tool exists with exactly the three outcomes `succeeded | failed | blocked`, and it accepts an optional `pr_url` (HIGH-6); (2) writing `.agent-router/outcome.json` (`{ outcome, reason_code?, reason?, blocked?, pr_url? }`, same three outcomes, with an optional `pr_url` string, HIGH-6) in the worktree root is an accepted alternative; (3) one of these MUST be used before the session ends, and the agent SHOULD include `pr_url` if it opened a pull request; (4) the agent is responsible for committing, pushing, and opening the PR — and the preamble states the **exact push command** `git push origin <branchName>` with the attempt's real branch name interpolated (HIGH-7/HIGH-4), so the agent pushes to the branch the router's post-exit remote-ref check (Req 22.5) inspects and cannot cause a false `git_push_failed` by pushing elsewhere. The preamble never mutates `task.spec`, and `prompt_hash = sha256(task.spec)` is still computed over the spec alone (Requirement 4.1), so the preamble does not change the attempt's prompt identity.

**Agent self-report scope (HIGH-1, Requirement 7.1a).** The `report_outcome` tool and `.agent-router/outcome.json` accept only `outcome ∈ { succeeded, failed, blocked }`. The daemon-enforced outcomes `timed_out`, `budget_exceeded`, `interrupted`, and `cancelled` are set exclusively by the router and the agent cannot declare or override them. Validation against the agent-allowed enum happens daemon-side; any out-of-scope `outcome` (including the daemon-only values) is rejected and the runner falls through to the file/mechanical path (Requirement 7.7).

**`report_outcome` wire payload — `pr_url` end-to-end (HIGH-5).** The MCP tool schema (Requirement 7.1) accepts an optional `pr_url`, but it is only useful if it survives the whole hop from the agent to the stored attempt row. The complete path is:

1. The agent calls the `report_outcome` MCP tool with `{ outcome, reason_code?, reason?, blocked?, pr_url? }`.
2. `mcp-server.ts`'s `tools/call` branch forwards the **full argument set, including `pr_url`**, over the existing Unix socket as `{ op: 'report_outcome', session_id, outcome, reason_code, reason, blocked, pr_url }` (HIGH-5 — `pr_url` was previously dropped from this wire payload).
3. `cli-server.ts` resolves the session's active `AttemptRunner` and hands it the decoded message. The runner's MCP handler **extracts `pr_url` from the call arguments** and records the whole payload (including `pr_url`) on the in-memory `RunningAttemptState` as the attempt's declared `reported` outcome.
4. At attempt end, `resolveOutcome` returns the declared outcome, and the runner builds the natural-end `AttemptEndState` with `artifacts.pr_url = reported.pr_url` (null when the agent omitted it). `teardownAttempt` (HIGH-1) then writes `artifacts` — including `pr_url` — into the attempt row and the `attempt.ended` event in step 1's transaction.

So `pr_url` flows agent → MCP tool args → socket wire payload (`op: 'report_outcome'`) → `RunningAttemptState.reported` → `endState.artifacts.pr_url` → persisted `artifacts.pr_url` and the top-level `pr_url` mirror on `GET /v1/attempts/:id` (HIGH-4). The same applies when the outcome arrives via `.agent-router/outcome.json`: the runner reads `pr_url` from the parsed file and populates `endState.artifacts.pr_url` identically.

### 10. HTTP surface — `src/v1-routes.ts` + `src/web-server.ts`

`createV1Routes(deps)` returns a `Hono<WebEnv>` mounted at `/v1`. `web-server.ts` applies the already-constructed `authMiddleware` to `/v1` and `/v1/*`, and the write guard to the `/v1` POST routes, exactly as it does for `/sessions/*`. Responses use `c.json(payload, status)`; every success body includes `v: 1`; errors use `errorEnvelope(code, message, details?)`.

| Method | Path | Handler behavior | Reqs |
|---|---|---|---|
| POST | `/v1/tasks` | validate → `submitTask`; `201` new / `200` idempotent hit | 1 |
| GET | `/v1/tasks/:id` | task + latest attempt summary; `404` | 2 |
| GET | `/v1/tasks` | list filtered by `repo`,`state` | 2 |
| POST | `/v1/tasks/:id/cancel` | `cancelTask`; `409` if terminal | 5 |
| POST | `/v1/tasks/:id/attempts` | `retryTask`: re-queue `failed`/`blocked` → `202`; `409` otherwise | 5 |
| GET | `/v1/tasks/:id/attempts` | list all attempts for a task (ordered by `attempt_no`); `404` | 21 |
| GET | `/v1/attempts/:id` | attempt detail + parsed `artifacts`/`usage` + `blocked` field + top-level `pr_url` (mirror of `artifacts.pr_url`); `404` | 10 |
| GET | `/v1/attempts/:id/transcript` | `Accept: text/event-stream` → SSE of new lines; else full transcript `text/plain` (raw or zstd-decompressed); `404` if deleted | 10, 11, 21 |
| GET | `/v1/events` | SSE; `Last-Event-ID`/`?since` replay | 8, 9 |
| GET | `/v1/repos` | list all configured repos + current status | 21 |
| GET | `/v1/repos/:owner/:name/status` | slots + breaker | 12 |
| POST | `/v1/repos/:owner/:name/circuit-breaker/reset` | close breaker; emit `repo.resumed` | 12 |

> **Repo path params (HIGH-6).** Because a repo is `owner/name`, the slash is split into two path segments (`/v1/repos/:owner/:name/...`) rather than a single `:repo` segment, which would otherwise contain an un-decodable slash. The task-submission body keeps `repo` as the single `"owner/name"` string.

**Repo status response schema (HIGH-10).** Both repo-status endpoints standardize on the single **flat** shape of Requirement 21.2 — `design §6 statusSnapshot` produces exactly this and nothing nests it under a `breaker` object:

```jsonc
// one repo-status object
{
  "repo": "owner/name",
  "circuit_breaker_state": "closed",          // 'closed' | 'open' | 'half-open'
  "consecutive_failures": 0,
  "paused_until": null,                        // ISO-8601 cooldown deadline, or null when not paused
  "slots_total": 1,
  "slots_in_use": 0
}
```

`GET /v1/repos` returns `{ "v": 1, "repos": [ <object>, ... ] }` (one object per configured repo). `GET /v1/repos/:owner/:name/status` returns a single such object alongside `"v": 1`. Both are produced by the same `statusSnapshot`, so the shapes stay in lock-step. The `paused_until` timestamp is ISO-8601 (Requirement 2.7).

Pure validators exported for Tier 1 (mirroring `web-routes.ts`): `validateTaskStateParam`, `validateSinceParam`, `serializeTask`, `serializeAttempt`, `serializeEventEnvelope` (all timestamp fields rendered ISO 8601 — Requirement 2.7).

**`pr_url` placement (HIGH-4).** The authoritative home for the PR URL is `artifacts.pr_url` within the `attempt.ended` event payload and the stored attempt row (Requirement 6.6). `serializeAttempt` for `GET /v1/attempts/:id` additionally copies that value to a **top-level `pr_url`** field (equal to `artifacts.pr_url`, or `null` when absent) so a UI need not reach into the nested `artifacts` object. The top-level field is a read-only mirror, never an independent value.

### 11. ROADMAP importer — `src/roadmap-importer.ts`

Pure parsing/annotation functions (Tier 1), plus an orchestrating method that calls `TaskService.submitTask`:

```ts
export function parseRoadmapItems(markdown: string): RoadmapItem[];   // {lineNo, text, checked, annotationId?}
export function annotateLine(line: string, id: string): string;       // appends `<!-- ar:<ULID> -->`
export function tickCheckbox(line: string): string;                   // `- [ ]` → `- [x]`
```

Flow (push-before-submit ordering, HIGH-6): `git pull --ff-only` the roadmap branch so the scan reads the latest annotations → parse → for each item without an annotation, generate a ULID, write the `<!-- ar:<ULID> -->` annotation back, **commit it, and push it** (Requirement 14.3 / 20.7 / 20.8); only on a **successful push** derive `external_id` from the pushed annotation id (Requirement 14.2, **not** a text hash) and call `submitTask({ source: 'roadmap', source_ref: '<path>#<id>', external_id: <id>, ... })`; when a task reaches `succeeded`, tick its checkbox (Requirement 14.5). The DB is authoritative; ROADMAP.md is an optional rendering (Requirement 14.6).

**Push-outcome handling (HIGH-6).** `submitTask()` runs only after the annotation push succeeds.
- **Non-fast-forward rejection** (another writer advanced the branch): discard the local annotation commit, `git pull --ff-only`, and **restart the scan from the beginning** against the updated file. The losing importer thereby re-reads and adopts the winner's annotation instead of submitting a competing one.
- **Protected default branch** (push rejected with a permission error): log a warning, **skip the annotation write-back**, and derive `external_id` from a **content hash of the item** so idempotency still holds without writing to the repo.

Correctness against concurrent importers comes from this push-before-submit ordering, not from `UNIQUE(external_id)`: two importers that each minted a *different* ULID before either pushed would hold two different `external_id` values, which the `UNIQUE` constraint would happily accept as two tasks. The non-fast-forward rejection is what forces the loser to re-pull and reuse the winner's id. `UNIQUE(external_id)` remains only a backstop against the *same* id being submitted twice (Requirement 1.3/1.4).

**Importer specification (HIGH-12, Requirement 20).**

- **Trigger:** a cron tick on a configurable interval (`roadmap.scanIntervalMinutes`) drives each scan; the importer is not request-triggered.
- **Read:** before each scan the importer runs `git pull --ff-only` on the roadmap branch (HIGH-8 / Req 20.7) and reads `ROADMAP.md` from the repo's **default branch** via git (not from a working copy), so the daemon sees the latest committed annotations.
- **Write-back ordering (HIGH-6 / Req 20.8):** for an unannotated item the importer writes the `<!-- ar:<ULID> -->` annotation, commits it, and **pushes** it; only on a **successful push** does it call `submitTask()`. On a non-fast-forward rejection it discards the commit, `git pull --ff-only`s, and restarts the scan; on a protected branch it skips write-back and derives `external_id` from an item content hash. The pushed annotation id (or the content hash) is the idempotency key — `UNIQUE(external_id)` is only a backstop against the *same* id being submitted twice, not against two importers minting different ULIDs.
- **Title:** the task `title` is the checklist item text with any trailing annotation comment (`<!-- ar:<ULID> -->`) stripped.
- **Spec:** the task `spec` is the full ROADMAP item text block (the item line plus its indented continuation).
- **Write-back on success:** when the item's task reaches `succeeded`, the importer rewrites the checkbox to `[x]` and **commits and pushes** that change directly to the repo using the router's configured GitHub token (a router-authored git commit — this is the one place the router commits to a repo, distinct from attempt work which the agent commits).
- **Skip / idempotency:** items already marked `[x]` are skipped; `external_id` idempotency (Requirement 1.3) prevents a re-scan from creating a duplicate task for an already-submitted item.

### 12. Config additions — `src/config.ts` (extended)

```ts
// RepoConfig additions
concurrency?: number;                       // default 1 (Req 12.1)
circuitBreaker?: { failureThreshold: number; timeoutSeconds?: number };  // Req 12.4/12.7/12.11 (timeoutSeconds default 3600 → half-open probe)

// AttemptRunner / budget additions
idleTimeoutSeconds?: number;                // default 900 → stuck-agent idle timeout (Req 17.6, HIGH-4)

// AgentRouterConfig additions
taskTranscript?: {
  archiveGraceMinutes: number;   // active → archived (Req 11.2)
  retentionDays: number;         // archived → deleted (Req 11.3), independent of reaper (Req 11.4)
  sweepIntervalMinutes: number;
};
roadmap?: {
  scanIntervalMinutes: number;   // cron-tick scan cadence (Req 20.1)
};
```

Validation extends `validateConfig` with the same defensive style (type/range checks, `FatalError` on invalid). Defaults: `concurrency = 1`, `failureThreshold = 3`, `timeoutSeconds = 3600` (the half-open probe window, Req 12.11), `idleTimeoutSeconds = 900` (the stuck-agent idle timeout, Req 17.6 / HIGH-4), `archiveGraceMinutes = 60`, `retentionDays = 90` (the default compressed retention period), `sweepIntervalMinutes = 30`, `scanIntervalMinutes = 15`.

---

## Data flow

### Submit → run → succeed

1. `POST /v1/tasks` → `validateSubmitBody` → `TaskService.submitTask`.
2. `createTaskWithEvent` inserts the task (`queued`) and `task.queued` in one txn; broker emits.
3. `RepoScheduler.enqueue`: if a slot is free and the breaker is closed, start immediately; else leave `queued`.
4. `AttemptRunner.start` (attempt-row-first): `startAttemptWithEvent` **first** (atomic task claim via `UPDATE ... WHERE state='queued'` + insert attempt row + task→`running` + `attempt.started`, all one txn), set `prompt_hash`; **then after that transaction commits**, for a fresh (non-resume) attempt create the worktree with `git worktree add /tmp/agent-runs/<attempt_id> -b <worktree_branch> <base_ref>` (`<worktree_branch>` = the attempt's stored `attempts.worktree_branch` column, `agent/<attempt_id>` for a fresh attempt — never the doubled `agent/agent/<id>`), record `base_sha` (`git rev-parse HEAD`), `worktree_branch`, and `worktree_path = /tmp/agent-runs/<attempt_id>` (H2); for a resume attempt reuse the retained `worktree_path` without running `git worktree add` and copy `worktree_branch`/`artifacts.base_sha` forward from the interrupted attempt (H2); delete any stale `.agent-router/outcome.json`, run the GitHub setup validation, and spawn the agent process. **Immediately after the agent process is spawned, record its `pid`/`pgid`/`process_start_time`/`process_cmdline` on the attempt row, and only THEN — before sending the prompt — re-check `termination_intent` (HIGH-3 / H3)**: if set (an API/breaker cancel landed during the setup window), call `teardownAttempt(attempt_id, intent, /* skipKill */ false)` without sending the prompt (teardown now has the recorded pid to kill); otherwise send `buildPromptPreamble(task, attempt_id, worktree_branch) + spec` as the prompt. A worktree/setup/spawn failure ends the already-created attempt with the matching infra reason code (`spawn_failed`/`auth_failed`/`rate_limited`), removing any partial worktree via `git worktree remove --force` (HIGH-3).
5. Heartbeat timer emits `attempt.heartbeat` and refreshes the lease to `now() + 3×heartbeat_interval_ms` **on every heartbeat** (HIGH-1 — anchored to the last heartbeat, not to `started_at`) every `heartbeat_interval_s`; the budget enforcer and lease checker watch for over-budget / expired-lease ends.
6. Agent commits/pushes/opens the PR, then calls `report_outcome` (or writes `.agent-router/outcome.json`); the session ends on ACP `stopReason` or process exit.
7. `resolveOutcome` (ordered first-match list: self-report → ACP `stopReason` → `hasDiff` commit count → exit-code fallbacks, CRITICAL-2) → `endAttemptWithEvent` (conditional UPDATE; attempt `ended` + task→`succeeded` + `attempt.ended`) in one txn; the runner removes the worktree.
8. Scheduler frees the slot, resets the repo's `consecutive_failures` on success, drains the queue.

### Retry (Requirement 5, CRITICAL-2)

`POST /v1/tasks/:id/attempts` on a `failed`/`blocked` task → `retryTask` moves it back to `queued` (202), emits a `task.requeued` event with `reason = 'retry'` **in the same transaction** as the state write (HIGH-9), and calls `RepoScheduler.enqueue`. No attempt row is created here. The scheduler creates attempt `attempt_no+1` only when it next claims the task (via the atomic conditional UPDATE, HIGH-8) with a free slot and a closed breaker — the identical path a first run takes. Every path that returns a task to `queued` emits `task.requeued`: `reason = 'retry'` for an explicit API retry, `reason = 'importer'` for a ROADMAP re-submission, and `reason = 'interrupted'` for the `allow_resume = true` restart-resume path (HIGH-5(a) / Req 13.6), which re-queues an interrupted task so the scheduler can start a resume attempt. (Interruptions WITHOUT `allow_resume` still land in `failed` per Requirement 13.9, not `queued`.)

### Restart recovery (Requirement 13)

On startup, after DB init and before accepting traffic: **run `git worktree prune` in the repo clone first, unconditionally (HIGH-2)** — before and independent of the running-attempts list — because `git worktree prune` is idempotent and cleans up any orphaned worktree directories left behind by processes killed mid-setup (e.g. a `spawn_failed` whose worktree was half-created, HIGH-3), which may have no `attempts` row at all. Then `findRunningAttempts()` → **recover each through the single `teardownAttempt` path with `skipKill = true` (HIGH-2)**: `teardownAttempt(id, { outcome: 'interrupted', reasonCode: 'interrupted', failureClass: 'infra' }, /* skipKill */ true)`. 

Passing `skipKill = true` is required because the PID-identity check (HIGH-8) lives inside `teardownAttempt`'s kill steps, and on a reboot the stored `process_start_time` was captured against a *previous* boot's clock-ticks-since-boot and can never match the current `/proc/<pid>/stat` field 22 — so the runtime kill path would either skip-and-warn on every attempt or (worse, if a PID were recycled) risk signaling an unrelated process. With `skipKill = true`, `teardownAttempt` SKIPS the ACP-close and SIGTERM/SIGKILL steps (the agent process is already dead after the reboot) but still runs the DB end-claim + `attempt.ended`/task-state events (steps 1, 7, 8) and the worktree cleanup (step 6). 

Separately — for the case where the daemon crashed **without** a reboot and an orphan agent is genuinely still alive — the recovery pass performs the HIGH-8 orphan reap *outside* `teardownAttempt`: for each running attempt whose stored `pid` is still alive, verify PID identity (read `/proc/<pid>/stat` field 22 and compare to the stored `process_start_time`, AND verify `/proc/<pid>/cmdline` matches the stored `process_cmdline` prefix); only when BOTH match, `SIGKILL` it (prefer a process-group kill via `pgid`); if the identity check fails (a recycled PID) SKIP the kill and log a warning. This explicit orphan reap runs before the `teardownAttempt(..., skipKill=true)` call so no live agent from the crashed daemon survives, while `teardownAttempt`'s own kill steps stay skipped to avoid acting on a stale/recycled PID.

Each `teardownAttempt` call ends the attempt `outcome='interrupted'`, `failure_class='infra'`, `reason_code='interrupted'`, moves the **task→`failed`** (reason_code `interrupted`; NOT `queued` — an interruption is never auto-retried, so a poison-pill task that crashes the daemon on every pickup cannot crash-loop; CRITICAL-3 / Req 3.4 / Req 5.3 / Req 13.9), and emits `attempt.ended` (per-attempt txn). Collect ids, then `appendEvent('daemon.started', { version, interrupted_attempt_ids })`. Tasks already in `state='queued'` at startup are left untouched; once `daemon.started` is emitted the `RepoScheduler` drains them normally (Req 13.8). `interrupted` does NOT increment `consecutive_failures` (Req 12.5 / Req 13.10). An explicit `POST /v1/tasks/:id/attempts` is the only way to retry an interrupted task. (The `allow_resume = true` resume path is the one exception that re-queues instead of leaving the task `failed`; see **Resume semantics** below.)

**Orphaned-task sweep (HIGH-4).** Because the task claim and the attempt-row insert are atomic (one transaction, HIGH-4), a crash cannot leave a `running` task without a `running` attempt under normal operation. As a belt-and-suspenders guard against a half-written claim from an older build or a torn write, startup recovery ALSO sweeps `tasks WHERE state='running' AND NOT EXISTS (an attempt in state='running' for that task)` and marks each such task `interrupted` (→ `failed`, `reason_code='interrupted'`, no auto-retry) in the same recovery pass, so no task is left stranded in `running` with nothing to drive it.

**Resume semantics (HIGH-5, Requirement 13.5–13.6).** `budget.allow_resume` defaults to `false`; when absent or `false`, recovery stops at marking the attempt `interrupted` and moving the task to `failed` with `reason_code = 'interrupted'` (Req 13.9) — this is **session-state recovery, not a resume of the crashed session**, and the task is NOT auto-retried: the orchestrator or operator retries explicitly via `POST /v1/tasks/:id/attempts`, or cancels via `POST /v1/tasks/:id/cancel` (CRITICAL-3).

`allow_resume` is only supported for `agent = 'kiro'`. For `agent = 'claude'` the daemon logs a warning and treats `allow_resume` as `false` (Claude Code has no equivalent `--resume-id`). When `allow_resume === true` AND `agent = 'kiro'`, restart recovery records the interrupted session id on the task (`tasks.resume_session_id`) and retains the worktree (Req 18.4 exception). The resume then goes through the scheduler as ordinary queued work rather than a direct attempt creation (HIGH-5):

1. **Worktree-existence precondition (HIGH-5(d)):** verify the attempt's worktree path still exists on disk. If it does **not** (e.g. `/tmp` was cleared across the restart), fall back to the non-resume path — leave the task `failed`/`interrupted` for a fresh explicit retry — and do not attempt the resume.
2. **Re-queue before claim (HIGH-5(a)):** move the task to `queued` and emit `task.requeued` (`reason = 'interrupted'`) in one transaction, INSTEAD OF leaving it `failed`. The scheduler claims it through the normal atomic claim (Req 12.13), so the resume honors the per-repo concurrency guard and the breaker and never bypasses the scheduler. (The scheduler only ever claims `queued` tasks, which is why the resume must be re-queued first rather than started directly off a `failed` task.)
3. **Resume attempt reuses the original branch (HIGH-5(c)):** when the scheduler claims the re-queued task it creates a **new** attempt row (`attempt_no` = max + 1), `session_id = resume_session_id`, marked `resuming`, that **reuses the same branch `agent/<original_attempt_id>`** — not a new `agent/<new_attempt_id>`. Every git operation, including the post-exit `git ls-remote origin refs/heads/agent/<original_attempt_id>` push check (CRITICAL-2 / Req 22.5), targets that original branch, so the remote-ref/SHA comparison checks the branch the agent actually pushed to and cannot raise a false `git_push_failed`.
4. **Clear `resume_session_id` after one use (HIGH-5(b)):** when the resume attempt row is created, set `tasks.resume_session_id = NULL`. One resume per interruption: if the resumed attempt is itself interrupted, it does not auto-resume a second time off the stale session id — it falls back to `failed`/`interrupted` for an explicit retry, closing the crash-loop hole.

At most **one** concurrent resume attempt per task is allowed. If a slot is not free within the 30-second resume window — or the resume otherwise fails to come up — the resume is abandoned and the task remains `failed`/`interrupted` for an explicit retry, exactly as in the non-resume path. A resume therefore competes for a concurrency slot and honors the breaker like any other attempt; it never opens a scheduler bypass.

### Circuit breaker

`onAttemptEnded(repo, attemptEnd)` → `breakerTransition`. Only an infra-reason-code end increments the counter (CRITICAL-3 / Requirement 12.5); a `succeeded` end resets it; all other ends leave it unchanged. At the threshold the breaker opens, `repo.paused` is emitted, and a running attempt is ended with `outcome='failed'` / `reason_code='cancelled_by_breaker'` (so it stays retry-eligible, not permanently cancelled). Both the breaker state change and its event are written to `repo_state` + `task_events` in one transaction (Requirement 19.3). `POST /v1/repos/:owner/:name/circuit-breaker/reset` (or an automatic cooldown) closes it and emits `repo.resumed` (`reset_by` `'api'`/`'auto'`).

---

## Error handling

- `src/task-errors.ts` defines `TaskError` and `AttemptError` (same shape as `errors.ts`). A `TaskError`/`AttemptError` is logged via the structured `Logger` and does not crash the daemon (Requirement 15.4); `FatalError` remains reserved for startup/DB failures.
- All state+event writes go through `db.transaction(...)`; a thrown error rolls back both (Requirement 15.1–15.2).
- HTTP validation failures map to `400 invalid_body`/`invalid_param`/`invalid_repo`/`invalid_agent`/`invalid_budget`; missing resources to `404 not_found`; illegal transitions to `409 conflict`.
- Infra failures during an attempt (spawn/auth/rate-limit/git-push/adapter-crash) set `failure_class='infra'` with the matching reason code and feed the breaker's failure counter (Requirement 12.5). `interrupted` also sets `failure_class='infra'` but does not feed the counter.
- Attempt-end is exactly-once via the conditional UPDATE (HIGH-5): the agent report, budget enforcer, lease checker, cancel, and breaker all route through `endAttemptWithEvent`; a losing racer sees 0 rows affected and emits no event.

---

## Testing strategy

Three tiers, per `AGENTS.md`. Tier 1 and Tier 2 must not touch the network, real tokens, or real Kiro.

### Tier 1 (`test/tier1/`) — pure logic + property tests (fast-check, ≥100 iterations)

- `ulid.ts`: monotonicity within a millisecond; lexicographic sort order matches time order; 26-char Crockford base32 (property).
- `task-service.ts`: `validateSubmitBody` (missing/invalid fields, repo/agent/budget rejection, defaults); `nextTaskStateForOutcome` is total over the outcome enum (property); `canRetry`/`canCancel` truth tables.
- `attempt-runner.ts`: `resolveOutcome` priority (tool > file > mechanical), agent-allowed enum (`succeeded|failed|blocked`) rejection falls through (HIGH-1), the full success/mechanical classification table (CRITICAL-4: `succeeded` requires `exit=0`+self-report+`hasDiff`; `no_changes`; `agent_error`), and `failure_class='infra'` exactly for the infra reason-code set plus `interrupted` (property over all reason codes); `reason_code=null` only for `succeeded` (HIGH-2).
- `repo-scheduler.ts`: `breakerTransition` increments only for the infra reason-code set (CRITICAL-3), opens at threshold, resets on success, idempotent while open (property on mixed outcome sequences); non-counting outcomes (`cancelled_by_api`, `timed_out`, `budget_exceeded`, `interrupted`, `no_changes`) leave the counter unchanged; a `git_push_failed` end carrying the "ls-remote-failed" flag (`remoteBranchExists = null`, HIGH-7) also leaves the counter unchanged, while a `git_push_failed` from an absent/mismatched remote ref increments it.
- `task-event-broker.ts`: `resolveSince` picks the max of header/param and rejects non-integers; `envelopeFromRow` renders ISO-8601 and echoes metadata/external_id.
- `transcript-retention.ts`: `classifyRetentionPhase` boundaries (active/archived/deleted) across random `now`/`endedAt` (property); the 90-day default retention is applied when unconfigured.
- lease window helper: `lease_expires_at = now() + 3×heartbeat_interval_ms`, refreshed on every heartbeat and anchored to the last heartbeat / now, never to `started_at` (HIGH-1), and the expiry predicate used by the lease checker (property across random intervals / clocks).
- `roadmap-importer.ts`: parse/annotate/tick round-trips; `external_id` derives from annotation id, never from text; re-annotation is stable (property).
- `task-db.ts`: idempotent `createTaskWithEvent` returns existing on duplicate `external_id` (in-memory SQLite is acceptable here as pure-ish logic, else Tier 2).

### Tier 2 (`test/tier2/`) — full daemon vs fake backends (real SQLite tmpdir, FakeKiro/FakeGitHub)

- Submit idempotency end-to-end: duplicate `external_id` returns the same task; concurrent submits yield one row.
- Attempt lifecycle: `attempt.started` → `attempt.heartbeat` (lease refresh) → `attempt.ended` with a resolved outcome; task reaches the correct terminal state.
- Success path (CRITICAL-4): a scripted FakeKiro that commits a diff and reports `succeeded` ends `succeeded` with `pr_url` observed; a run with no diff ends `failed`/`no_changes`; a nonzero exit with no self-report ends `failed`/`agent_error`.
- Retry (CRITICAL-2): `POST /v1/tasks/:id/attempts` on `failed`/`blocked` returns `202` and re-queues; the attempt row appears only when the scheduler claims the task; a retry while the breaker is open or the slot is full stays `queued`; `409` from `queued`/`running`/`succeeded`/`cancelled`; `attempt_no` increments on the eventual start.
- Cancel: kills the session, emits `attempt.ended`(`cancelled_by_api`) + `task.cancelled`.
- Budget enforcement (HIGH-3): a FakeKiro that overruns `max_wall_s` ends `timed_out` (SIGTERM); one that overruns tokens/turns ends `budget_exceeded`; neither increments `consecutive_failures`.
- Lease expiry (HIGH-4): a session that stops heartbeating past `3×interval` is ended `interrupted`/`infra` by the lease checker.
- Attempt-end race (HIGH-5): two concurrent end triggers produce exactly one `attempt.ended`.
- SSE replay: `Last-Event-ID`/`?since` resumes with no gaps or duplicates; both-present uses the max.
- Circuit breaker (CRITICAL-3 + HIGH-9): N consecutive infra failures emit `repo.paused`; the breaker-cancelled attempt ends `failed`/`cancelled_by_breaker` and the task is retry-eligible; reset emits `repo.resumed`; a queued task does not start while open; breaker state persists across a daemon restart (paused repo stays paused).
- Restart recovery (HIGH-10): a `running` attempt left in the DB becomes `interrupted`/`infra`, emits `attempt.ended`, and `daemon.started` lists its id; with `allow_resume=false` no resume is attempted.
- Transcript: active served raw; after grace it is archived (zstd) and still served decompressed; after TTL it 404s; `Accept: text/event-stream` streams new lines (HIGH-13).
- Worktree lifecycle (HIGH-11): a worktree + `agent/<attempt_id>` branch is created at start, a pre-existing `.agent-router/outcome.json` is deleted, and the worktree is removed after `attempt.ended`.
- `report_outcome` MCP tool: a scripted FakeKiro scenario calls it and the recorded outcome wins over mechanical classification; a daemon-only `outcome` value (e.g. `timed_out`) is rejected and falls through (HIGH-1).
- Additional endpoints (HIGH-13): `GET /v1/tasks/:id/attempts` lists attempts; `GET /v1/repos` lists configured repos with status; `GET /v1/attempts/:id` includes the `blocked` field for a blocked attempt (HIGH-7).
- ROADMAP importer (HIGH-12): an unannotated item gets an annotation written back and a task created; re-scan creates no duplicate; the checkbox is ticked and committed/pushed only on `succeeded`.
- Transactional integrity: a forced failure mid-write leaves neither state nor event (no partial row, no orphan event).

### Tier 3 (`test/tier3/`) — real GitHub + real Kiro (not run per change)

- One real task submitted via `/v1/tasks` runs an attempt against a real repo and reports a real outcome; transcript retrievable.

---

## Design decisions and rationale

- **`task_events` instead of `events`.** The database already has an `events` table for GitHub webhooks. Reusing the name would shadow it; a distinct name keeps both logs clear. This is the single intentional deviation from the brief's naming.
- **`failure_class` invariant encoded as a CHECK (CRITICAL-1 / HIGH-8).** `failure_class` can only be `'infra'`, and only when `outcome ∈ {failed, interrupted}`; the table-level CHECK makes a contradictory row impossible, while the finer rule (which `failed` reason codes count as infra) stays in application code where the reason-code set lives.
- **Retry re-queues rather than starting directly (CRITICAL-2).** Routing retries back through the scheduler keeps the concurrency guard and circuit breaker on the single path that creates attempt rows; no code path starts an attempt while bypassing them.
- **Breaker cancel is a `failed` end, not `cancelled` (CRITICAL-3).** A permanent `cancelled` would strand the task; ending as `failed`/`cancelled_by_breaker` keeps it retry-eligible once the breaker is reset.
- **Inline ULID, no dependency.** `AGENTS.md` demands dependency justification. ULID is small and fully specified, so a ~40-line generator is cheaper than a new supply-chain surface.
- **zstd via `node:zlib`.** The runtime is Node 22.15+/24, which ships `zstdCompressSync`/`zstdDecompressSync`. No external compression dependency is needed.
- **Attempt transcript == session `stream.log`.** Reusing the existing per-session NDJSON file avoids a second transcript store; retention operates on that file and records the location in `artifacts.transcript_ref`.
- **Events table is the SSE source of truth.** Unlike `sse-broker.ts` (which tails a file), `/v1/events` replays by `seq` from `task_events`, giving a global monotonic cursor across all tasks — exactly what an orchestrator needs.
- **Slot counts in-memory; breaker state persisted (HIGH-9).** Slot occupancy is rebuilt at startup from `running` attempts, but circuit-breaker state (`consecutive_failures`, `paused_until`) is persisted in `repo_state` and reloaded on startup so a repo paused before a crash stays paused. The DB remains the durable source of truth.
- **No automatic retry.** Retry is strictly orchestrator-driven (`POST .../attempts`), honoring the execution-primitive principle.

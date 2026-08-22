# Design Document: Session Recovery

## Overview

Session Recovery is implemented as a method on the `SessionManager` interface (`resumeSessions()`) that runs exactly once during daemon startup, after the session manager is constructed and before the HTTP server begins accepting webhooks. It iterates over on-disk sessions with `status: active`, attempts to resume each via the ACP `session/load` method, and either re-registers the session in the in-memory registry or marks it abandoned.

The design leverages the existing persistence contract: `meta.json` is the authoritative session state on disk, the SQLite `sessions` table provides `(repo, pr_number) → session_id` routing, and the ACP `session/load` JSON-RPC method allows a new Kiro subprocess to re-attach to a previously created session.

## Architecture

### Sequence Diagram

```
┌─────────┐      ┌───────────────┐      ┌──────────────┐      ┌───────────┐
│ index.ts │      │ SessionManager │      │ SessionFiles │      │ ACP Client│
└────┬────┘      └───────┬───────┘      └──────┬───────┘      └─────┬─────┘
     │                    │                      │                     │
     │ resumeSessions()   │                      │                     │
     │───────────────────>│                      │                     │
     │                    │ listSessions()       │                     │
     │                    │─────────────────────>│                     │
     │                    │    [all metas]       │                     │
     │                    │<─────────────────────│                     │
     │                    │                      │                     │
     │                    │  filter status=active                      │
     │                    │─────────┐            │                     │
     │                    │         │            │                     │
     │                    │<────────┘            │                     │
     │                    │                      │                     │
     │                    │  FOR EACH active session:                  │
     │                    │                      │                     │
     │                    │  [no kiro_session_id?]                     │
     │                    │──── mark abandoned ──>│                     │
     │                    │                      │                     │
     │                    │  [has kiro_session_id]                     │
     │                    │  acpSpawner(id,repo) │                     │
     │                    │──────────────────────────────────────────>│
     │                    │                      │    acp.initialize() │
     │                    │──────────────────────────────────────────>│
     │                    │                      │  acp.loadSession()  │
     │                    │──────────────────────────────────────────>│
     │                    │                      │                     │
     │                    │  [success: register handle, start timers]  │
     │                    │  [failure: mark abandoned]                 │
     │                    │                      │                     │
     │  {resumed, terminated}                    │                     │
     │<───────────────────│                      │                     │
```

### Component Interactions

1. **`src/index.ts`** — Calls `sessionMgr.resumeSessions()` after session manager construction and before starting the HTTP server, event queue worker, and cron jobs. This ordering guarantees that no webhook can arrive before recovery is complete.

2. **`src/session-mgr.ts` (`resumeSessions`)** — The core recovery logic. Iterates active sessions, spawns ACP clients, calls `loadSession`, rebuilds `SessionHandle` objects, and registers them in the in-memory `SessionRegistry`.

3. **`src/session-files.ts` (`listSessions`)** — Scans the `sessions/` directory, reads each `meta.json`, returns all session metadata sorted by `created_at` descending.

4. **`src/acp.ts` (`loadSession`)** — Sends a `session/load` JSON-RPC request with the `kiro_session_id` to the freshly spawned Kiro subprocess. On success, Kiro restores the session context.

5. **`src/db.ts` (sessions table)** — The `(repo, pr_number) → session_id` mapping persists in SQLite across restarts. No re-insertion is needed during recovery — the existing rows route webhooks to the resumed session.

### State Machine

```
                     ┌──────────┐
  daemon restart     │  active  │  (on-disk meta.json)
  ─────────────────> │(orphaned)│
                     └────┬─────┘
                          │
              ┌───────────┴───────────┐
              │                       │
     has kiro_session_id?      no kiro_session_id
              │                       │
              v                       v
     ┌────────────────┐      ┌───────────────┐
     │  spawn + load  │      │   abandoned   │
     └───────┬────────┘      │(terminated_by │
             │               │   _restart)   │
    ┌────────┴────────┐      └───────────────┘
    │                 │
  success           failure
    │                 │
    v                 v
┌────────┐   ┌───────────────┐
│ active │   │   abandoned   │
│(in-mem │   │(terminated_by │
│registry)   │   _restart)   │
└────────┘   └───────────────┘
```

## Detailed Design

### Recovery Procedure (`resumeSessions`)

```typescript
async resumeSessions(): Promise<{ resumed: number; terminated: number }>
```

**Algorithm:**

1. Call `sessionFiles.listSessions()` to get all session metadata from disk.
2. Filter to sessions with `status === 'active'`.
3. For each active session:
   - If `kiro_session_id` is undefined or empty → mark abandoned (Requirement 2.1).
   - Otherwise:
     a. Call `acpSpawner(sessionId, meta.repo)` to spawn a new Kiro subprocess with the session's repo-specific token env.
     b. Call `acp.initialize()` to complete the ACP handshake.
     c. Call `acp.loadSession(kiroSessionId)` to resume the Kiro session context.
     d. On success: log at INFO level `{ sessionId, kiroSessionId }` confirming resumption, build a `SessionHandle`, add to registry, start notification consumer, subprocess exit monitor, inactivity timer, and lifetime timer. Successful recovery appends no stream entries — the original `session_started` remains the only start marker.
     e. On error: catch, log at WARN, mark the session abandoned with `terminated_by_restart`.
4. Return `{ resumed, terminated }` counts.

### SessionHandle Reconstruction

A recovered session's `SessionHandle` is identical in structure to a freshly created one:

| Field | Source |
|-------|--------|
| `sessionId` | From `meta.session_id` |
| `repo` | From `meta.repo` |
| `paths` | From `sessionFiles.getSessionPaths(sessionId)` |
| `acp` | Freshly spawned ACP client |
| `eventQueue` | New `createEventQueue()` |
| `turnQueue` | New `createTurnQueue(acp, sessionFiles, sessionId, log)` |
| `kiroPid` | `acp.pid` — the OS process ID of the newly spawned Kiro subprocess (real PID, not 0) |
| `boundProject` | From `meta.bound_project` |
| `boundProjectRepos` | From `meta.bound_project_repos` |

### Abandonment Procedure

When a session cannot be resumed:

1. Append to `stream.log`: `{ ts, source: 'router', type: 'session_ended', reason: 'terminated_by_restart' }`
2. Update `meta.json`: `{ status: 'abandoned', completed_at: now, termination_reason: 'terminated_by_restart' }`
3. Call `markTerminalAndNotifyReaper(sessionId)` to set `terminal_at` and notify the reaper for disk reclamation.

All three steps are wrapped in try/catch for best-effort semantics — a failure to write does not prevent processing the next session.

### Startup Ordering (in `index.ts`)

```
1. loadConfig
2. createLogger
3. initDatabase
4. createSessionFiles
5. createSessionManager  ← resumeSessions() lives here
6. sessionMgr.resumeSessions()  ← runs BEFORE servers
7. createEventQueue + startWorker
8. serve() (HTTP)
9. setupCronJobs
10. createCliServer
11. startWebServer
```

The HTTP server does not bind until step 8, so no webhook can arrive before recovery completes (Requirement 3.3).

After step 6, `index.ts` (the caller) inspects the returned `{ resumed, terminated }` counts. When `resumed + terminated > 0`, `index.ts` logs an INFO summary: `{ resumed: <n>, terminated: <n> }` (Requirement 6.1). When both are zero, no additional log is emitted (Requirement 5.1). The summary is logged by `index.ts`, not by `resumeSessions()` itself — the session manager returns data, the entry point decides what to log at the orchestration level.

### Timer Behavior on Recovery

Both timers start fresh from zero on recovery:

- **Inactivity timer**: `resetInactivityTimer(sessionId, acp)` — starts a new countdown from the configured `inactivityMinutes`. The time elapsed during the restart does not count.
- **Lifetime timer**: `enforceMaxLifetime(sessionId, acp)` — starts a new countdown from the configured `maxLifetimeMinutes`. This is a deliberate tradeoff: a session that was 90 minutes into a 120-minute lifetime before restart gets a fresh 120-minute window after recovery.

**Rationale:** Punishing a session for daemon downtime would be unfair — the agent wasn't running during that time. The restart is an operator action, not a session fault.

`created_at` is not modified during recovery — it reflects true session creation time (Requirement 4.3). Only the timers reset; the metadata remains an accurate historical record.

### ACP `session/load` Protocol

The `session/load` JSON-RPC method:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/load",
  "params": { "sessionId": "<kiro_session_id>" }
}
```

On success, Kiro restores the agent's conversation context, tool state, and working directory. On failure (unknown session ID, expired session, internal error), Kiro returns a JSON-RPC error response which surfaces as a thrown error from `acp.loadSession()`.

### Error Handling Strategy

| Failure Mode | Handling |
|---|---|
| No `kiro_session_id` in meta | Skip spawn, mark abandoned immediately |
| `meta.json` parse failure (corrupted/invalid JSON) | Log WARN with session directory path, skip session (counted as neither resumed nor terminated), continue scan |
| ACP subprocess fails to start | Caught by try/catch, mark abandoned |
| `acp.initialize()` throws (protocol mismatch) | Caught, mark abandoned |
| `acp.loadSession()` throws (session unknown/expired) | Caught, mark abandoned |
| `sessionFiles.listSessions()` returns empty | Return `{ 0, 0 }`, no error |
| `meta.json` write fails during abandonment | Best-effort catch, continue to next session |
| `stream.log` append fails during abandonment | Best-effort catch, continue with `meta.json` update and reaper notification |

**Post-recovery subprocess exit:** If the Kiro subprocess dies immediately after `loadSession` succeeds (e.g., OOM, segfault), the standard subprocess-exit handler fires. The session is ended normally (not counted as a failed recovery) — recovery succeeded; the subsequent crash is a separate lifecycle event handled by the existing exit monitor wired in step 3d.

### Interaction with Cron Circuit Breaker

When a session is marked `abandoned` with `terminated_by_restart`, the cron guard (`canCronRefire`) evaluates this session as the "last terminal session" for the repo. The `terminated_by_restart` reason is treated as a retriable failure — the cron will fire a fresh session on the next schedule tick. This is the designed recovery path for sessions that Kiro cannot resume.

### Interaction with Session Reaper

Abandoned sessions have `terminal_at` set via `markTerminalAndNotifyReaper`. The reaper's grace period begins from this timestamp, ensuring the worktree and session metadata are eventually cleaned up.

## Design Decisions

| Decision | Rationale |
|---|---|
| Fresh subprocess, not re-attach | The original PID is dead. Spawning a new process is the only option. `session/load` handles context restoration. |
| `session/load` not `session/new` + re-prompt | Re-sending the original prompt would lose all agent context (tool calls, edits, PR state). `session/load` preserves the full conversation. |
| Abandoned, not failed | `abandoned` signals "external cause, not agent fault." The cron guard treats this as retriable. `failed` would imply the agent broke. |
| Timers reset to zero | Daemon downtime is operator-caused. Penalizing the session with reduced time budget would be unfair and surprising. |
| No config option to disable recovery | Recovery is always desirable. An operator who doesn't want it can avoid restarting with active sessions (graceful shutdown terminates them first). |
| Sequential, not parallel recovery | Sessions are recovered one-at-a-time in a for-loop. Parallelism adds complexity with no meaningful latency benefit (typical case: 0–2 active sessions). |
| No re-insertion into SQLite sessions table | The `(repo, pr_number) → session_id` row persists across restarts. The session_id hasn't changed, so no DB mutation is needed. |

## Constraints and Limitations

- **Kiro must support `session/load`** — if a future Kiro version deprecates this method, recovery breaks. The spec relies on this ACP contract.
- **No partial recovery** — a session either fully resumes (handle registered, timers started) or is fully abandoned. There is no intermediate state.
- **Startup latency** — each recovery attempt involves a subprocess spawn + ACP handshake + load. With N active sessions, startup is delayed by roughly N × (spawn time + handshake time). Acceptable for typical N ≤ 3.
- **Lost in-memory state** — timer durations, completion flags, grace period state, and pending prompt queue contents are lost. Only the persistent state (meta.json, SQLite, stream.log) survives.

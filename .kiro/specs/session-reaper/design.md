# Design Document: Session Reaper

## Overview

The Session Reaper is an in-process module (`src/reaper.ts`) that reclaims disk space from two artifact types produced by agent-router sessions:

1. **Agent worktrees** (`~/agent-runs/<timestamp>-<repo>/`) — large git clones with build outputs (3.5–9 GB each).
2. **Session metadata** (`~/.agent-router/sessions/<uuid>/`) — stream logs, prompt logs, meta.json (~200 KB each).

The reaper integrates directly into the daemon process, using the session manager's in-memory registry as the authoritative "is this session still active?" check. It operates via two mechanisms:

- **Event-driven**: When the session manager transitions a session to a terminal state, it notifies the reaper. The reaper schedules a deferred deletion after the configured grace period.
- **Periodic sweep**: A `setInterval`-based timer runs every N minutes, catching any artifacts that the event-driven path missed (daemon restarts, timer drift, unregistered worktrees).

### Key Design Decisions

1. **In-process, not external timer.** The reaper runs inside the daemon because it needs access to the in-memory session registry to guarantee the safety invariant (never delete an active session's artifacts). An external cron/systemd-timer would need to query the daemon, adding IPC complexity and race windows.

2. **Grace period via `setTimeout`.** After session terminal-state transition, a `setTimeout` schedules the worktree deletion. This is consistent with the existing inactivity/lifetime timer pattern in `session-mgr.ts`. On daemon shutdown, pending timers are cleared without executing.

3. **Metadata sweep via `setInterval`.** Metadata has a longer retention window (30 days), so event-driven deletion would require persisting timers across daemon restarts. A periodic sweep is simpler and sufficient — metadata is small, so the cost of scanning is negligible.

4. **Discovery heuristic as fallback.** The primary path is explicit worktree registration (agent calls `register_worktree` MCP tool). The fallback parses the directory name format `<YYYYMMDD-HHMMSS>-<repo>` and matches the timestamp against the session's `created_at` within a 5-minute window. This uniquely identifies a worktree per session even when multiple sessions target the same repo. This handles legacy sessions that predate the registration mechanism.

5. **No database schema changes.** Worktree paths and reap timestamps are stored in `meta.json` (already an extensible JSON document), not in SQLite. This avoids migrations and keeps the reaper's state co-located with the session artifacts it manages.

6. **Startup backfill sweep.** On daemon startup (if reaper is enabled), a one-time discovery sweep runs for all terminal sessions that have no registered `worktree_path`. This ensures that sessions created before the `register_worktree` mechanism was available (or where the agent crashed before registering) get their worktree paths discovered and populated. The backfill runs after the session manager is ready but before the first periodic sweep.

7. **Synchronous deletion with async scheduling.** Directory removal is synchronous (`fs.rmSync` with `{ recursive: true, force: true }`), consistent with the project's pattern of synchronous file I/O for state operations. The scheduling layer (timers, sweep interval) is async.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Daemon Process                            │
│                                                              │
│  ┌──────────────┐    terminal state    ┌──────────────────┐ │
│  │ Session Mgr  │ ──── event ────────> │     Reaper       │ │
│  │              │                      │                  │ │
│  │  registry    │ <── isActive? ────── │  grace timers    │ │
│  │  (in-memory) │                      │  sweep interval  │ │
│  └──────────────┘                      └────────┬─────────┘ │
│                                                  │           │
│  ┌──────────────┐                      ┌────────▼─────────┐ │
│  │ Session Files│ <── readMeta ─────── │  Deletion Logic  │ │
│  │              │ <── updateMeta ───── │                  │ │
│  └──────────────┘                      └────────┬─────────┘ │
│                                                  │           │
└──────────────────────────────────────────────────┼───────────┘
                                                   │
                              ┌─────────────────────┼──────────────────┐
                              │                     │                   │
                              ▼                     ▼                   ▼
                   ~/agent-runs/<id>/    ~/.agent-router/sessions/   daemon log
                   (recursive delete)    (recursive delete)         (structured)
```

### Integration Points

1. **Session Manager → Reaper**: `session-mgr.ts` calls `reaper.onSessionTerminal(sessionId)` whenever a session enters terminal state (in `completeSession`, `terminateSession`, `monitorSubprocessExit` timeout paths).

2. **Reaper → Session Manager**: The reaper calls a provided `isActive(sessionId): boolean` function (backed by the registry's `.has()`) immediately before each deletion to enforce the safety invariant.

3. **Reaper → Session Files**: The reaper calls `sessionFiles.readMeta(sessionId)` to check status and `worktree_path`, and `sessionFiles.updateMeta(sessionId, { worktree_reaped_at })` after successful worktree deletion.

4. **MCP Server → Reaper** (indirect): The `register_worktree` tool writes to `meta.json` via the daemon socket → session manager → session files. The reaper reads it later from meta.

## Components and Interfaces

### `src/reaper.ts` — Session Reaper

```typescript
export interface ReaperConfig {
  enabled: boolean;
  gracePeriodMinutes: number;       // default 60
  retentionDays: number;            // default 30
  agentRunsDir: string;             // default ~/agent-runs, ~ expanded
  sweepIntervalMinutes: number;     // default 15
}

export interface Reaper {
  /** Called by session manager when a session enters terminal state. */
  onSessionTerminal(sessionId: string): void;

  /** Start the periodic sweep timer. Called once at daemon startup. */
  start(): void;

  /** Cancel all pending timers and stop the sweep. Called on shutdown. */
  shutdown(): void;
}

export function createReaper(deps: {
  config: ReaperConfig;
  sessionFiles: SessionFiles;
  isActive: (sessionId: string) => boolean;
  log: Logger;
}): Reaper;
```

#### Internal State

```typescript
// Resolved real path of agentRunsDir, computed once at init to avoid
// per-call realpathSync overhead and to handle symlinked path prefixes.
const resolvedParent = fs.realpathSync(path.resolve(config.agentRunsDir));

// Pending grace-period timers, keyed by sessionId
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// The periodic sweep interval handle
let sweepTimer: ReturnType<typeof setInterval> | null = null;

// Flag to prevent new deletions after shutdown begins
let shuttingDown = false;
```

### Configuration Extension in `src/config.ts`

```typescript
// Added to AgentRouterConfig interface:
export interface AgentRouterConfig {
  // ... existing fields ...
  reaper: ReaperConfig;
}

// Validation added to validateConfig():
// - reaper.enabled: boolean (default true)
// - reaper.gracePeriodMinutes: positive integer (default 60)
// - reaper.retentionDays: positive integer (default 30)
// - reaper.agentRunsDir: non-empty string (default ~/agent-runs)
// - reaper.sweepIntervalMinutes: positive integer (default 15)
```

### SessionMeta Extension in `src/session-files.ts`

```typescript
export interface SessionMeta {
  // ... existing fields ...
  terminal_at?: number;             // Unix timestamp, set on ANY terminal transition (completed/failed/abandoned)
  worktree_path?: string;           // registered by agent via MCP
  worktree_reaped_at?: number;      // Unix timestamp, set after worktree deletion
}
```

> **Note:** `session-mgr.ts` MUST set `terminal_at` for all three terminal states (completed, failed, abandoned). This is the single authoritative timestamp the reaper uses for grace-period and retention-window eligibility. Code that previously relied on `completed_at` for these calculations must use `terminal_at` instead, since `failed` and `abandoned` sessions may never set `completed_at`.
```

### MCP Tool Addition in `src/mcp-server.ts`

```typescript
// New tool: register_worktree
// Input: { path: string }
// Validates path is under agentRunsDir (prefix check)
// Writes to meta.json via daemon socket op "register_worktree"
```

### CLI Server Op in `src/cli-server.ts`

```typescript
// New op: "register_worktree"
// Params: { session_id: string, path: string }
// Validates session is active, path prefix matches agentRunsDir
// Calls sessionFiles.updateMeta(sessionId, { worktree_path: path })
```

## Core Algorithms

### Event-Driven Worktree Reaping

```
onSessionTerminal(sessionId):
  if shuttingDown: return
  schedule setTimeout(gracePeriodMs):
    if shuttingDown: return
    if isActive(sessionId): log.warn("session reactivated"); return
    meta = sessionFiles.readMeta(sessionId)
    if meta.status === 'active': log.warn("status changed"); return
    path = meta.worktree_path ?? discoverWorktree(sessionId, meta.repo, meta.created_at)
    if path === null: log.debug("no worktree found"); return
    try:
      if !isStrictChild(path, resolvedParent):
        log.error("path outside agentRunsDir"); return
    catch (err):
      log.error("path validation failed", { sessionId, path, err }); return
    if !fs.existsSync(path): log.debug("already deleted"); return
    fs.rmSync(path, { recursive: true, force: true })
    sessionFiles.updateMeta(sessionId, { worktree_reaped_at: now })
    log.info("worktree reaped", { sessionId, path })
```

### Periodic Sweep

```
sweep():
  if shuttingDown: return
  stats = { scanned: 0, worktrees_reaped: 0, metadata_pruned: 0, skipped: 0, errors: 0 }
  now = Date.now() / 1000

  // Phase 1: Worktree sweep (grace period elapsed, not yet reaped)
  for session of sessionFiles.listSessions():
    stats.scanned++
    if isActive(session.session_id): stats.skipped++; continue
    if session.status === 'active': stats.skipped++; continue
    if session.terminal_at === null || session.terminal_at === undefined: stats.skipped++; continue
    if session.worktree_reaped_at != null: continue  // already reaped

    age = now - session.terminal_at
    if age < gracePeriodSeconds: continue

    path = session.worktree_path ?? discoverWorktree(session.session_id, session.repo, session.created_at)
    if path === null: continue
    try:
      if !isStrictChild(path, resolvedParent): stats.errors++; continue
    catch:
      stats.errors++; log.error("path validation failed", ...); continue

    try:
      if fs.existsSync(path):
        fs.rmSync(path, { recursive: true, force: true })
        sessionFiles.updateMeta(session.session_id, { worktree_reaped_at: now })
        stats.worktrees_reaped++
    catch:
      stats.errors++; log.error(...)

  // Phase 2: Metadata sweep (retention window elapsed)
  for session of sessionFiles.listSessions():
    if isActive(session.session_id): continue
    if session.status === 'active': continue
    if session.terminal_at === null || session.terminal_at === undefined: continue

    age = now - session.terminal_at
    if age < retentionSeconds: continue

    try:
      fs.rmSync(sessionDir, { recursive: true, force: true })
      stats.metadata_pruned++
    catch:
      stats.errors++; log.error(...)

  log.info("reaper sweep complete", stats)
```

### Worktree Discovery Heuristic

```
discoverWorktree(sessionId, repo?, createdAt?):
  if repo === undefined: return null
  if createdAt === undefined: return null
  slug = repo.split('/')[1]  // "owner/name" → "name"
  if !fs.existsSync(agentRunsDir): return null

  entries = fs.readdirSync(agentRunsDir)

  // Directory name format: <YYYYMMDD-HHMMSS>-<repo>
  // Parse the timestamp prefix and match against session created_at within a 5-minute window
  const FIVE_MINUTES_S = 5 * 60

  matches = entries.filter(entry => {
    if !isDirectory(entry): return false
    // Parse timestamp prefix: YYYYMMDD-HHMMSS
    const tsMatch = entry.match(/^(\d{8}-\d{6})-(.+)$/)
    if !tsMatch: return false
    const [_, tsStr, dirSlug] = tsMatch
    // Verify repo slug matches the directory suffix
    if dirSlug !== slug: return false
    // Parse YYYYMMDD-HHMMSS into a Unix timestamp
    const parsed = parseDirTimestamp(tsStr)  // returns seconds since epoch or null
    if parsed === null: return false
    // Match if within 5-minute window of session created_at
    return Math.abs(parsed - createdAt) <= FIVE_MINUTES_S
  })

  if matches.length === 1:
    return path.join(agentRunsDir, matches[0])
  if matches.length === 0:
    log.debug("no worktree found via timestamp match", { sessionId, repo })
    return null
  // Multiple matches within window — should not happen in practice but log and skip
  log.warn("ambiguous worktree discovery", { sessionId, matches })
  return null
```

The `parseDirTimestamp(tsStr)` helper parses a `YYYYMMDD-HHMMSS` string into a Unix timestamp (seconds). This is a pure function exported for direct unit testing.

### Path Safety Check

```typescript
import path from 'node:path';
import fs from 'node:fs';

/**
 * Returns true if `target` is a strict child of `parent`.
 * Uses fs.realpathSync on BOTH sides to resolve symlinks before
 * the startsWith check. This prevents symlinked path prefixes
 * (e.g. /home is a symlink to /data/home) from causing the comparison
 * to always fail.
 *
 * Error handling:
 * - ENOENT on target: target was already deleted — log at debug level,
 *   return false (caller should skip, not error).
 * - Any other error on target (EPERM, EIO, etc.): this is a real
 *   path-boundary violation or filesystem problem — throw so caller
 *   can log at error level.
 *
 * `resolvedParent` is expensive to compute per-call since it hits the
 * filesystem. In production, the Reaper MUST compute it once at init
 * time and pass it in (see createReaper). The exported function accepts
 * the pre-resolved parent for testability and to enforce the caching
 * contract.
 */
export function isStrictChild(target: string, resolvedParent: string): boolean {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Target already deleted — not an error, just nothing to do
      return false;
    }
    // Real filesystem error — rethrow so caller can log at error level
    throw err;
  }
  return resolved.startsWith(resolvedParent + path.sep);
}
```

At Reaper initialization, the resolved parent is computed once and cached:

```typescript
// Inside createReaper(), at init time:
const resolvedParent = fs.realpathSync(path.resolve(config.agentRunsDir));
// All subsequent isStrictChild calls use this cached value:
// isStrictChild(candidatePath, resolvedParent)
```

This eliminates three vulnerabilities: (1) `startsWith` alone would accept paths like `/home/user/agent-runs-malicious/` as valid children of `/home/user/agent-runs`, (2) symlinked path components in the target could redirect deletion outside the parent directory, and (3) symlinked path prefixes in the parent (e.g. `/home` → `/data/home`) would cause `path.resolve` (lexical-only) to disagree with the resolved target, making the comparison always fail and preventing any worktrees from ever being reaped.

## Data Flow

### Session Lifecycle with Reaping

```
Session Created
    │
    ▼
Agent starts work
    │
    ├── Agent calls register_worktree(path)  ─── meta.json gains worktree_path
    │
    ▼
Session enters terminal state (completed/failed/abandoned)
    │
    ├── session-mgr calls reaper.onSessionTerminal(sessionId)
    │
    ▼
Grace period timer (default 1 hour)
    │
    ├── Safety checks pass
    │
    ▼
Worktree deleted (rm -rf ~/agent-runs/<id>/)
    │
    ├── meta.json updated with worktree_reaped_at
    │
    ▼
Retention window (default 30 days)
    │
    ├── Periodic sweep finds eligible session
    │
    ▼
Session metadata deleted (rm -rf ~/.agent-router/sessions/<uuid>/)
```

## Configuration Example

```json
{
  "reaper": {
    "enabled": true,
    "gracePeriodMinutes": 60,
    "retentionDays": 30,
    "agentRunsDir": "~/agent-runs",
    "sweepIntervalMinutes": 15
  }
}
```

All fields are optional. When the `reaper` key is omitted entirely, defaults apply and the reaper is enabled.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Worktree path doesn't exist (ENOENT in realpathSync) | `isStrictChild` returns false, caller logs at debug level ("already deleted"), skips — no error |
| Worktree path inaccessible (EPERM/EIO in realpathSync) | `isStrictChild` throws, caller logs at error level, skips session |
| Worktree path outside agentRunsDir | `isStrictChild` returns false, log error, skip |
| Worktree deletion fails (EPERM, EBUSY) | Log error, continue to next session |
| meta.json unreadable | Log warn, skip session |
| Session reactivated during grace period | Log warn, abort deletion |
| agentRunsDir doesn't exist at init | `realpathSync` throws `FatalError` — daemon cannot start without a valid agentRunsDir |
| agentRunsDir removed after init | `existsSync` check in sweep catches it; log debug, skip worktree phase |
| Discovery finds multiple matches | Log warn, skip that session |
| Daemon shutdown during deletion | Allow in-progress `rmSync` to finish, don't start new ones |

## Testing Strategy

### Tier 1 (Unit/Property)

- **Worktree discovery heuristic**: Property tests with random repo names, timestamps, and directory listings. Verify single-match returns path when timestamp is within 5-minute window, zero-match returns null when timestamp is outside window, multi-match returns null. Also unit test `parseDirTimestamp` with valid and invalid inputs.
- **Eligibility logic**: Pure function that determines if a session's artifacts are eligible for deletion given its meta and the current time. Property-test with random timestamps and states.
- **Config validation**: Unit tests for reaper config field validation, defaults, and error messages.
- **Path safety check**: Property test that no path outside agentRunsDir is ever accepted for deletion.

### Tier 2 (Full Daemon with Fakes)

- **Event-driven reaping**: Create session → complete it → advance clock past grace period → verify worktree directory is deleted.
- **Active session protection**: Create two sessions → complete one → verify only the completed session's worktree is deleted.
- **Metadata sweep**: Create sessions with old `terminal_at` timestamps → run sweep → verify metadata directories are removed.
- **Disabled reaper**: Set `enabled: false` → complete sessions → verify no deletions occur.
- **Missing worktree**: Complete a session without creating its worktree on disk → verify no error, just a debug log.
- **Daemon restart catch-up**: Complete a session without registered worktree → restart daemon → verify startup backfill discovers the worktree path, then sweep catches and reaps it.

### Tier 3 (Real Environment)

- Covered by existing session lifecycle Tier 3 tests. The reaper observes the same terminal-state transitions already exercised.

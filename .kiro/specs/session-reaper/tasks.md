# Implementation Plan: Session Reaper

## Overview

Incremental build of the session reaper subsystem. The reaper is a single new module (`src/reaper.ts`) plus small integration touches in config, session-files, session-mgr, mcp-server, and cli-server. All new code ships with Tier 1 property/unit tests and Tier 2 integration tests that exercise the reaper through the full daemon against fake backends.

Tasks are ordered: config validation first (pure logic, easy to test), then the core reaper module, then integration wiring, then MCP/CLI extensions for worktree registration.

## Tasks

- [ ] 1. Reaper configuration validation
  - [ ] 1.1 Extend `AgentRouterConfig` interface in `src/config.ts` with a `reaper: ReaperConfig` field. Define `ReaperConfig` interface: `enabled` (boolean), `gracePeriodMinutes` (positive integer), `retentionDays` (positive integer), `agentRunsDir` (string), `sweepIntervalMinutes` (positive integer). Also extend `SessionMeta` in `src/session-files.ts` with `terminal_at?: number` — a Unix timestamp set on ANY terminal transition (completed, failed, abandoned). The session manager MUST populate this field for all three terminal states.
    - _Requirements: 1.1_
  - [ ] 1.2 Add validation logic in `validateConfig` for the `reaper` block: apply defaults when key is absent (`enabled: true`, `gracePeriodMinutes: 60`, `retentionDays: 30`, `agentRunsDir: ~/agent-runs`, `sweepIntervalMinutes: 15`). Throw `FatalError` on invalid field types or non-positive integers. Expand leading `~` in `agentRunsDir` to `$HOME`.
    - _Requirements: 1.1, 1.2, 1.4, 1.5_
  - [ ] 1.3 Update `config.example.json` with a commented `reaper` block showing all fields and defaults.
    - _Requirements: 1.1_
  - [ ] 1.4 Tier 1: Unit tests for reaper config validation — test defaults applied when key absent, test each invalid field throws FatalError with descriptive message, test `~` expansion.
    - _Requirements: 1.2, 1.4, 1.5_

- [ ] 2. SessionMeta extension for worktree tracking
  - [ ] 2.1 Add optional fields `worktree_path?: string` and `worktree_reaped_at?: number` to the `SessionMeta` interface in `src/session-files.ts`.
    - _Requirements: 2.1, 3.7_
  - [ ] 2.2 Update `updateMeta` to allow writing `worktree_path` and `worktree_reaped_at` fields. Relax the "only active sessions can be modified" guard for the `worktree_reaped_at` field specifically (reaper writes it after terminal state).
    - _Requirements: 2.1, 3.7_
  - [ ] 2.3 Tier 1: Unit test confirming `worktree_path` round-trips through `updateMeta`/`readMeta`, and that `worktree_reaped_at` can be written to a terminal-state session.
    - _Requirements: 2.1, 3.7_

- [ ] 3. Core reaper module (`src/reaper.ts`)
  - [ ] 3.1 Implement `createReaper` factory function accepting dependencies: `config: ReaperConfig`, `sessionFiles: SessionFiles`, `isActive: (sessionId: string) => boolean`, `log: Logger`. At init, compute and cache `resolvedParent = fs.realpathSync(path.resolve(config.agentRunsDir))` — this value is reused for all `isStrictChild` calls. Throw `FatalError` if `agentRunsDir` does not exist at init time. Return `Reaper` interface with methods `onSessionTerminal`, `start`, `shutdown`.
    - _Requirements: 7.1, 7.4_
  - [ ] 3.2 Implement `onSessionTerminal(sessionId)` — schedule a `setTimeout` for `gracePeriodMinutes * 60 * 1000` ms. Store timer handle in internal `graceTimers` map. On fire: run safety checks (isActive, re-read meta status), resolve worktree path, delete if valid.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [ ] 3.3 Implement worktree deletion logic — validate path is a strict child of `agentRunsDir` using `isStrictChild(target, resolvedParent)`. The `resolvedParent` value MUST be computed once at Reaper init time via `fs.realpathSync(path.resolve(config.agentRunsDir))` and cached for the lifetime of the Reaper instance (avoids per-call filesystem cost and ensures consistent resolution). `isStrictChild` calls `fs.realpathSync(target)` to resolve symlinks on the candidate path, then requires the resolved real path starts with `resolvedParent + path.sep`. Error handling in `realpathSync(target)`: distinguish ENOENT (target already deleted) from other errors — ENOENT returns `false` and the caller logs at debug level ("already deleted", skip silently); any other error (EPERM, EIO, etc.) is rethrown so the caller can log at error level and skip the session. This eliminates `../` traversal, prefix-collision attacks, symlinked path components in the target, AND symlinked path prefixes in the parent (e.g. `/home` → `/data/home`) that would cause a lexical-only `path.resolve` to disagree with the resolved target. Check `fs.existsSync`, call `fs.rmSync(path, { recursive: true, force: true })`, update meta with `worktree_reaped_at`. Do not follow symlinks (`fs.lstatSync` check before deletion). Export `isStrictChild` as a pure function for unit testing (accepts pre-resolved parent string).
    - _Requirements: 3.4, 3.5, 3.6, 6.2, 6.6_
  - [ ] 3.4 Implement `discoverWorktree(sessionId, repo?, createdAt?)` — scan `agentRunsDir` entries, parse directory name format `<YYYYMMDD-HHMMSS>-<repo>`, match the parsed timestamp against the session's `created_at` within a 5-minute window AND verify the directory suffix matches the repo slug. Return single match or null on zero/multiple. Export a pure `parseDirTimestamp(tsStr): number | null` helper for unit testing. **All callers MUST pass `created_at`** — the function returns `null` immediately when `createdAt` is `undefined`, so omitting it silently disables discovery.
    - _Requirements: 2.3, 2.4_
  - [ ] 3.5 Implement `start()` — run an initial sweep immediately, then start `setInterval` at `sweepIntervalMinutes`.
    - _Requirements: 7.1, 4.1_
  - [ ] 3.6 Implement periodic sweep — Phase 1 (worktree): iterate `sessionFiles.listSessions()`, skip active/ineligible, delete worktrees past grace period. Phase 2 (metadata): iterate again, delete session directories past retention window. Log summary.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 5.3, 5.4_
  - [ ] 3.7 Implement `shutdown()` — set `shuttingDown` flag, clear all grace timers, clear sweep interval. Do not abort in-progress `rmSync` calls (they're synchronous and fast enough).
    - _Requirements: 7.2, 7.3_
  - [ ] 3.8 Implement structured logging — info on each deletion (sessionId, path, age), debug on skips, warn on ambiguity/reactivation, error on filesystem failures. Emit sweep summary with counts.
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 4. Tier 1 tests for reaper
  - [ ] 4.1 Property test: worktree discovery heuristic. Generate random directory names (format `<YYYYMMDD-HHMMSS>-<repo>`), repo slugs, and `created_at` timestamps. Assert single match returns correct path when timestamp is within 5-minute window of `created_at`, zero matches returns null when outside window, multiple matches returns null. Unit test `parseDirTimestamp` with valid and malformed inputs.
    - _Requirements: 2.3, 2.4_
  - [ ] 4.2 Property test: eligibility logic. Given random `SessionMeta` objects and timestamps, verify the pure eligibility function correctly classifies sessions as eligible/ineligible for worktree reaping and metadata pruning.
    - _Requirements: 3.1, 4.3, 6.1, 6.5_
  - [ ] 4.3 Property test: path safety check (`isStrictChild`). Generate random paths including edge cases: paths with `../` traversal, paths that share a prefix but aren't strict children (e.g. `agentRunsDir + "-malicious"`), exact match of `agentRunsDir` itself, and valid strict children. The function takes a pre-resolved parent (simulating the cached `resolvedParent` from Reaper init). Assert only paths where `fs.realpathSync(target)` starts with `resolvedParent + path.sep` pass validation. Verify ENOENT on target returns false (not throws). Verify other errors (EPERM, EIO) are rethrown. Verify no `../` traversal bypasses the check. Verify symlinked parent prefixes are handled correctly because both sides are resolved via realpathSync.
    - _Requirements: 6.2, 5.4_
  - [ ] 4.4 Unit test: `onSessionTerminal` with mock deps — verify timer is scheduled, verify safety checks prevent deletion of active session, verify deletion is skipped when path doesn't exist.
    - _Requirements: 3.2, 3.3, 3.5, 6.1_
  - [ ] 4.5 Unit test: sweep logic with mock deps — verify eligible sessions are reaped, ineligible are skipped, summary log is emitted.
    - _Requirements: 4.7, 5.1, 5.2_

- [ ] 5. Session manager integration
  - [ ] 5.1 Wire reaper into `createSessionManager` dependencies. Add optional `reaper?: Reaper` parameter to the deps object.
    - _Requirements: 7.1_
  - [ ] 5.2 Call `reaper.onSessionTerminal(sessionId)` in all terminal-state transition paths: `completeSession`, `terminateSession`, inactivity timeout handler, max-lifetime timeout handler, and `monitorSubprocessExit` failure path. Each of these paths MUST also set `terminal_at` in `meta.json` via `sessionFiles.updateMeta(sessionId, { terminal_at: now })` before notifying the reaper.
    - _Requirements: 3.1_
  - [ ] 5.3 Call `reaper.shutdown()` in the session manager's `shutdown()` method, before terminating active sessions.
    - _Requirements: 7.2_
  - [ ] 5.4 Wire reaper instantiation in `src/index.ts`: if `config.reaper.enabled`, create reaper with `isActive: (id) => sessionMgr.getActiveSession(id) !== null`, call `reaper.start()` after session manager is ready.
    - _Requirements: 1.3, 7.1, 7.4_

- [ ] 6. MCP tool: `register_worktree`
  - [ ] 6.1 Add `register_worktree` CLI server op in `src/cli-server.ts`: accepts `{ session_id, path }`, validates session is active, validates path starts with configured `agentRunsDir`, calls `sessionFiles.updateMeta(sessionId, { worktree_path: path })`.
    - _Requirements: 2.2_
  - [ ] 6.2 Expose `register_worktree` tool in `src/mcp-server.ts`: reads path argument, validates it's an absolute path under `agentRunsDir`, sends `register_worktree` op to daemon socket.
    - _Requirements: 2.2_
  - [ ] 6.3 Tier 1: Unit test for path validation in `register_worktree` — rejects paths outside agentRunsDir, rejects relative paths, accepts valid absolute paths.
    - _Requirements: 2.2, 6.2_

- [ ] 7. Tier 2 integration tests
  - [ ] 7.1 Test: event-driven worktree reaping. Create session with registered worktree path → complete session → advance clock past grace period → assert worktree directory is deleted and `worktree_reaped_at` is set in meta.
    - _Requirements: 3.1, 3.4, 3.7_
  - [ ] 7.2 Test: active session protection. Create two sessions → complete one → advance clock → assert only completed session's worktree is deleted, active session's worktree untouched.
    - _Requirements: 6.1, 6.5_
  - [ ] 7.3 Test: metadata sweep. Create sessions with `terminal_at` older than retention window → trigger sweep → assert session directories are removed from disk.
    - _Requirements: 4.3, 4.5_
  - [ ] 7.4 Test: missing worktree path. Complete session without creating worktree on disk → verify no error, debug log emitted, daemon continues.
    - _Requirements: 3.5_
  - [ ] 7.5 Test: reaper disabled. Set `reaper.enabled: false` in config → complete sessions → verify no deletions occur, no timers are scheduled.
    - _Requirements: 1.3, 7.4_
  - [ ] 7.6 Test: sweep catches orphaned worktree after daemon restart. Complete session → stop daemon → restart daemon → run sweep → assert worktree is reaped.
    - _Requirements: 5.1, 5.2_

- [ ] 8. Startup worktree backfill sweep
  - [ ] 8.1 On daemon startup, if `reaper.enabled` is true, run a one-time discovery sweep for all terminal sessions that have no registered `worktree_path` in their `meta.json`. For each such session, call `discoverWorktree(session.session_id, session.repo, session.created_at)` — passing `created_at` is required for the heuristic to match — and, if a unique match is found, write the discovered path to `meta.json` via `sessionFiles.updateMeta(sessionId, { worktree_path: path })`.
    - _Requirements: 2.3, 5.1_
  - [ ] 8.2 The backfill sweep MUST run after session-manager is ready and before the first periodic sweep, so that the periodic sweep can operate on the newly-discovered paths.
    - _Requirements: 7.1_
  - [ ] 8.3 Tier 1: Unit test for backfill logic — given a set of terminal sessions without `worktree_path` and a set of directory entries, verify correct paths are discovered and written.
    - _Requirements: 2.3, 2.4_
  - [ ] 8.4 Tier 2: Integration test — create sessions without registered worktree paths, place matching directories in `agentRunsDir`, start daemon → verify backfill populates `worktree_path` in meta.json and subsequent sweep can reap them.
    - _Requirements: 2.3, 5.1_

- [ ] 9. Documentation and config update
  - [ ] 9.1 Update `README.md` operational section with reaper configuration documentation and explanation of default behavior.
    - _Requirements: 1.1_
  - [ ] 9.2 Update `BACKLOG.md` to mark P1.4 as superseded by session-reaper spec.
  - [ ] 9.3 Add reaper fields to `config.example.json` with inline comments.
    - _Requirements: 1.1_

## Notes

- Task ordering ensures pure-logic modules (config validation, eligibility checks) are built and tested before integration wiring.
- The `updateMeta` guard relaxation (task 2.2) is scoped narrowly: only `worktree_reaped_at` can be written to terminal sessions. All other fields still require active status.
- Tier 2 tests require clock control (`advanceClock` on TestDaemon) to avoid real 1-hour waits. The existing harness already supports this.
- Total estimate: ~600 lines of production code, ~400 lines of tests. Fits in a single PR.

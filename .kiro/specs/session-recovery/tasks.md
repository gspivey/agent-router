# Implementation Tasks: Session Recovery

## Task 1: Add `loadSession` to ACPClient interface and implementation

- [ ] Add `loadSession(sessionId: string): Promise<void>` to the `ACPClient` interface in `src/acp.ts`
- [ ] Implement `loadSession` in `createACPClientFromStreams` — sends `session/load` JSON-RPC request with `{ sessionId }` params
- [ ] Implement `loadSession` in the `spawnACPClient` wrapper (delegates to streams-based client)

**Requirements addressed:** Req 1.3

## Task 2: Add `kiro_session_id` persistence to session creation

- [ ] Add `kiro_session_id?: string` field to the `SessionMeta` interface in `src/session-files.ts`
- [ ] In `createSession` within `src/session-mgr.ts`, after `acp.newSessionWithPrompt()` succeeds, call `sessionFiles.updateMeta(sessionId, { kiro_session_id: acpSessionId })` to persist the ACP session ID

**Requirements addressed:** Req 1.3 (prerequisite — recovery needs this ID to exist)

## Task 3: Implement `resumeSessions` method on SessionManager

- [ ] Add `resumeSessions(): Promise<{ resumed: number; terminated: number }>` to the `SessionManager` interface in `src/session-mgr.ts`
- [ ] Implement the recovery loop: scan active sessions, filter by `status === 'active'`, attempt resume for each
- [ ] For sessions without `kiro_session_id`: log WARN, append `session_ended` stream entry with `reason: terminated_by_restart`, update meta to `{ status: 'abandoned', completed_at, termination_reason: 'terminated_by_restart' }`, call `markTerminalAndNotifyReaper`
- [ ] For sessions with `kiro_session_id`: spawn ACP client via `acpSpawner(sessionId, meta.repo)`, call `acp.initialize()`, call `acp.loadSession(kiroSessionId)`
- [ ] On success: build `SessionHandle` (paths, event queue, turn queue), register in registry, start notification consumer, subprocess exit monitor, inactivity timer, lifetime timer. Log INFO.
- [ ] On failure: catch error, log WARN with error message, mark abandoned same as missing-ID case
- [ ] Return aggregate `{ resumed, terminated }` counts

**Requirements addressed:** Req 1.1–1.5, Req 2.1–2.5, Req 4.1–4.3

## Task 4: Wire `resumeSessions` into daemon startup

- [ ] In `src/index.ts`, call `await sessionMgr.resumeSessions()` after session manager creation and before starting the HTTP server, event queue worker, and cron jobs
- [ ] Log the result at INFO level when at least one session was resumed or terminated: `'Session resumption complete', { resumed, terminated }`
- [ ] Verify startup ordering: recovery completes before `serve()` binds the port

**Requirements addressed:** Req 1.1, Req 3.3, Req 5.1–5.3, Req 6.1

## Task 5: Add `terminated_by_restart` to termination reason union

- [ ] Add `'terminated_by_restart'` to the `termination_reason` union type in `SessionMeta` (in `src/session-files.ts`)
- [ ] Verify the cron guard (`src/cron-guard.ts`) treats `terminated_by_restart` as a retriable failure that allows cron refire

**Requirements addressed:** Req 2.3 (type safety for the new reason value)

## Task 6: Tier 1 tests — `resumeSessions` unit tests

- [ ] Test: recovery with zero active sessions returns `{ resumed: 0, terminated: 0 }` (Req 5.1)
- [ ] Test: session without `kiro_session_id` is marked abandoned with correct meta fields (Req 2.1, 2.3)
- [ ] Test: session with `kiro_session_id` where `loadSession` succeeds results in handle registered in registry (Req 1.3, 1.4)
- [ ] Test: session with `kiro_session_id` where `loadSession` throws is marked abandoned (Req 2.2, 2.4)
- [ ] Test: multiple active sessions — one succeeds, one fails — counts are correct and both are processed (Req 2.5)
- [ ] Test: fresh inactivity and lifetime timers are started for recovered sessions (Req 4.1, 4.2)

**Requirements addressed:** Req 1–6 (unit coverage)

## Task 7: Tier 2 tests — full daemon recovery integration

- [ ] Test: start daemon with FakeKiro backend, create a session, stop daemon (simulate restart by directly re-instantiating), verify the session is resumed and webhook routing works post-restart (Req 1, 3)
- [ ] Test: start daemon, create a session, corrupt the `kiro_session_id` (or make FakeKiro reject `session/load`), restart daemon, verify session is marked abandoned and cron can refire (Req 2)
- [ ] Test: start daemon with no active sessions, verify clean startup with no errors and zero-count return (Req 5)

**Requirements addressed:** Req 1–5 (integration coverage)

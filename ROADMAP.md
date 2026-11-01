# ROADMAP

Ordered work queue for agent-router sessions. This is the serialized, dependency-ordered
form of the project's specs and backlog: one list of PR-sized items an agent ships **one at
a time**.

**How an agent uses this file:** pick the **first item whose checkbox is unchecked**
(`- [ ] Complete`), implement exactly that one item, and read every file named on the item's
`Spec:` line *before* writing any code. When CI is green, tick the item's box with the PR
number (`- [x] Complete · PR: #<n>`), tick the matching checkboxes in the referenced
`tasks.md` (where one exists), and squash-merge the branch into `development`. **One item per
session — never start a second.** The full session contract lives in
[`prompts/agent-router.md`](prompts/agent-router.md); the conventions and branch model live
in [`AGENTS.md`](AGENTS.md).

Each item is sized for a single reviewable PR (roughly 300–500 lines of new or modified code,
tests included) and is topologically ordered: by the time an agent reaches an item, every
prerequisite it builds on has already merged to `development`. Items are sourced two ways:

- **Spec-backed items** cite a Kiro spec directory and `tasks.md` sub-task numbers, e.g.
  `Spec: .kiro/specs/browser-test-harness/ · tasks 1.1, 2.1`. Read the spec's
  `requirements.md`, `design.md`, and `tasks.md` before coding, and tick the cited sub-tasks
  on merge.
- **Backlog-backed items** cite a `BACKLOG.md` mini-spec, e.g. `Spec: BACKLOG.md § P1.5`.
  The mini-spec is the contract; there is no `tasks.md` to tick, only the ROADMAP checkbox.

For the method used to turn a Kiro spec into queue items, see
[`docs/roadmap-from-kiro-specs.md`](docs/roadmap-from-kiro-specs.md). Strategic phase
direction (what this all builds toward) lives in [`PRODUCT.md`](PRODUCT.md); tactical
mini-specs live in [`BACKLOG.md`](BACKLOG.md).

---

## Active Roadmap

---

### 62. Auth credential proxy v2 — get_token derives project from session (security fix)

Read `.kiro/specs/auth-credential-proxy-v2/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `10.1`, `10.2`, `10.3`, `10.4`, `11`. Depends on item 61.

- Spec: `.kiro/specs/auth-credential-proxy-v2/` · tasks `10.1`, `10.2`, `10.3`, `10.4`, `11`
- [x] Complete · PR: #118

### 61. Auth credential proxy v2 — path/repo cross-check security fix

Read `.kiro/specs/auth-credential-proxy-v2/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `9.1`, `9.2`, `9.3`, `9.4`.

- Spec: `.kiro/specs/auth-credential-proxy-v2/` · tasks `9.1`, `9.2`, `9.3`, `9.4`
- [x] Complete · PR: #115

---

### 60. Browser test harness v2 — housekeeping (update stale v1 spec headers, record backoff defect note)

Read `.kiro/specs/browser-test-harness-v2/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `G2`, `G3`. G2 is documentation-only — add a code comment in `src/web-ui.ts`
near `connectSSE` noting the reset behavior; do NOT change the backoff logic (Req 6.2 requires
fixed 1000ms first retry). Depends on item 59.

- Spec: `.kiro/specs/browser-test-harness-v2/` · tasks `G2`, `G3`
- [x] Complete · PR: #113

---

### 59. Browser test harness v2 — missing tests (Last-Event-ID header, fetch timeout budget, stale test.fail marks)

Read `.kiro/specs/browser-test-harness-v2/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `8.2`, `14.5`, `G4`.

- Spec: `.kiro/specs/browser-test-harness-v2/` · tasks `8.2`, `14.5`, `G4`
- [x] Complete · PR: #112

---

### 58. Web client: SSE anti-buffering headers and initial flush

Read `.kiro/specs/web-client/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `4.1b`.

- Spec: `.kiro/specs/web-client/` · task `4.1b`
- [x] Complete · PR: #110

Items move here after they merge to `development`.

### 84. Agent process isolation — config, agent socket, spawn change, cap-token, worktree base

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `84.1`, `84.2`, `84.3`, `84.4`, `84.5`, `84.6`, `84.7`, `84.8`.
Depends on item 83 (user, socket dir, worktree dir must exist).

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `84.1–84.8`
- [x] Complete · PR: #150

---

### 85. Agent process isolation — MCP changes (remove git_credential, github_forward relay, push_branch)

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `85.1`, `85.2`, `85.3`, `85.4`, `85.5`, `85.6`. Depends on item 84
(agent socket and cap_token in place).

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `85.1–85.6`
- [x] Complete · PR: #151

---

### 83. Agent process isolation — setup script, user, proxy, iptables, rootDir hardening

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `83.1`, `83.2`, `83.3`, `83.4`.

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `83.1–83.4`
- [x] Complete · PR: #149

---

### 79. Wire MCP server into ACP sessions (register_pr, merge_pr, complete_session)

Read `.kiro/specs/mcp-server-wiring/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1`, `2`, `3`, `4`, `5`, `6`, `7`, `7b`, `8`, `9`, `9b`, `10`, `11`.

- Spec: `.kiro/specs/mcp-server-wiring/` · tasks `1`–`11` (including `9b`)
- [x] Complete · PR: #142

### 82. SPA operator restoration — Config view

Read `.kiro/specs/spa-operator-restoration/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `C-1`, `C-2`. Depends on items 80 and 81.

- Spec: `.kiro/specs/spa-operator-restoration/` · tasks `C-1`, `C-2`
- [x] Complete · PR: #147

---

### 81. SPA operator restoration — Session detail: metadata panel, internals toggle, tool truncation, Kill

Read `.kiro/specs/spa-operator-restoration/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `B-1`, `B-2`, `B-3`, `B-4`, `B-5`, `B-6`, `B-7`, `B-8`. Depends on item 80.

- Spec: `.kiro/specs/spa-operator-restoration/` · tasks `B-1`–`B-8`
- [x] Complete · PR: #146

---

### 80. SPA operator restoration — Session list: metadata fields, repo grouping, Config route stub

Read `.kiro/specs/spa-operator-restoration/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `A-1`, `A-2`, `A-3`, `A-4`, `A-5`, `A-6`, `A-7`, `A-8`, `A-9`.

- Spec: `.kiro/specs/spa-operator-restoration/` · tasks `A-1`–`A-9`
- [x] Complete · PR: #145

---

### 78. SPA overhaul — cutover: migrate / and /ui to the SPA, remove the monolith

Read `.kiro/specs/spa-overhaul/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `8`. Depends on item 77.

- Spec: `.kiro/specs/spa-overhaul/` · task `8`
- [x] Complete · PR: #138

### 77. SPA overhaul — JSON pivot toggle, polish, accessibility

Read `.kiro/specs/spa-overhaul/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `7`. Depends on item 76.

- Spec: `.kiro/specs/spa-overhaul/` · task `7`
- [x] Complete · PR: #137

### 76. SPA overhaul — live SSE streaming, streaming states, operator controls

Read `.kiro/specs/spa-overhaul/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `6`. Depends on item 75.

- Spec: `.kiro/specs/spa-overhaul/` · task `6`
- [x] Complete · PR: #136

### 75. SPA overhaul — core chat view, bubble renderer, all entry kinds

Read `.kiro/specs/spa-overhaul/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `5`. Depends on item 74.

- Spec: `.kiro/specs/spa-overhaul/` · task `5`
- [x] Complete · PR: #135

### 74. SPA overhaul — mobile-first session list view, single Sessions nav

Read `.kiro/specs/spa-overhaul/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `4`. Depends on item 73.

- Spec: `.kiro/specs/spa-overhaul/` · task `4`
- [x] Complete · PR: #134

### 73. SPA overhaul — auth flow, typed API client, SSE stream client

Read `.kiro/specs/spa-overhaul/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `3`. Depends on item 71.

- Spec: `.kiro/specs/spa-overhaul/` · task `3`
- [x] Complete · PR: #133

### 72. SPA overhaul — Hono SPA serving under /app, dev proxy wiring

Read `.kiro/specs/spa-overhaul/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `2`. Depends on item 71.

- Spec: `.kiro/specs/spa-overhaul/` · task `2`
- [x] Complete · PR: #132

---

### 71. SPA overhaul — client build infrastructure + history/SSE seam field

Read `.kiro/specs/spa-overhaul/requirements.md`, `design.md`, and `tasks.md` in full,
then implement task `1`. First item in the spa-overhaul sequence.

- Spec: `.kiro/specs/spa-overhaul/` · task `1`
- [x] Complete · PR: #131

---

### 70. Task/attempt/outcome — ROADMAP intake adapter + final verification

Read `.kiro/specs/task-attempt-outcome/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `12.1`, `12.2`, `12.3`, `12.4`, `13.1`. Depends on item 69.

- Spec: `.kiro/specs/task-attempt-outcome/` · tasks `12.1`, `12.2`, `12.3`, `12.4`, `13.1`
- [x] Complete · PR: #128

---

### 69. Task/attempt/outcome — /v1 REST + SSE API, restart recovery, daemon wiring

Read `.kiro/specs/task-attempt-outcome/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `9.1`, `9.2`, `10.1`, `10.2`, `10.3`, `10.4`, `10.5`, `11.1`, `11.2`, `11.3`. Depends on item 68.

- Spec: `.kiro/specs/task-attempt-outcome/` · tasks `9.1`, `9.2`, `10.1`, `10.2`, `10.3`, `10.4`, `10.5`, `11.1`, `11.2`, `11.3`
- [x] Complete · PR: #127

---

### 68. Task/attempt/outcome — attempt runner, repo scheduler/breaker, agent outcome channel, transcript retention

Read `.kiro/specs/task-attempt-outcome/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `4.1`, `4.2`, `4.3`, `5.1`, `5.2`, `5.3`, `5.4`, `5.5`, `6.1`, `6.2`, `6.3`, `7.1`, `7.2`, `7.3`, `8.1`, `8.2`, `8.3`. Depends on item 67.

- Spec: `.kiro/specs/task-attempt-outcome/` · tasks `4.1`, `4.2`, `4.3`, `5.1`, `5.2`, `5.3`, `5.4`, `5.5`, `6.1`, `6.2`, `6.3`, `7.1`, `7.2`, `7.3`, `8.1`, `8.2`, `8.3`
- [x] Complete · PR: #126

---

### 67. Task/attempt/outcome — ULID, types, DB tables, task service/state machine

Read `.kiro/specs/task-attempt-outcome/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1.1`, `1.2`, `1.3`, `1.4`, `2.1`, `2.2`, `2.3`, `2.4`, `2.5`, `3.1`, `3.2`, `3.3`.

- Spec: `.kiro/specs/task-attempt-outcome/` · tasks `1.1`, `1.2`, `1.3`, `1.4`, `2.1`, `2.2`, `2.3`, `2.4`, `2.5`, `3.1`, `3.2`, `3.3`
- [x] Complete · PR: #125

---

### 66. Session stream chat — Tier 2 browser tests and regression verification

Read `.kiro/specs/session-stream-chat/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `8`, `9`. Depends on item 65.

- Spec: `.kiro/specs/session-stream-chat/` · tasks `8`, `9`
- [x] Complete · PR: #122

---

### 65. Session stream chat — tool cards, permission/internal rendering, and wiring

Read `.kiro/specs/session-stream-chat/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `5`, `6`, `7`. Depends on item 64.

- Spec: `.kiro/specs/session-stream-chat/` · tasks `5`, `6`, `7`
- [x] Complete · PR: #121

---

### 64. Session stream chat — CSS, markdown renderer, and render context

Read `.kiro/specs/session-stream-chat/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `2`, `3`, `4`. Depends on item 63.

- Spec: `.kiro/specs/session-stream-chat/` · tasks `2`, `3`, `4`
- [x] Complete · PR: #120

---

### 63. Session stream chat — parser, types, and Tier 1 tests

Read `.kiro/specs/session-stream-chat/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1`, `1b`.

- Spec: `.kiro/specs/session-stream-chat/` · tasks `1`, `1b`
- [x] Complete · PR: #119

---

### 57. Claude Code adapter — wiring, hot-reload, and tests

Read `.kiro/specs/claude-code-adapter/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `3`, `4`, `5`, `6`, `7`. Depends on item 56.

- Spec: `.kiro/specs/claude-code-adapter/` · tasks `3`, `4`, `5`, `6`, `7`
- [x] Complete · PR: #106

---

### 56. Claude Code adapter — config schema and adapter file

Read `.kiro/specs/claude-code-adapter/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1`, `2`.

- Spec: `.kiro/specs/claude-code-adapter/` · tasks `1`, `2`
- [x] Complete · PR: #105

---

### 55. Web UI project concept — frontend (UI panel, repo filter, E2E)

Read `.kiro/specs/web-ui-project-concept/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `6`, `7`, `8`. Depends on item 54.

- Spec: `.kiro/specs/web-ui-project-concept/` · tasks `6`, `7`, `8`
- [x] Complete · PR: #104

---

### 54. Web UI project concept — backend (config types, pure logic, tests, API)

Read `.kiro/specs/web-ui-project-concept/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1`, `2`, `3`, `4`, `5`.

- Spec: `.kiro/specs/web-ui-project-concept/` · tasks `1`, `2`, `3`, `4`, `5`
- [x] Complete · PR: #103

---

### 53. Web UI sessions by repo — frontend polish (accessibility, router, verification)

Read `.kiro/specs/web-ui-sessions-by-repo/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `9`, `10`, `11`. Depends on item 52.

- Spec: `.kiro/specs/web-ui-sessions-by-repo/` · tasks `9`, `10`, `11`
- [x] Complete · PR: #102

---

### 52. Web UI sessions by repo — frontend core (CSS, grouped JS, pagination)

Read `.kiro/specs/web-ui-sessions-by-repo/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `6`, `7`, `8`. Depends on item 51.

- Spec: `.kiro/specs/web-ui-sessions-by-repo/` · tasks `6`, `7`, `8`
- [x] Complete · PR: #101

---

### 51. Web UI sessions by repo — backend (utilities + API endpoints)

Read `.kiro/specs/web-ui-sessions-by-repo/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1`, `2`, `3`, `4`, `5`.

- Spec: `.kiro/specs/web-ui-sessions-by-repo/` · tasks `1`, `2`, `3`, `4`, `5`
- [x] Complete · PR: #100

---

### 50. Web UI config view — frontend (nav, rendering, CSS)

Read `.kiro/specs/web-ui-config-view/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `4`, `5`, `6`, `7`. Depends on item 49.

- Spec: `.kiro/specs/web-ui-config-view/` · tasks `4`, `5`, `6`, `7`
- [x] Complete · PR: #99

---

### 49. Web UI config view — backend (helpers + API route)

Read `.kiro/specs/web-ui-config-view/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1`, `1b`, `2`, `2b`, `3`.

- Spec: `.kiro/specs/web-ui-config-view/` · tasks `1`, `1b`, `2`, `2b`, `3`
- [x] Complete · PR: #97

---

### 48. Session recovery on daemon restart

Implement automatic session recovery in `resumeSessions()` on `SessionManager`: scan for
`status: active` sessions on startup, spawn fresh ACP subprocesses, call `acp.loadSession()`
to resume Kiro context, re-register in the in-memory registry so webhook routing resumes.
Sessions that cannot be resumed are marked `abandoned` with `terminated_by_restart` so the
cron circuit breaker can refire them. Includes `loadSession` ACP method, `kiro_session_id`
persistence, startup wiring, new termination reason union value, and Tier 1 + Tier 2 tests.

- Spec: `.kiro/specs/session-recovery/` · tasks `1`, `2`, `3`, `4`, `5`, `6`, `7`
- [x] Complete · PR: #96

---

### 47. Add deadline to `verify()` call in inactivity timer

Wrap `verify(sessionId)` in `Promise.race([verify(sessionId), timeout(30_000)])` to prevent the
inactivity handler from leaking sessions when the GitHub API hangs.

- Spec: `BACKLOG.md § P2.18`
- [x] Complete · PR: #95

---

### 46. Add `writeWorktreeReapedAt` to `SessionFiles`

Move reaper's direct `meta.json` writes into a new `SessionFiles.writeWorktreeReapedAt()` method
so the atomic-write abstraction is not duplicated.

- Spec: `BACKLOG.md § P2.17`
- [x] Complete · PR: #94

---

### 45. Extract `SessionState` type from `session-mgr.ts`

Replace 4 parallel Maps (`inactivityTimers`, `lifetimeTimers`, `graceTimers`, `completionFlags`)
with a single `Map<sessionId, SessionState>`. Pure refactor — all existing tests must pass.

- Spec: `BACKLOG.md § P2.16`
- [x] Complete · PR: #93

---

### 44. Fix Reaper double-initialization

Refactor `src/index.ts` startup to pass the real reaper instance (not a placeholder stub) to
`createSessionManager`. Add Tier 2 test asserting real reaper shutdown is called.

- Spec: `BACKLOG.md § P2.15`
- [x] Complete · PR: #88

---

### 43. Fix CI `pull_request` trigger to target `development`

Change `pull_request: branches: [main]` → `branches: [development]` in `.github/workflows/ci.yml`
and fix nightly to run against `development`. Unblocks the entire agent CI feedback loop — without
this fix, agents receive zero CI comment feedback on their PRs.

- Spec: `BACKLOG.md § P2.14`
- [x] Complete · PR: #85

---

### 42. Session reaper: automatic disk reclamation

Delete agent working directories (`~/agent-runs/<session>/`) and prune session metadata
(`~/.agent-router/sessions/<uuid>/`) after sessions reach a terminal state. Solves an
immediate disk crisis: 128 unreleased worktrees consuming 65 GB (88% disk) on the VM.

Core design: in-process `src/reaper.ts` wired into the session state machine.
Event-driven deletion fires after a configurable grace period (default 1h) on session
terminal transition. A periodic sweep catches sessions missed during downtime. Worktree
paths registered via new `register_worktree` MCP tool, with timestamp-based discovery
heuristic and startup backfill for legacy sessions. Safety: `isStrictChild` uses
`fs.realpathSync` on both sides; active sessions are never touched.

- Spec: `.kiro/specs/session-reaper/` · tasks `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`
- [x] Complete · PR: #83

---

### 41. Token_Store startup integration

Wire Token_Store into `src/index.ts` startup: create after config load with `tokensFilePath` and
optional `GITHUB_TOKEN` fallback, register SIGHUP → `tokenStore.reload()`, call
`startWatching()`, pass to SessionManager/createApp/CliServer. FatalError if fallback mode +
`credentialMode: "mcp"`. Add `tokenStore.stopWatching()` to shutdown sequence. Builds on all
prior credential items (34–40).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `23.1`, `23.2`, `24`
- [x] Complete · PR: #80

---

### 40. Webhook token lookup + CLI `tokens status`

Extend webhook handler to use Token_Store reverse lookup (repo → project → PAT) for outgoing API
calls. Add `tokens_status` IPC op to `src/cli-server.ts` with optional `--check` live validation
(GET /user per token, 1h cache). Implement CLI daemon-offline fallback (read tokens.json
directly). Property test for cache validity. Unit tests for output format, cache hit/miss, offline
fallback. Tier 2 tests: correct PAT used for webhook outgoing calls, unknown repo warning.
Builds on item 34 (Token_Store).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `19`, `20.1`, `20.2`, `21`, `22.1`, `22.2`, `22.3`
- [x] Complete · PR: #79

---

### 39. MCP `git_credential` tool + IPC contract tests

Implement `git_credential` MCP tool: validate repo in Bound_Project repos, per-call `get_token`
IPC, return `{ protocol, host, username, password }` in git credential format. Structured logging
with same Property 14 fields. Tier 2 tests: correct credential format returned, unauthorized repo
rejected, token lookup failure returns error. Tier 2 IPC contract tests: `get_session_project`
returns correct data, `get_token` returns token with `expires_at`. Builds on item 38 (shared MCP
infrastructure).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `17.1`, `17.2`, `18`
- [x] Complete · PR: #78

---

### 38. MCP `github_http_forward` tool

Implement the `github_http_forward` MCP tool: per-call `get_token` IPC (not cached — rotation
propagates), inject `Authorization: Bearer <token>` + `User-Agent` + `Accept` headers, forward
to `https://api.github.com`, 30s timeout, return status + headers + body. Structured logging
(Property 14 fields: `tool_name`, `repo`, `project`, `session_id`, `status`, `duration_ms`,
`error_code`). Never log token values. Property test for log entry structure. Tier 2 tests
against fake GitHub server (token injection, response passthrough, timeout, body size, read/write
enforcement). Builds on items 37 (validation + IPC) and 32 (fake GitHub auth).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `16.1`, `16.2`, `16.3`, `16.4`
- [x] Complete · PR: #77

---

### 37. IPC ops + MCP credential bootstrap + request validation

Add `get_session_project` and `get_token` IPC ops to `src/cli-server.ts`. Implement MCP startup
`get_session_project` call with caching and register `github_http_forward` / `git_credential`
tool skeletons. Implement request validators: method (GET/POST/PUT/PATCH/DELETE), path prefix
(GitHub API), body size (10 MB max), repo authorization (write → Bound_Project repos, read →
public or `read_repos`). Property tests (Properties 6, 11, 12, 13) for validators. Unit tests
for edge cases. Tier 2 IPC contract tests. Builds on items 35/36 (session metadata, IPC deps).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `12`, `13`, `14`, `15.1`, `15.2`, `15.3`, `15.4`, `18`
- [x] Complete · PR: #76

---

### 36. Session `read_repos` parsing

Implement YAML frontmatter and explicit-arg `read_repos` parsing in `src/session-mgr.ts`. Store
parsed `read_repos` in session metadata as `bound_project_read_repos`. Tier 1 unit tests for
parsing edge cases (valid/invalid/missing YAML frontmatter, explicit parameter, malformed inputs).
Tier 2 test verifying `read_repos` stored correctly and available via IPC. Builds on item 35
(session metadata fields).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `11.1`, `11.2`, `11.3`, `11.4`
- [x] Complete · PR: #75

---

### 35. Config `credentialMode` + session credential injection

Add `credentialMode: 'env' | 'mcp'` to config with validation. Extend `SessionMeta` with
optional `bound_project`, `bound_project_repos`, `bound_project_read_repos`, `credential_mode`
fields. Extend `SessionHandle` and `createSessionManager` deps to accept `TokenStore` and
`credentialMode`. Implement Bound_Project resolution in `createSession`: resolve repo →
project, inject `GITHUB_TOKEN` for env mode, omit for mcp mode, reject on unknown repo. Tier 1
config tests; Tier 2 session credential tests (env present/absent, bound project metadata,
rejection for unknown repo). Builds on item 34 (Token_Store).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `8`, `9.1`, `9.2`, `10.1`, `10.2`, `10.3`, `10.4`
- [x] Complete · PR: #74

---

### 34. Token_Store factory + lifecycle tests

Implement `createTokenStore` factory in `src/token-store.ts`: load/parse/validate tokens file,
fallback to `GITHUB_TOKEN` env with deprecation warning, `FatalError` when neither available.
Implement `getToken`, `getProject`, `findProjectByRepo`, `getTokenMap`, `reload` (re-read,
re-validate, atomic swap, retain-on-failure), `startWatching` (fs.watch + 30s poll),
`stopWatching`. Property tests for lookups (Properties 4, 5). Unit tests for lifecycle (fallback,
missing file, invalid reload retains old, permissions warning). Tier 2 tests with real filesystem:
write tokens.json, create store, verify lookups; SIGHUP reload; fs.watch automatic reload. Builds
on item 33 (validation functions).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `6.1`, `6.2`, `6.3`, `7`
- [x] Complete · PR: #73

---

### 33. Pure validation functions + property tests

Create `src/token-store.ts` with exported pure validation functions and type definitions:
`isValidProjectName`, `isValidRepoString`, `validateProjectEntry`, `validateRepoUniqueness`,
`parseTokensFile`, `computeReloadDiff`, `evaluateExpiryWarnings`, `serializeTokenMap`. Define
`ProjectEntry`, `TokenMap`, `ReloadDiff`, `ExpiryWarning`, `TokenStore` interfaces. Property
tests: tokens-file round-trip (Property 1), project entry validation (Property 2), repo
uniqueness invariant (Property 3), reload diff correctness (Property 7), project name validation
(Property 9), expiry warning tiers (Property 10). Unit tests for edge cases (invalid JSON,
missing fields, duplicate repos). Builds on item 32 (`Secret` type).

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `3`, `4.1`, `4.2`, `4.3`, `4.4`, `4.5`, `4.6`, `5`
- [x] Complete · PR: #72

---

### 32. Secret type + test harness extensions

Create `src/secret.ts` with a `Secret` wrapper class that prevents raw credential strings from
leaking into logs, JSON output, or string interpolation. Private constructor, `Secret.of(value)`
factory (throws on empty), `reveal()` for controlled access, `toString()`/`toJSON()`/custom
inspect all return `[REDACTED]`. Extend `test/harness/fake-github.ts` with Authorization header
validation (`requireAuthToken`) and canned response support for credential-tool forwarding tests.
Create `test/harness/mock-daemon-socket.ts` simulating `get_session_project` and `get_token` IPC
operations for future MCP credential tool Tier 2 tests. Property tests (fast-check, 100 runs)
for the Secret redaction guarantee; Tier 2 tests for the harness extensions.

- Spec: `.kiro/specs/auth-credential-proxy/` · tasks `1.1`, `1.2`, `1.3`, `2.1`, `2.2`
- [x] Complete · PR: #71

---

### 31. `no_work_available` termination reason

Add `no_work_available` to the closed `termination_reason` union in `src/session-files.ts` so
an agent that finds no actionable roadmap items can exit cleanly via `complete_session` with
this reason. The session ends with `status: "completed"`. Tier 1 test (write + read the new
reason) + Tier 2 test (`complete_session` via IPC with the new reason produces correct meta
state).

- Spec: `BACKLOG.md § P1.2`
- [x] Complete · PR: #70

---

### 29. Web: SSE hardening for Cloudflare / mobile

Make the live stream survive proxy buffering and mobile network transitions. Server: set
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, explicit event-stream type,
an initial flush, per-event `id:` and a `retry:` hint; configurable heartbeat
(`src/web-server.ts`/`src/sse-broker.ts`). Client: reconnect on `visibilitychange`/`online`,
resume via `Last-Event-ID` with de-dupe, stop on `session_ended`. Browser tests for reconnect
without duplicates. Builds on items 17/18 reconnect coverage.

- Spec: `.kiro/specs/web-client/` · tasks `4.1`, `4.2`
- [x] Complete · PR: #69

---

### 28. Web: client fetch resilience

Replace the bare `apiFetch` with a wrapper that has a bounded `AbortController` timeout and
retry-with-backoff for network/5xx (not `401`), and add a clear error state with a Retry action
plus an auth-specific message. Transient blips self-heal; mutations are not auto-retried.
Browser tests: fail-then-recover, permanent-fail → Retry, `401` → auth message, hung → timeout.

- Spec: `.kiro/specs/web-client/` · tasks `3.1`
- [x] Complete · PR: #68

---

### 27. Web: one-request session list

Kill the N+1 fan-out that causes most mobile "Load failed". Move the per-session waiting-for
computation server-side so the `/sessions` list response carries status/repo/timestamps/waiting-for
(`src/web-routes.ts`), add bounded pagination (replace `limit=500`, active always shown), and
make the client (`src/web-ui.ts`) render from a single request — deleting `fetchWaitingFor` and
the per-row loop. Tier 2 (list shape + pagination) + browser test (exactly one list request).

- Spec: `.kiro/specs/web-client/` · tasks `2.1`, `2.2`
- [x] Complete · PR: #67

---

### 26. Web: diagnose and reproduce load/SSE failures

Reproduce the "Load failed"/SSE-drop failures under the browser harness with network shaping
(CDP `Network.emulateNetworkConditions`, route delay/abort, offline→online) — desktop-direct vs
mobile/cloudflared-like — and capture a repro matrix. These specs start as expected-fail and
become the regression suite for items 27–29. Depends on the browser harness (items 14–18).

- Spec: `.kiro/specs/web-client/` · tasks `1.1`
- [x] Complete · PR: #66

---

### 25. Restart-required surfacing (env caveat)

Surface changes that a hot-reload cannot apply. Record a `restart_required` condition
(`{ fields, since }`) when a reload sees a restart-required field differ from the startup value;
log `warn` each reload while it persists and expose it on `/health` (item 9) when present.
Document the `EnvironmentFile`/`ENV:` limitation (rotated tokens need a restart) in README.
Builds on item 24. Tier 1 (state logic) + Tier 2 (changed restart-field sets the condition).

- Spec: `.kiro/specs/operator-controls/` · tasks `6.1`
- [x] Complete · PR: #65

---

### 24. Config hot-reload

Pick up `config.json` changes without a restart. Add `src/config-watch.ts` (debounced
`fs.watch` → `loadConfig`, retain-on-invalid) and a pure `classifyConfigChange(old, next)`;
apply reloadable fields (`repos`, `cron`, `rateLimit`, `sessionTimeout`, `defaultGithubToken`,
`allowedEmails`) to running components via a mutable holder + `reconcileCronJobs`, without
touching active sessions. Restart-required fields are left for item 25. Tier 1 (classify,
debounce) + Tier 2 (reload adds repo/cron, rejects invalid, no session dropped).

- Spec: `.kiro/specs/operator-controls/` · tasks `5.1`, `5.2`, `5.3`
- [x] Complete · PR: #64

---

### 23. CI-reconciliation nudge (wake watchdog)

Eliminate the manual "CI is green, proceed" nudging. Add `src/check-watchdog.ts`: on a bounded
interval, for each active session waiting on an open registered PR, poll the PR's check status
and, when checks are terminal and not already nudged, inject a wake via
`sessionMgr.injectPrompt(..., 'router')`. Idempotent on `(pr, head_sha, conclusion)`;
best-effort on GitHub errors. The agent's no-poll contract is preserved (the daemon polls).
Tier 1 (terminal/idempotency) + Tier 2 (one wake on terminal, none while in-progress).

- Spec: `.kiro/specs/operator-controls/` · tasks `4.1`, `4.2`
- [x] Complete · PR: #63

---

### 22. Per-repo cron pause / resume

Add a `cron_state` table (`src/db.ts`) and `agent-router cron list|pause <name>|resume <name>`
(CLI + IPC) so an operator can pause one repo's cron and re-enable it; `setupCronJobs` honors
the persisted state and live `.stop()`/`.start()` the `ScheduledTask`. State survives restarts.
Tier 1 (state default/round-trip) + Tier 2 (paused does not fire, persists, resume re-enables).

- Spec: `.kiro/specs/operator-controls/` · tasks `2.1`, `2.2`
- [x] Complete · PR: #62

---

### 21. Child-environment secret hygiene (env-scrub)

Stop leaking every repo's PAT into every spawned session. Add a pure
`buildChildEnv(parentEnv, overrides, allowlist)` and route the spawn path
(`spawnACPClient`/adapter) through it so the child receives only an allowlist of parent env
(PATH, HOME, `AGENT_ROUTER_*`, optional `config.childEnvAllowlist`) plus the resolved
`GITHUB_TOKEN` — no other `GITHUB_TOKEN_*`/`GITHUB_WEBHOOK_SECRET*`. Defense-in-depth half of
the per-repo-token fix. Tier 1 (allowlist) + Tier 2 (spawned child excludes other secrets).

- Spec: `.kiro/specs/operator-controls/` · tasks `1.1`, `1.2`
- [x] Complete · PR: #61

---

### 20. Git worktrees per session

Add `src/worktree-manager.ts`: ensure a canonical clone per repo under
`~/.agent-router/repos/<owner>/<repo>`, create a session worktree via `git worktree add` (its
own branch off the default branch), and `git worktree remove --force` on any termination.
Replace the per-session `git clone` with a daemon-provided `WORKDIR` pointing at the worktree.
This obsoletes interim collision detection (P0.4) and shares `.git/objects` across runs.
Tier 2-test: two simultaneous sessions on one repo get isolated worktrees and both clean up.

- Spec: `BACKLOG.md § P1.7`
- [x] Complete · PR: #60

---

### 19. Session resumption across daemon restarts

Add `kiro_session_id?: string` to `SessionMeta` (`src/session-files.ts`), persist it to
`meta.json` after ACP `session/create` (`src/session-mgr.ts`), and on daemon startup attempt
ACP `session/load(kiro_session_id)` (already present at `src/acp.ts`) for each session still
marked `active`: keep it active if load succeeds, otherwise mark `terminated_by_restart` (new
closed-union reason). This makes restarts non-destructive and complements item 3's cron guard.
Tier 2-test: spawn, kill the daemon mid-session, restart, assert clean resume-or-terminate.
This is group 3 of the operator-controls spec (it supersedes the standalone `BACKLOG.md § P2.1`).

- Spec: `.kiro/specs/operator-controls/` · tasks `3.1`, `3.2`
- [x] Complete · PR: #59

---

### 18. Browser harness: visibility reconnect and `test:browser` script

Add `visibility-reconnect.spec.ts` using a CDP session and `Page.setWebLifecycleState`
(hidden → active triggers a reconnect with the last event ID; entries appended while hidden
appear on resume; no duplicate IDs). Wire `"test:browser": "npx playwright test"` into
`package.json`, and verify `npm test` (vitest) does not pick up `.spec.ts` files and that no
other test tier or config is modified. Closes out the browser-test-harness spec.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `12.1`, `14.1`
- [x] Complete · PR: #58

---

### 17. Browser harness: reconnect, inject, and kill tests

Add the interactive spec files: `sse-reconnect.spec.ts` (drop via `disconnectAll`, reconnect
with `Last-Event-ID`, no duplicate IDs, no reconnect after `session_ended`, delay reset),
`inject-prompt.spec.ts` and `kill-session.spec.ts` (both `seedSession({ live: true })` with the
`slow-multi-prompt.json` scenario — inject yields a `web_inject` stream entry and clears the
textarea; kill confirms, terminates with `terminated_web`, hides controls). Builds on items
14–16.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `8.1`, `9.1`, `10.1`
- [x] Complete · PR: #57

---

### 16. Browser harness: list, detail, SSE-render, and auth tests

Add the read-path spec files against the fixtures from item 15: `list-view.spec.ts` (status
badges render, no console errors), `detail-view.spec.ts` (row click → hash route, not-found
state, back to list), `sse-render.spec.ts` (appended `stream.log` entries render in ID order,
auto-scroll, `session_ended` hides controls), and `auth-token.spec.ts` (token present when
`bindPublic: false`, absent when `true`). All use `seedSession({ live: false })`.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `5.1`, `6.1`, `7.1`, `13.1`
- [x] Complete · PR: #56

---

### 15. Browser harness: fixtures and server lifecycle

Create `test/browser/fixtures.ts` with the full per-test server lifecycle (tmpdir → session
files → db → logger → token store → SSE broker → FakeKiroBackend → session manager → web app →
`startWebServer` on an ephemeral port), the TCP readiness check, teardown, the `ConsoleCollector`
(console errors, page errors, dialogs), and the `seedSession` helper with its `live: false`
(filesystem-only) and `live: true` (`slow-multi-prompt.json` scenario) modes. The page fixture
must not auto-navigate. Builds on item 14's harness scaffold; unblocks all spec files.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `3.1`
- [x] Complete · PR: #55

---

### 14. Browser harness: module resolution and `disconnectAll`

Stand up the Playwright tier. Install `@playwright/test` as a devDependency, add
`playwright.config.ts` (`testDir: ./test/browser`, `.spec.ts` match, chromium headless,
`workers: CI ? 1 : 4`), and a `test/browser/smoke.spec.ts` that imports `createWebApp` from
`../../src/web-server.js` to prove `.js`→`.ts` resolution under Playwright's loader. Add
`disconnectAll(sessionId)` to the `SSEBroker` interface and `createSSEBroker`
(`src/sse-broker.ts`) — close all clients, clear the poll timer and heartbeat state, write no
`session_ended` event — to enable reconnect testing. Foundation for the harness items that
follow.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `1.1`, `2.1`
- [x] Complete · PR: #54

---

### 13. Prompt-injection input guards

Wrap untrusted-source fields (webhook comment bodies, titles, check-run summaries) in
`<<UNTRUSTED_INPUT>>…<</UNTRUSTED_INPUT>>` markers inside the prompt composers in
`src/prompt.ts`, prepend a preamble instructing the agent to treat delimited content as data
not instructions, and cap each field at 2KB with a truncation marker. Tier 1-test that a large
hostile field is truncated, wrapped, and preceded by the preamble.

- Spec: `BACKLOG.md § P3.2`
- [x] Complete · PR: #53

---

### 12. PAT expiry alerting

Add an optional `token_expires_at` (ISO 8601) config field and a startup + 24h-interval check
that logs `warn` at 14 and 7 days out, `error` at 2 days and after expiry. Document the
rotation procedure in `README.md` on the same branch. Builds on the notification webhook from
item 11 (reuse it to surface the alert). Tier 1-test the days-to-severity mapping as a pure
function.

- Spec: `BACKLOG.md § P2.0`
- [x] Complete · PR: #52

---

### 11. Session-end notification webhook

Add a `notifyOnSessionEnd: { url: string, events: string[] }` config field (`src/config.ts`)
and have the daemon POST `{ session_id, status, termination_reason, prs, started_at,
ended_at }` to the URL when a session ends with a matching termination reason. Best-effort:
log and continue on failure, never block cleanup. Tier 2-test against a mock HTTP server,
asserting the payload and that a failed POST does not stall termination.

- Spec: `BACKLOG.md § P1.3`
- [x] Complete · PR: #51

---

### 10. Track merge timestamp

Add an optional `merged_at?: number` to each `prs[]` entry in `SessionMeta`
(`src/session-files.ts`) and have the auto-completion path (the `merged` termination handler)
set it. Add `agent-router ls --merged` to filter to sessions that shipped a PR. Tier 1-test
the metadata write; Tier 2-test that a synthetic merge populates `merged_at`.

- Spec: `BACKLOG.md § P2.2`
- [x] Complete · PR: #50

---

### 9. `GET /health` endpoint

Add a `GET /health` route to the daemon's HTTP server (`src/server.ts`) returning `200` with
`{ status: "ok", uptime_seconds, active_sessions, db_ok }`, and `503` when the database is
unreachable. The handler is a pure function over injected daemon state so it Tier 1-tests
directly (ok shape, db-down → 503).

- Spec: `BACKLOG.md § P1.5`
- [x] Complete · PR: #49

---

### 8. `tail` renders agent text

Fix the `tail` pretty-printer (`prettyPrint` in `bin/agent-router.ts`) so a plain (non-`--raw`)
tail shows the agent's actual output. Agent message text arrives in the entry's `content`
field, which the current printer renders only for error/stderr entry types while agent
messages fall back to `message`. Render `content` for agent-message entries too. Add Tier 1
tests covering each entry shape (agent message, error, tool call).

- Spec: `BACKLOG.md § P2.12`
- [x] Complete · PR: #48

---

### 7. `kill` subcommand

Add `agent-router kill <session-id> [--reason <reason>]` (`bin/agent-router.ts` + the IPC
handler) that drives the existing terminate flow, defaulting `termination_reason` to
`killed_by_operator` (add it to the closed union in `src/session-files.ts`). Error if the
session is not active. Reuses the prefix resolver from item 6. Add a Tier 2 test that `kill`
ends a live session and writes the reason.

- Spec: `BACKLOG.md § P2.5`
- [x] Complete · PR: #47

---

### 6. Session-id prefix matching and `--full`

Let every CLI subcommand that takes a session-id (`tail`, `terminate`, `complete-session`,
`kill`) accept any unambiguous prefix of the full UUID, erroring with the candidate list on an
ambiguous prefix and erroring on no match. Add `agent-router ls --full` to print untruncated
IDs while keeping the truncated default. Extract a pure `resolveSessionId(prefix, candidates)`
function and Tier 1-test the unique / none / ambiguous cases. Builds on the `ls` flag parsing
from item 5.

- Spec: `BACKLOG.md § P2.8`
- [x] Complete · PR: #46

---

### 5. `ls` pagination

Give `agent-router ls` (`bin/agent-router.ts`, `cmdLs`) a default cap of 20 rows with active
sessions always shown, an `--all` flag to print everything, and a `--limit N` override.
Pure CLI change, no daemon involvement. Add Tier 1 tests for the row-selection logic
(default cap, `--all`, `--limit`, active-always-shown).

- Spec: `BACKLOG.md § P2.11`
- [x] Complete · PR: #45

---

### 4. Reject non-JSON webhooks cleanly

Make the `/webhook` handler in `src/server.ts` reject a request whose `Content-Type` is not
JSON with a `400` before attempting to parse, rather than failing inside `JSON.parse`. The
daemon must stay up. Add a Tier 1 test posting `application/x-www-form-urlencoded` and
asserting a `400` with a clear error body.

- Spec: `BACKLOG.md § P2.7`
- [x] Complete · PR: #44

---

### 30. Rate-limit queues wake delivery instead of dropping events

Stop the per-PR rate limiter from dropping webhook events during its cooldown window. Today
`evaluateWakePolicy` (`src/router.ts`) returns `rate_limited` / `wake: false` when
`tryAcquireWakeSlot` finds a wake happened less than `rateLimit.perPRSeconds` (default 60) ago,
and the event processor (`src/index.ts`) drops the event — so a `check_run.completed` that lands
during the cooldown is lost and the session waits on CI forever (observed: sessions `eedb2b25`,
`6675adac`), which is why agents resort to polling `gh pr checks` against their no-poll contract.
Instead, *defer* a rate-limited event: persist one coalesced pending wake per `(repo, pr)` (newest
payload wins) in a new `pending_wakes` table (`src/db.ts`) with `deferred_until = last_waked_at +
perPRSeconds`, and add a bounded daemon sweeper that injects the deferred wake once the window
elapses (reusing the existing inject path and re-acquiring the slot), then clears the row. Clear a
PR's pending wake on session end; drop cleanly if the session is gone. This is the root-cause fix
that item 23's watchdog only works around. Tier 1 (defer-until + coalescing pure logic) + Tier 2
(an event during the cooldown is delivered after the window; a burst yields exactly one later wake
with the latest payload).

- Spec: `BACKLOG.md § P1.9`
- [x] Complete · PR: #43

---

### 3. Allow cron re-fire after an abandoned session

Relax the clean-state guard in the cron-fire handler (`handleCronFire`, `src/index.ts`) so it
permits a last session whose status is `abandoned`, not only `completed`. An `abandoned` status
means the daemon restarted mid-session (operator action), not that the agent failed — so it
must not block the next scheduled run.

- Spec: `BACKLOG.md § P1.8`
- [x] Complete · PR: #41

---

### 2. Idempotent PR registration

Change `registerPR` in `src/db.ts` from a plain `INSERT` to an upsert (`INSERT … ON CONFLICT
(repo, pr_number) DO UPDATE` or `INSERT OR REPLACE`) so a new session can claim a `(repo, pr)`
already held by a completed or dead session. Today the `INSERT` fails the `UNIQUE(repo,
pr_number)` constraint, `meta.json` updates but the SQLite row still points at the old
session, and inbound webhooks route to the void. Add a Tier 1 test (re-register from a second
session wins) and a Tier 2 test (webhook for the PR routes to the new session after
re-registration).

- Spec: `BACKLOG.md § P2.13`
- [x] Complete · PR: #37

---

### 1. Trim environment variable values

Add `.trim()` to resolved environment-variable values in `resolveEnvValues` (`src/config.ts`,
~line 69) so trailing whitespace from a systemd `EnvironmentFile` can no longer silently
corrupt a secret (a trailing newline on `GITHUB_TOKEN` produces opaque 401s). A focused Tier 1
test feeds a value with surrounding whitespace and asserts the resolved value is trimmed. This
is the foundation item — small, self-contained, and proves the self-build loop end to end.

- Spec: `BACKLOG.md § P2.10`
- [x] Complete · PR: #36

### 86. Agent process isolation — startup checks, ClaudeCodeAdapter block, Tier 2 tests, docs

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `86.1`, `86.2`, `86.3`, `86.4`. Depends on items 83, 84, 85.

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `86.1–86.4`
- [x] Complete · PR: #152

### 87. SPA Polish — Backend endpoint, shared primitives, layout & overflow

Read `.kiro/specs/spa-polish/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1`, `2`, `3`, `4`, `5`, `6`, `7`.

- Spec: `.kiro/specs/spa-polish/` · tasks `1`, `2`, `3`, `4`, `5`, `6`, `7`
- [x] Complete · PR: #156

---

### 88. SPA Polish — Header branding, router/overview routing, message grammar

Read `.kiro/specs/spa-polish/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `8`, `9`, `10`, `11`. Depends on item 87 (shared primitives and
CSS tokens must be present).

- Spec: `.kiro/specs/spa-polish/` · tasks `8`, `9`, `10`, `11`
- [x] Complete · PR: #158

---

### 89. SPA Polish — Overview page, Config cron status, empty states

Read `.kiro/specs/spa-polish/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `12`, `13`, `14`, `15`, `16`. Depends on item 88 (router
overview route and MessageRow must be present).

- Spec: `.kiro/specs/spa-polish/` · tasks `12`, `13`, `14`, `15`, `16`
- [x] Complete · PR: #159

---


### 90. Security isolation fix — code (MCP socket fallback, agent-server PAT source, .github fail-closed)

Read `.kiro/specs/security-isolation-fix/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `90.1`–`90.10`. Realigns shipped agent-process-isolation code with the
corrected spec: removes the MCP operator-socket fallback (CRITICAL), sources the agent-server PAT
from `credentialTokenResolver` via the credential token store only (HIGH — `tokens.json` is now
required for `push_branch`/`pr_create`/`pr_view`), and makes the `push_branch` `.github/` guard
fail closed. Adds startup warnings for both missing `agentworker` account (when `useWorkerUid:
true`) and `_fallback` token mode. Depends on items 83–86.

- Spec: `.kiro/specs/security-isolation-fix/` · tasks `90.1`–`90.10`
- [x] Complete · PR: #160

### 91. Security isolation fix — provisioning (usermod step, iptables chain rename, docs)

Read `.kiro/specs/security-isolation-fix/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `91.1`–`91.8`. Adds `usermod -aG "$WORKER_USER" "$DAEMON_USER"` to
`setup-agent-user.sh`, renames the tinyproxy iptables chain from `TPROXY_SSRF_BLOCK` to
`TINYPROXY_OUT` in the script and docs, and documents the provisioning prerequisites. Depends on
item 90 (merge conflict on `src/index.ts` and `src/isolation-startup.ts`).

- Spec: `.kiro/specs/security-isolation-fix/` · tasks `91.1`–`91.8`
- [x] Complete · PR: #161

---


### 92. Continuous mode — core runner and session-mgr wiring

Read `.kiro/specs/continuous-mode/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `1.6`, `1.7`. Adds config fields
(`continuous`, `baseBranch`), the `ContinuousRunner` module, `onSessionEnded` callback to
session-mgr (fires at registry removal, not meta-write), cron handler integration, and
Tier 1 + T2-CONT-1/2 tests.

- Spec: `.kiro/specs/continuous-mode/` · tasks `1.1`–`1.7`
- [x] Complete · PR: #166

---

### 93. Continuous mode — CLI surface and remaining tests

Read `.kiro/specs/continuous-mode/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `2.1`, `2.2`, `2.3`, `2.4`, `2.6`, `2.7`. Adds `stop_continuous` CLI
server op, `stop-continuous` CLI subcommand, `ls` display enhancements, and T2-CONT-3/6/7
tests. Depends on item 92.

- Spec: `.kiro/specs/continuous-mode/` · tasks `2.1`–`2.4`, `2.6`, `2.7`
- [x] Complete · PR: #167

---

### 94. Fix `buildGitAuthEnv` test isolation

Add an optional `askpassHelperExists?: () => boolean` dep to `AgentServerDeps` and thread it
into `buildGitAuthEnv`. Default is `() => fs.existsSync(ASKPASS_HELPER)` (production behavior
unchanged). Update the failing test to pass `askpassHelperExists: () => false`, and add a
second test for the askpass-present path. Fixes a CI-breaking environment dependency.

- Spec: `BACKLOG.md § P2.21`
- [ ] Complete · PR: —

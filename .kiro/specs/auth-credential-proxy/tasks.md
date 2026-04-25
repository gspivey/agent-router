# Implementation Plan: Auth Credential Proxy

## Overview

Implements project-scoped PAT credential management for Agent Router. Two tracks: Track 1 injects PATs into agent env (`credentialMode: "env"`), Track 2 uses MCP credential tools (`credentialMode: "mcp"`). Build order follows dependency graph: Secret type → test harness → pure validation → Token_Store → config → session manager (Bound_Project + read_repos) → MCP IPC ops → MCP tools (IPC bootstrap → validation → github_http_forward → git_credential) → webhook → CLI → startup integration → Tier 3.

## Tasks

- [ ] 1. Create Secret wrapper type and Tier 1 tests
  - [ ] 1.1 Create `src/secret.ts` with `Secret` class
    - Private constructor, `Secret.of(value)` factory that throws on empty string
    - `reveal()` returns raw value
    - `toString()`, `toJSON()`, `[Symbol.for('nodejs.util.inspect.custom')]()` all return `'[REDACTED]'`
    - _Requirements: 4.2, 6.5, 11.2_
  - [ ] 1.2 Write property test for Secret redaction (Property 8)
    - **Property 8: Token redaction in logs**
    - Create `test/tier1/secret.test.ts`
    - Generate arbitrary non-empty strings, wrap in `Secret`, verify `toString()`, `toJSON()`, and `JSON.stringify()` never contain the raw value
    - **Validates: Requirements 4.2, 6.5, 11.2**
  - [ ] 1.3 Write unit tests for Secret edge cases
    - Test `Secret.of('')` throws, `Secret.of('abc').reveal()` returns `'abc'`
    - Test that `console.log` / `util.inspect` output contains `[REDACTED]`
    - _Requirements: 4.2, 6.5, 11.2_

- [ ] 2. Extend test harness for credential testing
  - [ ] 2.1 Extend mock GitHub API server in `test/harness/fake-github.ts`
    - Add Authorization header validation on incoming requests
    - Return canned responses for credential tool forwarding tests
    - Make reusable for future specs
    - _Requirements: 5.3, 5.4_
  - [ ] 2.2 Create mock daemon socket in `test/harness/`
    - Simulate `get_session_project` and `get_token` IPC operations
    - Configurable responses for different session/project scenarios
    - Mocks SHALL be standalone modules importable from `test/harness/`. fast-check default iterations set to 100 in test config.
    - _Requirements: 7.3_

- [ ] 3. Implement pure validation functions and interfaces
  - Create `src/token-store.ts` with exported pure functions and type definitions
  - Define `ProjectEntry`, `TokenMap`, `ReloadDiff`, `ExpiryWarning`, `TokenStore` interfaces
  - `isValidProjectName(name: string): boolean` — matches `^[a-zA-Z0-9._-]+$`
  - `isValidRepoString(repo: string): boolean` — matches `^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`
  - `validateProjectEntry(name: string, entry: unknown): ProjectEntry` — validates token, repos, optional expires_at; wraps token in `Secret`
  - `validateRepoUniqueness(projects: Map<string, ProjectEntry>): void` — throws `FatalError` on duplicate repos
  - `parseTokensFile(content: string): TokenMap` — full JSON parse + validation pipeline
  - `computeReloadDiff(oldMap: TokenMap, newMap: TokenMap): ReloadDiff`
  - `evaluateExpiryWarnings(projects, now): ExpiryWarning[]`
  - `serializeTokenMap(map: TokenMap): string` — for round-trip testing
  - _Requirements: 1.1, 1.2, 1.3, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 12.1, 12.2_

- [ ] 4. Write property tests for pure validation (Properties 1, 2, 3, 7, 9, 10)
  - [ ] 4.1 Write property test: tokens file round-trip (Property 1)
    - **Property 1: Tokens file round-trip**
    - Create `test/tier1/token-store.test.ts`
    - Generate arbitrary valid `TokenMap`, serialize via `serializeTokenMap`, parse via `parseTokensFile`, assert same project keys, token values, repo lists, expiry dates
    - **Validates: Requirements 9.5**
  - [ ]* 4.2 Write property test: project entry validation (Property 2)
    - **Property 2: Project entry validation**
    - Generate valid and invalid project entries, verify `validateProjectEntry` accepts iff token non-empty, repos non-empty, all repos match pattern
    - **Validates: Requirements 1.2, 9.3**
  - [ ] 4.3 Write property test: repo uniqueness invariant (Property 3)
    - **Property 3: Repo uniqueness invariant**
    - Generate project maps with and without duplicate repos, verify `validateRepoUniqueness` throws iff duplicates exist
    - **Validates: Requirements 1.3, 9.4**
  - [ ]* 4.4 Write property test: reload diff correctness (Property 7)
    - **Property 7: Reload diff correctness**
    - Generate two valid `TokenMap` instances, verify `computeReloadDiff` partitions all project names into added/removed/changed/unchanged correctly
    - **Validates: Requirements 2.4, 11.4**
  - [ ]* 4.5 Write property test: project name validation (Property 9)
    - **Property 9: Project name validation**
    - Generate arbitrary strings, verify `isValidProjectName` returns true iff non-empty and matches `^[a-zA-Z0-9._-]+$`
    - **Validates: Requirements 9.2**
  - [ ]* 4.6 Write property test: expiry warning tiers (Property 10)
    - **Property 10: Expiry warning tiers**
    - Generate project entries with various `expires_at` dates relative to `now`, verify `evaluateExpiryWarnings` emits correct tier (error ≤2d, warn+alert ≤7d, warn ≤14d, none >14d)
    - **Validates: Requirements 12.1, 12.2**

- [ ] 5. Write unit tests for validation edge cases
  - Test `parseTokensFile` with invalid JSON → `FatalError`
  - Test `parseTokensFile` with missing `projects` key → `FatalError`
  - Test `validateProjectEntry` with empty token, empty repos, invalid repo format, invalid expires_at → `FatalError`
  - Test `validateRepoUniqueness` error message includes duplicate repo and conflicting project names
  - Add to `test/tier1/token-store.test.ts`
  - _Requirements: 1.2, 1.3, 1.7, 9.2, 9.3, 9.4, 9.6_

- [ ] 6. Implement Token_Store factory with reload and file watching
  - [ ] 6.1 Implement `createTokenStore` factory function in `src/token-store.ts`
    - Accept `{ tokensFilePath, log, fallbackToken? }` deps
    - On creation: read and parse tokens file, or fall back to `GITHUB_TOKEN` env var with deprecation warning, or throw `FatalError` if neither available
    - Fallback creates a synthetic single-project entry with all configured repos
    - Check file permissions (mode > 600 → log warning)
    - `getToken(projectName)` → `Secret | undefined`
    - `getProject(projectName)` → `ProjectEntry | undefined`
    - `findProjectByRepo(repo)` → `string | undefined`
    - `getTokenMap()` → current `TokenMap` snapshot
    - `reload()` → re-read, re-validate, atomic swap on success, retain old on failure, log diff; return boolean
    - `startWatching()` → register `fs.watch` + 30s polling interval, `reloadInProgress` guard, re-register watcher after reload
    - `stopWatching()` → close watcher, clear interval, set `reloadInProgress` to suppress in-flight
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [ ]* 6.2 Write property tests for Token_Store lookups (Properties 4, 5)
    - **Property 4: Repo-to-project lookup**
    - **Property 5: Token lookup by project**
    - Generate valid `TokenMap`, create store, verify `findProjectByRepo` and `getToken` return correct results for all entries and `undefined` for missing
    - **Validates: Requirements 3.1, 3.3, 3.5, 8.1**
  - [ ] 6.3 Write unit tests for Token_Store lifecycle
    - Test fallback to `GITHUB_TOKEN` when tokens file missing (Req 1.5)
    - Test `FatalError` when both tokens file and env var missing (Req 1.6)
    - Test `FatalError` on invalid JSON in tokens file (Req 1.7)
    - Test reload with invalid file retains old map (Req 2.5)
    - Test reload with deleted file retains old map (Req 2.6)
    - Test file permissions warning (Req 1.4)
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.5, 2.6_

- [ ] 7. Write Tier 2 Token_Store tests
  - Create `test/tier2/token-store.test.ts`
  - Test with real filesystem (temp dir): write tokens.json, create store, verify lookups
  - Test SIGHUP-triggered reload: modify file, send reload, verify new map
  - Test fs.watch/polling: modify file, wait for automatic reload
  - Test atomic swap: verify no partial state observable during reload
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7_

- [ ] 8. Checkpoint — Tier 1 token-store and secret tests green
  - Run full test suite (`npm test`). All tests in scope must pass. If any task scope changed during implementation, post a checkpoint comment summarizing changes and unresolved questions. Only proceed to the next batch when this checkpoint passes.

- [ ] 9. Add `credentialMode` to config
  - [ ] 9.1 Extend `AgentRouterConfig` in `src/config.ts`
    - Add `credentialMode: 'env' | 'mcp'` field
    - Default to `'env'` when omitted from JSON
    - Validate during `validateConfig`: must be `'env'` or `'mcp'`, reject other values with `FatalError`
    - _Requirements: 4.4_
  - [ ] 9.2 Write Tier 1 config validation tests
    - Test default value when `credentialMode` omitted
    - Test valid values `'env'` and `'mcp'` accepted
    - Test invalid values rejected with `FatalError`
    - Add tests to `test/tier1/validate-config.test.ts` or `test/tier1/load-config.test.ts`
    - _Requirements: 4.4_

- [ ] 10. Session manager — Bound_Project resolution and credential injection
  - [ ] 10.1 Extend `SessionMeta` in `src/session-files.ts`
    - Add optional fields: `bound_project`, `bound_project_repos`, `bound_project_read_repos`, `credential_mode`
    - Fields are optional for backward compatibility with legacy sessions
    - _Requirements: 3.2_
  - [ ] 10.2 Extend `SessionHandle` and `createSessionManager` deps in `src/session-mgr.ts`
    - Add `boundProject`, `boundProjectRepos` to `SessionHandle`
    - Accept `tokenStore: TokenStore` and `credentialMode: 'env' | 'mcp'` in deps
    - _Requirements: 3.1, 3.2, 4.4_
  - [ ] 10.3 Implement `createSession` Bound_Project resolution and credential injection
    - Extract target repo from prompt, call `tokenStore.findProjectByRepo(repo)` to resolve `Bound_Project`
    - If not found → reject session with error (Req 3.8)
    - If `credentialMode === 'env'` → inject `GITHUB_TOKEN` into subprocess env via `tokenStore.getToken(project).reveal()`
    - If `credentialMode === 'mcp'` → omit `GITHUB_TOKEN` from subprocess env
    - Record `boundProject`, `boundProjectRepos`, `credential_mode` in session metadata
    - Log Bound_Project name and repos (not token value) on injection
    - _Requirements: 3.1, 3.5, 3.7, 3.8, 4.1, 4.2, 4.3, 4.5_
  - [ ] 10.4 Write Tier 2 session credential tests in `test/tier2/session-credential.test.ts`
    - Test `GITHUB_TOKEN` present in env for `credentialMode: "env"`
    - Test `GITHUB_TOKEN` absent in env for `credentialMode: "mcp"`
    - Test `Bound_Project` recorded in session metadata
    - Test session rejection for unknown repo (Req 3.8)
    - Test cross-project write rejection (Req 3.7)
    - _Requirements: 3.1, 3.2, 3.7, 3.8, 4.1, 4.3_

- [ ] 11. Session manager — read_repos parsing
  - [ ] 11.1 Implement YAML frontmatter and explicit-arg `read_repos` parsing in `src/session-mgr.ts`
    - Parse `read_repos` from prompt YAML frontmatter or explicit `read_repos: string[]` parameter
    - _Requirements: 3.6_
  - [ ] 11.2 Wire `read_repos` into session metadata
    - Store parsed `read_repos` in session metadata as `bound_project_read_repos`
    - _Requirements: 3.6_
  - [ ]* 11.3 Write Tier 1 unit tests for `read_repos` parsing edge cases
    - Test YAML frontmatter parsing with valid/invalid/missing `read_repos`
    - Test explicit parameter parsing
    - Test empty and malformed inputs
    - _Requirements: 3.6_
  - [ ] 11.4 Write Tier 2 test for `read_repos` in session metadata
    - Verify `read_repos` stored correctly in session metadata and available via IPC
    - _Requirements: 3.6_

- [ ] 12. Checkpoint — Session manager integration tests green
  - Run full test suite (`npm test`). All tests in scope must pass. If any task scope changed during implementation, post a checkpoint comment summarizing changes and unresolved questions. Only proceed to the next batch when this checkpoint passes.

- [ ] 13. Implement IPC ops for credential tools in `src/cli-server.ts`
  - Add `get_session_project { session_id }` → `{ project, repos, read_repos }` or `{ error }`
  - Add `get_token { project }` → `{ token, expires_at }` or `{ error }`
  - Wire `TokenStore` and `SessionManager` into `createCliServer` deps
  - IPC op handlers read `Bound_Project` / `read_repos` from session metadata as written by task 10. Coordinate field names between tasks 10.3 and this task to ensure no mismatch.
  - _Requirements: 7.3_

- [ ] 14. MCP credential tools — IPC bootstrap and tool registration
  - Implement startup `get_session_project` IPC call with caching (single call, cached for session lifetime)
  - Register `github_http_forward` and `git_credential` in `MCP_TOOLS` array (skeleton handlers)
  - MCP subprocess receives `session_id` via `AGENT_ROUTER_SESSION_ID` env var at spawn time
  - _Requirements: 7.1, 7.2, 7.3_

- [ ] 15. MCP credential tools — request validation
  - [ ] 15.1 Implement method, path prefix, body size validators
    - Method: must be one of GET, POST, PUT, PATCH, DELETE (Property 11)
    - Path: must start with known GitHub API prefix (Property 12)
    - Body size: max 10 MB (Property 13)
    - _Requirements: 10.1, 10.2, 10.3_
  - [ ] 15.2 Implement repo authorization check (Property 6)
    - Write methods: repo must be in Bound_Project repo list
    - Read methods: public repos allowed; private repos outside Bound_Project require `read_repos` declaration
    - _Requirements: 3.4, 5.2, 6.2_
  - [ ] 15.3 Write Tier 1 property tests for validators (Properties 6, 11, 12, 13)
    - **Property 6: Write authorization enforcement** — generate sessions with Bound_Project repo sets, verify write methods permitted iff repo in set
    - **Validates: Requirements 3.4, 5.2, 6.2**
    - **Property 11: HTTP method validation** — generate arbitrary strings, verify method validator accepts iff one of GET, POST, PUT, PATCH, DELETE
    - **Validates: Requirements 10.2**
    - **Property 12: GitHub API path validation** — generate arbitrary strings, verify path validator accepts iff starts with known prefix
    - **Validates: Requirements 10.1**
    - **Property 13: Request body size enforcement** — generate strings of various byte lengths, verify body validator rejects iff > 10 MB
    - **Validates: Requirements 10.3**
  - [ ] 15.4 Write Tier 1 unit tests for validation edge cases
    - Test boundary conditions for body size (exactly 10 MB, 10 MB + 1 byte)
    - Test all valid/invalid method strings
    - Test all valid path prefixes and invalid paths
    - Test repo authorization with empty repo lists, single repo, multiple repos
    - _Requirements: 10.1, 10.2, 10.3, 3.4, 5.2, 6.2_

- [ ] 16. MCP credential tools — `github_http_forward` implementation
  - [ ] 16.1 Implement header injection, upstream forwarding, timeout
    - Per tool call: issue `get_token` IPC call (not cached — rotation propagates)
    - Inject `Authorization: Bearer <token>`, `User-Agent: agent-router/<version>`, `Accept: application/vnd.github+json` headers
    - Forward to `https://api.github.com`, 30s timeout, return status + headers + body
    - _Requirements: 5.1, 5.3, 5.4, 10.4, 10.5_
  - [ ] 16.2 Implement structured logging with Property 14 fields
    - Log structured entry per call: `tool_name`, `repo`, `project`, `session_id`, `status`, `duration_ms`, `error_code`
    - `error_code` field is a string enum: `token_missing`, `repo_unauthorized`, `upstream_5xx`, `upstream_timeout`, `body_too_large`, `method_invalid`, `path_invalid`
    - Never log token values or Authorization header contents (Req 11.2)
    - _Requirements: 11.1, 11.2, 11.3_
  - [ ] 16.3 Write Tier 1 property test for credential log entry structure (Property 14)
    - **Property 14: Credential log entry structure**
    - Verify every credential tool call log entry contains `tool_name`, `repo`, `project`, `session_id`, `status`, `duration_ms`, `error_code`
    - **Validates: Requirements 11.1**
  - [ ] 16.4 Write Tier 2 tests against fake GitHub server in `test/tier2/credential-mcp.test.ts`
    - Test token injection in Authorization header against mock GitHub API server
    - Test response passthrough (status, headers, body)
    - Test 30s timeout handling
    - Test body size enforcement (>10 MB → error)
    - Test read/write split enforcement (write to non-Bound_Project repo → error)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 10.1, 10.2, 10.3, 10.4_

- [ ] 17. MCP credential tools — `git_credential` implementation
  - [ ] 17.1 Implement git credential format response
    - Validate repo in Bound_Project repos
    - Per tool call: issue `get_token` IPC call (not cached)
    - Return `{ protocol: "https", host: "github.com", username: "x-access-token", password: "<token>" }`
    - Log structured entry per call (same Property 14 fields including `error_code`)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [ ] 17.2 Write Tier 2 tests for `git_credential`
    - Test `git_credential` returns correct credential format
    - Test `git_credential` rejects unauthorized repo
    - Test token lookup failure returns error result
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 18. Write Tier 2 IPC contract tests
  - Create `test/tier2/ipc-contract.test.ts`
  - Test `get_session_project` returns correct Bound_Project, repos, and read_repos
  - Test `get_token` returns valid token response with `expires_at` field
  - Tier 2 test verifying `get_token`'s `expires_at` field reflects `tokens.json`'s `expires_at` value
  - Test error responses for unknown session/project
  - _Requirements: 7.3_

- [ ] 19. Checkpoint — MCP credential tools and session integration tests green
  - Run full test suite (`npm test`). All tests in scope must pass. If any task scope changed during implementation, post a checkpoint comment summarizing changes and unresolved questions. Only proceed to the next batch when this checkpoint passes.

- [ ] 20. Implement webhook token reverse lookup
  - [ ] 20.1 Extend `createApp` in `src/server.ts` to accept `TokenStore` dependency
    - Add `tokenStore: TokenStore` to deps (required — always present, including fallback mode)
    - When webhook handler needs to post status comment: call `tokenStore.findProjectByRepo(repo)` → `tokenStore.getToken(project)` → use `.reveal()` for Authorization header
    - If no project found for repo → log warning, skip outgoing API call (Req 8.3)
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ] 20.2 Write Tier 2 webhook token tests in `test/tier2/webhook-token.test.ts`
    - Test webhook handler uses correct project-scoped PAT for outgoing API calls
    - Test unknown repo → warning logged, no outgoing call
    - Test fallback mode (single synthetic project) works for webhook lookup
    - _Requirements: 8.1, 8.2, 8.3_

- [ ] 21. Implement CLI `tokens status` IPC op
  - Add `tokens_status { check?: boolean }` IPC op to `src/cli-server.ts`
  - Returns `{ projects: Array<{ name, repoCount, expiryStatus, validationResult? }> }`
  - When `check: true`: call `GET /user` with each token, cache results for 1 hour in `$AGENT_ROUTER_HOME/.token-check-cache.json`
  - Cache file written with mode 600
  - _Requirements: 12.3, 12.4, 12.5_

- [ ] 22. Implement CLI daemon-offline fallback and tests
  - [ ] 22.1 Implement CLI daemon-offline fallback
    - CLI first attempts daemon socket; if unreachable (missing, refused, timeout >2s), fall back to reading `tokens.json` directly
    - Report project metadata without live `--check` results when daemon offline
    - Output includes `Source:` header: `Source: daemon (live)` or `Source: file (daemon offline; --check unavailable)`
    - _Requirements: 12.3, 12.4_
  - [ ] 22.2 Write property test for token check cache validity (Property 15)
    - **Property 15: Token check cache validity**
    - Generate cache entries with various `checked_at` timestamps, verify valid iff `now - checked_at < 3600000`
    - **Validates: Requirements 12.5**
  - [ ] 22.3 Write unit tests for CLI tokens status
    - Test output format with various project states (valid, expiring-soon, expired, no-expiry-set)
    - Test `--check` flag triggers live validation
    - Test cache hit (within 1 hour) and cache miss (expired)
    - Test daemon-offline fallback reads tokens.json directly
    - _Requirements: 12.3, 12.4, 12.5_

- [ ] 23. Integrate Token_Store into daemon startup
  - [ ] 23.1 Update `src/index.ts` startup sequence
    - After config load: create `TokenStore` with `tokensFilePath` and optional `GITHUB_TOKEN` fallback
    - Register `SIGHUP` handler that calls `tokenStore.reload()`
    - Call `tokenStore.startWatching()` for fs.watch + polling
    - Pass `tokenStore` to `SessionManager`, `createApp`, and `CliServer`
    - Pass `credentialMode` from config to `SessionManager`
    - If Token_Store is in fallback mode (Req 1.5) AND `credentialMode` is `"mcp"`, refuse to start with `FatalError`. Error message instructs operator to either provide `tokens.json` or set `credentialMode: env`
    - On shutdown: call `tokenStore.stopWatching()`
    - _Requirements: 1.1, 1.5, 2.1, 2.2, 4.4_
  - [ ] 23.2 Update `src/index.ts` shutdown sequence
    - Add `tokenStore.stopWatching()` to graceful shutdown handler
    - Ensure stopWatching is called before database shutdown
    - _Requirements: 2.2_

- [ ] 24. Checkpoint — All Tier 1 and Tier 2 tests green
  - Run full test suite (`npm test`). All tests in scope must pass. If any task scope changed during implementation, post a checkpoint comment summarizing changes and unresolved questions. Only proceed to the next batch when this checkpoint passes.

- [ ] 25. Write Tier 3 integration tests
  - Each Tier 3 test SHALL restore `tokens.json` to its pre-test state in `afterEach` hooks. Tier 3 tests gated by `TIER3` env var.
  - [ ]* 25.1 Write Tier 3 token injection end-to-end test
    - Full daemon → agent → GitHub API flow with real PATs
    - Verify correct token reaches GitHub for both credential modes
    - Add to `test/tier3/`
    - _Requirements: 4.1, 5.3, 6.3_
  - [ ]* 25.2 Write Tier 3 MCP credential tool forwarding test
    - `github_http_forward` against real GitHub API
    - `git_credential` for real git operations
    - _Requirements: 5.3, 5.4, 6.3_
  - [ ]* 25.3 Write Tier 3 token rotation test
    - env-mode: active session retains old token, new session picks up new token
    - mcp-mode: active session picks up new token on next MCP tool call
    - _Requirements: 2.7_
  - [ ]* 25.4 Write Tier 3 CLI tokens status --check test
    - `agent-router tokens status --check` against real GitHub
    - Verify valid/invalid token detection
    - _Requirements: 12.4_

- [ ] 26. Final checkpoint — All tiers green
  - Run full test suite (`npm test`). All tests in scope must pass. If any task scope changed during implementation, post a checkpoint comment summarizing changes and unresolved questions. Only proceed to the next batch when this checkpoint passes.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property tests for load-bearing security invariants (Properties 6, 8) and config schema correctness (Properties 1, 3) are required, not optional.
- Tier 2 tests within feature tasks (7, 10.4, 11.4, 16.4, 17.2, 18, 20.2, 22.3) are NOT optional
- Each task references specific requirements for traceability
- Property tests validate the 15 correctness properties defined in the design document
- Build order follows the design's dependency graph: Secret → harness → pure functions → Token_Store → config → session (Bound_Project + read_repos) → MCP IPC → MCP tools (bootstrap → validation → http_forward → git_credential) → webhook → CLI → startup integration
- Test harness (task 2) is built early so all subsequent Tier 2 tests can use the mock GitHub API server and mock daemon socket
- All code uses TypeScript with strict mode, ESM imports with `.js` extensions
- `fast-check` with minimum 100 iterations per property
- Property 14 log entries include `error_code` field (string enum: `token_missing`, `repo_unauthorized`, `upstream_5xx`, `upstream_timeout`, `body_too_large`, `method_invalid`, `path_invalid`)

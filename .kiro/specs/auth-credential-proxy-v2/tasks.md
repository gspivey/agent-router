# Implementation Plan

Tasks 1–8 describe the surface that shipped in PRs #71–80 and are marked complete. Tasks 9–11
are the three fixes this spec introduces and are the work to be picked up.

## Shipped (PRs #71–80)

- [x] 1. Credential validators — `validateMethod`, `validatePathPrefix`, `validateBodySize`,
  `validateRepoAuthorization` as pure functions in `src/credential-validators.ts`.
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Tier 1 property + unit tests for the credential validators in
  `test/tier1/credential-validators.test.ts`.
  - _Requirements: 1.5_

- [x] 3. `github_http_forward` MCP tool in `src/mcp-server.ts`: argument validation, method /
  path-prefix / body-size / repo-authorization checks, token fetch, upstream forward with 30s
  timeout, `{ status, headers, body }` response.
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 4. Structured credential logging (`tool_name`, `repo`, `project`, `session_id`, `status`,
  `duration_ms`, `error_code`) for credential tool calls.
  - _Requirements: 2.4_

- [x] 5. `git_credential` MCP tool in `src/mcp-server.ts`: `repo` validation, bound-project
  membership check, git credential-helper response shape.
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 6. `get_session_project` daemon IPC op in `src/cli-server.ts` returning
  `{ project, repos, read_repos }` for the active session.
  - _Requirements: 4.1_

- [x] 7. `get_token` daemon IPC op in `src/cli-server.ts` (as shipped: accepts `{ project }`).
  - _Requirements: 4.2_

- [x] 8. `tokens_status` operator CLI IPC op in `src/cli-server.ts` with optional live token
  validation.
  - _Requirements: 4.3_

## Fixes (this spec)

- [x] 9. Path/repo authorization cross-check (SECURITY — Issue 1)
  - [x] 9.1 Add pure `validatePathMatchesRepo(path, repo)` to `src/credential-validators.ts`:
    strip query string first; reject `path_invalid` on `..`, `//`, `://`, `@`, or any
    URL-encoded dot sequence (`%2e`/`%2E`) in the path component to prevent WHATWG URL
    normalization bypass; return null when no `/repos/{owner}/{repo}` segment is present
    (non-repo paths like /search/, /orgs/ need no cross-check); extract the first
    `{owner}/{repo}`, lowercase both sides, reject `repo_unauthorized` on mismatch, return
    null on match.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - [x] 9.2 Call `validatePathMatchesRepo(path, repo)` in the `github_http_forward` handler
    (`src/mcp-server.ts`) after `validatePathPrefix` and before token fetch; map failures to
    the `path_invalid` / `repo_unauthorized` credential log codes and return `isError: true`.
    - _Requirements: 5.6, 5.7_
  - [x] 9.3 Tier 1: unit + property tests (≥100 iterations) for `validatePathMatchesRepo` in
    `test/tier1/credential-validators.test.ts`. Cases must include: match, case-insensitive
    match, owner mismatch, repo mismatch, `..`, `%2e` (URL-encoded dot, both cases), `//`,
    absolute URL (`://`), `@`, missing `/repos/` segment (returns null), short path, path with
    query string (null returned), `/orgs/foo` path (null returned — no /repos/).
    - _Requirements: 5.1–5.5_
  - [x] 9.4 Tier 2: in `test/tier2/credential-mcp.test.ts`, assert `github_http_forward` rejects
    a `repo`/`path` owner mismatch (`repo_unauthorized`, no upstream request, no `get_token`
    IPC) and still succeeds when they match.
    - _Requirements: 5.6, 5.7_

- [ ] 10. `get_token` derives project from session (Issue 2)
  - [ ] 10.1 Change the `get_token` IPC op in `src/cli-server.ts` to accept `{ session_id }`,
    look up the active session, read its `bound_project`, and return that project's
    `{ token, expires_at }`; ignore any caller-supplied `project`. Return an error (no token)
    for missing `session_id`, unknown/inactive session, or missing `bound_project`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [ ] 10.2 Update both token fetches in `src/mcp-server.ts` (`github_http_forward` and
    `git_credential`) to send `{ op: 'get_token', session_id: sessionId }`.
    - _Requirements: 6.5_
  - [ ] 10.3 Tier 2: update `test/harness/mock-daemon-socket.ts` and the `get_token` cases in
    `test/tier2/ipc-contract.test.ts` / `test/tier2/credential-harness.test.ts` to key on
    `session_id`; assert a known active session returns its bound project's token+expiry and
    that missing/unknown/inactive session returns an error with no token.
    - _Requirements: 6.1, 6.2, 6.3_

- [ ] 11. Document CLI vs MCP socket separation (Issue 3)
  - [ ] 11.1 Ensure `get_token` is reached only via the MCP server's `sendToDaemon` path with
    `session_id`, and `tokens_status` remains the operator `tokens status` CLI path (no code
    change beyond task 10 — verify and adjust if needed).
    - _Requirements: 7.1, 7.2_
  - [ ] 11.2 Record the separate-code-paths-on-a-shared-socket design and the rationale for not
    using `SO_PEERCRED` in `design.md` (done in this spec) and in any operator-facing docs the
    change touches.
    - _Requirements: 7.3_

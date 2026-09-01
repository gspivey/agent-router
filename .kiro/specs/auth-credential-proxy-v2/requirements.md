# Requirements Document

## Introduction

The MCP credential tools (`github_http_forward`, `git_credential`) and their supporting
IPC ops shipped across PRs #71–80 and are running in production. They let a daemon-spawned
agent perform GitHub operations and obtain git HTTPS credentials without ever holding a raw
Personal Access Token: the agent sends request details to the agent-router MCP server, and
the MCP server resolves the session's bound project, authorizes the target repo, fetches the
project-scoped PAT from the daemon over the Unix socket, and injects the token server-side.

This is the correct architecture, but the shipped implementation has three defects — one a
genuine authorization-bypass vulnerability, two design flaws that widen the credential blast
radius. This spec documents the currently-shipped behavior accurately and specifies the three
fixes. It does **not** re-specify the Token_Store, credential-mode selection, or the Track 1
env-injection path; those shipped correctly and are described only where a fix touches them.

The original `auth-credential-proxy` spec was deprecated for exactly these three issues (see
its deprecation header). This is its replacement, written from the code as it actually exists.

## Glossary

- **MCP_Server**: The per-session MCP server in `src/mcp-server.ts`, spawned as a child of the
  daemon. Speaks JSON-RPC 2.0 over stdio to the agent and newline-delimited JSON over the
  daemon Unix socket (`sendToDaemon`).
- **Daemon_Socket**: The Unix domain socket the daemon listens on (`src/cli-server.ts`). Serves
  both operator CLI subcommands and daemon-child MCP callbacks. Path is passed to the MCP
  server as `AGENT_ROUTER_SOCKET`.
- **Bound_Project**: The project a session is bound to for write operations, recorded in the
  session's `meta.json` as `bound_project` (with `bound_project_repos` and
  `bound_project_read_repos`). Resolved at session creation.
- **Scoped_PAT**: The project-scoped GitHub Personal Access Token held only by the daemon's
  Token_Store (`src/token-store.ts`). Never delivered to the agent in MCP mode.
- **Path_Repo**: The `{owner}/{repo}` pair extracted from the first `/repos/{owner}/{repo}`
  segment of a `github_http_forward` `path` argument.
- **Repo_Arg**: The `repo` argument (in `owner/repo` form) supplied to `github_http_forward`,
  against which repo authorization is currently performed.

## Currently Shipped Behavior (PRs #71–80)

The following is running in production and is treated as the baseline. Requirements 1–4
describe what exists; Requirements 5–7 specify the fixes.

### Requirement 1 — Credential validators (shipped)

**User Story:** As the MCP server, I want pure validators for method, path prefix, body size,
and repo authorization, so that malformed or unauthorized credential-tool calls are rejected
before a token is fetched.

#### Acceptance Criteria

1. WHEN `validateMethod` receives a method THEN it SHALL return null iff the method is one of
   GET, POST, PUT, PATCH, DELETE.
2. WHEN `validatePathPrefix` receives a path THEN it SHALL return null iff the path starts with
   one of the known GitHub API prefixes (`/repos/`, `/orgs/`, `/users/`, `/gists/`, `/search/`,
   `/notifications/`, `/issues/`, `/pulls/`).
3. WHEN `validateBodySize` receives a body THEN it SHALL reject iff `Buffer.byteLength(body)`
   exceeds 10 MB.
4. WHEN `validateRepoAuthorization` receives a write method (POST/PUT/PATCH/DELETE) THEN it
   SHALL authorize iff `repo` is in `boundProjectRepos`; for GET it SHALL authorize iff `repo`
   is in `boundProjectRepos` OR `readRepos`.
5. These functions live in `src/credential-validators.ts` and are covered by Tier 1 tests in
   `test/tier1/credential-validators.test.ts`.

### Requirement 2 — `github_http_forward` tool (shipped)

**User Story:** As an agent, I want to forward an HTTP request to the GitHub API with
project-scoped authentication I never see, so that I can operate on authorized repos without
holding a token.

#### Acceptance Criteria

1. WHEN the tool is called THEN it SHALL require non-empty `method`, `path`, and `repo`
   arguments and reject with `isError: true` otherwise.
2. WHEN arguments are present THEN it SHALL apply, in order: `validateMethod`,
   `validatePathPrefix`, `validateBodySize`, then repo authorization via
   `validateRepoAuthorization` using the session's Bound_Project repos and read repos.
3. WHEN authorization passes THEN it SHALL fetch a token from the daemon and forward the
   request to `${githubApiBaseUrl}${path}` with an `Authorization: Bearer <token>` header, a
   30-second timeout, and return `{ status, headers, body }`.
4. WHEN the call succeeds, times out, or the upstream returns 5xx THEN it SHALL emit a
   structured credential log entry (`tool_name`, `repo`, `project`, `session_id`, `status`,
   `duration_ms`, `error_code`).

### Requirement 3 — `git_credential` tool (shipped)

**User Story:** As an agent, I want git HTTPS credentials for a bound-project repo, so that
`git push`/`git fetch` over HTTPS works without me holding a token.

#### Acceptance Criteria

1. WHEN the tool is called THEN it SHALL require a non-empty `repo` argument.
2. WHEN `repo` is not in the session's `bound_project_repos` THEN it SHALL reject with
   `repo_unauthorized` (git credentials are write-capable, so read-only repos are excluded).
3. WHEN authorized THEN it SHALL fetch a token and return
   `{ protocol: "https", host: "github.com", username: "x-access-token", password: <token> }`.

### Requirement 4 — Daemon IPC ops (shipped)

**User Story:** As the MCP server, I want daemon IPC ops to resolve a session's project and to
retrieve a token, so that authorization and token injection happen daemon-side.

#### Acceptance Criteria

1. WHEN `get_session_project { session_id }` is called THEN the daemon SHALL return
   `{ project, repos, read_repos }` for the active session's Bound_Project, or `{ error }`.
2. WHEN `get_token` is called THEN the daemon SHALL return `{ token, expires_at }` from the
   Token_Store. **(As shipped, `get_token` accepts a raw `{ project }` argument — Requirement 6
   changes this.)**
3. WHEN `tokens_status` is called THEN the daemon SHALL return per-project expiry status, with
   optional live validation when `check` is true. This is an operator CLI subcommand.

## Fixes (this spec)

### Requirement 5 — Path/repo authorization cross-check (SECURITY)

**User Story:** As the daemon operator, I want `github_http_forward` to reject any call whose
`path` targets a different repository than the authorized `repo` argument, so that an agent
cannot use an allowed `repo` to write an unauthorized repo via a crafted `path`.

#### Background

Today authorization runs against `Repo_Arg` but the upstream URL is built from `path`:

```typescript
const authErr = validateRepoAuthorization(method, repo, { ... }); // checks `repo`
const upstreamUrl = `${baseUrl}${path}`;                          // uses `path`
```

An agent authorized for `mine/allowed` can pass
`{ repo: "mine/allowed", path: "/repos/other/victim/contents/x" }` and write `other/victim`.

#### Acceptance Criteria

1. THERE SHALL be a new pure function `validatePathMatchesRepo(path, repo)` in
   `src/credential-validators.ts` returning `ValidationError | null`.
2. WHEN the `path` contains a `..` segment, a `//` sequence, an absolute URL (a `://`
   substring), an `@` character, or any URL-encoded dot sequence (`%2e` or `%2E`, case-
   insensitive) THEN `validatePathMatchesRepo` SHALL reject with a `path_invalid` error,
   without attempting a repo comparison. The query string (`?...`) is stripped first; these
   checks apply to the path portion only.
3. WHEN the `path` contains no `/repos/{owner}/{repo}` segment THEN the function SHALL return
   null (no cross-check needed — paths like `/search/`, `/orgs/`, `/users/` do not target a
   specific repo and are already gated by the upstream `validateRepoAuthorization` check on
   `repo`).
4. WHEN a `/repos/{owner}/{repo}` segment is present THEN the function SHALL extract the first
   such `{owner}/{repo}`, normalize both it and `repo` to lowercase, and reject with
   `repo_unauthorized` if they are not equal. Checks are applied to the path component only —
   any query string (`?param=value`) is stripped before extraction.
5. WHEN the extracted `Path_Repo` equals the normalized `Repo_Arg` THEN the function SHALL
   return null.
6. WHEN `github_http_forward` runs THEN it SHALL call `validatePathMatchesRepo(path, repo)`
   after the existing `validatePathPrefix` check and before fetching a token, returning
   `isError: true` with error code `repo_unauthorized` (matching the existing error taxonomy)
   when path's owner/repo does not match the `repo` argument.
7. The behavior SHALL NOT change any accepted request: a call whose `path` owner/repo matches
   its `repo` argument, or whose `path` has no `/repos/` segment, continues to succeed exactly
   as before.

### Requirement 6 — `get_token` derives project from session, never from caller

**User Story:** As the daemon operator, I want `get_token` to identify the project from the
caller's session rather than a caller-supplied name, so that a session cannot request another
project's PAT.

#### Background

`get_token` currently accepts `{ project }` directly. Any MCP session can request any project's
PAT by name. The daemon already has the trusted mapping via the session's `bound_project`.

#### Acceptance Criteria

1. WHEN `get_token { session_id }` is called THEN the daemon SHALL look up the active session
   via `sessionMgr.getActiveSession(session_id)` (which exposes `boundProject` and
   `boundProjectRepos` from the in-memory session handle), and return that project's
   `{ token, expires_at }` from the Token_Store.
2. WHEN `session_id` is missing or empty THEN `get_token` SHALL return an error and SHALL NOT
   return any token.
3. WHEN the session does not exist, is not active, or has no `bound_project` THEN `get_token`
   SHALL return an error and SHALL NOT return any token.
4. `get_token` SHALL NOT accept or honor a caller-supplied `project` argument; the served
   project is derived solely from the session's Bound_Project.
5. WHEN `github_http_forward` and `git_credential` fetch a token THEN they SHALL call
   `get_token { session_id }` (they already hold the authenticated `sessionId`) instead of
   passing a project name.

### Requirement 7 — CLI socket vs MCP callback separation (documented)

**User Story:** As a maintainer, I want the operator `tokens status` path and the MCP
`get_token` path documented as distinct code paths, so that the incompatibility between
operator CLI calls and daemon-child MCP calls on the shared socket is understood and preserved.

#### Background

The original design imagined `SO_PEERCRED` verification for daemon-child MCP calls, which is
incompatible with operator CLI calls on the same socket. In the shipped code these are already
separate ops and separate callers: `tokens_status` is an operator CLI subcommand, `get_token`
is invoked by the MCP server via `sendToDaemon`. No socket split is required.

#### Acceptance Criteria

1. The `get_token` op SHALL be reached only by the MCP server via the daemon socket
   (`sendToDaemon`), passing `session_id` (per Requirement 6).
2. The `tokens_status` op SHALL remain the operator `tokens status` CLI subcommand path and
   SHALL NOT depend on session context.
3. The design document SHALL describe these as separate code paths on the shared daemon socket
   and SHALL record that `SO_PEERCRED`-based access control is out of scope because the two
   caller classes legitimately share the socket.

## Out of Scope

- GitHub App migration and installation tokens.
- Per-session scope narrowing.
- Short-TTL credentials.
- The original spec's appendix items (Phase C, Phase D).
- Any change to the Track 1 env-injection credential mode.

## Testing Strategy

- **Tier 1** (`test/tier1/`): `validatePathMatchesRepo` gets unit tests and property tests
  (≥100 iterations) in `test/tier1/credential-validators.test.ts`, covering the traversal
  rejections (`..`, `%2e`/`%2E` URL-encoded dots, `//`, `://`, `@`), the missing-repos-segment
  null return, the owner/repo match/mismatch cases, and query-string stripping.
- **Tier 2** (`test/tier2/`): the path/repo cross-check is exercised end-to-end through the MCP
  server against the fake GitHub backend and mock daemon socket; the `get_token` session lookup
  is exercised against a real `createCliServer` with a real session manager and token store.
- **Tier 3**: unchanged; not required for these fixes.

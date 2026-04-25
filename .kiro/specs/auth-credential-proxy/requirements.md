# Requirements Document

## Introduction

Agent Router currently authenticates all GitHub operations with a single shared `GITHUB_TOKEN` environment variable. This token is broadly scoped, statically configured, and visible to every agent process spawned by the daemon. A leak — through tool output, log capture, model exfiltration, or process inspection — compromises every repository the token can reach. There is no project isolation: a session working on repo A uses the same credential that could push to repo B. This document specifies a two-track migration to project-scoped credentials that progressively reduces blast radius and eliminates the agent's direct access to tokens.

**Track 1 — project-scoped PATs, env-injected (agent sees raw token).** Replace the single shared token with a JSON-configured map of project → fine-grained Personal Access Token. Each PAT is scoped by the user to cover all repositories in one project. The daemon resolves each session's bound project at spawn time and injects only that project's PAT into the agent's environment as `GITHUB_TOKEN`. The agent continues to see the raw token — this is intentional, so the existing `gh` CLI and `git` tooling works without any agent-side change. A leaked token compromises one project instead of the whole account. Track 1 is the fast-adoption baseline: no agent code changes, no new MCP tools, immediate value.

**Track 2 / Phase A — credential MCP tools (agent never sees tokens).** Add MCP tools to the existing agent-router MCP server that perform GitHub operations on the agent's behalf, injecting the project's PAT server-side. The tools are a generic HTTP forwarder (`github_http_forward`) and a git credential helper (`git_credential`) — they are passthrough tools, not semantic wrappers around the GitHub API. By the end of Track 2 / Phase A's rollout, the agent process has no environment variable, file, or memory containing a raw GitHub credential — all GitHub access flows through MCP tool calls. The PATs themselves are unchanged from Track 1; only the access path differs.

**Out of scope.** GitHub App migration, short-TTL credentials (e.g., 1-hour installation tokens), per-session scope narrowing, Checks API integration, and pluggable non-GitHub credential providers are all out of scope. Each of these is a meaningful design decision in its own right and will be specified in a dedicated future GitHub App spec. This document is intentionally limited to the PAT-based credential surface.

| Phase | Agent sees token? | Token TTL | Blast radius if leaked |
|---|---|---|---|
| Today | Yes (single env var) | Until manually revoked | All repos token can reach |
| Track 1 | Yes (per-project env var) | 30 days (recommended) | One project, up to 30 days |
| Track 2 / Phase A | No | 30 days (same PATs, hidden) | One project, up to 30 days |

**Non-goals.** This document does not specify (a) the agent process's runtime sandboxing beyond credential isolation, (b) outbound traffic policy beyond GitHub API and Git over HTTPS, or (c) any auth model for inbound webhook traffic, which retains the existing webhook secret mechanism.

## Glossary

- **Token_Store**: The in-memory representation of project-to-PAT mappings loaded from the Tokens_File; provides lookup of a token by project name, and reverse lookup of a project by `owner/repo`
- **Tokens_File**: A JSON file at `~/.agent-router/tokens.json` (chmod 600) containing the project-scoped token configuration, located under `$AGENT_ROUTER_HOME`
- **Scoped_PAT**: A GitHub fine-grained Personal Access Token scoped by the user to all repositories in a project, with minimum permissions: `contents:write`, `pull_requests:write`, `metadata:read`
- **Project**: A named grouping of one or more `owner/repo` identifiers that share a single Scoped_PAT; the user mints one fine-grained PAT per project and scopes it to cover all repos in that project
- **Project_Repo_Map**: The mapping within the Tokens_File from a project name to its single PAT and the list of `owner/repo` identifiers the PAT covers
- **Bound_Project**: The project that a Session is bound to for write operations; determined at session creation from the Project_Repo_Map based on the repos referenced in the prompt or explicit project selection
- **Credential_MCP_Tools**: A set of MCP tools added to the existing MCP server (`src/mcp-server.ts`) that handle token injection server-side, so the agent sends request details and the MCP server adds authentication before forwarding upstream. These are generic passthrough/forwarder tools, not semantic GitHub API wrappers
- **Upstream_Response**: The HTTP response returned by the upstream service after the Credential_MCP_Tools forward a request
- **Daemon**: The long-running Agent Router process
- **Session**: A mapping between a GitHub PR (or set of PRs across repos) and an ACP agent session, as defined in the existing system; each session is bound to exactly one Project for write operations
- **credentialMode**: A per-deployment configuration flag (`"env"` or `"mcp"`) that determines whether the daemon injects tokens into the agent environment (Track 1) or relies exclusively on MCP credential tools (Track 2)

## Testing Strategy

This spec uses a three-tier test harness aligned with the project's existing testing tiers:

**Tier 1 — Unit / pure-function tests.** All Token_Store parsing, validation, schema checks, project-repo-map lookups, and credential-mode logic are pure functions tested in isolation. Property-based tests (fast-check, 100+ iterations) cover round-trip parsing, repo-uniqueness invariants, and input validation. No I/O, no mocks, milliseconds to run.

**Tier 2 — Component tests with mocks.** Full daemon exercised against mock surfaces:
- **Mock GitHub API server**: Accepts forwarded HTTP requests, validates Authorization headers, returns canned responses. Verifies that `github_http_forward` injects tokens correctly and respects timeouts.
- **Mock daemon socket**: Simulates the daemon's Unix socket IPC so the MCP server can resolve Bound_Project without a real daemon.
- **Mock agent process**: Simulates an agent subprocess to verify that `GITHUB_TOKEN` is (or is not) present in the environment depending on `credentialMode`.

No network access required. Target: under 30 seconds.

**Tier 3 — Real integration tests.** Full daemon against real GitHub API with real PATs. Validates end-to-end token injection, MCP tool forwarding, and webhook token lookup. Requires `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `KIRO_PATH` env vars. Minutes to run.

**Test-first build order:** Each requirement is implemented test-first. Tier 1 tests are written before implementation code. Tier 2 tests are written as part of each feature task and are not optional.

**Cross-spec harness reuse:** The mock GitHub API server, mock daemon socket, and mock agent process are implemented in `test/harness/` and are reusable by future specs (e.g., the GitHub App spec).

## Forward Compatibility

This section defines the explicit boundary between this spec and the future GitHub App spec:

- **MCP tool surface is credential-backend-agnostic.** The `github_http_forward` and `git_credential` tool input schemas and output schemas do not reference the credential type (PAT, App token, etc.). A future credential backend can be swapped in without changing the agent-facing tool interface.
- **Tokens_File schema is PAT-specific.** The `tokens.json` schema defined in this spec is specific to PAT-based credentials. The future GitHub App spec will define its own configuration format (app ID, private key, installation ID, etc.).
- **Per-session scope narrowing is out of scope.** This spec does not implement per-session permission restriction. The future GitHub App spec will define `ScopeSpec` and per-session token minting.
- **Short TTLs and Checks API are out of scope.** GitHub App installation tokens (1-hour TTL) and the Checks API (which requires App authentication) are deferred to the GitHub App spec.

## Requirements

### Requirement 1: Tokens File Schema and Loading

**User Story:** As a developer, I want project-scoped PATs loaded from a secured JSON file on startup, so that each project has a single token covering all its repos and a token leak compromises only one project's repositories.

#### Acceptance Criteria

1. WHEN the Daemon starts, THE Token_Store SHALL read the Tokens_File from `~/.agent-router/tokens.json` (or `$AGENT_ROUTER_HOME/tokens.json` if the environment variable is set) and parse it as JSON conforming to the schema defined in Requirement 9
2. WHEN the Tokens_File is loaded, THE Token_Store SHALL validate that each project entry contains a non-empty `token` string and a non-empty `repos` array where every element is a valid `owner/repo` string
3. WHEN the Tokens_File is loaded, THE Token_Store SHALL validate that no `owner/repo` string appears in more than one project; IF a duplicate is found, THE Token_Store SHALL throw a FatalError identifying the duplicate repo and the conflicting projects
4. IF the Tokens_File has filesystem permissions more permissive than owner-read-write (mode 600), THEN THE Token_Store SHALL log a warning indicating insecure file permissions
5. IF the Tokens_File is missing and the `GITHUB_TOKEN` environment variable is set, THEN THE Token_Store SHALL fall back to using `GITHUB_TOKEN` for all repos and log a deprecation warning on every startup
6. IF the Tokens_File is missing and the `GITHUB_TOKEN` environment variable is not set, THEN THE Token_Store SHALL throw a FatalError with a descriptive message
7. IF the Tokens_File contains invalid JSON or fails schema validation, THEN THE Token_Store SHALL throw a FatalError identifying the validation error

### Requirement 2: Token File Hot-Reload

**User Story:** As a developer, I want to update the tokens file without restarting the daemon, so that I can rotate tokens with zero downtime.

#### Acceptance Criteria

1. WHEN the Daemon receives a `SIGHUP` signal, THE Token_Store SHALL re-read and re-validate the Tokens_File. SIGHUP is the canonical reload trigger
2. WHEN the Tokens_File is loaded on startup, THE Token_Store SHALL also register an `fs.watch` listener on the Tokens_File path as a best-effort change detector; IF `fs.watch` is unavailable or unreliable on the platform, THE Token_Store SHALL fall back to polling the file's mtime every 30 seconds
3. WHEN a reload is triggered (by SIGHUP, fs.watch, or polling), THE Token_Store SHALL re-read and re-validate the Tokens_File within 1 second
4. IF the re-read Tokens_File is valid, THEN THE Token_Store SHALL replace the in-memory reference in a single event-loop tick so no reader observes a partial state, and log an informational message listing added, removed, and changed projects
5. IF the re-read Tokens_File is invalid, THEN THE Token_Store SHALL retain the previous valid token map, log a warning with the validation error, and continue operating with the old data
6. WHEN the Tokens_File is deleted while the Daemon is running, THE Token_Store SHALL retain the previous valid token map and log a warning
7. WHEN a token is rotated (replaced in the Tokens_File) while sessions are active, Track 2 sessions SHALL transparently use the new token on the next MCP tool call; Track 1 sessions SHALL retain the token that was injected into their environment at spawn time until the session ends

### Requirement 3: Project-Scoped Session Authorization

**User Story:** As a developer, I want each agent session bound to a single project for write operations, with read access to additional repos when declared or publicly available, so that the session can gather context broadly while maintaining project-scoped write isolation.

#### Acceptance Criteria

1. WHEN the Daemon spawns a session, THE Daemon SHALL determine the session's Bound_Project by finding the project in the Project_Repo_Map that contains the repo referenced in the prompt or by explicit project selection
2. WHEN a session's Bound_Project is determined, THE Daemon SHALL record the Bound_Project name and its full list of repos in the session's metadata
3. WHILE a session is active, THE Token_Store SHALL return the Bound_Project's single PAT when queried by the Credential_MCP_Tools or by session-scoped callers for any repo in the Bound_Project's repo list
4. WHILE a session is active, THE Credential_MCP_Tools SHALL enforce a read/write split: write operations (push, PR creation, commit comments, issue creation) are permitted only for repos in the session's Bound_Project repo list
5. WHEN a session is created, THE Daemon SHALL determine a single Bound_Project for write operations based on the prompt's primary repo target
6. IF a prompt references additional repos outside the Bound_Project for read-only purposes, THE Daemon SHALL allow unauthenticated read access to public repos outside the Bound_Project; for private repos outside the Bound_Project, THE Daemon SHALL allow read access only if the prompt explicitly declares them in a `read_repos` directive and the Token_Store contains a project entry covering them
7. IF a prompt declares write operations against repos in different projects, THEN THE Daemon SHALL reject the session creation with an error indicating that cross-project write sessions are not supported
8. IF a prompt references a repo not present in any project in the Project_Repo_Map and the repo is not public, THEN THE Daemon SHALL reject the session creation with an error identifying the unknown repo

### Requirement 4: Agent Environment Token Injection (Track 1)

**User Story:** As a developer, I want the daemon to inject the project's single PAT as `GITHUB_TOKEN` into the agent's environment on session spawn, so that I can use standard GitHub tooling immediately without waiting for the MCP credential layer.

#### Acceptance Criteria

1. WHEN the Daemon spawns a session and `credentialMode` is `env`, THE Daemon SHALL look up the Bound_Project's single PAT from the Token_Store and set the `GITHUB_TOKEN` environment variable in the agent subprocess to that token
2. WHEN the Daemon injects the token into the agent environment, THE Daemon SHALL log an informational message listing the Bound_Project name and the repos it covers, without logging the token value, any token prefix, token suffix, or token hash
3. IF the Token_Store does not contain an entry for the session's Bound_Project during session spawn, THEN THE Daemon SHALL log an error and reject the session creation
4. THE Daemon SHALL support a per-deployment configuration flag `credentialMode` with values `"env"` (Track 1 — inject `GITHUB_TOKEN` into agent environment) and `"mcp"` (Track 2 / Phase A — omit `GITHUB_TOKEN`, rely on credential MCP tools). WHEN `credentialMode` is `"env"`, THE Daemon SHALL inject `GITHUB_TOKEN` as specified in 4.1. WHEN `credentialMode` is `"mcp"`, THE Daemon SHALL omit `GITHUB_TOKEN` from the agent environment and log a startup message listing the registered credential MCP tools
5. WHEN `credentialMode` transitions between values (e.g., config file change or restart), existing sessions SHALL continue with their original credential mode until they end

### Requirement 5: GitHub HTTP Forward MCP Tool (Phase A)

**User Story:** As a developer, I want the agent to call a `github_http_forward` MCP tool that forwards arbitrary GitHub API requests with the correct project-scoped token injected server-side, so that the agent never handles raw credentials once Track 2 is enabled. This tool is a generic HTTP passthrough/forwarder — it is not a semantic GitHub API wrapper and does not mirror the official GitHub MCP server's tool surface.

#### Acceptance Criteria

1. THE MCP_Server SHALL register a `github_http_forward` tool with input schema: `{ method: string, path: string, body?: string, repo: string }` where `repo` is in `owner/repo` format. Note: `body` is string-only; binary upload (e.g., release assets) is out of scope for Phase A. The tool does not accept custom headers; all necessary headers (Authorization, User-Agent, Accept) are set server-side
2. WHEN the `github_http_forward` tool is called, THE MCP_Server SHALL validate that the `repo` parameter is in the session's Bound_Project repo list for write methods (POST, PUT, PATCH, DELETE); for GET requests, the read/write split rules from Requirement 3 apply
3. WHEN the `repo` is authorized, THE MCP_Server SHALL look up the Bound_Project's single PAT from the Token_Store, set the `Authorization: Bearer <token>` header, and forward the request to `https://api.github.com` with the specified method, path, and body
4. WHEN the upstream GitHub API returns a response, THE MCP_Server SHALL return the response status code, headers, and body to the agent as the tool result
5. IF the Token_Store does not contain an entry for the session's Bound_Project, THEN THE MCP_Server SHALL return an error result with a descriptive message and SHALL NOT forward the request upstream

### Requirement 6: Git Credential MCP Tool (Phase A)

**User Story:** As a developer, I want the agent to call a `git_credential` MCP tool to obtain git HTTPS credentials for push and pull operations, so that git operations work without raw tokens in the agent's environment once Track 2 is enabled. This tool returns credential data for use with `git credential fill` — it is a passthrough to the Token_Store, not a semantic git wrapper.

#### Acceptance Criteria

1. THE MCP_Server SHALL register a `git_credential` tool with input schema: `{ repo: string }` where `repo` is in `owner/repo` format
2. WHEN the `git_credential` tool is called, THE MCP_Server SHALL validate that the `repo` parameter is in the session's Bound_Project repo list; IF the repo is not in the Bound_Project, THE MCP_Server SHALL return an error response identifying the unauthorized repo
3. WHEN the `repo` is authorized, THE MCP_Server SHALL look up the Bound_Project's single PAT from the Token_Store and return a result containing `{ protocol: "https", host: "github.com", username: "x-access-token", password: "<token>" }`
4. IF the Token_Store does not contain an entry for the session's Bound_Project, THEN THE `git_credential` tool SHALL return an error result with a descriptive message
5. THE MCP_Server SHALL log each `git_credential` call with the session ID and repo, excluding the token value from the log entry

### Requirement 7: MCP Credential Tools Registration and Lifecycle

**User Story:** As a developer, I want the credential MCP tools added to the existing MCP server, so that agents can access GitHub APIs without a separate proxy process.

#### Acceptance Criteria

1. WHEN the MCP_Server starts, THE MCP_Server SHALL register the `github_http_forward` and `git_credential` tools alongside the existing MCP tools (`session_status`, `register_pr`, `complete_session`)
2. THE MCP_Server SHALL include the credential tools in the `tools/list` response so that agents discover them during MCP initialization
3. WHEN the MCP_Server handles a `tools/call` request for a credential tool, THE MCP_Server SHALL resolve the session's Bound_Project from the Daemon via the daemon socket before processing the request

### Requirement 8: Webhook Token Lookup

**User Story:** As a developer, I want webhook handlers to use the correct project-scoped token when posting status comments, so that webhook responses authenticate with the right PAT.

Note: Webhook token lookup is a reverse-lookup flow (webhook delivers a repo → Token_Store finds the project containing that repo → returns the project's PAT). This is distinct from the session-scoped forward lookup (session has a Bound_Project → Token_Store returns that project's PAT) used by the credential MCP tools and session authorization.

#### Acceptance Criteria

1. WHEN a webhook handler needs to post a status comment or update on GitHub, THE Daemon SHALL look up the project that contains the webhook's repo from the Token_Store and use that project's single PAT
2. WHEN the token is obtained, THE Daemon SHALL use it in the `Authorization: Bearer <token>` header for the outgoing GitHub API request
3. IF the Token_Store does not contain any project with the webhook's repo, THEN THE Daemon SHALL log a warning with the repo name and skip the outgoing API call without crashing

### Requirement 9: Tokens File Configuration Schema

**User Story:** As a developer, I want a well-defined JSON schema for the tokens file, so that I can validate my configuration and tooling can generate it.

#### Acceptance Criteria

1. THE Tokens_File SHALL conform to the following top-level schema: `{ "projects": Record<string, { "token": string, "repos": string[], "expires_at"?: string }> }` where each key is a project name and each value contains a single PAT, the list of repos it covers, and an optional ISO 8601 expiry timestamp
2. WHEN the `projects` map is parsed, THE Token_Store SHALL validate that each project name is a non-empty ASCII-only string matching the pattern `^[a-zA-Z0-9._-]+$`. Note: project names are ASCII-only
3. WHEN a `projects` entry is parsed, THE Token_Store SHALL validate that the `token` field is a non-empty string and the `repos` array is non-empty with each element matching the pattern `^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`
4. WHEN the `projects` map is parsed, THE Token_Store SHALL validate that no `owner/repo` string appears in more than one project entry
5. FOR ALL valid Tokens_File JSON strings, parsing the file into a Token_Store and serializing the Token_Store back to JSON SHALL produce a structure with the same project keys, token values, and repo lists (round-trip property)
6. WHEN a `projects` entry contains an `expires_at` field, THE Token_Store SHALL validate that it is a valid ISO 8601 date-time string; IF the field is present but invalid, THE Token_Store SHALL throw a FatalError identifying the malformed entry

### Requirement 10: MCP Credential Tools Request Validation

**User Story:** As a developer, I want the MCP credential tools to validate and sanitize all incoming tool arguments, so that malformed or malicious requests do not reach upstream services.

#### Acceptance Criteria

1. WHEN the `github_http_forward` tool receives a call with a `path` that does not start with `/repos/` or another known GitHub API prefix, THE MCP_Server SHALL return an error result with a descriptive message
2. WHEN the `github_http_forward` tool receives a call, THE MCP_Server SHALL validate that the `method` parameter is one of GET, POST, PUT, PATCH, DELETE; calls with other methods SHALL receive an error result
3. THE MCP_Server SHALL enforce a maximum request body size of 10 MB for the `github_http_forward` tool; requests exceeding this limit SHALL receive an error result
4. THE MCP_Server SHALL set a 30-second timeout on upstream GitHub API requests made by the `github_http_forward` tool; IF the timeout is exceeded, THE MCP_Server SHALL return an error result to the agent
5. THE MCP_Server SHALL add a `User-Agent: agent-router/<version>` header to all forwarded requests

### Requirement 11: Credential Tools Observability

**User Story:** As a developer, I want structured logs and metrics from the credential MCP tools, so that I can debug authentication failures and monitor token usage.

#### Acceptance Criteria

1. WHEN the MCP_Server processes a credential tool call, THE MCP_Server SHALL log a structured entry with fields: `tool_name`, `repo`, `project`, `session_id`, `status` (success or error), and `duration_ms`
2. THE MCP_Server SHALL NOT include token values, Authorization header contents, or request/response bodies in log entries
3. WHEN a token lookup fails for a project during a credential tool call, THE MCP_Server SHALL log a warning entry with the project name, the error reason, and the session ID
4. WHEN the Token_Store hot-reloads the Tokens_File, THE Token_Store SHALL log an informational entry listing the count of projects added, removed, and unchanged

### Requirement 12: Token Health and Expiry Monitoring

**User Story:** As a developer, I want proactive warnings about expiring tokens and a CLI command to check token health, so that I can rotate credentials before they expire and avoid service disruptions.

#### Acceptance Criteria

1. WHEN the Token_Store loads or hot-reloads the Tokens_File, THE Token_Store SHALL evaluate the `expires_at` field for each project entry that includes one and emit tiered warnings: a `warn`-level log when the token expires within 14 days, an `alert`-level log when the token expires within 7 days, and an `error`-level log when the token expires within 2 days
2. WHEN a token's `expires_at` date has passed, THE Token_Store SHALL log an `error`-level message identifying the expired project and SHALL continue to serve the token (GitHub may still accept it briefly after fine-grained PAT expiry)
3. THE Daemon SHALL provide a CLI subcommand `agent-router tokens status` that lists all projects, their repo counts, and their expiry status (valid, expiring-soon, expired, no-expiry-set)
4. WHEN the `agent-router tokens status` command is invoked with the `--check` flag, THE CLI SHALL perform a live validation of each token by calling the GitHub API `GET /user` endpoint with the token and reporting whether the token is valid, invalid, or rate-limited
5. THE CLI SHALL cache `--check` validation results for 1 hour in a local cache file to avoid excessive GitHub API calls on repeated invocations
6. THE documentation SHALL include a canonical token rotation procedure: (1) mint new fine-grained PAT in GitHub, (2) update `tokens.json` with new token and `expires_at`, (3) verify via `agent-router tokens status --check`, (4) revoke old PAT in GitHub

## Appendix A: Future Considerations (Non-Binding)

The following concepts are illustrative and non-binding. They are included to provide context for future design decisions but are explicitly out of scope for this spec. No implementation work should be based on this appendix.

### AppCredentialProvider Interface (Future Phase D)

A pluggable `AppCredentialProvider` interface would allow the MCP credential tools to be extended to support services beyond GitHub (e.g., Slack, Linear, Google Drive). The interface would define methods for issuing credentials, forwarding requests, and validating policy for a specific service. The Phase A GitHub PAT provider would serve as the reference implementation. This concept requires careful design around service discovery, configuration schema per provider, and security policy enforcement, and will be specified in a dedicated future spec.

### Per-Session Scope Narrowing (Future Phase C)

Per-session scope narrowing would allow the MCP credential tools to mint tokens restricted to only the permissions and repos needed for each session, minimizing blast radius if a session is compromised. This requires a `ScopeSpec` descriptor and integration with a credential backend that supports permission-scoped token minting (e.g., GitHub App installation tokens). This concept depends on the GitHub App migration and will be specified alongside it.

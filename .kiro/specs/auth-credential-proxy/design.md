# Design Document: Auth Credential Proxy

## Overview

This design specifies a two-track migration from a single shared `GITHUB_TOKEN` environment variable to project-scoped Personal Access Tokens (PATs). The system introduces a `Token_Store` module that loads, validates, and hot-reloads a `tokens.json` configuration file mapping projects to fine-grained PATs. Two credential delivery modes are supported:

- **Track 1 (`credentialMode: "env"`)**: The daemon injects the project's PAT as `GITHUB_TOKEN` into the agent subprocess environment at spawn time. The agent sees the raw token. Existing `gh` CLI and `git` tooling works unchanged.
- **Track 2 (`credentialMode: "mcp"`)**: The daemon omits `GITHUB_TOKEN` from the agent environment. Two new MCP tools — `github_http_forward` and `git_credential` — are added to the existing per-session MCP server. These tools inject the PAT server-side, so the agent never handles raw credentials.

Both tracks use the same `Token_Store` and `tokens.json` schema. The credential mode is a per-deployment configuration flag. Webhook handlers also use the Token_Store for reverse-lookup (repo → project → PAT) when posting status comments.

### Design Rationale

The design prioritizes:
1. **Incremental adoption**: Track 1 requires zero agent-side changes. Track 2 can be enabled later without re-configuring tokens.
2. **Blast radius reduction**: A leaked token compromises one project instead of the entire account.
3. **Hot-reload without downtime**: Token rotation via file edit + SIGHUP, no daemon restart.
4. **Forward compatibility**: MCP tool schemas are credential-backend-agnostic, enabling future GitHub App migration without agent-facing changes.
5. **Consistency with existing patterns**: Dependency injection, structured logging, synchronous I/O for pure logic, existing error classes.

## Architecture

```mermaid
graph TD
    subgraph Daemon Process
        Config["config.ts<br/>(+credentialMode)"]
        TS["token-store.ts<br/>Token_Store"]
        SM["session-mgr.ts<br/>(+Bound_Project resolution)"]
        WH["server.ts<br/>Webhook Handler"]
        CLI["cli-server.ts<br/>(+tokens status)"]
        Index["index.ts<br/>Startup + SIGHUP"]
    end

    subgraph Per-Session MCP Subprocess
        MCP["mcp-server.ts<br/>(+github_http_forward<br/>+git_credential)"]
    end

    TF["~/.agent-router/tokens.json"]
    GH["GitHub API"]
    Agent["Agent Subprocess"]

    TF -->|load/reload| TS
    Index -->|SIGHUP| TS
    Config -->|credentialMode| SM
    TS -->|PAT lookup| SM
    TS -->|reverse lookup| WH
    SM -->|env inject (Track 1)| Agent
    SM -->|Bound_Project via socket| MCP
    MCP -->|PAT from daemon| GH
    MCP -->|tool results| Agent
    WH -->|PAT for status comments| GH
    CLI -->|token health| TS
```

> **Note:** The MCP server runs as one subprocess per session, spawned by the daemon at session creation.

### Data Flow: Track 1 (env injection)

1. Session creation request arrives (webhook, CLI, cron)
2. `SessionManager` resolves `Bound_Project` from prompt's target repo via `Token_Store.findProjectByRepo()`
3. `SessionManager` looks up the project's PAT via `Token_Store.getToken(projectName)`
4. `SessionManager` spawns ACP subprocess with `GITHUB_TOKEN=<PAT>` in env
5. Agent uses `gh` CLI / `git push` normally — token is in env

### Data Flow: Track 2 (MCP credential tools)

1. Session creation request arrives
2. `SessionManager` resolves `Bound_Project` (same as Track 1) but does NOT inject `GITHUB_TOKEN`
3. Agent calls `github_http_forward` or `git_credential` MCP tool
4. MCP server subprocess sends IPC request to daemon socket to resolve session's `Bound_Project`
5. Daemon returns `Bound_Project` name + repo list
6. MCP server looks up PAT from daemon (via a new `get_token` IPC op)
7. MCP server injects `Authorization: Bearer <PAT>` and forwards to GitHub API
8. Response returned to agent as tool result

### Data Flow: Webhook reverse lookup

1. Webhook arrives with `repository.full_name`
2. Webhook handler calls `Token_Store.findProjectByRepo(repo)` → returns the project name
3. Webhook handler calls `Token_Store.getToken(projectName)` → returns the project's PAT (`Secret`)
4. Webhook handler calls `.reveal()` and uses the raw PAT for the outgoing GitHub API call (status comment)

## Components and Interfaces

### Secret Type (`src/secret.ts`)

All credential strings (PATs, future App installation tokens) are wrapped in a `Secret` type immediately on parse. The wrapper prevents accidental serialization in logs, JSON output, or error messages.

```typescript
export class Secret {
  private constructor(private readonly value: string) {}
  
  static of(value: string): Secret {
    if (!value) throw new Error('Secret cannot be empty');
    return new Secret(value);
  }
  
  reveal(): string { return this.value; }
  toString(): string { return '[REDACTED]'; }
  toJSON(): string { return '[REDACTED]'; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return '[REDACTED]'; }
}
```

The `Token_Store` interface uses `Secret` throughout: `getToken()` returns `Secret | undefined` instead of `string | undefined`, and `ProjectEntry.token` is typed as `Secret`. Callers that need the raw value call `.reveal()` at the latest possible moment (HTTP header injection, env var injection). This makes Property 8 a structural invariant of the type system.

### Token_Store (`src/token-store.ts`)

The central credential management module. Pure-logic validation functions are exported separately for direct unit testing.

```typescript
/** Parsed and validated representation of a single project entry */
export interface ProjectEntry {
  name: string;
  token: Secret;
  repos: string[];
  expiresAt: Date | undefined;
}

/** The immutable snapshot of all project-token mappings */
export interface TokenMap {
  projects: ReadonlyMap<string, ProjectEntry>;
  repoIndex: ReadonlyMap<string, string>; // repo → project name
}

/** Result of a reload diff */
export interface ReloadDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

/** Token_Store interface — injected as a dependency */
export interface TokenStore {
  /** Get the PAT for a project by name. Returns undefined if not found. */
  getToken(projectName: string): Secret | undefined;

  /** Get the full ProjectEntry for a project. */
  getProject(projectName: string): ProjectEntry | undefined;

  /** Reverse lookup: find the project name that contains a given repo. */
  findProjectByRepo(repo: string): string | undefined;

  /** Get the current TokenMap snapshot (for CLI status, health checks). */
  getTokenMap(): TokenMap;

  /** Trigger a reload from disk. Returns true if the map was replaced. */
  reload(): boolean;

  /** Register fs.watch + polling fallback. Call once at startup. */
  startWatching(): void;

  /** Stop fs.watch and polling. Call on shutdown. */
  stopWatching(): void;
}
```

**`startWatching` behavior:**
- `startWatching` registers an `fs.watch` listener AND a 30-second `setInterval` polling timer
- A `reloadInProgress` boolean prevents concurrent reloads from the two sources
- After every successful reload, the existing `fs.watch` listener is closed and re-registered to handle atomic-rename rotations (which invalidate the original inode watch)
- After every reload, `evaluateExpiryWarnings` is re-run against the new map
- `stopWatching` is idempotent: closes watcher, clears polling timer, sets `reloadInProgress` to `true` to suppress in-flight reload completion. Safe to call from SIGTERM handlers.

**Exported pure functions** (for Tier 1 testing):

```typescript
/** Parse and validate tokens.json content. Throws FatalError on invalid input. */
export function parseTokensFile(content: string): TokenMap;

/** Validate a single project entry. Throws FatalError on invalid input. */
export function validateProjectEntry(name: string, entry: unknown): ProjectEntry;

/** Validate the repo-uniqueness invariant across all projects. */
export function validateRepoUniqueness(projects: Map<string, ProjectEntry>): void;

/** Compute the diff between two TokenMaps. */
export function computeReloadDiff(oldMap: TokenMap, newMap: TokenMap): ReloadDiff;

/** Evaluate expiry warnings for all projects. Returns array of warning entries. */
export function evaluateExpiryWarnings(projects: ReadonlyMap<string, ProjectEntry>, now: Date): ExpiryWarning[];

/** Expiry warning entry returned by evaluateExpiryWarnings */
export interface ExpiryWarning {
  projectName: string;
  expiresAt: Date;
  daysUntilExpiry: number;
  level: 'warn' | 'error';
  alert: boolean; // true for ≤7 days (maps EARS "alert" to warn+alert)
  message: string;
}

/** Validate a project name against the allowed pattern. */
export function isValidProjectName(name: string): boolean;

/** Validate a repo string against the owner/repo pattern. */
export function isValidRepoString(repo: string): boolean;

/** Serialize a TokenMap back to the tokens.json schema (for round-trip testing). */
export function serializeTokenMap(map: TokenMap): string;
```

**Factory function**:

```typescript
export function createTokenStore(deps: {
  tokensFilePath: string;
  log: Logger;
  fallbackToken?: string; // from GITHUB_TOKEN env var
}): TokenStore;
```

### Config Changes (`src/config.ts`)

Add `credentialMode` to `AgentRouterConfig`:

```typescript
export interface AgentRouterConfig {
  // ... existing fields ...
  credentialMode: 'env' | 'mcp';
}
```

Default value: `"env"` (Track 1). Validated during config loading. The field is optional in the JSON file — omitting it defaults to `"env"`.

### Session Manager Changes (`src/session-mgr.ts`)

The `createSession` method gains project resolution logic:

```typescript
export interface SessionHandle {
  // ... existing fields ...
  boundProject: string;        // project name
  boundProjectRepos: string[]; // repos in the bound project
}
```

Session creation flow:
1. Extract target repo from prompt (using existing repo extraction or explicit `repo` parameter)
2. Call `tokenStore.findProjectByRepo(repo)` to resolve `Bound_Project`
3. If not found → reject session with error
4. If `credentialMode === 'env'` → inject `GITHUB_TOKEN` into subprocess env
5. If `credentialMode === 'mcp'` → omit `GITHUB_TOKEN` from subprocess env
6. Record `boundProject` and `boundProjectRepos` in session metadata

**`read_repos` resolution:**
- The `read_repos` directive is parsed by `SessionManager` from the session creation request — either as an explicit `read_repos: string[]` argument or as a YAML frontmatter block at the top of the prompt
- Parsed `read_repos` is stored in session metadata as `bound_project_read_repos`
- The MCP server's authorization check for read methods consults this field via the IPC response from `get_session_project` (which includes a `read_repos` field)

### MCP Server Changes (`src/mcp-server.ts`)

Two new tools added to `MCP_TOOLS` array:

```typescript
// github_http_forward tool definition
{
  name: 'github_http_forward',
  description: 'Forward an HTTP request to the GitHub API with project-scoped authentication.',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE' },
      path: { type: 'string', description: 'GitHub API path (e.g., /repos/owner/name/pulls)' },
      body: { type: 'string', description: 'Request body as JSON string (optional)' },
      repo: { type: 'string', description: 'Repository in owner/repo format' },
    },
    required: ['method', 'path', 'repo'],
  },
}

// git_credential tool definition
{
  name: 'git_credential',
  description: 'Get git HTTPS credentials for a repository.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Repository in owner/repo format' },
    },
    required: ['repo'],
  },
}
```

The MCP server resolves the session's Bound_Project via a new daemon socket IPC operation (`get_session_project`), then uses a second IPC operation (`get_token`) to obtain the PAT. This keeps the MCP subprocess stateless with respect to credentials.

**MCP IPC model:**
- MCP subprocess receives `session_id` via `AGENT_ROUTER_SESSION_ID` env var at spawn time
- At MCP server startup, it issues a SINGLE `get_session_project` IPC call to resolve and CACHE its session's `Bound_Project` and `bound_project_repos` for the session's lifetime (these don't change)
- Per-tool-call, the MCP server issues `get_token { project }` to obtain the PAT (NOT cached — so token rotation propagates immediately)
- `get_token` response includes `{ token: string, expires_at: string | null }` for forward compatibility with future GitHub App backend (`expires_at` is always `null` in this spec)
- Daemon validates IPC caller is its own child subprocess via `SO_PEERCRED` on the Unix socket

New daemon socket IPC operations:

```typescript
// Request: { op: 'get_session_project', session_id: string }
// Response: { project: string, repos: string[], read_repos: string[] } | { error: string }

// Request: { op: 'get_token', project: string }
// Response: { token: string, expires_at: string | null } | { error: string }
```

### Request Validation (`github_http_forward`)

The MCP server validates all incoming tool arguments before forwarding:

1. **Method**: Must be one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
2. **Path**: Must start with a known GitHub API prefix (`/repos/`, `/orgs/`, `/users/`, `/gists/`, `/search/`, `/notifications/`, `/issues/`, `/pulls/`)
3. **Body size**: Maximum 10 MB
4. **Repo format**: Must match `^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`
5. **Write authorization**: For write methods (POST, PUT, PATCH, DELETE), the repo must be in the session's Bound_Project repo list
6. **Read authorization**: For GET, public repos are allowed unauthenticated; private repos outside the Bound_Project require explicit `read_repos` declaration

### Webhook Handler Changes (`src/server.ts`)

The webhook handler gains a `TokenStore` dependency for reverse-lookup when making outgoing GitHub API calls:

```typescript
export function createApp(deps: {
  webhookSecret: string;
  db: Database;
  enqueue: (event: QueuedEvent) => void;
  log: Logger;
  tokenStore: TokenStore; // required — always present, including in fallback mode (Req 1.5)
}): Hono;
```

> **Note:** The `Token_Store` is always present, including in fallback mode (Req 1.5), where it contains a synthetic single-project entry derived from the legacy `GITHUB_TOKEN` env var.

### CLI Subcommand (`tokens status`)

A new CLI operation exposed via the daemon socket:

```typescript
// Request: { op: 'tokens_status', check?: boolean }
// Response: { projects: Array<{ name, repoCount, expiryStatus, validationResult? }> }
```

**CLI daemon-offline fallback:**
- CLI first attempts the daemon socket
- If daemon is unreachable (socket missing, connection refused, timeout > 2 seconds), CLI falls back to reading `tokens.json` directly
- Reports project metadata without live `--check` results when daemon is offline
- Output includes a `Source:` header line: `Source: daemon (live)` or `Source: file (daemon offline; --check unavailable)`
- Cache file is written by CLI subcommand process with mode 600. Daemon does not read or write the cache file.

The `--check` flag triggers live GitHub API validation (`GET /user`) for each token. Results are cached for 1 hour in `$AGENT_ROUTER_HOME/.token-check-cache.json`.

### Startup Integration (`src/index.ts`)

Startup sequence additions:
1. After config load, create `TokenStore` with `tokensFilePath` and optional `GITHUB_TOKEN` fallback
2. Register `SIGHUP` handler that calls `tokenStore.reload()`
3. Call `tokenStore.startWatching()` for fs.watch + polling
4. Pass `tokenStore` to `SessionManager`, `createApp`, and `CliServer`
5. On shutdown, call `tokenStore.stopWatching()`

## Data Models

### Tokens File Schema (`tokens.json`)

```json
{
  "projects": {
    "my-project": {
      "token": "github_pat_...",
      "repos": ["owner/repo-a", "owner/repo-b"],
      "expires_at": "2026-08-15T00:00:00Z"
    },
    "another-project": {
      "token": "github_pat_...",
      "repos": ["org/repo-c"],
      "expires_at": "2026-09-01T00:00:00Z"
    }
  }
}
```

**Validation rules:**
- Top-level must be an object with a `projects` key
- `projects` is a `Record<string, ProjectEntry>`
- Project name: non-empty ASCII, matches `^[a-zA-Z0-9._-]+$`
- `token`: non-empty string
- `repos`: non-empty array, each element matches `^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`
- `expires_at`: optional, valid ISO 8601 date-time string
- No repo may appear in more than one project (global uniqueness)

### Session Metadata Extension

The existing `SessionMeta` in `session-files.ts` gains:

```typescript
export interface SessionMeta {
  // ... existing fields ...
  bound_project?: string;
  bound_project_repos?: string[];
  bound_project_read_repos?: string[];
  credential_mode?: 'env' | 'mcp';
}
```

These fields are written at session creation and are immutable for the session's lifetime.

**Field presence rules:**
- Fields are optional in JSON schema for backward compatibility with pre-spec session metadata files
- At session creation in this spec, all fields are written unconditionally — write code never produces a session without them
- Read code that encounters a session metadata file with these fields absent treats the session as legacy and does NOT promote it to either credential mode

### Token Check Cache

```json
{
  "checked_at": "2026-07-10T12:00:00Z",
  "results": {
    "my-project": { "valid": true, "checked_at": "2026-07-10T12:00:00Z" },
    "another-project": { "valid": false, "error": "401 Unauthorized", "checked_at": "2026-07-10T12:00:00Z" }
  }
}
```

Cached for 1 hour. Stored at `$AGENT_ROUTER_HOME/.token-check-cache.json`.

### Expiry Warning Tiers

| Days until expiry | Log level | Message pattern |
|---|---|---|
| ≤ 14 | `warn` | `Token for project "X" expires in N days` |
| ≤ 7 | `warn` (alert) | `Token for project "X" expires in N days — rotate soon` |
| ≤ 2 | `error` | `Token for project "X" expires in N days — immediate rotation required` |
| ≤ 0 (expired) | `error` | `Token for project "X" has expired — still serving but may fail` |

Note: The requirements specify `alert`-level for ≤7 days, but the existing logger supports `debug`, `info`, `warn`, `error`. We map `alert` to `warn` with an `alert: true` field in the structured log entry to distinguish it from the ≤14-day warning.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Tokens file round-trip

*For any* valid `TokenMap` (with valid project names, non-empty tokens, valid repo strings, and optional valid ISO 8601 expiry dates), serializing the `TokenMap` to JSON via `serializeTokenMap` and then parsing it back via `parseTokensFile` SHALL produce a `TokenMap` with the same project keys, token values, repo lists, and expiry dates.

**Validates: Requirements 9.5**

### Property 2: Project entry validation

*For any* project entry object, `validateProjectEntry` SHALL accept it if and only if the `token` field is a non-empty string, the `repos` array is non-empty, and every element of `repos` matches the pattern `^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`.

**Validates: Requirements 1.2, 9.3**

### Property 3: Repo uniqueness invariant

*For any* set of project entries, `validateRepoUniqueness` SHALL throw a `FatalError` if and only if at least one `owner/repo` string appears in more than one project's `repos` array. The error message SHALL identify the duplicate repo and the conflicting project names.

**Validates: Requirements 1.3, 9.4**

### Property 4: Repo-to-project lookup

*For any* valid `TokenMap` and any repo string `r`, `findProjectByRepo(r)` SHALL return the project name `p` such that `r` is in `p`'s repos list, or `undefined` if no project contains `r`. Because the repo uniqueness invariant holds, at most one project can match.

**Validates: Requirements 3.1, 3.5, 8.1**

### Property 5: Token lookup by project

*For any* valid `TokenMap` and any project name `p`, `getToken(p)` SHALL return the token string associated with `p` if `p` exists in the map, or `undefined` otherwise.

**Validates: Requirements 3.3**

### Property 6: Write authorization enforcement

*For any* session with a `Bound_Project` containing a set of repos `R`, and any repo `r` and HTTP method `m`: if `m` is a write method (POST, PUT, PATCH, DELETE), the authorization check SHALL permit the operation if and only if `r` is in `R`.

**Validates: Requirements 3.4, 5.2, 6.2**

### Property 7: Reload diff correctness

*For any* two valid `TokenMap` instances `old` and `new`, `computeReloadDiff(old, new)` SHALL produce a `ReloadDiff` where: (a) every project in `new` but not in `old` is in `added`, (b) every project in `old` but not in `new` is in `removed`, (c) every project in both where the token or repos changed is in `changed`, (d) every project in both where token and repos are identical is in `unchanged`, and (e) the union of `added`, `removed`, `changed`, and `unchanged` equals the union of all project names from both maps.

**Validates: Requirements 2.4, 11.4**

### Property 8: Token redaction in logs

*For any* token string `t` (non-empty) and any structured log entry produced during a credential operation (token injection, git_credential call, github_http_forward call), the serialized log line SHALL NOT contain `t` as a substring.

**Validates: Requirements 4.2, 6.5, 11.2**

### Property 9: Project name validation

*For any* string `s`, `isValidProjectName(s)` SHALL return `true` if and only if `s` is non-empty and matches the pattern `^[a-zA-Z0-9._-]+$`.

**Validates: Requirements 9.2**

### Property 10: Expiry warning tiers

*For any* project entry with an `expires_at` date and a reference time `now`, `evaluateExpiryWarnings` SHALL emit: an `error`-level warning if the token is expired or expires within 2 days, a `warn`-level alert if it expires within 7 days, a `warn`-level warning if it expires within 14 days, and no warning if it expires in more than 14 days.

**Validates: Requirements 12.1, 12.2**

### Property 11: HTTP method validation

*For any* string `s`, the method validator SHALL accept `s` if and only if `s` is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.

**Validates: Requirements 10.2**

### Property 12: GitHub API path validation

*For any* string `s`, the path validator SHALL accept `s` if and only if `s` starts with one of the known GitHub API prefixes (`/repos/`, `/orgs/`, `/users/`, `/gists/`, `/search/`, `/notifications/`, `/issues/`, `/pulls/`).

**Validates: Requirements 10.1**

### Property 13: Request body size enforcement

*For any* string `body`, the body size validator SHALL reject `body` if and only if `Buffer.byteLength(body) > 10 * 1024 * 1024` (10 MB).

**Validates: Requirements 10.3**

### Property 14: Credential log entry structure

*For any* credential tool call (github_http_forward or git_credential) that completes (success or error), the structured log entry SHALL contain all of: `tool_name`, `repo`, `project`, `session_id`, `status`, and `duration_ms`.

**Validates: Requirements 11.1**

### Property 15: Token check cache validity

*For any* cache entry with a `checked_at` timestamp and a query time `now`, the cache entry SHALL be considered valid if and only if `now - checked_at < 3600000` (1 hour in milliseconds).

**Validates: Requirements 12.5**

## Error Handling

### Error Classes

The feature uses the existing error class hierarchy:

- **FatalError**: Thrown during startup for unrecoverable configuration errors:
  - Missing tokens file with no `GITHUB_TOKEN` fallback (Req 1.6)
  - Invalid JSON or schema validation failure in tokens file (Req 1.7, 9.6)
  - Duplicate repo across projects (Req 1.3)
- **EventError**: Not directly used by this feature (webhook events continue to use existing error handling)
- **WakeError**: Not directly used by this feature

### Runtime Error Handling

| Scenario | Behavior |
|---|---|
| Token file missing on reload | Retain old map, log warning (Req 2.6) |
| Token file invalid on reload | Retain old map, log warning (Req 2.5) |
| Bound_Project not found for session | Reject session creation with error (Req 4.3) |
| Token lookup fails during MCP tool call | Return error result to agent, log warning (Req 5.5, 6.4) |
| Repo not in any project for webhook | Log warning, skip outgoing API call (Req 8.3) |
| Cross-project write attempt | Return error result to agent (Req 3.7) |
| Unknown repo (not public, not in any project) | Reject session creation (Req 3.8) |
| Upstream GitHub API timeout (30s) | Return error result to agent (Req 10.4) |
| Request body exceeds 10 MB | Return error result to agent (Req 10.3) |
| Invalid HTTP method | Return error result to agent (Req 10.2) |
| Invalid API path prefix | Return error result to agent (Req 10.1) |

### Graceful Degradation

- Token file permissions warning (mode > 600) is non-fatal — daemon continues with a warning (Req 1.4)
- Expired tokens are still served with an error-level log — GitHub may accept them briefly after expiry (Req 12.2)
- `fs.watch` failure falls back to 30-second polling (Req 2.2)
- `GITHUB_TOKEN` env var fallback when tokens file is missing (Req 1.5)

## Testing Strategy

### Property-Based Tests (Tier 1)

Property-based tests use `fast-check` with a minimum of 100 iterations per property. All properties from the Correctness Properties section are implemented as PBT tests in `test/tier1/token-store.test.ts`.

**Generators needed:**
- `arbProjectName`: ASCII string matching `^[a-zA-Z0-9._-]+$`
- `arbRepoString`: Two `arbProjectName` strings joined by `/`
- `arbToken`: Non-empty string (prefixed with `github_pat_` for realism)
- `arbExpiresAt`: Optional valid ISO 8601 date-time string
- `arbProjectEntry`: `{ token: arbToken, repos: non-empty array of arbRepoString, expiresAt?: arbExpiresAt }`
- `arbTokenMap`: Map of `arbProjectName → arbProjectEntry` with globally unique repos
- `arbHttpMethod`: One of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
- `arbGitHubPath`: String starting with a known API prefix

**Tag format:** Each property test is tagged with a comment:
```typescript
// Feature: auth-credential-proxy, Property N: <property title>
```

**Property 8 (Token redaction) testing note:** Property 8 is tested both as a PBT (generating random token strings and verifying they never appear in serialized log output) and as a structural invariant via the `Secret` type — `Secret.toString()`, `Secret.toJSON()`, and `Secret[Symbol.for('nodejs.util.inspect.custom')]()` all return `'[REDACTED]'`, so any code path that serializes a `Secret` without calling `.reveal()` is safe by construction.

### Unit Tests (Tier 1)

Example-based unit tests in `test/tier1/token-store.test.ts` cover:
- Fallback to `GITHUB_TOKEN` when tokens file is missing (Req 1.5)
- FatalError when both tokens file and env var are missing (Req 1.6)
- FatalError on invalid JSON (Req 1.7)
- Reload with invalid file retains old map (Req 2.5)
- Reload with deleted file retains old map (Req 2.6)
- Session rejection for unknown repo (Req 3.8)
- Cross-project write rejection (Req 3.7)
- Config validation for credentialMode (Req 4.4)
- Token lookup failure during MCP tool call (Req 5.5, 6.4)
- Webhook reverse lookup for unknown repo (Req 8.3)
- CLI tokens status output format (Req 12.3)

### Component Tests (Tier 2)

Component tests in `test/tier2/` exercise the full daemon with mock surfaces:

- **`test/tier2/token-store.test.ts`**: Token_Store with real filesystem (temp dir), SIGHUP handling, fs.watch/polling
- **`test/tier2/credential-mcp.test.ts`**: MCP credential tools against mock GitHub API server, verifying:
  - Token injection in Authorization header
  - Read/write split enforcement
  - Response passthrough
  - Timeout handling
  - Body size enforcement
- **`test/tier2/ipc-contract.test.ts`**: IPC contract test between real daemon and real MCP server subprocess, verifying:
  - `get_session_project` returns correct `Bound_Project`, `repos`, and `read_repos`
  - `get_token` returns a valid token response with `expires_at` field
  - `SO_PEERCRED` validation rejects non-child callers (where platform supports it)
- **`test/tier2/session-credential.test.ts`**: Session creation with both credential modes, verifying:
  - `GITHUB_TOKEN` present in env for `credentialMode: "env"`
  - `GITHUB_TOKEN` absent in env for `credentialMode: "mcp"`
  - Bound_Project recorded in session metadata
- **`test/tier2/webhook-token.test.ts`**: Webhook handler using Token_Store reverse lookup for outgoing API calls

### Integration Tests (Tier 3)

Real end-to-end tests in `test/tier3/` (requires real GitHub PATs):
- Full token injection flow: daemon → agent → GitHub API
- MCP credential tool forwarding to real GitHub API
- Token rotation during active session:
  - **env-mode rotation**: active session retains old token (injected at spawn), new sessions pick up new token
  - **mcp-mode rotation**: active session picks up new token on next MCP tool call (not cached)
- CLI `tokens status --check` against real GitHub

### Test Harness Extensions

New mock surfaces added to `test/harness/`:
- **Mock GitHub API server**: Extended to validate Authorization headers on incoming requests and return canned responses. Reusable by future specs.
- **Mock daemon socket**: Simulates `get_session_project` and `get_token` IPC operations for MCP server testing.

### Build Order

Tests are written before implementation (test-first). The build order follows dependency order:
1. Pure validation functions + PBT (Tier 1)
2. Token_Store creation + reload (Tier 1 + Tier 2)
3. Config changes (Tier 1)
4. Session manager changes (Tier 2)
5. MCP credential tools (Tier 2)
6. Webhook token lookup (Tier 2)
7. CLI tokens status (Tier 2)
8. Expiry monitoring (Tier 1)
9. Tier 3 tests come last, after all Tier 1/2 steps are green

### Forward Compatibility

The `Bound_Project` concept, the `Token_Store` interface, and the MCP tool schemas (`github_http_forward`, `git_credential`) are designed to be retained when a GitHub App credential backend is added in a future spec. The App backend would implement the same `TokenStore` interface, returning short-lived installation tokens instead of long-lived PATs. The MCP tool input/output schemas remain unchanged — only the credential source behind `getToken()` changes.


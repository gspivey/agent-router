# Design Document

## Overview

This design corrects three defects in the shipped MCP credential surface without altering its
architecture. The credential path is: agent → MCP server (`src/mcp-server.ts`) → daemon socket
(`src/cli-server.ts`) → Token_Store (`src/token-store.ts`). Authorization and token injection
already happen daemon-side; the agent never holds a raw PAT in MCP mode.

The three changes are surgical:

1. **Path/repo cross-check** — a new pure validator in `src/credential-validators.ts`, called
   from `github_http_forward` after the existing path-prefix check.
2. **Session-derived `get_token`** — change the `get_token` IPC op in `src/cli-server.ts` to
   accept `session_id` and resolve the project from the session's `bound_project`; update both
   MCP callers to pass `session_id`.
3. **Documented path separation** — no code change beyond (2); the operator `tokens status`
   path and the MCP `get_token` path are already distinct. This document records the separation
   and why `SO_PEERCRED` is not used.

## Architecture

### Current credential flow (unchanged shape)

```
agent ──JSON-RPC──▶ MCP_Server ──sendToDaemon──▶ Daemon_Socket ──▶ Token_Store
                        │                             │
                        │  get_session_project        │  resolves Bound_Project
                        │  get_token                  │  reveals Scoped_PAT
                        ▼                             ▼
                   forwards to GitHub with Bearer <token>
```

Two caller classes share `Daemon_Socket`:

- **Operator CLI** (`bin/`): `tokens status`, `cron list`, `new_session`, etc. Trusted human.
- **Daemon-child MCP** (`src/mcp-server.ts`): `get_session_project`, `get_token`,
  `register_pr`, `merge_pr`, `session_status`, `complete_session`, `register_worktree`.

`get_token` moves fully into the second class: after the fix it is meaningful only with a
`session_id`, so an operator invoking it by hand gains nothing (no project is served without a
matching active session). `tokens_status` stays in the first class and never needs session
context. This is the "separate code paths on a shared socket" property Requirement 7 documents.
`SO_PEERCRED` is intentionally not used: both caller classes are local processes that
legitimately connect to the same socket, and peer-credential checks cannot distinguish the
daemon's own MCP children from the operator's CLI in a useful way here. Authorization is instead
enforced by *what each op requires* — `get_token` requires a valid active session's
`bound_project`.

## Components and Interfaces

### 1. `validatePathMatchesRepo` (new, `src/credential-validators.ts`)

A pure function alongside the existing validators, following the same `ValidationError | null`
contract.

```typescript
/**
 * Ensure the owner/repo encoded in a github_http_forward path matches the
 * authorized repo argument, and that the path has no traversal/injection tricks.
 *
 * Rejects (path_invalid) if path component contains "..", "//", an absolute URL ("://"),
 * "@", or any URL-encoded dot sequence ("%2e"/"%2E") — checked on the raw string to prevent
 * WHATWG URL normalization from bypassing the check.
 * Returns null if no /repos/{owner}/{repo} segment is present (non-repo paths
 * like /search/, /orgs/, /users/ do not need a cross-check).
 * Rejects (repo_unauthorized) if the extracted owner/repo != repo (case-insensitive).
 * Returns null when the path's owner/repo matches repo.
 */
export function validatePathMatchesRepo(
  path: string,
  repo: string,
): ValidationError | null;
```

**Algorithm:**

1. Strip query string from `path` (split on `?`, take first part) before all checks.
2. Reject `path_invalid` if the path component contains `..`, `//`, `://`, `@`, or any
   URL-encoded dot sequence (`%2e` or `%2E`, case-insensitive). These checks are on the raw
   string to prevent WHATWG URL normalization from turning `%2e%2e` into `..` after validation.
3. Split path on `/`, drop empty segments. Find the index of the segment equal to `repos`.
   If absent, or fewer than two segments follow it, **return null** (no cross-check needed for
   non-repo paths like `/search/`, `/orgs/`, `/users/`).
4. Take the two segments following `repos` as `owner` and `name`; form `owner/name`.
5. Lowercase both `owner/name` and `repo`; if unequal, reject `repo_unauthorized`.
6. Otherwise return null.

Notes:
- The `//` check runs on the raw `path` before splitting, catching `/repos//x` and protocol
  slashes; the `://` check is redundant with `//` but stated explicitly for intent and to guard
  against future changes to the `//` rule.
- The function does not re-validate the prefix; `validatePathPrefix` already ran. It only
  concerns itself with the owner/repo cross-check and traversal safety.
- Only the *first* `/repos/{owner}/{repo}` is authoritative. GitHub paths that mention a second
  repo (e.g. cross-repo compare) are out of scope and rejected by the mismatch rule if their
  first repo segment matches but is not the intended target; this is acceptably conservative.

### 2. `github_http_forward` handler change (`src/mcp-server.ts`)

Insert the cross-check immediately after the existing `validatePathPrefix` block and before
token fetch:

```typescript
// (existing) validate path prefix
const pathErr = validatePathPrefix(path);
if (pathErr) { /* log path_invalid; return isError */ }

// (new) cross-check path's owner/repo against the authorized repo arg
const matchErr = validatePathMatchesRepo(path, repo);
if (matchErr) {
  const code = matchErr.code === 'repo_unauthorized' ? 'repo_unauthorized' : 'path_invalid';
  logCredentialCall('github_http_forward', repo, '', startTime, 'error', code);
  writeResponse(makeSuccessResponse(req.id, {
    content: [{ type: 'text', text: JSON.stringify({ error: matchErr.message, code: matchErr.code }) }],
    isError: true,
  }));
  return;
}
```

Placing it before token fetch means an unauthorized cross-repo call never causes a token to be
retrieved. `git_credential` is unaffected — it takes only `repo`, builds no path, and already
requires the repo to be in `bound_project_repos`.

### 3. `get_token` IPC op change (`src/cli-server.ts`)

Before:

```typescript
async get_token(req) {
  const project = req['project'];               // caller-supplied — the flaw
  if (!project) return { error: 'Missing ... "project" parameter' };
  const secret = tokenStore.getToken(project);
  ...
}
```

After:

```typescript
async get_token(req) {
  const sessionId = req['session_id'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { error: 'Missing or empty "session_id" parameter' };
  }
  if (!tokenStore) return { error: 'Token store not configured' };

  const handle = sessionMgr.getActiveSession(sessionId);
  if (!handle) return { error: `Session not found: ${sessionId}` };
  if (!handle.boundProject) return { error: `Session "${sessionId}" has no bound project` };

  const project = handle.boundProject;
  const secret = tokenStore.getToken(project);
  if (!secret) return { error: `No token found for project "${project}"` };

  const projectEntry = tokenStore.getProject(project);
  const expiresAt = projectEntry?.expiresAt ? projectEntry.expiresAt.toISOString() : null;
  return { token: secret.reveal(), expires_at: expiresAt };
}
```

The project is now derived exclusively from the trusted session handle (the same source
`get_session_project` already uses). A caller-supplied `project` is ignored.

### 4. MCP callers pass `session_id` (`src/mcp-server.ts`)

Both token fetches change from `{ op: 'get_token', project: sessionProject.project }` to
`{ op: 'get_token', session_id: sessionId }`. The MCP server already holds the authenticated
`sessionId` for its lifetime. `getSessionProject()` (which calls `get_session_project`) is still
used for authorization; only the token fetch changes its argument.

## Data Models

No schema changes. `SessionMeta.bound_project` already exists and is the source of truth for the
served project. The `get_token` request shape changes from `{ project }` to `{ session_id }`;
the response shape (`{ token, expires_at }` or `{ error }`) is unchanged.

## Error Handling

- `validatePathMatchesRepo` returns `ValidationError` with `code: 'path_invalid'` for
  traversal/injection attempts (`..`, `%2e`/`%2E` URL-encoded dots, `//`, `://`, `@`) and
  `code: 'repo_unauthorized'` for owner/repo mismatch. Paths with no `/repos/` segment return
  null (no error). The handler maps these to the existing credential log `error_code` union
  (`path_invalid`, `repo_unauthorized`) — no new error codes.
- `get_token` returns `{ error }` for missing session_id, unknown/inactive session, missing
  bound project, missing token, or unconfigured store. None of these leak a token.
- No new error classes. `FatalError` / `EventError` / `WakeError` semantics are untouched.

## Testing Strategy

### Tier 1 (`test/tier1/credential-validators.test.ts`)

- Unit cases for `validatePathMatchesRepo`: exact match; case-insensitive match; owner mismatch;
  repo mismatch; `..` traversal; `//`; absolute URL (`https://…`); `@` prefix
  (`/repos/@evil/x`); path with no `/repos/` segment; `/repos/` with only one following segment.
- Property test (fast-check, ≥100 iterations): for random valid `owner/repo`, a path of the form
  `/repos/{owner}/{repo}/...suffix` accepts iff the arg equals `owner/repo` (case-insensitive),
  and any injected `..`/`//`/`@`/`://` forces `path_invalid`.

### Tier 2

- `test/tier2/credential-mcp.test.ts`: add cases asserting `github_http_forward` rejects a call
  where `path`'s owner/repo differs from `repo` (expect `repo_unauthorized`, no upstream request
  issued, no `get_token` IPC issued), and still succeeds when they match.
- `test/tier2/ipc-contract.test.ts`: change `get_token` cases to pass `session_id`; assert a
  known active session returns its bound project's token+expiry, and that unknown/inactive
  session or missing `session_id` returns an error with no token.
- Update the mock daemon socket (`test/harness/mock-daemon-socket.ts`) and any Tier 2 helpers so
  `get_token` is keyed by `session_id` → project rather than by a supplied `project`.

### Tier 3

Unchanged; not exercised for these fixes.

## Migration / Compatibility

- The `get_token` request contract changes from `{ project }` to `{ session_id }`. The only
  callers are the MCP server (updated here) and tests (updated here); there is no external
  consumer, so this is a safe in-repo contract change, not a public breaking change.
- No config, filesystem-layout, or `meta.json` schema changes. No data migration.

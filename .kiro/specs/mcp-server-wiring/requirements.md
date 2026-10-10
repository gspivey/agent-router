# Requirements — MCP Server Wiring

## Introduction

The agent-router daemon spawns an ACP-compatible coding agent (Kiro) per session and
drives it through the Agent Client Protocol (JSON-RPC 2.0 over stdio). A complete MCP
server already exists in `src/mcp-server.ts`, exposing eight daemon tools —
`session_status`, `register_pr`, `merge_pr`, `complete_session`, `github_http_forward`,
`git_credential`, `register_worktree`, and `report_outcome` — over a standalone stdio
entry point that reads `AGENT_ROUTER_SESSION_ID` and `AGENT_ROUTER_SOCKET` from its
environment.

That server is never reachable by any session. In `src/acp.ts`, both `newSession` and
`newSessionWithPrompt` call the ACP `session/new` method with `mcpServers: []`
hardcoded, and the resume path (`loadSession`) passes no MCP servers at all. As a
result, every session runs without the daemon's tools, forcing agents to shell out to
`git`/`gh` for operations the MCP tools exist to handle safely (branch-protected merges,
project-scoped credentials, structured outcome reporting).

This feature wires the existing MCP server into every ACP session automatically at
session creation and resumption, so agents receive all eight tools with no manual
`~/.kiro/settings/mcp.json` edit. The ACP `session/new` `mcpServers` field takes an
**array** of stdio server entries (per the Agent Client Protocol spec), which is a
different shape from the kiro `mcp.json` object format used by
`scripts/install-mcp-config.sh`. The wiring must use the ACP array shape.

### Scope

In scope:
- Forwarding a per-session MCP server entry through `session/new` and `session/load`.
- Constructing that entry in the session manager with the correct env, command, and
  args that work in both dev (`tsx`) and compiled (`node`) execution modes.
- Fixing the `socketPath` declaration ordering in `src/index.ts` so the daemon socket
  path is available when the session manager is constructed.
- Adding an `agent-router-mcp` bin entry to `package.json`.
- Auto-approving the eight MCP tools' permission requests on the ACP client side.

Out of scope:
- Changing the MCP server's tool implementations or wire protocol.
- Changing the kiro `mcp.json` object format or the functional behavior of
  `scripts/install-mcp-config.sh` (the manual install path remains for users who want
  it; only a brief legacy comment is added to its header per R10.3)
- Adding new npm dependencies.
- Per-repo MCP server selection or tool allowlisting beyond the fixed eight tools.

### Terminology

- **ACP MCP server entry** — one element of the `session/new` `mcpServers` array. A
  stdio server descriptor with `name`, `command`, `args`, and `env`, where `env` is an
  `Array<{ name: string; value: string }>` (NOT a `Record`). This is the Agent Client
  Protocol shape, distinct from the kiro `mcp.json` object format.
- **Daemon socket** — the Unix domain socket at `$AGENT_ROUTER_HOME/sock` used for
  CLI-to-daemon and MCP-server-to-daemon IPC. The MCP server reads its path from
  `AGENT_ROUTER_SOCKET`.
- **MCP server entry point** — `src/mcp-server.ts` (dev) / its compiled `.js` form,
  whose standalone block starts the server when run directly.

## Requirements

### Requirement 1 — Forward MCP servers through `session/new`

**User Story:** As the daemon, I want to pass a list of MCP server entries to the ACP
`session/new` call, so that the spawned agent connects to the daemon's MCP server and
receives its tools.

#### Acceptance Criteria

1. WHEN `newSession(cwd, mcpServers)` is called with a non-empty `mcpServers` array THEN
   the ACP client SHALL include that exact array as the `mcpServers` field of the
   `session/new` JSON-RPC params.
2. WHEN `newSessionWithPrompt(cwd, prompt, mcpServers)` is called with a non-empty
   `mcpServers` array THEN the ACP client SHALL include that exact array as the
   `mcpServers` field of the `session/new` JSON-RPC params, preserving the existing
   immediate-prompt-after-session behavior (no await/microtask gap between `session/new`
   and `session/prompt`).
3. WHEN `newSession` or `newSessionWithPrompt` is called WITHOUT a `mcpServers` argument
   (or with `undefined`) THEN the ACP client SHALL send `mcpServers: []`, preserving the
   pre-feature behavior for existing callers.
4. The `mcpServers` parameter SHALL be the final, optional parameter on both
   `newSession` and `newSessionWithPrompt` so that existing call sites compile unchanged.
5. Each MCP server entry forwarded to `session/new` SHALL conform to the ACP stdio shape:
   an object with string `name`, string `command`, string-array `args`, and
   `env` as an `Array<{ name: string; value: string }>`.

### Requirement 2 — Forward MCP servers through the resume path (`loadSession`)

**User Story:** As the daemon, I want resumed sessions to receive the MCP server entry
too, so that a session restored after a daemon restart has the same tool access as a
freshly created one.

#### Acceptance Criteria

1. WHEN `loadSession(sessionId, mcpServers)` is called with a non-empty `mcpServers`
   array THEN the ACP client SHALL include that array as the `mcpServers` field of the
   `session/load` JSON-RPC params.
2. WHEN `loadSession` is called WITHOUT a `mcpServers` argument THEN the ACP client SHALL
   send `session/load` params containing `{ sessionId, cwd, mcpServers: [] }`. Both
   `cwd` and `mcpServers` are required by the ACP `session/load` schema. This
   intentionally changes the pre-feature call (which sent only `{ sessionId }`) — adding
   `cwd` is a bug fix, and `mcpServers: []` matches the schema requirement. This is a
   deliberate breaking change to the wire format, justified as a correctness fix; R8.1
   and R8.2 apply an exception for this specific call site (see Requirement 8).
3. The `mcpServers` parameter SHALL be the final, optional parameter on `loadSession`.

### Requirement 3 — Construct the per-session MCP server entry in the session manager

**User Story:** As the session manager, I want to build the MCP server entry for each
session using the session id and daemon socket, so that each agent's MCP server talks to
the daemon on behalf of the correct session.

#### Acceptance Criteria

1. The session manager SHALL accept an optional `daemonSocket` string in its options.
2. WHEN `daemonSocket` is provided AND a session is created THEN the session manager SHALL
   build exactly one MCP server entry and pass it to `newSessionWithPrompt`.
3. WHEN `daemonSocket` is provided AND a session is resumed THEN the session manager SHALL
   build exactly one MCP server entry and pass it to `loadSession`.
4. WHEN `daemonSocket` is NOT provided THEN the session manager SHALL omit the MCP server
   entry (pass no `mcpServers` / an empty array), preserving pre-feature behavior for
   tests and callers that do not wire the socket.
5. The constructed entry's `env` SHALL carry `AGENT_ROUTER_SESSION_ID` set to the
   agent-router session id and `AGENT_ROUTER_SOCKET` set to the `daemonSocket` value, each
   as an `{ name, value }` element of the `env` array. The builder is pure and reads no
   env itself; `index.ts` SHALL read `GITHUB_API_BASE_URL` from the daemon's environment
   and pass it through the `extraEnv` parameter when set, so that the MCP server's
   `github_http_forward` tool uses the same API base as the daemon.
   Additional variables MAY be forwarded via `extraEnv`.
6. The entry's `name` SHALL be a stable, recognizable identifier (e.g. `agent-router`).

### Requirement 4 — Resolve the MCP server path for dev and compiled modes

**User Story:** As the operator, I want MCP wiring to work whether the daemon runs via
`tsx` (dev) or compiled `node` (production), so that I don't have to configure paths per
environment.

#### Acceptance Criteria

1. The constructed MCP server entry's `command` and `args` SHALL launch
   `src/mcp-server.ts` (or its compiled equivalent) such that the standalone entry-point
   guard in `mcp-server.ts` recognizes it as the main module (its check matches
   filenames ending in `mcp-server.ts` or `mcp-server.js`).
2. WHEN the daemon runs under `tsx` THEN the resolved command SHALL execute the
   TypeScript entry point without requiring a separate build step.
3. WHEN the daemon runs as compiled JavaScript THEN the resolved command SHALL execute
   the compiled entry point.
4. The resolved path SHALL be computed relative to the daemon's own module location (not
   the process working directory), so it is correct regardless of the directory the
   daemon was launched from.
5. The resolution SHALL NOT depend on the agent's `cwd` passed to `session/new`.

### Requirement 5 — Fix `socketPath` ordering in `index.ts`

**User Story:** As the daemon startup sequence, I want the daemon socket path available
before the session manager is created, so that it can be passed as `daemonSocket`.

#### Acceptance Criteria

1. The `socketPath` value (`path.join(rootDir, 'sock')`) SHALL be computed before
   `createSessionManager` is called.
2. WHEN `createSessionManager` is called THEN the daemon SHALL pass the already-computed
   `socketPath` as the `daemonSocket` option.
3. The CLI server SHALL continue to use the same single `socketPath` value (no second,
   divergent computation of the socket path).
4. Reordering SHALL NOT change any other startup behavior or ordering of unrelated
   initialization steps.

### Requirement 6 — Add the `agent-router-mcp` bin entry

**User Story:** As an operator or packaging step, I want a named bin entry for the MCP
server, so that the server has a stable, documented launch target.

#### Acceptance Criteria

1. `package.json` SHALL declare a `bin` entry named `agent-router-mcp` pointing at the
   MCP server entry point.
2. The bin target SHALL start the MCP server by calling the exported
   `runMcpServerFromEnv()` function from `mcp-server.ts`, reading
   `AGENT_ROUTER_SESSION_ID` and `AGENT_ROUTER_SOCKET` from env and starting the
   JSON-RPC stdio loop.
3. Adding the bin entry SHALL NOT remove or alter the existing `agent-router` bin entry.
4. Adding the bin entry SHALL NOT introduce a new npm dependency.

### Requirement 7 — Auto-approve the eight MCP tool permission requests

**User Story:** As the daemon-driven agent, I want the daemon's MCP tools to be approved
automatically, so that unattended sessions can call them without a human clicking
"allow".

#### Acceptance Criteria

1. WHEN the agent sends a `session/request_permission` request THEN the ACP client SHALL
   respond with a `selected` outcome choosing an available option, using the existing
   preference order (`allow_always`, then `allow_once`, then the first option).
2. The auto-approval behavior SHALL cover permission requests for all eight daemon MCP
   tools (`session_status`, `register_pr`, `merge_pr`, `complete_session`,
   `github_http_forward`, `git_credential`, `register_worktree`, `report_outcome`).
3. WHEN a `session/request_permission` request offers no selectable option THEN the ACP
   client SHALL return a JSON-RPC error response (preserving existing behavior).
4. WHEN a permission request is auto-approved THEN the ACP client SHALL emit an
   observable notification into the session stream (preserving existing behavior) so the
   approval is auditable.
5. The design SHALL document whether tool-name-scoped approval is required or whether the
   existing option-based auto-approval already covers the eight tools, and justify the
   chosen approach against the current `autoApprovePermission` implementation in
   `src/acp.ts`.

### Requirement 8 — Backward compatibility and no new dependencies

**User Story:** As a maintainer, I want the wiring to be additive, so that existing
tests, callers, and the manual mcp.json install path keep working.

#### Acceptance Criteria

1. Every new parameter (`mcpServers` on `newSession`/`newSessionWithPrompt`/`loadSession`,
   `daemonSocket` on the session manager options) SHALL be optional, and omitting it SHALL
   reproduce the exact pre-feature behavior. **Exception:** `loadSession` without
   `mcpServers` will now send `{ sessionId, cwd, mcpServers: [] }` instead of the
   pre-feature `{ sessionId }`. This is a deliberate wire-format bug fix (R2.2) and is
   not covered by the backward-compatibility guarantee.
2. Existing Tier 1 and Tier 2 tests that call `newSession`, `newSessionWithPrompt`, or
   `createSessionManager` without the new arguments SHALL continue to pass without
   modification. Existing tests asserting `loadSession` params SHALL be updated to
   reflect the R2.2 bug fix (`{ sessionId, cwd, mcpServers: [] }` instead of
   `{ sessionId }`); this is an intentional, correct change.
3. The feature SHALL NOT add any entry to `dependencies` or `devDependencies` in
   `package.json`.
4. The feature SHALL NOT introduce a build step; `tsx` continues to run the daemon and
   the MCP server in dev, and `tsc --noEmit` continues to type-check.
5. `npm run typecheck` SHALL pass with `strict`, `noUncheckedIndexedAccess`, and
   `exactOptionalPropertyTypes` enabled.

### Requirement 9 — Test coverage

**User Story:** As a maintainer, I want the wiring exercised by tests at the right tiers,
so that regressions are caught without requiring real GitHub or real Kiro.

#### Acceptance Criteria

1. Tier 1 tests SHALL assert that `newSession`, `newSessionWithPrompt`, and `loadSession`
   place the provided `mcpServers` array into the correct JSON-RPC params, and that
   omitting it reproduces the pre-feature params.
2. Tier 1 tests SHALL assert the shape of the MCP server entry built by the session
   manager (name, command, args, and `env` as an `{ name, value }` array containing
   `AGENT_ROUTER_SESSION_ID` and `AGENT_ROUTER_SOCKET`).
3. Tier 2 tests SHALL run the full daemon against the fake backends and assert that a
   session created with `daemonSocket` wired causes the FakeKiro backend to receive a
   `session/new` request whose `mcpServers` array contains the agent-router entry.
4. Tier 2 tests SHALL assert the resume path forwards the MCP server entry via
   `session/load`.
5. All Tier 1 and Tier 2 tests SHALL run without network access, real API tokens, or real
   Kiro.
6. An entry-execution smoke test SHALL spawn the resolved `command`/`args` against a stub
   Unix socket, complete an MCP `initialize` handshake, and assert that `tools/list`
   returns all eight tool names. This test exercises the `import.meta.resolve('tsx/esm')`
   URL, the `argv[1]` main-module guard, and the env contract — surfaces not covered by
   unit or Tier 2 tests. The test MAY be skipped (with a logged warning) when the MCP
   entry point file is absent from the build.

### Requirement 10 — Warn when manual MCP install conflicts

**User Story:** As an operator who previously ran `install-mcp-config.sh`, I want a clear
warning at startup so I know to remove the now-redundant global entry.

#### Acceptance Criteria

1. At daemon startup, IF `~/.kiro/settings/mcp.json` (or the equivalent Kiro config path)
   contains an `agent-router` key, the daemon SHALL log a warning-level message stating
   that the manual entry is superseded by per-session wiring and should be removed.
2. The home directory path used for the check SHALL be injectable (e.g. via a config
   option or a test helper) so the check can be exercised in a Tier 1 test without
   touching the real home directory.
3. The `scripts/install-mcp-config.sh` header SHALL be updated with a brief `# Legacy`
   comment noting that per-session wiring is now the default and the script is only
   needed for environments that do not auto-wire. No other change to the script is made.

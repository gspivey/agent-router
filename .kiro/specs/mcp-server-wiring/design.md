# Design — MCP Server Wiring

## Overview

Today the MCP server (`src/mcp-server.ts`) is a fully implemented, standalone stdio
JSON-RPC server, but no session ever launches it: `src/acp.ts` hardcodes
`mcpServers: []` on every `session/new` call, and `loadSession` sends no `mcpServers` at
all. This design closes that gap by threading a single per-session MCP server entry from
the session manager, through the ACP client, into the `session/new` and `session/load`
JSON-RPC calls, using the Agent Client Protocol's `mcpServers` **array** shape.

The change is intentionally thin and additive:

- `src/acp.ts` — add an optional, trailing `mcpServers` parameter to `newSession`,
  `newSessionWithPrompt`, and `loadSession`; forward it to the JSON-RPC params; default
  to the pre-feature behavior when omitted.
- `src/session-mgr.ts` — accept an optional `daemonSocket`, build one `McpServerEntry`
  per session via a pure helper, and pass it into the ACP calls on both the create and
  resume paths.
- `src/index.ts` — move the `socketPath` declaration above `createSessionManager` and
  pass it as `daemonSocket`.
- `package.json` — add an `agent-router-mcp` bin entry.

No new dependencies, no build step, and every new parameter is optional so existing
tests and callers compile and pass unchanged.

## Grounding in current source

The design is anchored to the exact call sites in the context files:

- `src/acp.ts`
  - `newSession(cwd)` → `await sendRequest('session/new', { cwd, mcpServers: [] })`.
  - `newSessionWithPrompt(cwd, prompt)` → same `session/new` call, then a synchronously
    written `session/prompt` with no await/microtask gap (a deliberate guard against Kiro
    exiting between the two calls — this behavior must be preserved).
  - `loadSession(sessionId)` → `await sendRequest('session/load', { sessionId })`.
  - `autoApprovePermission(request)` already handles `session/request_permission`,
    selecting `allow_always` → `allow_once` → first option, writing a `selected` outcome
    response, and pushing an observable notification. This is the mechanism Requirement 7
    builds on.
- `src/session-mgr.ts`
  - `createSessionManager(deps)` takes a single deps object; `createSession` calls
    `acp.newSessionWithPrompt(process.cwd(), originalPrompt)`; `resumeSessions` calls
    `acp.loadSession(kiroSessionId)`.
- `src/index.ts`
  - `createSessionManager({...})` is constructed well before
    `const socketPath = path.join(rootDir, 'sock')` is declared for the CLI server. This
    ordering must be inverted.
  - The `acpSpawner` lambda already injects `AGENT_ROUTER_SESSION_ID` via the kiro
    adapter's `spawn`, and forwards `AGENT_ROUTER_*` env keys through `buildChildEnv`.
- `src/mcp-server.ts`
  - The standalone guard matches `process.argv[1]` ending in `mcp-server.ts` or
    `mcp-server.js`, then requires `AGENT_ROUTER_SESSION_ID` and `AGENT_ROUTER_SOCKET`
    (and optionally reads `GITHUB_API_BASE_URL`).
- `package.json`
  - `type: "module"`, `bin.agent-router → bin/agent-router.mjs`, dev via `tsx`, start via
    `node --import tsx/esm src/index.ts`.

## The ACP `mcpServers` schema (array, not object)

The ACP `session/new` (and `session/load`) `mcpServers` field is an **array** of stdio
server descriptors, per the Agent Client Protocol spec. This is different from the kiro
`mcp.json` object format produced by `scripts/install-mcp-config.sh` (which uses
`{ "mcpServers": { "<name>": { command, args, env: {…} } } }`). The ACP array shape uses
`env` as a list of `{ name, value }` pairs:

```ts
/** One entry of the ACP session/new (and session/load) `mcpServers` array. */
export interface McpServerEntry {
  /** Human-recognizable server name, e.g. "agent-router". */
  name: string;
  /** Executable to spawn (stdio transport). */
  command: string;
  /** Arguments passed to `command`. */
  args: string[];
  /** Environment variables as an ARRAY of name/value pairs (NOT a Record). */
  env: Array<{ name: string; value: string }>;
}
```

> Important: `env` is `Array<{ name, value }>`. Do not emit the kiro object form
> (`env: { AGENT_ROUTER_SOCKET: "…" }`) here — that is only valid in
> `~/.kiro/settings/mcp.json` and is handled by the separate install script, which stays
> unchanged.

The schema above is grounded in the ACP spec for stdio server entries. See
[Agent Client Protocol — Session Setup](https://agentclientprotocol.com/protocol/session-setup).

## Architecture

```
index.ts (startup)
  rootDir ─┐
           ├─> socketPath = join(rootDir, 'sock')   ← moved ABOVE session mgr
           │
           ├─> createSessionManager({ …, daemonSocket: socketPath })
           │        │
           │        ├─ createSession():
           │        │     entry = buildMcpServerEntry(sessionId, daemonSocket)
           │        │     acp.newSessionWithPrompt(cwd, prompt, entry ? [entry] : undefined)
           │        │
           │        └─ resumeSessions():
           │              entry = buildMcpServerEntry(sessionId, daemonSocket)
           │              acp.loadSession(kiroSessionId, entry ? [entry] : undefined)
           │
           └─> createCliServer({ socketPath, … })   ← same single socketPath

acp.ts
  newSession(cwd, mcpServers?)            → session/new  { cwd, mcpServers: mcpServers ?? [] }
  newSessionWithPrompt(cwd, p, mcpServers?) → session/new { cwd, mcpServers: mcpServers ?? [] } + session/prompt
  loadSession(sessionId, mcpServers?)    → session/load { sessionId, cwd: process.cwd(), mcpServers: mcpServers ?? [] }
  autoApprovePermission(request)         → selects allow_always|allow_once|first  (already present)

mcp-server.ts  ← launched per session via the entry's command/args
  reads AGENT_ROUTER_SESSION_ID, AGENT_ROUTER_SOCKET from env
  connects to daemon over the Unix socket, serves the 8 tools over stdio
```

## Components and interfaces

### 1. `src/acp.ts` — thread `mcpServers` into the JSON-RPC calls

Add the `McpServerEntry` type (exported, so the session manager and tests can reference
it). Extend the `ACPClient` interface and the implementation:

```ts
export interface ACPClient {
  initialize(): Promise<void>;
  newSession(cwd: string, mcpServers?: McpServerEntry[]): Promise<string>;
  newSessionWithPrompt(cwd: string, prompt: string, mcpServers?: McpServerEntry[]): Promise<string>;
  loadSession(sessionId: string, mcpServers?: McpServerEntry[]): Promise<void>;
  // …unchanged…
}
```

Implementation changes (minimal edits to the existing bodies):

```ts
async newSession(cwd, mcpServers) {
  const result = await sendRequest('session/new', { cwd, mcpServers: mcpServers ?? [] });
  // …unchanged…
}

async newSessionWithPrompt(cwd, prompt, mcpServers) {
  const result = await sendRequest('session/new', { cwd, mcpServers: mcpServers ?? [] });
  // …then the SAME synchronous session/prompt write, no await/microtask gap…
}

async loadSession(sessionId, mcpServers) {
  await sendRequest('session/load', {
    sessionId,
    cwd: process.cwd(),         // required by ACP session/load schema
    mcpServers: mcpServers ?? [], // required by ACP schema; matches session/new convention
  });
}
```

Rationale:
- `newSession`/`newSessionWithPrompt` default to `[]` (R1.3) to byte-match the current
  params for existing callers.
- `loadSession` always sends `cwd: process.cwd()` and `mcpServers: mcpServers ?? []`
  (R2.2 bug fix — the pre-feature call omitted both, which violates the ACP
  `session/load` schema). Using `?? []` is consistent with `session/new`, removes the
  need for a conditional spread, and is safe with `exactOptionalPropertyTypes` because
  the value is never `undefined`.
- The `newSessionWithPrompt` prompt-pipelining (synchronous `stdin.write` of
  `session/prompt` right after `session/new` resolves) is left intact — only the
  `session/new` params object changes.

### 2. `src/session-mgr.ts` — build and pass the entry

Add an optional `daemonSocket` to the deps object and a pure builder.

```ts
export function createSessionManager(deps: {
  // …existing…
  /** Unix socket path the per-session MCP server uses to reach the daemon. */
  daemonSocket?: string;
}): SessionManager { … }
```

Pure builder (exported for Tier 1 testing, consistent with the "pure functions exported
individually" convention):

```ts
/**
 * Build the ACP MCP server entry for a session, or undefined when no daemon
 * socket is configured. Pure — no I/O, no process.env reads.
 * Callers pass any extra env variables to forward (e.g. GITHUB_API_BASE_URL).
 */
export function buildMcpServerEntry(
  sessionId: string,
  daemonSocket: string | undefined,
  mcpServerPath: string,
  command: string,
  commandArgs: string[],
  extraEnv?: Array<{ name: string; value: string }>,
): McpServerEntry | undefined {
  if (daemonSocket === undefined) return undefined;
  return {
    name: 'agent-router',
    command,
    args: [...commandArgs, mcpServerPath],
    env: [
      { name: 'AGENT_ROUTER_SESSION_ID', value: sessionId },
      { name: 'AGENT_ROUTER_SOCKET', value: daemonSocket },
      ...(extraEnv ?? []),
    ],
  };
}
```

`index.ts` builds `extraEnv` before calling the session manager by reading any
variables `mcp-server.ts` is known to consume beyond the two required ones:

```ts
const extraEnv: Array<{ name: string; value: string }> = [];
const githubApiBase = process.env['GITHUB_API_BASE_URL'];
if (githubApiBase) extraEnv.push({ name: 'GITHUB_API_BASE_URL', value: githubApiBase });
```

This keeps `buildMcpServerEntry` pure (no `process.env` reads) while ensuring the MCP
server's `github_http_forward` tool uses the same API base as the daemon. Additional
variables can be added to `extraEnv` without changing the builder's signature.

Usage on the create path:

```ts
const mcpEntry = buildMcpServerEntry(sessionId, deps.daemonSocket, mcpServerPath, cmd, cmdArgs, deps.extraEnv);
const acpSessionId = await acp.newSessionWithPrompt(
  process.cwd(),
  originalPrompt,
  mcpEntry ? [mcpEntry] : undefined,
);
```

Usage on the resume path:

```ts
const mcpEntry = buildMcpServerEntry(sessionId, deps.daemonSocket, mcpServerPath, cmd, cmdArgs, deps.extraEnv);
await acp.loadSession(kiroSessionId, mcpEntry ? [mcpEntry] : undefined);
```

When `daemonSocket` is undefined, `buildMcpServerEntry` returns `undefined`, the call
sites pass `undefined`, and the ACP client reproduces the pre-feature behavior (R3.4,
R8.1).

Env placement rationale: `AGENT_ROUTER_SESSION_ID` is also injected into the agent's own
child env by the kiro adapter, but the MCP server is a **separate** subprocess the agent
spawns from the ACP entry; it must get the session id and socket from this entry's `env`
array. Carrying both values explicitly in the entry (rather than relying on inheritance)
makes the MCP server's environment deterministic regardless of how the agent harness
propagates env to MCP child processes.

### 3. MCP server path resolution (dev + compiled)

The command/args must launch `mcp-server.ts` such that its main-module guard
(`argv[1]` ends in `mcp-server.ts` or `mcp-server.js`) fires, in both execution modes,
and the path must be resolved relative to the daemon's own module location (R4.4), not
`process.cwd()`.

Resolution strategy, computed once in `src/index.ts` (which already imports `node:path`
and `node:url` is available) and passed into the session manager:

```ts
import { fileURLToPath } from 'node:url';

// Directory of the running daemon module (src/ in dev, dist/ when compiled).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Sibling MCP server entry point. In dev this is src/mcp-server.ts; in a
// compiled layout it is <outdir>/mcp-server.js. We detect which exists.
const mcpTs = path.join(moduleDir, 'mcp-server.ts');
const mcpJs = path.join(moduleDir, 'mcp-server.js');
const mcpServerPath = fs.existsSync(mcpTs) ? mcpTs : mcpJs;

// Command selection:
//   - .ts  → run under tsx (no build step): `node --import <abs-tsx-esm-url> <path>`
//   - .js  → run under plain node:            `node <path>`
const isTs = mcpServerPath.endsWith('.ts');
const mcpCommand = process.execPath;                       // the current node binary
// Resolve tsx/esm to an absolute file URL so Node can find it regardless of the
// MCP child's working directory (Node resolves --import specifiers from cwd).
const tsxLoaderUrl = isTs ? import.meta.resolve('tsx/esm') : undefined;
const mcpArgs = tsxLoaderUrl ? ['--import', tsxLoaderUrl] : [];
```

- Dev: daemon runs via `tsx` / `node --import tsx/esm src/index.ts`; `moduleDir` is
  `src/`, `mcp-server.ts` exists, so the MCP child is launched as
  `node --import tsx/esm /abs/src/mcp-server.ts` (R4.1, R4.2). Using `process.execPath`
  as the command guarantees the same Node binary; appending `--import tsx/esm` registers
  the TypeScript loader the same way the daemon itself is started.
- Compiled: `moduleDir` is the output dir, `mcp-server.js` exists, launched as
  `node /abs/dist/mcp-server.js` (R4.3).
- The guard in `mcp-server.ts` matches on the trailing filename of `argv[1]`, which is
  the resolved absolute path in both cases, so it fires in both modes (R4.1).
- Nothing here reads the agent `cwd` (R4.5).

Why resolve in `index.ts` and pass down rather than resolve inside `session-mgr.ts`:
keeping `import.meta.url`/filesystem probing at the composition root preserves the
session manager's testability (its logic stays pure and injectable), consistent with the
dependency-injection convention. The session manager receives `mcpServerPath`,
`command`, and `commandArgs` (or a small pre-built struct) alongside `daemonSocket`.

**Exported helper for testability.** The resolution logic is extracted into an exported
function in `src/mcp-resolver.ts`:

```ts
/**
 * Resolve the command, args, and serverPath for launching the MCP server.
 * Pure (no I/O, no process.env reads); returns undefined when neither
 * mcp-server.ts nor mcp-server.js exists under moduleDir.
 *
 * @param moduleDir  Absolute path to the directory containing mcp-server.ts/js.
 * @param resolve    Callable that resolves a module specifier to an absolute URL
 *                   (pass `import.meta.resolve` in production, a fixture in tests).
 */
export function resolveMcpServerCommand(
  moduleDir: string,
  resolve: (specifier: string) => string,
): { command: string; args: string[]; serverPath: string } | undefined {
  const mcpTs = path.join(moduleDir, 'mcp-server.ts');
  const mcpJs = path.join(moduleDir, 'mcp-server.js');
  const serverPath = fs.existsSync(mcpTs) ? mcpTs : fs.existsSync(mcpJs) ? mcpJs : undefined;
  if (serverPath === undefined) return undefined;
  const isTs = serverPath.endsWith('.ts');
  const command = process.execPath;
  const args = isTs ? ['--import', resolve('tsx/esm')] : [];
  return { command, args, serverPath };
}
```

`index.ts` calls `resolveMcpServerCommand(moduleDir, import.meta.resolve)`. The test
in task 9b calls it with a controlled `moduleDir` and passes `import.meta.resolve`
directly (or a fixture), then spawns the real child process with the returned values.

To keep the deps surface tidy, these can be grouped:

```ts
deps: {
  // …existing…
  daemonSocket?: string;
  mcpServerCommand?: { command: string; args: string[]; serverPath: string };
  /** Extra env variables to forward to the MCP server (e.g. GITHUB_API_BASE_URL). */
  extraEnv?: Array<{ name: string; value: string }>;
}
```

The session manager builds the entry only when both `daemonSocket` and
`mcpServerCommand` are present; otherwise it falls back to the no-MCP path (R3.4, R8.1).

### 4. `src/index.ts` — ordering fix and wiring

Move the socket path computation above `createSessionManager`:

```ts
// Compute once, before the session manager is created.
const socketPath = path.join(rootDir, 'sock');

// Resolve command/args (returns undefined if neither mcp-server.ts nor .js exists).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const mcpServerCommand = resolveMcpServerCommand(moduleDir, import.meta.resolve);
if (!mcpServerCommand) { /* warning already logged by the helper */ }

// Forward env variables mcp-server.ts reads beyond the two required ones.
const extraEnv: Array<{ name: string; value: string }> = [];
const githubApiBase = process.env['GITHUB_API_BASE_URL'];
if (githubApiBase) extraEnv.push({ name: 'GITHUB_API_BASE_URL', value: githubApiBase });

sessionMgr = createSessionManager({
  // …existing deps…
  daemonSocket: socketPath,
  mcpServerCommand,    // undefined → session manager falls back to no-MCP path
  extraEnv,
});

// …later, CLI server reuses the SAME socketPath (no second computation)…
const cliServer = createCliServer({ socketPath, /* … */ });
```

The existing `const socketPath = path.join(rootDir, 'sock')` near the CLI server block is
removed so there is exactly one declaration (R5.1–R5.3). No other startup step moves
(R5.4).

**Socket-ready ordering:** `resumeSessions()` is called after the CLI server starts
listening on `socketPath`. The per-session MCP server connects to the daemon socket at
first tool-call time (lazy connect), not at spawn time, so the exact moment Kiro spawns
the MCP subprocess from its ACP entry is irrelevant; what matters is that the socket is
bound before any MCP tool call arrives. Because `resumeSessions()` runs after
`createCliServer()` (which binds the socket), and because `mcp-server.ts` connects
lazily, there is no startup race. This constraint must be preserved: if future refactoring
moves `resumeSessions()` before `createCliServer()`, verify `mcp-server.ts` still
connects lazily, or add an explicit socket-ready gate.

### 5. `package.json` — `agent-router-mcp` bin entry

Add a bin entry pointing at a thin `.mjs` launcher that mirrors the existing
`bin/agent-router.mjs` pattern (register `tsx/esm`, then import the TS entry point). This
keeps dev-mode execution working with no build step and no new dependency:

```jsonc
"bin": {
  "agent-router": "bin/agent-router.mjs",
  "agent-router-mcp": "bin/agent-router-mcp.mjs"
}
```

`bin/agent-router-mcp.mjs`:

```js
#!/usr/bin/env node
import 'tsx/esm';
const m = await import('../src/mcp-server.ts');
m.runMcpServerFromEnv();
```

The bin calls `runMcpServerFromEnv()` explicitly — it does NOT rely on the `isMainModule`
guard, because `process.argv[1]` when running through the bin shim is
`bin/agent-router-mcp.mjs`, not `mcp-server.ts`, so the guard would be false.

This requires adding an exported function to `mcp-server.ts`:

```typescript
/** Start the MCP server from environment variables. Called by the bin entry and the isMainModule guard. */
export function runMcpServerFromEnv(): void {
  // existing standalone block contents
}
```

The `isMainModule` guard is updated to call `runMcpServerFromEnv()`. The existing
`agent-router` bin entry is untouched (R6.3), and no dependency is added (R6.4).

> Note: the per-session ACP launch (Component 3) does not use this bin entry — it invokes
> the entry point directly via `node [--import tsx/esm] <path>`. The bin entry exists as a
> stable, documented launch target per Requirement 6 and for future packaging.

### 5b. Coexistence with manual `install-mcp-config.sh` install

Users who previously ran `scripts/install-mcp-config.sh` have a global `agent-router`
entry in `~/.kiro/settings/mcp.json`. With per-session wiring, that entry is redundant:
the session receives the server automatically. The per-session entry uses a different
`AGENT_ROUTER_SESSION_ID` per session, so the two would conflict (duplicate tool names,
wrong session IDs on the global instance).

**Required:** the daemon SHALL log a startup warning when `~/.kiro/settings/mcp.json`
contains an `agent-router` key, instructing the user to remove the manual entry. The
`install-mcp-config.sh` script header SHALL be updated with a brief `# Legacy` comment
noting that per-session wiring is the default — no other change to the script is made.
Removing the global entry is the user's action; this spec does not remove it programmatically.

### 6. Permission auto-approval (Requirement 7)

`src/acp.ts` already intercepts `session/request_permission` in the stdout framing loop
and calls `autoApprovePermission`, which:

1. reads `params.options`,
2. selects the first option whose `kind` is `allow_always`, else `allow_once`, else the
   first option,
3. writes a `{ outcome: { outcome: 'selected', optionId } }` response,
4. pushes an observable notification into the stream (auditable), and
5. returns a JSON-RPC error when no option is selectable.

Analysis against Requirement 7: ACP permission requests are keyed by the **options the
agent offers**, not by MCP tool name — the request payload carries `options[]` with
`kind` values, and does not require the client to match on a specific tool identifier.
The eight daemon tools are therefore already covered by the existing option-based
auto-approval: when the agent asks to run any of them, the client selects an allow
option and proceeds. No tool-name-scoped allowlist is needed on the ACP side (R7.5).

This differs from the kiro `mcp.json` `autoApprove` array (which lists tool names like
`@agent-router/register_pr`); that array governs kiro's **own** manual-install UI
prompting and is irrelevant to the ACP `session/request_permission` flow the daemon
drives. We deliberately do not replicate it on the ACP path.

Design decision: **keep the existing option-based auto-approval unchanged.** It already
satisfies R7.1–R7.4. The design documents this explicitly (R7.5) rather than adding a
redundant tool-name filter. The Tier 2 FakeKiro scenario will exercise a
`session/request_permission` for an MCP tool to confirm the eight tools are approved
end-to-end.

## Data flow — created session

1. Daemon startup computes `socketPath` and the MCP command/args/path, then constructs
   `createSessionManager({ …, daemonSocket, mcpServerCommand })`.
2. `createSession` builds `entry = buildMcpServerEntry(sessionId, daemonSocket, …)`.
3. `acp.newSessionWithPrompt(cwd, prompt, [entry])` sends `session/new` with
   `mcpServers: [entry]`, immediately followed by the synchronous `session/prompt`.
4. The agent launches the MCP server as a stdio child using `entry.command`,
   `entry.args`, and `entry.env` (which carry `AGENT_ROUTER_SESSION_ID` and
   `AGENT_ROUTER_SOCKET`).
5. The MCP server connects to the daemon over the Unix socket and serves the eight tools.
6. When the agent calls a tool, the agent issues `session/request_permission`; the ACP
   client auto-approves it and the tool executes.

## Data flow — resumed session

1. `resumeSessions` reads active sessions, builds the same `entry`, and calls
   `acp.loadSession(kiroSessionId, [entry])` → `session/load` with `mcpServers: [entry]`.
2. The agent re-establishes the MCP server connection; the eight tools are available
   again.

## Error handling

- Missing `daemonSocket` or `mcpServerCommand`: `buildMcpServerEntry` returns `undefined`;
  sessions run without MCP tools exactly as before (no error — graceful degradation,
  R3.4/R8.1). The daemon logs at startup when MCP wiring is active vs. degraded, via the
  existing structured logger (no `console.log`).
- MCP server fails to start inside the agent: this is the agent harness's concern; the
  daemon's `session/new` call already succeeded. The MCP server's own standalone guard
  exits non-zero with a stderr message if `AGENT_ROUTER_SESSION_ID`/`AGENT_ROUTER_SOCKET`
  are missing — our entry always supplies both, so that path should not trigger.
- No new error classes are introduced; this change does not add a new failure mode in the
  daemon's sense (`FatalError`/`EventError`/`WakeError` remain as-is).

## Type-safety considerations

- `exactOptionalPropertyTypes`: `loadSession` uses `mcpServers: mcpServers ?? []` (never
  `undefined`) — no conditional spread needed, and `exactOptionalPropertyTypes` is
  satisfied because the value is always an array.
- `noUncheckedIndexedAccess`: `buildMcpServerEntry` constructs arrays by literal, so no
  unchecked index access is introduced. Existing option indexing in
  `autoApprovePermission` is unchanged.
- `McpServerEntry` is exported from `acp.ts` and imported where needed; no `any`, no
  `as` casts.

## Testing strategy

### Tier 1 (`test/tier1/`)

- `acp.ts` with `createACPClientFromStreams` over PassThrough streams:
  - `newSession(cwd, [entry])` → captured `session/new` params include
    `mcpServers: [entry]`.
  - `newSession(cwd)` → params include `mcpServers: []` (pre-feature parity).
  - `newSessionWithPrompt(cwd, prompt, [entry])` → `session/new` carries the array AND the
    `session/prompt` still follows immediately.
  - `loadSession(id, [entry])` → `session/load` params include `{ sessionId, cwd, mcpServers: [entry] }`.
  - `loadSession(id)` → params are `{ sessionId, cwd, mcpServers: [] }` (adds both `cwd`
    and `mcpServers: []` compared to pre-feature — both are intentional bug fixes per
    R2.2; the R8.2 exception allows updating existing assertions to this shape).
- `buildMcpServerEntry`:
  - returns `undefined` when `daemonSocket` is undefined.
  - returns an entry whose `env` is an array containing both
    `{ name: 'AGENT_ROUTER_SESSION_ID', value: <sessionId> }` and
    `{ name: 'AGENT_ROUTER_SOCKET', value: <socket> }`, and whose `name` is
    `agent-router`.
  - `args` equals `[...commandArgs, serverPath]` (the `.ts`/`.js` and loader URL
    decisions live in `index.ts`, not in the helper).
  - Property test (fast-check, ≥100 iterations): for arbitrary session ids and socket
    paths, the entry round-trips the id/socket into the `env` array and never emits a
    `Record`-shaped `env`.

### Tier 2 (`test/tier2/`)

- Using `TestDaemonImpl` + `FakeKiroBackend` + a scenario file:
  - Create a session with `daemonSocket` wired; assert FakeKiro received a `session/new`
    whose `mcpServers` array contains an entry named `agent-router` with the session's
    env pairs.
  - Assert the resume path forwards the entry via `session/load` (restart scenario).
  - A scenario that issues `session/request_permission` for an MCP tool; assert the
    daemon's ACP client auto-approves it (option-based) so the tool call proceeds.
  - All without network, tokens, or real Kiro (R9.5).

### Tier 3

- Not required for this change. Real-Kiro verification that the eight tools are callable
  can be folded into existing Tier 3 session runs opportunistically; it is not a gate for
  this feature.

## Backward compatibility summary

| Surface | Pre-feature | Post-feature (arg omitted) |
|---|---|---|
| `newSession(cwd)` | `session/new {cwd, mcpServers: []}` | identical |
| `newSessionWithPrompt(cwd,p)` | `session/new {cwd, mcpServers: []}` + prompt | identical |
| `loadSession(id)` | `session/load {sessionId}` | adds `cwd` + `mcpServers: []` (bug fix, R2.2); R8.2 exception allows updating existing assertions |
| `createSessionManager(deps)` | no MCP wiring | no MCP wiring when `daemonSocket` absent |
| `package.json` bin | `agent-router` | `agent-router` unchanged + new `agent-router-mcp` |

All new parameters are optional and trailing; existing tests and callers are unaffected
(R8.1, R8.2).

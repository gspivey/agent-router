# Implementation Plan — MCP Server Wiring

Dependency-ordered. Each task is a discrete, reviewable step. Tasks are checkpoints: do
`npm run typecheck` after type-surface changes, and run the relevant tier tests as noted.
Backward compatibility (every new param optional) is a cross-cutting constraint —
existing tests must keep passing at every step.

- [x] 1. Add the `McpServerEntry` type and thread `mcpServers` through the ACP client
  - In `src/acp.ts`, define and export `interface McpServerEntry { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }`.
  - Add an optional trailing `mcpServers?: McpServerEntry[]` parameter to `newSession`, `newSessionWithPrompt`, and `loadSession` on the `ACPClient` interface.
  - In `newSession`, send `session/new` with `mcpServers: mcpServers ?? []`.
  - In `newSessionWithPrompt`, send `session/new` with `mcpServers: mcpServers ?? []`, keeping the synchronous `session/prompt` write that immediately follows `session/new` (no await/microtask gap).
  - In `loadSession`, build `session/load` params with `cwd: process.cwd()` (required by
    ACP schema) and `mcpServers: mcpServers ?? []` (also required). Always emit both
    fields — never conditionally omit `mcpServers`. This is a deliberate wire-format
    change from the pre-feature `{ sessionId }` call: adding `cwd` and `mcpServers: []`
    fixes a bug and is covered by R8.2's explicit exception for this call site.
    Do not omit either field. Do not use a conditional spread.
  - Do not add any dependency; no `any`/`as`.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 8.1, 8.3, 8.5_

- [x] 2. Tier 1 tests for ACP `mcpServers` forwarding
  - In `test/tier1/`, add a test file driving `createACPClientFromStreams` over PassThrough streams and asserting the JSON-RPC written to stdin.
  - Assert `newSession(cwd, [entry])` → `session/new` params contain `mcpServers: [entry]`; `newSession(cwd)` → `mcpServers: []`.
  - Assert `newSessionWithPrompt(cwd, p, [entry])` → `session/new` carries the array AND a `session/prompt` request follows.
  - Assert `loadSession(id, [entry])` → `session/load` params contain `{ sessionId: id, cwd: <any string>, mcpServers: [entry] }`; `loadSession(id)` → params are `{ sessionId: id, cwd: <any string>, mcpServers: [] }` (R2.2 bug fix: pre-feature sent only `{ sessionId }`; existing assertions may be updated per R8.2 exception).
  - _Requirements: 9.1, 9.5_

- [x] 3. Add the `buildMcpServerEntry` pure helper to the session manager
  - In `src/session-mgr.ts`, define and export `buildMcpServerEntry(sessionId, daemonSocket, serverPath, command, commandArgs, extraEnv?)` returning `McpServerEntry | undefined` (undefined when `daemonSocket` is undefined).
  - The entry: `name: 'agent-router'`, `command`, `args: [...commandArgs, serverPath]`, and `env` as an array containing `{ name: 'AGENT_ROUTER_SESSION_ID', value: sessionId }`, `{ name: 'AGENT_ROUTER_SOCKET', value: daemonSocket }`, plus any `extraEnv` elements.
  - Keep it pure: no I/O, no `process.env` reads. Callers (i.e. `index.ts`) pass `extraEnv` with any env variables to forward.
  - _Requirements: 3.5, 3.6_

- [x] 4. Tier 1 tests for `buildMcpServerEntry`
  - In `test/tier1/`, assert: undefined when `daemonSocket` is undefined; correct `name`; `env` array contains both session id and socket pairs; `args` equals `[...commandArgs, serverPath]` (the helper forwards whatever command args it receives — the `.ts`/`.js` decision lives in `index.ts`, not in the helper).
  - Add a fast-check property test (≥100 iterations): for arbitrary session ids and socket strings, the returned entry round-trips both values into the `env` array and `env` is always an array (never a Record).
  - _Requirements: 9.2, 9.5_

- [x] 5. Accept `daemonSocket`, `mcpServerCommand`, and `extraEnv` in the session manager and use them
  - In `src/session-mgr.ts`, extend the `createSessionManager` deps object with optional `daemonSocket?: string`, `mcpServerCommand?: { command: string; args: string[]; serverPath: string }`, and `extraEnv?: Array<{ name: string; value: string }>`.
  - In `createSession`, build the entry via `buildMcpServerEntry(sessionId, deps.daemonSocket, serverPath, cmd, cmdArgs, deps.extraEnv)` (only when both `daemonSocket` and `mcpServerCommand` are present) and pass `entry ? [entry] : undefined` to `acp.newSessionWithPrompt`.
  - In `resumeSessions`, build the entry the same way and pass `entry ? [entry] : undefined` to `acp.loadSession`.
  - When the deps are absent, pass `undefined` so pre-feature behavior is reproduced.
  - Log (structured logger) once whether MCP wiring is active or degraded.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 8.1, 8.2_

- [x] 6. Resolve the MCP server path and command in `index.ts`, fix `socketPath` ordering
  - In `src/index.ts`, move `const socketPath = path.join(rootDir, 'sock')` to before `createSessionManager`, and remove the later duplicate declaration near the CLI server block (CLI server reuses the single value).
  - Extract the path/command resolution into an exported pure helper in a sibling module (e.g. `src/mcp-resolver.ts`): `resolveMcpServerCommand(moduleDir: string, resolve: (s: string) => string): { command: string; args: string[]; serverPath: string } | undefined`. The `resolve` parameter accepts the specifier string (e.g. `'tsx/esm'`) and returns an absolute URL/path — injectable in tests, and `import.meta.resolve` in production. Return `undefined` (and log a warning) if neither `mcp-server.ts` nor `mcp-server.js` exists under `moduleDir`. This makes the real path resolution testable without depending on `import.meta`.
  - In `src/index.ts`, compute `moduleDir` from `fileURLToPath(import.meta.url)` and call `resolveMcpServerCommand(moduleDir, import.meta.resolve)` to get the command struct.
  - Build `extraEnv`: if `process.env['GITHUB_API_BASE_URL']` is set, add `{ name: 'GITHUB_API_BASE_URL', value: process.env['GITHUB_API_BASE_URL'] }`.
  - Pass `daemonSocket: socketPath`, `mcpServerCommand: <resolved struct or undefined>`, and `extraEnv` into `createSessionManager`.
  - Verify no other startup step ordering changes.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4_

- [x] 7. Export `runMcpServerFromEnv` from `mcp-server.ts` and update bin entry
  - In `src/mcp-server.ts`, extract the existing standalone entry-point block into an
    exported `runMcpServerFromEnv(): void` function. Update the `isMainModule` guard to
    call `runMcpServerFromEnv()`.
  - Create `bin/agent-router-mcp.mjs`:
    ```js
    #!/usr/bin/env node
    import 'tsx/esm';
    const m = await import('../src/mcp-server.ts');
    m.runMcpServerFromEnv();
    ```
  - Add `"agent-router-mcp": "bin/agent-router-mcp.mjs"` to the `bin` map in
    `package.json`, keeping the existing `agent-router` entry.
  - Confirm no new dependency is added.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 8.3, 8.4_

- [x] 7b. Warn at startup when manual `install-mcp-config.sh` entry conflicts
  - In `src/index.ts` (or a small helper it calls), after `socketPath` is resolved but
    before `createSessionManager`, check whether `~/.kiro/settings/mcp.json` contains an
    `agent-router` key. If so, log a warn-level message: the manual entry is superseded
    by per-session wiring and should be removed to avoid duplicate tool registration.
  - The home-dir path used for the check SHALL be passed as a parameter (or default to
    `os.homedir()`) so a Tier 1 test can point at a temp dir.
  - Add a brief `# Legacy` comment at the top of `scripts/install-mcp-config.sh` noting
    that per-session wiring is now the default and this script is only needed for
    environments that don't auto-wire.
  - Add a Tier 1 test: (a) config file absent → no warning; (b) config has
    `agent-router` key → warning logged; (c) config present but no `agent-router` key →
    no warning.
  - _Requirements: 10.1, 10.2, 10.3_

- [x] 8. Confirm and document permission auto-approval for the eight tools
  - Review `autoApprovePermission` in `src/acp.ts`; confirm its option-based selection (`allow_always` → `allow_once` → first) covers MCP tool permission requests without tool-name matching.
  - Add a brief code comment noting this path approves the daemon's eight MCP tools and references the design's analysis.
  - Do not add a tool-name allowlist on the ACP side.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 9. Tier 2 test — created session forwards the MCP entry and auto-approves tools
  - Before writing the test scenario: verify whether `TestDaemonImpl` builds the session manager internally or accepts it as a dep. If it builds internally, add sub-steps for any `TestDaemonImpl` constructor or factory changes needed to accept `daemonSocket` and `mcpServerCommand`. Verify FakeKiro records `session/new` and `session/load` params (add recording if absent). Verify FakeKiro can inject a `session/request_permission` request (add if absent).
  - Using `TestDaemonImpl` + `FakeGitHubBackend` + `FakeKiroBackend` with a scenario file, create a session with `daemonSocket`/`mcpServerCommand` wired.
  - Assert FakeKiro received a `session/new` whose `mcpServers` array contains an `agent-router` entry carrying the session's `AGENT_ROUTER_SESSION_ID` and `AGENT_ROUTER_SOCKET` env pairs.
  - Add a scenario step issuing `session/request_permission` for an MCP tool; assert the daemon auto-approves (option-based) so the call proceeds.
  - No network, tokens, or real Kiro.
  - _Requirements: 9.3, 9.5, 7.2_

- [x] 9b. Entry-execution smoke test — verify the resolved command/args actually launch the MCP server
  - In `test/tier1/` or a dedicated `test/smoke/`, add a test that calls the exported `resolveMcpServerCommand(moduleDir, resolve)` helper from task 6 with `src/` as `moduleDir` and a real `import.meta.resolve` (or a fixture), then executes the returned `command` / `args` as a real child process against a stub Unix socket, completes an MCP `initialize` handshake, and calls `tools/list`, asserting all 8 tool names are present.
  - This is the only gate on the real `import.meta.resolve('tsx/esm')` URL, the `argv[1]` guard, and the env contract — none of these are exercised by unit tests alone. Exporting the helper makes it reachable by the test without depending on `import.meta` of the test file.
  - Skip the test (or mark it conditional) when the MCP entry point file is absent from the build. Log a clear warning when skipped.
  - Add a note in task 11 that this smoke test must pass in CI before the feature is complete.
  - _Requirements: 4.1, 4.2, 4.3, 9.1, 9.6_

- [x] 10. Tier 2 test — resume path forwards the MCP entry
  - Confirm `TestDaemonImpl`'s restart scenario drives `resumeSessions` with `daemonSocket`/`mcpServerCommand` wired (add if absent — this may be covered by the TestDaemonImpl changes in task 9).
  - Add a restart scenario that drives `resumeSessions`; assert FakeKiro received a `session/load` whose `mcpServers` array contains the `agent-router` entry.
  - No network, tokens, or real Kiro.
  - _Requirements: 9.4, 9.5, 2.1_

- [x] 11. Verification and docs
  - Run `npm run typecheck` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) — must pass.
  - Run `npm test` (Tier 1 + Tier 2) — must pass, including the new tests and all pre-existing tests unchanged. The task 9b smoke test must also pass (it is the only gate on the actual entry-point launch; CI must not be green without it).
  - Land any doc updates the change justifies (e.g. note in README/relevant doc that MCP tools are now wired automatically and the manual `install-mcp-config.sh` path is optional) on the feature branch alongside the code.
  - _Requirements: 8.2, 8.4, 8.5, 9.5_

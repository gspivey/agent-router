# Security Isolation Fix — Tasks

Two ROADMAP items, each one PR. **Item 90 must merge before Item 91 is started** (both items
modify `src/index.ts` and the isolation startup surface; sequencing avoids a merge conflict). Do
not edit the corrected spec at `.kiro/specs/agent-process-isolation/`.

Each sub-task cites the requirement (`FR-n`) and design fix it implements. Tick a sub-task only
when its code and its tests are both on the branch and green.

---

## Item 90 — Code fixes (bugs 1–3)

Files: `src/mcp-server.ts`, `src/index.ts`, `src/agent-server.ts` (+ tests).
Covers FR-1, FR-2, FR-3. Branch slug suggestion: `agent/security-isolation-fix-code`.

- [ ] 90.1 Remove the operator-socket fallback from `resolveAgentSocket()` in `src/mcp-server.ts`
  so it resolves only `ctx.agentSocket ?? process.env['AGENT_ROUTER_AGENT_SOCK']` and throws
  `Error('AGENT_ROUTER_AGENT_SOCK not set; cannot relay MCP tool')` when both are absent or
  empty. Treat `''` as unset: because `??` only skips `null`/`undefined`, the implementation
  must coerce empty string explicitly (e.g. `(ctx.agentSocket || undefined) ??
  (process.env['AGENT_ROUTER_AGENT_SOCK'] || undefined)`). Delete all references to
  `AGENT_ROUTER_SOCKET` and `daemonSocket` from the function. Update the `resolveAgentSocket`
  doc comment and the `McpContext.agentSocket` JSDoc to describe the two-source resolution and
  the hard error. (FR-1.1, FR-1.2, FR-1.3; design Fix 1)

- [ ] 90.2 Verify (and, if needed, adjust) that a throw from `resolveAgentSocket()` inside a
  relay tool call (`github_http_forward`, `push_branch`, `pr_create`, `pr_view`) is surfaced by
  the existing `handleToolsCall` catch as an `isError: true` tool result and does not crash the
  MCP server. No new catch should be required — confirm by test. (FR-1.4; design Fix 1)

- [ ] 90.3 Tier 1 tests for `resolveAgentSocket()`: either extract it as a small pure exported
  helper `resolveAgentSocket(ctxSock: string | undefined, envSock: string | undefined): string`
  and test it directly, or exercise it via relay tool calls through `handleToolsCall`. Test matrix
  (coercion semantics — empty string is absent):
  - `ctx.agentSocket = 'real-path'`, env unset → returns `'real-path'`.
  - `ctx.agentSocket = undefined`, env `'real-path'` → returns `'real-path'`.
  - `ctx.agentSocket = ''`, env `'real-path'` → returns `'real-path'` (falls through to env).
  - `ctx.agentSocket = undefined`, env unset → throws exact error message.
  - `ctx.agentSocket = ''`, env `''` → throws exact error message.
  - `AGENT_ROUTER_SOCKET` set, `AGENT_ROUTER_AGENT_SOCK` unset → must be tested via `createMcpServer`
    (the pure helper never reads `AGENT_ROUTER_SOCKET`): point `daemonSocket` at a listening fake
    socket, assert `isError: true` on the relay call, and assert the fake socket received zero frames
    (proves the operator socket is never contacted).
  - A relay tool call with no agent socket → `isError: true` result with the error text; server alive.
  (AC-1, AC-2; NFR-2)

- [ ] 90.4 In `src/index.ts`, change the `tokenResolver` passed to `createAgentServer` so the PAT
  source is the credential token store only. Implement and export a pure helper
  `credentialTokenResolver(store: TokenStore): TokenResolver` in a new or existing module (e.g.
  `src/token-resolver.ts`). The helper resolves:
  `store.findProjectByRepo(`${owner}/${repo}`)` → `store.getToken(projectName)` → `secret.reveal()`,
  throwing `Error(`No token configured for repo ${owner}/${repo}`)` when either lookup returns
  `undefined`. Use `credentialTokenResolver(credentialTokenStore)` at the `createAgentServer` call
  site. Because `credentialTokenStore` is a `const` (never reassigned), passing it directly is
  correct — `store.reload()` mutates its internal map in place and the helper picks up updates
  automatically. Do NOT inline this as a closure inside `main()` (it cannot be unit-tested that
  way). Do NOT reference the daemon's envFallback `tokenResolver` in the helper. Leave the
  `github` client (`~L649`) and the per-session `acpSpawner` token env (`~L732`) using the
  existing `tokenResolver` unchanged.
  (FR-2.1, FR-2.2, FR-2.3; design Fix 2)

- [ ] 90.5 Tier 1 tests for `credentialTokenResolver` (the exported helper): resolves a stored
  project token for a repo listed in that project's `repos`; throws `No token configured for repo
  <slug>` when the repo maps to no project or the project has no token. Set
  `process.env.GITHUB_TOKEN = 'ghp_SENTINEL'` during tests and assert this sentinel never appears
  in any resolver output, confirming no envFallback path. Reload test: build a store from a temp
  `tokens.json`, call the resolver, rewrite `tokens.json` with a different token, call
  `store.reload()`, call the resolver again — the new token is returned. Add a `_fallback` mode
  test: store built with `fallbackToken` (no `tokens.json`), resolver throws for any repo slug.
  (AC-3, AC-10; NFR-2)
- [ ] 90.6 Tier 2 test for the no-token path: exercise `push_branch` against the agent-server
  harness with a real `createTokenStore` (temp `tokens.json` that has no entry for the session
  repo), a stub `bareClonePathFor` that returns a valid path (so Fix 3's guard does not fire),
  and an `execFileImpl` stub where `rev-parse` returns matching tree SHAs for both `tip` and
  `base`. Assert: the handler returns `{ error: 'push failed' }` (the existing outer catch), no
  push command was issued to the stub, and no `GITHUB_TOKEN` env var was present in any command
  issued. Add a `github_http_forward` case asserting `fetchImpl` was never called when the token
  lookup fails. (AC-3; NFR-2)

- [ ] 90.7 In `src/agent-server.ts` `push_branch`, make the `.github/` guard fail closed by
  hoisting the `bareClonePath === undefined` rejection to immediately after
  `bareClonePathFor?.(sessionRepo)` is called, before the base-branch fetch. Return
  `{ error: 'bare clone not configured; push_branch cannot verify .github/ changes' }` at that
  point and remove the `if (bareClonePath !== undefined)` gates from the base-branch fetch and the
  tree-SHA comparison block (both now run with bareClonePath known-present). Preserve the existing
  differing-tree rejection message `Bundle modifies .github — workflow pushes are not permitted`
  verbatim. Identify and update any existing test(s) that exercise `push_branch` with
  `bareClonePathFor` returning `undefined` — those tests must now either supply a defined bare
  clone or assert the new error; do NOT delete them. (FR-3.1, FR-3.2, FR-3.3; design Fix 3)

- [ ] 90.8 Tier 1/Tier 2 tests for the `.github/` guard: `bareClonePathFor` returning `undefined`
  → the exact "bare clone not configured" error and no push on the fake remote; defined bare clone
  + bundle touching `.github/` → existing `Bundle modifies .github …` rejection (regression);
  defined bare clone + clean bundle → push proceeds. (AC-4, AC-5; NFR-2)

- [ ] 90.9 Implement and export `checkAgentSocketTokenSource(store: TokenStore, log: Logger)` in
  `src/token-store-startup.ts`. Use `store.getProject('_fallback') !== undefined` (consistent with
  existing `validateTokenStoreStartup` at L26) to detect fallback mode; log a WARNING stating that
  agent-socket PAT operations (`push_branch`, `pr_create`, `pr_view`) require `tokens.json`.
  Wire the call from `main()` after `credentialTokenStore` is initialized. Tier 1 tests:
  `_fallback` project present → WARNING with the hint; no `_fallback` project → no warning.
  Update `docs/security-setup.md` and `README.md` to document that every repo used by an agent
  must appear in a `tokens.json` project. (FR-2.4; AC-10)

- [ ] 90.10 Run `npm run typecheck` and `npm test` (Tier 1 + Tier 2); fix any failures. Confirm no
  new runtime dependency was added and no `console.log` was introduced. (NFR-1, NFR-3, NFR-4)

---

## Item 91 — Provisioning fixes (bugs 4–6)

Files: `scripts/setup-agent-user.sh`, `src/isolation-startup.ts`, `src/index.ts`, `README.md`
(+ deploy/runbook doc if present), plus a Tier 1 test for the startup check.
Covers FR-4, FR-5, FR-6. **Depends on Item 90.** Branch slug suggestion:
`agent/security-isolation-fix-provisioning`.

- [ ] 91.1 In `scripts/setup-agent-user.sh`, add an idempotent step (after `agentworker` is
  created) that makes the daemon user a supplementary member of the worker group:
  `usermod -aG "$WORKER_USER" "$DAEMON_USER"` (use the script's daemon-user variable, else the
  literal `agentrouter`). Add a comment citing design §C "Socket group ownership". Do not add
  `agentworker` to the `agentrouter` group. Note: `$DAEMON_USER` is already defined in the
  script (`DAEMON_USER="agentrouter"` at the top) — use it. (FR-4.1, FR-4.2, FR-4.3; design Fix 4)

- [ ] 91.2 Rename every occurrence of `TPROXY_SSRF_BLOCK` to `TINYPROXY_OUT` in:
  `scripts/setup-agent-user.sh` (chain create/flush, REJECT rules, OUTPUT jump, persisted v4/v6
  blocks), `README.md`, and `docs/security-setup.md`. After the change,
  `grep -rn TPROXY_SSRF_BLOCK scripts README.md docs` must return 0 results. (FR-6.1, FR-6.2;
  design Fix 6)

- [ ] 91.3 Verify the changes: `grep -rn TPROXY_SSRF_BLOCK scripts README.md docs` returns 0;
  `bash -n scripts/setup-agent-user.sh` passes; the script contains a `usermod -aG` line adding
  `"$WORKER_USER"` to the daemon user group (verify with
  `grep -E 'usermod -aG.*WORKER_USER' scripts/setup-agent-user.sh`), and does not add
  `agentworker` to the `agentrouter` group. (AC-6, AC-8)

- [ ] 91.4 Add `checkAgentWorkerUser(useWorkerUid, log, lookup = defaultAgentUserLookup)` to
  `src/isolation-startup.ts`, following the existing advisory-check pattern: no-op when
  `useWorkerUid` is false; calls `lookup.agentWorkerExists()` inside a try/catch (treat a throw
  as missing — log a WARNING, do not rethrow); logs exactly one WARNING (with a
  `sudo scripts/setup-agent-user.sh` hint) when `useWorkerUid` is true and the `agentworker`
  account is missing; never throws. Add an injectable `AgentUserLookup` interface whose default
  `agentWorkerExists()` is a non-throwing, unprivileged probe that checks BOTH `/etc/passwd`
  (user) and `/etc/group` (group) for `agentworker:` entries (both must exist since
  `sudo -u agentworker` needs the user); any read error → `false`. (FR-5.1, FR-5.2, FR-5.3;
  design Fix 5)

- [ ] 91.5 Wire `checkAgentWorkerUser(config.useWorkerUid ?? false, log)` into `src/index.ts`
  startup alongside `checkTokenFilePermissions` and `checkIptablesRules`. (FR-5.4; design Fix 5)

- [ ] 91.6 Tier 1 tests in `test/tier1/isolation-startup.test.ts` for `checkAgentWorkerUser`:
  `useWorkerUid: false` → no warning; `true` + lookup returns false → exactly one WARNING with the
  hint; `true` + lookup returns true → no warning; `true` + lookup throws → exactly one WARNING
  (the function's try/catch treats the throw as missing), no exception escapes
  `checkAgentWorkerUser`. (AC-7; NFR-2)

- [ ] 91.7 Update `README.md`'s existing `setup-agent-user.sh` section (around line 173) and
  `docs/security-setup.md` to document: `sudo scripts/setup-agent-user.sh` is the provisioning
  prerequisite for `useWorkerUid: true`; the daemon must be restarted after running setup for the
  new supplementary group membership to take effect; and the daemon logs a startup WARNING when
  the account is missing. Do NOT create a new README section — extend the existing one and
  cross-link to `docs/security-setup.md`. Docs land on this branch, not as a post-merge fixup.
  (FR-5.5; AC-9)

- [ ] 91.8 Run `npm run typecheck` and `npm test` (Tier 1 + Tier 2); fix any failures. Confirm no
  new runtime dependency and no `console.log`. (NFR-1, NFR-3, NFR-4)

---

## ROADMAP entries to add

Add these two items to `ROADMAP.md` (newest-first, above item 62's region per the file's ordering
convention). Item 91 depends on item 90.

```markdown
### 90. Security isolation fix — code (MCP socket fallback, agent-server PAT source, .github fail-closed)

Read `.kiro/specs/security-isolation-fix/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `90.1`–`90.9`. Realigns shipped agent-process-isolation code with the
corrected spec: removes the MCP operator-socket fallback, sources the agent-server PAT from the
credential token store (no env fallback), and makes the `push_branch` `.github/` guard fail
closed. Depends on items 83–86.

- Spec: `.kiro/specs/security-isolation-fix/` · tasks `90.1`–`90.9`
- [ ] Complete

### 91. Security isolation fix — provisioning (usermod step, agentworker startup check, iptables chain rename, docs)

Read `.kiro/specs/security-isolation-fix/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `91.1`–`91.8`. Adds `usermod -aG agentworker agentrouter` to
`setup-agent-user.sh`, a non-fatal startup warning when `useWorkerUid: true` but `agentworker` is
missing, renames the tinyproxy chain to `TINYPROXY_OUT`, and documents the setup step. Depends on
item 90.

- Spec: `.kiro/specs/security-isolation-fix/` · tasks `91.1`–`91.8`
- [ ] Complete
```

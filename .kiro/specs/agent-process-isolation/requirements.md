# Agent Process Isolation & Credential Hardening — Requirements

## Overview

Close the current gap where agent sessions run as the same Unix user (`agentrouter`) as the
daemon, allowing any prompt-injected agent to read project PATs from `tokens.json` and the
daemon bearer token.

## Context: Verified Source State

- `git_credential` IS in `src/mcp-server.ts` (item 39, PR #78). Returns raw token. Remove.
- `github_http_forward` IS in `src/mcp-server.ts` (item 38, PR #77). Calls `get_token`.
- `createCliServer` exposes all CLI ops including `get_token` — operator socket only.
- `SpawnOpts` in `src/agent-adapter.ts`: `{ sessionId, env? }`.
- Worktrees currently at `$rootDir/worktrees/{id}` via `git worktree add` from a shared bare clone.
- Node.js version: 24. `crypto.randomUUID()` available.
- kiro-cli is Amazon Q Developer CLI, uses `*.amazonaws.com` + `*.kiro.dev`.

## Functional Requirements

### FR-1: System user isolation

FR-1.1: Idempotent setup script `scripts/setup-agent-user.sh` that: creates `agentworker` with
home dir `/home/agentworker`; writes sudoers rule (FR-2.1); hardens `$rootDir` (FR-3.1);
creates worktree and push-tmp base dirs (FR-3.4); creates agent socket dir (FR-4.2); installs
tinyproxy (FR-7.1); installs iptables rules (FR-7.2).

FR-1.2: Document prerequisites in README: `sudo`, `iptables`, `iptables-persistent`, `tinyproxy`,
and note: install `iptables-persistent` ONLY if `ufw` is not in use (it conflicts).

### FR-2: Sudo launcher for uid drop

FR-2.1: `/etc/sudoers.d/agent-router-worker` (mode 440):
```
Defaults:agentrouter env_keep += "AGENT_ROUTER_SESSION_ID WORKDIR AGENT_ROUTER_AGENT_SOCK AGENT_ROUTER_CAP_TOKEN HTTPS_PROXY"
agentrouter ALL=(agentworker) NOPASSWD: <kiroPath from config.json> acp
```
kiro path: absolute, from `config.json` `kiroPath`, NOT under `$rootDir`. Validated with
`visudo -c -f`. The setup script accepts `KIRO_PATH` env var.

FR-2.2: `KiroAdapter.spawn()` when `useWorkerUid: true`: call
`spawnACPClient('/usr/bin/sudo', ['-u', 'agentworker', kiroPath, 'acp'], env)`.
env must include: `AGENT_ROUTER_SESSION_ID`, `AGENT_ROUTER_AGENT_SOCK`,
`AGENT_ROUTER_CAP_TOKEN`, `HTTPS_PROXY=http://127.0.0.1:8080`, all existing `buildChildEnv`
fields (`WORKDIR`, etc.). env must NOT include `GITHUB_TOKEN`.

FR-2.3: ClaudeCodeAdapter: refuse when `useWorkerUid: true` with ERROR log.

FR-2.4: Unit test: `useWorkerUid: true` → correct sudo args; no `GITHUB_TOKEN` in env; non-empty cap token.

### FR-3: Token file hardening + per-session clone model

FR-3.1: Setup script hardens (daemon-owned, NOT root-owned):
- `$rootDir`: `chmod 750 agentrouter:agentrouter`
- `$rootDir/tokens.json`, `daemon-token`, `config.json`: `chmod 600 agentrouter:agentrouter`

FR-3.2: `checkTokenFilePermissions(rootDir, log)` in `src/index.ts`: checks mode `& 0o044`,
logs WARNING, does not crash.

FR-3.3: acpSpawner lambda removes `GITHUB_TOKEN` from child env when `useWorkerUid: true`.
Logs WARNING if present.

FR-3.4: Each session shall use a **standalone git clone** owned by `agentworker`, not a git
worktree attached to a daemon-owned bare repo. The workflow:
1. At session start, the daemon seeds the clone by creating a bundle from the daemon's bare
   clone (`git bundle create /srv/agent-router/worktrees/{sid}/seed.bundle --all`), then
   has `agentworker` clone from the bundle:
   `sudo -u agentworker git clone /srv/agent-router/worktrees/{sid}/seed.bundle /srv/agent-router/worktrees/{sid}/work/`
   with `GIT_CONFIG_NOSYSTEM=1 -c safe.directory=...`.
2. The agent's clone is owned by `agentworker`, mode 755.
3. The daemon's bare clone is owned by `agentrouter`, mode 700. `agentworker` cannot write to it.
4. The setup script adds a sudoers rule for the bundle seeding helper.
5. **The daemon SHALL NOT run any git command with a cwd inside the agent's `work/` directory.**
   The agent controls `.git/config` in that directory (hooks, fsmonitor, credential helpers),
   so any daemon-side `git` invocation there runs those hooks as `agentrouter`. Any daemon
   git operations on session state (e.g. checking head SHA, listing files, verifying presence)
   must be performed via `sudo -u agentworker git ...` to avoid privilege escalation. The
   `AttemptRunner`/`WorktreeOps` call sites that require git operations in the session working
   tree must use the sudo path or operate on the daemon's canonical clone only.

FR-3.5: The `worktree-manager.ts` shall be updated to implement FR-3.4. The shared bare clone
for fetching remotes remains daemon-owned. The per-session working directory is
`agentworker`-owned.

FR-3.6: The `push_branch` bundle input from the agent shall be read from a fixed path within
the session's working directory (`/srv/agent-router/worktrees/{sid}/work/push-bundle.bundle`).
The daemon reads this file with `O_NOFOLLOW`, verifies it is a regular file under a size cap
(50 MB), copies it to `/srv/agent-router/push-tmp/{sid}/` (daemon-owned, mode 0700) before
processing. The agent-controlled path is used only for reading, not for git operations.

### FR-4: Dual socket architecture

FR-4.1: Operator socket: `$rootDir/sock`, mode 0600. Unchanged. Not accessible to `agentworker`.

FR-4.2: Agent socket: `/run/agent-router/agent.sock`, mode 0660. `/run/agent-router/` owned
`agentrouter:agentworker`, mode **0750** (search+read, NOT write — prevents socket squatting).
Created via `tmpfiles.d`:
```
d /run/agent-router 0750 agentrouter agentworker -
```
After `server.listen()`, daemon calls `fs.chmodSync(agentSockPath, 0o660)`. Unlink stale socket
before listen.

FR-4.3: Agent socket ops (exhaustive): `session_status`, `register_pr`, `merge_pr`,
`complete_session`, `register_worktree`, `report_outcome`, `get_session_project`,
`github_forward`, `pr_create`, `pr_view`, `push_branch`.
All other ops: `{error: "Unknown op"}` (AC-10).

FR-4.4: Every op validates `session_id` + `cap_token` with `crypto.timingSafeEqual`. Empty
tokens rejected.

FR-4.5: MCP server reads `AGENT_ROUTER_AGENT_SOCK` from env. Daemon passes it in
`mcpServers[0].env` for `session/new` and `session/load`.

FR-4.6: When `useWorkerUid: true`, the daemon shall refuse to start a new session
(`sessionMgr.createSession`, `resumeSessions`, and any CLI `new_session` op) if another active
session is already running for a **different project** (bound `repo` field). This guard is
enforced in `src/session-mgr.ts` `createSession()` and `resumeSessions()`, not on the agent
socket. The `force` flag on CLI `new_session` must NOT bypass this check when `useWorkerUid`
is true. Comparison is on the project's bound repo string (case-insensitive). The rationale:
since all sessions share the `agentworker` uid, one agent can read another's `/proc/<pid>/environ`
to steal the other's cap token and then call `github_forward`/`push_branch` as that session.

FR-4.7: The daemon shall include a `pkill` sudoers rule so it can signal stray `agentworker`
processes after a session ends:
```
agentrouter ALL=(root) NOPASSWD: /usr/bin/pkill -KILL -u agentworker
```
This allows the daemon to send SIGKILL to all processes owned by `agentworker` during session
cleanup (sudo's inability to pass SIGKILL through to child processes makes direct kill of the
kiro subprocess unreliable). Call this after `kill()` returns / session ends.

FR-4.8 (Residual risk, documented): The shared `agentworker` uid means a compromised session
can implant files in `/home/agentworker/.kiro/` (hooks, config) that execute in a later session
for a different project. Full mitigation requires per-session uids (deferred). Short-term:
document this risk in `docs/security-setup.md`; operators running high-sensitivity sessions
should restart between projects.

### FR-5: `git_credential` removal and `github_forward` (daemon-side)

FR-5.1: Remove `git_credential` from `MCP_TOOLS` and handler. Remove any `get_token` op from
the agent socket.

FR-5.2: `github_http_forward` MCP tool: thin relay to `{op:'github_forward', session_id,
cap_token, method, path, body}` on agent socket.

FR-5.3: Daemon-side `github_forward` handler:
1. Validate `session_id` + `cap_token`
2. Validate raw path using **strict character-set validation** (not decode-then-check):
   - Each segment (split on `/`) must match `^[A-Za-z0-9._-]+$`
   - `%2F` allowed only in `{refSegments}` positions
   - Any other `%`, `?`, `#`, `\`, control chars, or empty segment → reject
   - Path must start with `/`
3. Accept query parameters as a separate `queryParams` argument (structured, not in path).
   Allowed param names: `per_page`, `page`, `state`, `head`, `base`, `sort`, `direction`.
   Build URL using `URL` + `URLSearchParams`.
4. Run allowlist check on `url.pathname` (after URL construction — exactly what gets sent).
5. Repo authorization: extract owner/repo from first two path segments after `/repos/`. Require
   `{owner}/{repo}` to equal `sessionMgr.getSessionRepo(sessionId)` (write methods: POST/PATCH/DELETE).
   Read methods (GET) may also access repos in `sessionMgr.getSessionReadRepos(sessionId)`.
   PAT from token resolver using session's bound repo — never from a caller argument.
6. Body checks: parse body as JSON (not string). For `POST /repos/*/pulls` and `pr_create`:
   reject if `base` is a protected **push-target** branch (`main`, `master`). `development`
   is the intended PR target and must be ALLOWED as a base here.
   For `PATCH /repos/*/pulls/{n}`: accept only `{title, body}` keys.
   For `POST /repos/*/issues/{n}/comments`: record returned `id` in `outbound_comments` table.
7. Fetch with `redirect: 'manual'`. Apply request body + response body size cap (1 MB each).
8. Daemon-side WARN log on block.

FR-5.4: `github_forward` allowlist — exact (method, path-pattern) table. All other (method, path) combinations are rejected with `{error:"not permitted"}`:

| Methods | Path pattern | Notes |
|---|---|---|
| GET | `/repos/{o}/{r}/pulls` | list PRs |
| GET | `/repos/{o}/{r}/pulls/{n}` | get PR |
| GET | `/repos/{o}/{r}/pulls/{n}/files` | PR files |
| GET | `/repos/{o}/{r}/pulls/{n}/reviews` | PR reviews |
| GET | `/repos/{o}/{r}/pulls/{n}/comments` | PR review comments |
| POST | `/repos/{o}/{r}/pulls` | create PR (base ≠ main/master enforced in body check) |
| PATCH | `/repos/{o}/{r}/pulls/{n}` | update PR title/body only |
| GET | `/repos/{o}/{r}/issues/{n}/comments` | issue comments |
| POST | `/repos/{o}/{r}/issues/{n}/comments` | post comment |
| GET | `/repos/{o}/{r}/commits/{ref}/check-runs` | CI check-runs |
| GET | `/repos/{o}/{r}/actions/runs` | list workflow runs |
| GET | `/repos/{o}/{r}/actions/runs/{n}` | get run |
| GET | `/repos/{o}/{r}/actions/runs/{n}/jobs` | run jobs |
| GET | `/repos/{o}/{r}/statuses/{ref}` | commit statuses |
| GET | `/repos/{o}/{r}/git/refs/heads/{branch}` | branch ref |
| GET | `/repos/{o}/{r}/branches/{branch}` | branch info |

Explicitly DENIED (not in allowlist, must NEVER be added without security review):
- Any path under `/repos/{o}/{r}/hooks` (webhooks)
- Any path under `/repos/{o}/{r}/keys` (deploy keys)
- Any path under `/repos/{o}/{r}/actions/runners` (runner registration)
- Any path under `/repos/{o}/{r}/actions/secrets` (CI secrets)
- `PATCH /repos/{o}/{r}` (repo settings including visibility)
- `POST /repos/{o}/{r}/merges` (direct merge)
- `PUT /repos/{o}/{r}/contents/{path}` (direct file write)
- `/graphql` (GraphQL endpoint — single path bypasses all repo-scope checks)
- Any path not starting with `/repos/`

FR-5.5: `register_pr`, `merge_pr`, `pr_create`, `pr_view` ops on the agent socket shall apply
the same repo-scope check as `github_forward`. `merge_pr` shall fetch the PR's base branch
from GitHub and reject the merge if `base` is `main` or `master` (not `development` — agents
legitimately merge into `development`).

FR-5.6: Unit tests per design.

### FR-6: `push_branch` via bundle handoff

FR-6.1: `push_branch` agent socket op:
1. Validate `session_id` + `cap_token`
2. Validate `branch` pattern: `^(agent|feat|fix|chore)\/[A-Za-z0-9._\-]+(\/[A-Za-z0-9._\-]+)*$`.
   Reject if contains `..`, `:` (refspec separator), `+`, `@{`. Reject protected branches
   (`main`, `master`, `development`).
3. Agent creates the bundle in its session dir: handled by the `push_branch` MCP tool
   description (agents call `git bundle create ./push-bundle.bundle <branch>`).
4. Daemon reads bundle from fixed path `{worktreeBase}/{sid}/work/push-bundle.bundle`:
   - Open with `fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)`
     (O_NONBLOCK prevents blocking on a named pipe before the isFile check)
   - `fstat` — require regular file, reject if > 50 MB
   - Read exactly `stat.size` bytes into a daemon-owned buffer (not read-until-EOF)
   - Write to `/srv/agent-router/push-tmp/{sid}/input.bundle` via `mkdtemp` (daemon-owned,
     mode 0700, deleted in `finally` block — on both success and failure)
5. Run `git bundle verify /srv/agent-router/push-tmp/{sid}/input.bundle` in a clean env.
6. Inspect the bundle's changed file paths via `git bundle list-heads` then diff-tree.
   **Reject the bundle if any path starts with `.github/`** — agents pushing workflow files
   would run with the repo's Actions token on the next `push` trigger, bypassing all controls.
7. Create bare repo at `/srv/agent-router/push-tmp/{sid}/repo/`, fetch bundle into it:
   `git fetch {bundlepath} refs/heads/{branch}:refs/heads/{branch}`
   with `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null -c core.hooksPath=/dev/null
   -c core.fsmonitor=false -c credential.helper=` and all args as array (no shell).
8. Push from the daemon-owned bare repo using PAT in child env only (`GIT_ASKPASS_PASSWORD`
   env var; fixed helper `/usr/local/libexec/agent-router-askpass` root:root 0755 echoes it).
   Push refspec: `refs/heads/{branch}:refs/heads/{branch}`.
   Flags include `GIT_TERMINAL_PROMPT=0`.
9. Cleanup push-tmp dir in `finally` block (success or failure).

FR-6.2: `push_branch` MCP tool (thin relay). Description instructs agent to run
`git bundle create ./push-bundle.bundle <branch>` first, then call this tool.

### FR-7: Hostname-filtered HTTPS proxy + iptables

FR-7.1: tinyproxy (version 1.11+ on Ubuntu 22.04, 1.10.x on 20.04 — check `FilterType` compat):
```
Port 8080
Listen 127.0.0.1
Allow 127.0.0.0/8
ConnectPort 443
Filter "/etc/tinyproxy/filter"
FilterDefaultDeny Yes
FilterType ere       # if 1.11+; else FilterExtended Yes
```
Filter file with anchored ERE patterns for all required hostnames.

Also add iptables REJECT for the `tinyproxy` uid (found via `id -u tinyproxy`) targeting
`169.254.0.0/16` and all RFC1918 ranges to prevent SSRF through proxy.

FR-7.2: iptables rules for `agentworker`:
- Applied atomically via `iptables-restore --noflush` from a file containing ONLY
  `:AGENTWORKER_OUT - [0:0]` and its rules — NO built-in chain policy lines.
- Idempotent jump rule: `iptables -C ... || iptables -I OUTPUT 1 ...`.
- IPv4: ESTABLISHED/RELATED, tcp/8080 to 127.0.0.1 (proxy), REJECT all else.
- IPv6: AGENTWORKER_OUT default DROP.
- NO direct DNS allow rule (proxy handles DNS, blocking prevents tunnelling).
- Save: write a **valid standalone restore file** `/etc/iptables/agent-router-rules.v4`
  with correct `*filter` header and `COMMIT` trailer (so `iptables-restore` can load it on
  boot). A separate systemd unit `agent-router-iptables.service` runs
  `iptables-restore --noflush /etc/iptables/agent-router-rules.v4` before
  `agent-router.service` starts (`Before=agent-router.service`, `WantedBy=network.target`).
  This replaces `iptables-persistent` and avoids interfering with Docker/ufw rules.

FR-7.3: `HTTPS_PROXY=http://127.0.0.1:8080` in child env (sudoers `env_keep` + spawn env).

FR-7.4: Startup check reads `/etc/iptables/agent-router-rules.v4` for string `AGENTWORKER_OUT`.
Logs WARNING if absent or file unreadable. This checks the on-disk config only (no
`CAP_NET_ADMIN` needed); the systemd unit is what ensures it is actually loaded.

FR-7.5: `xt_owner` available Ubuntu 20.04+ (kernel 5.4+), loaded automatically.

FR-7.6: Setup script checks for `ufw` before installing `iptables-persistent` and fails with
an error if ufw is active, instructing the operator to configure ufw instead.

## Non-Functional Requirements

NFR-1.1: `agentworker` cannot read `tokens.json` or `daemon-token` from disk.
NFR-1.2: `agentworker` HTTPS traffic is forced through hostname-filtering proxy.
NFR-1.3: `GITHUB_TOKEN` not in agent child env when `useWorkerUid: true`.
NFR-1.4: No raw credential op on agent socket.
NFR-2.1: All tier1/tier2 vitest tests pass after each item.
NFR-2.2: End-to-end session with `useWorkerUid: true` completes.
NFR-3.1: Daemon startup logs `useWorkerUid` mode.
NFR-3.2: Blocked `github_forward` logs daemon-side WARN.
NFR-4.1: Setup completes on Ubuntu 20.04+.
NFR-4.2–4.3: Daemon starts with/without setup.

## Acceptance Criteria

AC-1: `sudo -u agentworker cat $rootDir/tokens.json` → exit 1, "Permission denied".
AC-2: `sudo -u agentworker cat $rootDir/daemon-token` → exit 1, "Permission denied".
AC-3: `tools/list` has no `git_credential`.
AC-4: `github_forward {method:POST, path:/repos/o/r/hooks}` → error "not permitted".
AC-5: `github_forward {method:GET, path:/repos/o/r/pulls/1}` → success.
AC-6: `github_forward {path:/repos/o/r/pulls/%2e%2e}` → error "not permitted".
AC-7: Daemon startup log contains `useWorkerUid: true`.
AC-8: `sudo -u agentworker curl -x http://127.0.0.1:8080 --max-time 5 https://example.com` → blocked by filter.
AC-9: `ip6tables -S AGENTWORKER_OUT` ends in `-j DROP`.
AC-10: Agent socket returns `{error:"Unknown op"}` for `{op:"get_token"}`.
AC-11: `github_forward {path:\\repos\\o\\r\\hooks}` (backslash) → error "not permitted".

## Known Residual Risks

- GitHub/S3 as exfil targets (documented).
- kiro login tokens in `/home/agentworker/.kiro` readable by agent process.
- Shared `agentworker` uid — mitigated by refusing concurrent cross-project sessions (FR-4.6).
- `*.amazonaws.com` can resolve to private IPs → tinyproxy SSRF rules block this (FR-7.1).

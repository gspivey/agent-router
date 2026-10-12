# Security Setup — Agent Process Isolation

This is the complete operator guide for the agent process isolation substrate. It covers the
prerequisites, the setup procedure, the full acceptance-criteria verification matrix, the
residual risks, and how to revert or debug. The condensed version lives in the README under
["Security Setup (agent process isolation)"](../README.md#security-setup-agent-process-isolation);
this document is the authoritative reference it points to.

The threat model and the per-requirement rationale live in
[`.kiro/specs/agent-process-isolation/requirements.md`](../.kiro/specs/agent-process-isolation/requirements.md)
and [`design.md`](../.kiro/specs/agent-process-isolation/design.md).

## Why

By default the daemon and every agent session run as the **same** Unix user. A prompt-injected
agent can therefore:

- read your project PATs from `$ROOTDIR/tokens.json` and the daemon bearer token from
  `$ROOTDIR/daemon-token`;
- make arbitrary outbound network requests with those credentials;
- call unrestricted GitHub API endpoints via the MCP tools.

Enabling isolation (`"useWorkerUid": true`) closes those vectors:

| Threat | Mitigation |
|---|---|
| Read `tokens.json` / `daemon-token` | `$ROOTDIR` mode 750; token files mode 600; `agentworker` not in the group |
| Read `GITHUB_TOKEN` from the agent env | Withheld at spawn time; the adapter strips it and the spawner deletes it |
| `get_token` / raw credential op on the agent socket | Not registered on the agent socket (`{error:"Unknown op"}`) |
| Cross-session cap-token theft | Daemon refuses concurrent **cross-project** sessions in `useWorkerUid` mode |
| GitHub allowlist bypass via path tricks | Raw per-segment path validation (no decode-before-check) |
| Direct network egress bypassing the proxy | iptables REJECT for the `agentworker` uid; IPv6 DROP |
| `git push` leaking a PAT via argv/disk | `GIT_ASKPASS` helper feeds the PAT via env only |
| `git push` running attacker-controlled hooks | Push runs from a daemon-owned bare repo with `core.hooksPath=/dev/null` |
| Operator socket reachable by the agent | Operator socket `$ROOTDIR/sock` is mode 0600 |

This is **opt-in and Linux-only**. With `useWorkerUid: false` (the default) the daemon behaves
exactly as before and none of the setup below is required — the agent server still starts (it
falls back to `$ROOTDIR/agent.sock`) so the per-session MCP relay works in both modes.

## Prerequisites

- A Debian/Ubuntu host (20.04+). `xt_owner` (used by the iptables uid match) ships with the
  stock kernel (5.4+).
- Root access to run `scripts/setup-agent-user.sh`.
- The following packages: `sudo`, `iptables`, `tinyproxy`. The setup script installs
  `tinyproxy` via `apt` if it is missing.
- **Do not** install `iptables-persistent`. The setup script installs its own
  `agent-router-iptables.service` systemd unit to restore the rules on boot, which replaces
  `iptables-persistent` and avoids clobbering Docker/ufw rules.
- `ufw` must **not** be active — it conflicts with the egress rules. The setup script aborts
  if ufw is running. Disable ufw or add equivalent egress rules by hand.

## Setup

Run the setup script as root, pointing it at your kiro binary and daemon root dir:

```bash
sudo KIRO_PATH=/abs/path/to/kiro ROOTDIR=/home/agentrouter/.agent-router \
     ./scripts/setup-agent-user.sh
```

The script is **idempotent** — safe to re-run after an upgrade. It:

1. Creates the `agentworker` system user (home `/home/agentworker`, `nologin` shell).
2. Writes `/etc/sudoers.d/agent-router-worker` (mode 440, validated with `visudo -c`): lets the
   daemon run `kiro acp` as `agentworker`, run the two fixed wrapper scripts, run read-only
   `git rev-parse`/`git log` in the worktree base as `agentworker`, and
   `pkill -KILL -u agentworker`.
3. Hardens `$ROOTDIR` to mode 750 and `tokens.json` / `daemon-token` / `config.json` to
   mode 600, owned by the daemon user. `agentworker` is not in the group and cannot read them.
4. Creates `/srv/agent-router/worktrees` (setgid 2755, per-session standalone clones) and
   `/srv/agent-router/push-tmp` (0700, daemon-only push staging).
5. Creates `/run/agent-router/` (setgid 2750) via `tmpfiles.d` for the agent socket.
6. Installs fixed root-owned wrapper scripts under `/usr/local/libexec/`:
   `agent-router-seed-clone`, `agent-router-rm-session`, and `agent-router-askpass`.
7. Installs tinyproxy on `127.0.0.1:8080` with `FilterDefaultDeny Yes` and an anchored
   hostname allowlist (GitHub, Anthropic, AWS, kiro.dev, npm registry).
8. Installs iptables rules so `agentworker` can only reach the proxy (REJECT everything else,
   IPv6 DROP), plus a `TPROXY_SSRF_BLOCK` chain that stops the proxy itself from reaching
   link-local / RFC1918 addresses. Rules persist to `/etc/iptables/agent-router-rules.v{4,6}`
   and are restored on boot by `agent-router-iptables.service`.

### Enabling it

1. Run the setup script (above).
2. Authenticate kiro for the worker user:
   ```bash
   sudo -u agentworker /abs/path/to/kiro login     # or: sudo -u agentworker kiro-cli login
   ```
3. Set `"useWorkerUid": true` in `config.json`.
4. Restart the daemon: `systemctl restart agent-router`.

On startup the daemon logs its mode and runs two advisory checks:

```
Process isolation config { useWorkerUid: true }
```

If a secret file is group/other-readable it logs
`Secret file is group/other-readable — tighten permissions`, and if the iptables rules file is
missing or lacks the `AGENTWORKER_OUT` chain it logs
`iptables rules file ... — egress may be unfiltered`. Both are **warnings only** and never
block startup — they tell you the substrate is not fully in place.

## Verification (acceptance criteria)

After enabling, verify the isolation boundary. `$ROOTDIR` is your daemon root dir.

### Filesystem (AC-1, AC-2)

```bash
# The worker cannot read daemon secrets
sudo -u agentworker cat "$ROOTDIR/tokens.json"    # → Permission denied (exit 1)
sudo -u agentworker cat "$ROOTDIR/daemon-token"   # → Permission denied (exit 1)
```

### Startup mode (AC-7)

```bash
journalctl -u agent-router | grep 'useWorkerUid: true'
```

### MCP tool surface (AC-3, AC-10)

```bash
# AC-3: the raw-credential tool is gone from the agent's tool list
#   (inspect the running session's tools/list — git_credential must be absent)

# AC-10: the agent socket rejects any op not on its allowlist
#   { op: "get_token", ... }  →  { error: "Unknown op" }
```

AC-3 is exercised by `test/tier1/mcp-server.test.ts` and AC-10 by
`test/tier1/agent-server.test.ts`.

### GitHub allowlist + path validation (AC-4, AC-5, AC-6, AC-11)

These are exercised by `test/tier1/agent-server.test.ts` and
`test/tier2/agent-isolation.test.ts` against injected fetch/exec stubs (no real GitHub call):

| AC | Request | Expected |
|---|---|---|
| AC-4 | `github_forward {POST /repos/o/r/hooks}` | `{error:"not permitted"}`, no GitHub call |
| AC-5 | `github_forward {GET /repos/o/r/pulls/1}` | allowed |
| AC-6 | `github_forward {GET /repos/o/r/pulls/%2e%2e}` | `{error:"not permitted"}` |
| AC-11 | `github_forward {\repos\o\r\hooks}` (backslash) | `{error:"not permitted"}` |

### Network egress (AC-8, AC-9)

```bash
# AC-8: non-allowlisted host blocked by the proxy filter
sudo -u agentworker curl -x http://127.0.0.1:8080 --max-time 5 https://example.com   # → blocked

# AC-9: no direct IPv6 egress for the worker
sudo ip6tables -S AGENTWORKER_OUT   # → ends in "-j DROP"
```

### Socket modes (FR-4.1 / FR-4.2)

```bash
stat -c '%a %n' "$ROOTDIR/sock"                 # → 600  (operator socket; agentworker cannot connect)
stat -c '%a %n' /run/agent-router/agent.sock    # → 660  (agent socket; agentworker group can connect)
```

Both are exercised by `test/tier2/agent-isolation.test.ts`.

## Residual risks

- **Shared `agentworker` uid across sessions.** All sessions run as the one `agentworker` user,
  so a compromised session could implant files under `/home/agentworker/.kiro/` (hooks, config)
  that execute in a later session for a *different* project. The daemon mitigates the
  cross-session cap-token-theft vector by **refusing concurrent sessions for different projects**
  when `useWorkerUid` is on, but operators running high-sensitivity sessions should **restart the
  daemon between projects**. Full per-session-uid isolation is deferred.
- **GitHub and S3 remain reachable** (they are on the proxy allowlist), so a determined agent
  could in principle exfiltrate to a repo or bucket it controls. This is accepted and documented.
- **kiro login tokens** under `/home/agentworker/.kiro/` are readable by the agent process (it
  runs as `agentworker`). These are the worker's own kiro credentials, not your GitHub PATs.
- **`*.amazonaws.com`** can resolve to private IPs; the `TPROXY_SSRF_BLOCK` chain blocks the
  proxy from reaching link-local and RFC1918 ranges to prevent cloud-metadata SSRF.

## Revert / debug

To **disable** isolation and return to the pre-isolation behavior:

1. Set `"useWorkerUid": false` in `config.json` (or remove the field — `false` is the default).
2. Restart the daemon: `systemctl restart agent-router`. Sessions once again run as the daemon
   user; the agent server still starts on `$ROOTDIR/agent.sock`.

The setup-script artifacts (the `agentworker` user, sudoers file, iptables rules, tinyproxy) are
harmless when `useWorkerUid` is false — nothing spawns under the worker uid, and the egress rules
only match the `agentworker` uid, which is not used. You may leave them in place for a later
re-enable.

To fully remove the substrate:

```bash
sudo systemctl disable --now agent-router-iptables.service
sudo iptables -F AGENTWORKER_OUT 2>/dev/null; sudo iptables -X AGENTWORKER_OUT 2>/dev/null
sudo ip6tables -F AGENTWORKER_OUT 2>/dev/null; sudo ip6tables -X AGENTWORKER_OUT 2>/dev/null
sudo rm -f /etc/iptables/agent-router-rules.v4 /etc/iptables/agent-router-rules.v6
sudo rm -f /etc/sudoers.d/agent-router-worker /etc/tmpfiles.d/agent-router.conf
sudo systemctl disable --now tinyproxy
# Optionally: sudo userdel -r agentworker
```

**If the daemon warns at startup** that a secret file is group/other-readable, re-tighten it:

```bash
chmod 600 "$ROOTDIR/tokens.json" "$ROOTDIR/daemon-token" "$ROOTDIR/config.json"
chmod 750 "$ROOTDIR"
```

**If it warns that the iptables rules are missing**, re-run the setup script (it is idempotent)
or confirm the restore unit ran:

```bash
systemctl status agent-router-iptables.service
sudo iptables -S AGENTWORKER_OUT
```

**If a session fails to spawn with `useWorkerUid not supported for claude-code adapter`**, that
repo is configured to use the Claude Code adapter, which has no sudo uid-drop path. Either run
that repo without `useWorkerUid`, or switch it to the kiro adapter.

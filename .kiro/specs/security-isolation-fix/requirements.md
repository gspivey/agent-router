# Security Isolation Fix — Requirements

## Overview

ROADMAP items 83–86 (PRs #149–152) shipped the agent-process-isolation feature from the
pre-review version of `.kiro/specs/agent-process-isolation/`. PR #153 then applied ten rounds
of review corrections to that spec's `requirements.md` and `design.md`. The shipped code was
never re-aligned to the corrected spec.

Three code paths and three provisioning steps now diverge from the corrected design. Each
divergence weakens a security boundary the corrected spec intended to be strict. This spec
covers **only the delta** — it brings the implementation back into alignment with the already-
corrected `.kiro/specs/agent-process-isolation/` spec. It introduces no new security features.

The corrected spec files are authoritative and MUST NOT be edited by this work:

- `.kiro/specs/agent-process-isolation/requirements.md`
- `.kiro/specs/agent-process-isolation/design.md`
- `.kiro/specs/agent-process-isolation/tasks.md`

## Scope

Two PR-sized units of work, each shipped as one ROADMAP item:

- **Item 90 — code fixes (bugs 1–3):** `src/mcp-server.ts`, `src/index.ts`, `src/agent-server.ts`.
- **Item 91 — provisioning fixes (bugs 4–6):** `scripts/setup-agent-user.sh`, a daemon startup
  check in `src/isolation-startup.ts`, and operator docs.

Item 91 depends on item 90: both items modify `src/index.ts` and the shared isolation startup
surface; sequencing avoids a merge conflict.

## Out of Scope

- Any new security feature beyond closing the six documented gaps.
- Editing the corrected `agent-process-isolation` spec files (they are already correct).
- Actually running `scripts/setup-agent-user.sh` on a host — that is a deploy-time operator
  action, not a code change. This spec only adds the script step, the startup warning, and the
  runbook documentation.

## Functional Requirements

### FR-1: MCP socket fallback removed (Bug 1 — CRITICAL)

**Context.** `resolveAgentSocket()` in `src/mcp-server.ts` currently resolves the agent socket as:

```typescript
ctx.agentSocket ??
process.env['AGENT_ROUTER_AGENT_SOCK'] ??
process.env['AGENT_ROUTER_SOCKET'] ??   // ← operator socket
daemonSocket                             // ← operator socket
```

The two trailing fallbacks point at the operator/daemon socket. The operator socket serves
privileged ops (e.g. `get_token`) and performs **no** cap-token validation. Any relay that
falls through to it (`github_http_forward`, `push_branch`, `pr_create`, `pr_view`) bypasses the
entire credential boundary described in `agent-process-isolation` design §C ("The MCP server
never reads `AGENT_ROUTER_SOCKET` and never falls back to it").

FR-1.1: `resolveAgentSocket()` SHALL resolve only from `ctx.agentSocket` (test override) and
`process.env['AGENT_ROUTER_AGENT_SOCK']`, in that order.

FR-1.2: When neither source yields a non-empty path, `resolveAgentSocket()` SHALL throw an
`Error` whose message is exactly:
`AGENT_ROUTER_AGENT_SOCK not set; cannot relay MCP tool`.

FR-1.3: The function SHALL NOT reference `process.env['AGENT_ROUTER_SOCKET']` or `daemonSocket`.
An empty-string env value SHALL be treated as unset (throw), not as a valid path.

FR-1.4: When `resolveAgentSocket()` throws inside a `tools/call` handler, the existing
`handleToolsCall` catch path SHALL surface the message as an `isError: true` tool result rather
than crashing the MCP server.

### FR-2: PAT source for the agent server uses the credential token store (Bug 2 — HIGH)

**Context.** In `src/index.ts`, `createAgentServer(...)` is wired with
`tokenResolver: (o, r) => tokenResolver(o, r)`, where `tokenResolver` was built with
`envFallback: true`. A misconfigured per-repo token therefore silently falls back to the
daemon's inherited `GITHUB_TOKEN`. The corrected spec (design §H push_branch step 6) requires
the agent-side PAT to come from `credentialTokenStore.getToken()` with **no** env fallback, so a
missing project token fails closed instead of leaking the daemon's ambient credential.

FR-2.1: The token source passed to `createAgentServer` SHALL be the exported helper
`credentialTokenResolver(credentialTokenStore)`. The helper resolves:
`store.findProjectByRepo(`${owner}/${repo}`)` → `store.getToken(projectName)` → `secret.reveal()`,
throwing `Error(`No token configured for repo ${owner}/${repo}`)` when either lookup returns
`undefined`. It SHALL NOT reference the daemon's envFallback `tokenResolver`.

FR-2.2: When the credential token store has no token for the session's bound repo, the adapter
SHALL throw `Error(`No token configured for repo <owner>/<repo>`)`. In `push_branch`, the
existing outer `try/catch` at the handler level (which returns `{ error: 'push failed' }`) wraps
the `resolvePat` call; this is sufficient for the fail-closed requirement — no additional
try/catch is needed inside `push_branch`. For `github_http_forward`, the existing
`try { pat = resolvePat(authRepo); } catch { return { error: 'not permitted' }; }` also
satisfies this. Both PAT-dependent ops fail with a `{ error }` response and no push/request is
attempted when the token is absent.

FR-2.3: The daemon's other uses of `tokenResolver` (the `github` client, the per-session
`acpSpawner` token env) are unchanged by this requirement — only the `createAgentServer` token
source changes.

FR-2.4: **Breaking change for operators without project-scoped `tokens.json`.**

The replaced resolver used `perRepoTokens` (from `config.json`) and `GITHUB_TOKEN` as fallbacks.
After Fix 2, the only valid token source is `tokens.json` via `credentialTokenStore`. Affected
operators include: (a) `_fallback` mode (no `tokens.json`, only `GITHUB_TOKEN` set) — the
`_fallback` project has an empty repo index; (b) operators relying on `config.json`
`repos[].token` or `defaultGithubToken` for agent-socket operations.

In all these cases, `credentialTokenResolver` THROWS `No token configured for repo <slug>` for
every repo not listed in a `tokens.json` project. This means `push_branch`, `pr_create`,
`pr_view`, and authenticated `github_http_forward` all fail closed. This is the intended security
outcome. `tokens.json` is now required for agent-socket PAT operations — every repo used by an
agent must appear in a project's `repos` array.

The daemon SHALL emit an advisory WARNING at startup when the credential store is in `_fallback`
mode, informing operators that agent-socket PAT operations are unavailable until a `tokens.json`
is created. This warning is added on item 90's branch. `docs/security-setup.md` and `README.md`
SHALL document this requirement.

### FR-3: `.github/` push guard fails closed (Bug 3 — HIGH)

**Context.** In `src/agent-server.ts`, the `push_branch` handler guards against workflow
(`.github/`) changes by comparing the pushed branch's `.github` tree SHA to the base branch's.
Both the base-branch fetch and the comparison are gated on `if (bareClonePath !== undefined)`.
When the daemon's canonical bare clone path is absent, the guard is silently skipped and the
push proceeds — an agent can push workflow-modifying commits unchecked. The corrected spec
(design §H, "**Reject the bundle if any path starts with `.github/`**") requires this check to
be mandatory.

FR-3.1: When `bareClonePath` is `undefined`, `push_branch` SHALL reject the push and return an
error whose message is exactly:
`bare clone not configured; push_branch cannot verify .github/ changes`.

FR-3.2: The rejection in FR-3.1 SHALL occur before any `git push` to the remote, so no push
happens when the `.github/` guard cannot run.

FR-3.3: When `bareClonePath` is defined, the existing tree-SHA comparison behavior is unchanged:
a differing `.github` tree still returns the existing
`Bundle modifies .github — workflow pushes are not permitted` error.

### FR-4: Setup script adds `agentrouter` to the `agentworker` group (Bug 4 — HIGH)

**Context.** The corrected design §C ("Socket group ownership") requires `agentrouter` to be a
supplementary member of `agentworker` so the daemon can `chown`/`chmod` the `0660` agent socket
and open it. `scripts/setup-agent-user.sh` never runs `usermod`, so the daemon gets `EACCES` on
the agent socket even after setup completes.

FR-4.1: `scripts/setup-agent-user.sh` SHALL add the daemon user to the worker group via
`usermod -aG agentworker agentrouter` (using the script's existing `WORKER_USER` /daemon-user
variables where present).

FR-4.2: The step SHALL be idempotent — re-running the script with the daemon already in the
group SHALL NOT fail the script.

FR-4.3: The reverse membership (`agentworker` added to the `agentrouter` group) SHALL NOT be
introduced; the corrected design forbids it because it would grant `agentworker` read access to
`$rootDir` (mode 750).

### FR-5: Startup warning when `agentworker` is missing under `useWorkerUid` (Bug 5 — MEDIUM)

**Context.** `scripts/setup-agent-user.sh` has never been run on the host, so the
`useWorkerUid: true` code path is inert — there is no `agentworker` uid to drop to. The fix is a
documented runbook step plus an advisory startup check that makes the misconfiguration visible.
This is **not** a new security feature; it surfaces an existing provisioning gap.

FR-5.1: A new advisory startup check SHALL log a WARNING when `config.useWorkerUid === true` and
the `agentworker` user/group does not exist on the host.

FR-5.2: The check SHALL be non-fatal — it logs and returns, matching the existing advisory
checks in `src/isolation-startup.ts` (`checkTokenFilePermissions`, `checkIptablesRules`). It
SHALL NOT throw and SHALL NOT run (or SHALL be a silent no-op) when `useWorkerUid` is `false`.

FR-5.3: The check SHALL use an injectable lookup (mirroring the existing `IsolationFsReader`
pattern) so it is unit-testable without a real `agentworker` account.

FR-5.4: `src/index.ts` startup SHALL invoke the new check, passing `config.useWorkerUid` and the
logger.

FR-5.5: `README.md` (and any deploy/runbook doc the change touches) SHALL document the
`sudo scripts/setup-agent-user.sh` provisioning step as a prerequisite for `useWorkerUid: true`.

### FR-6: iptables chain name consistency (Bug 6 — LOW)

**Context.** `scripts/setup-agent-user.sh` uses the chain name `TPROXY_SSRF_BLOCK` for the
tinyproxy egress rules, but the corrected design §F/§G names that chain `TINYPROXY_OUT`. This is
a cosmetic/consistency fix with no functional change — the chain is self-referential within the
script.

FR-6.1: `scripts/setup-agent-user.sh`, `README.md`, and `docs/security-setup.md` SHALL rename
every occurrence of the tinyproxy chain from `TPROXY_SSRF_BLOCK` to `TINYPROXY_OUT`, matching
design §F/§G. A repo-wide check `grep -rn TPROXY_SSRF_BLOCK scripts README.md docs` must return
no results after this change.

FR-6.2: The rename SHALL be a functional no-op — the chain's rules, the owner-matched jump from
`OUTPUT`, and its inclusion in the persisted `agent-router-rules.v4` file are unchanged apart
from the name.

## Non-Functional Requirements

NFR-1: All changes SHALL pass `npm run typecheck` and the Tier 1 + Tier 2 vitest suites.
NFR-2: Every behavioral change SHALL have vitest coverage (Tier 1 for pure logic; Tier 2 where
the change is observable through the daemon). Bug fixes 1, 2, 3, and 5 are behavioral and
require tests. Bug fixes 4 and 6 are shell-script text changes verified by assertion-style
checks (see tasks.md) rather than runtime tests.
NFR-3: No new runtime dependency SHALL be added.
NFR-4: Structured logging only — no `console.log` in production code. The startup warning uses
the `Logger` interface.

## Acceptance Criteria

AC-1: `resolveAgentSocket()` throws `AGENT_ROUTER_AGENT_SOCK not set; cannot relay MCP tool`
when neither `ctx.agentSocket` nor a non-empty `AGENT_ROUTER_AGENT_SOCK` is present; the
function body contains no reference to `AGENT_ROUTER_SOCKET` or `daemonSocket`.

AC-2: With `AGENT_ROUTER_AGENT_SOCK` set, `github_http_forward`/`push_branch`/`pr_create`/
`pr_view` relays resolve to that socket (unchanged happy path).

AC-3: `createAgentServer`'s token source resolves exclusively through the credential token store
(`findProjectByRepo` → `getToken` → `reveal()`); a repo with no stored token yields an error
from PAT-dependent ops, not a fallback to `GITHUB_TOKEN`. No reference to the daemon's
envFallback `tokenResolver` exists in the `createAgentServer` call site.

AC-4: `push_branch` returns `bare clone not configured; push_branch cannot verify .github/
changes` and performs no remote push when `bareClonePath` is `undefined`.

AC-5: With `bareClonePath` defined and the bundle touching `.github/`, `push_branch` still
returns the existing `Bundle modifies .github …` rejection.

AC-6: `scripts/setup-agent-user.sh` contains a `usermod -aG` step that adds the daemon user
(`$DAEMON_USER` / `agentrouter`) to the worker group (`$WORKER_USER` / `agentworker`), and does
not add `agentworker` to the `agentrouter` group. After running setup, operators must restart the
daemon for the new supplementary group membership to take effect.

AC-7: With `useWorkerUid: true` and no `agentworker` account, the daemon logs a WARNING at
startup and continues; with `useWorkerUid: false` no such warning is emitted.

AC-8: No file in `scripts/`, `README.md`, or `docs/` contains `TPROXY_SSRF_BLOCK`; the tinyproxy
chain is named `TINYPROXY_OUT` throughout.

AC-9: `README.md` documents `sudo scripts/setup-agent-user.sh` as the provisioning step for
`useWorkerUid: true`.

AC-10: When `credentialTokenStore` is in `_fallback` mode (no `tokens.json`), the daemon logs a
WARNING at startup stating that `push_branch`/`pr_create` require a `tokens.json`.

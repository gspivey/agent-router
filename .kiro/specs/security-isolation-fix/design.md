# Security Isolation Fix — Design

## Scope and relationship to the corrected spec

This spec realigns the shipped agent-process-isolation code with the corrected spec at
`.kiro/specs/agent-process-isolation/` (post PR #153). It changes **implementation only**; the
corrected `requirements.md` and `design.md` in that spec are authoritative and are not edited.
Every fix below cites the corrected design section it restores.

The work splits into two PR-sized ROADMAP items:

- **Item 90 — code fixes:** FR-1 (`src/mcp-server.ts`), FR-2 (`src/index.ts`),
  FR-3 (`src/agent-server.ts`).
- **Item 91 — provisioning fixes:** FR-4 and FR-6 (`scripts/setup-agent-user.sh`),
  FR-5 (`src/isolation-startup.ts` startup check + `src/index.ts` wiring + `README.md`).

Item 91 depends on item 90 and merges after it — both items modify `src/index.ts` and the
isolation startup surface, so sequencing avoids a merge conflict.

---

## Fix 1 — MCP socket fallback removed (FR-1, `src/mcp-server.ts`)

### Current state

`createMcpServer(ctx)` defines:

```typescript
function resolveAgentSocket(): string {
  return (
    ctx.agentSocket ??
    process.env['AGENT_ROUTER_AGENT_SOCK'] ??
    process.env['AGENT_ROUTER_SOCKET'] ??
    daemonSocket
  );
}
```

The last two fallbacks resolve to the operator/daemon socket. The agent-socket relays
(`github_http_forward`, `push_branch`, `pr_create`, `pr_view`) call `resolveAgentSocket()` to
pick the destination. When `AGENT_ROUTER_AGENT_SOCK` is unset, these relays silently retarget
the operator socket, which performs no cap-token validation and serves privileged ops such as
`get_token`. That is exactly the bypass the corrected design §C forbids: *"The MCP server never
reads `AGENT_ROUTER_SOCKET` and never falls back to it."*

### Target state

```typescript
function resolveAgentSocket(): string {
  // Coerce empty strings to undefined so `??` treats them as absent.
  const sock = (ctx.agentSocket || undefined) ?? (process.env['AGENT_ROUTER_AGENT_SOCK'] || undefined);
  if (sock === undefined) {
    throw new Error('AGENT_ROUTER_AGENT_SOCK not set; cannot relay MCP tool');
  }
  return sock;
}
```

Key points:

- `ctx.agentSocket = ''` is treated as absent and falls through to `AGENT_ROUTER_AGENT_SOCK`
  (coercion via `|| undefined`). Only when both are absent or empty does the function throw.
- No reference to `AGENT_ROUTER_SOCKET` or `daemonSocket` remains in the function.
- `daemonSocket` keeps its existing role for the non-relay ops (`session_status`, `register_pr`,
  `merge_pr`, `complete_session`, `register_worktree`, `report_outcome`), which already call
  `sendToDaemon(daemonSocket, …)` directly and are unaffected.
- The doc comment on `resolveAgentSocket`, the `McpContext.agentSocket` JSDoc, and the stale
  inline comments at `src/mcp-server.ts:240-242` ("falls back to the operator socket when
  isolation is off") and `src/session-mgr.ts:509-510` are updated to state that the only sources
  are `ctx.agentSocket` and `AGENT_ROUTER_AGENT_SOCK`, and that absence (including empty string)
  is a hard error.

### Error propagation

`resolveAgentSocket()` is called synchronously inside the `switch` of `handleToolsCall`, which is
wrapped in a `try/catch` that converts thrown errors into an `isError: true` tool result:

```typescript
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  writeResponse(makeSuccessResponse(req.id, {
    content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
    isError: true,
  }));
}
```

So a missing agent socket surfaces to the agent as a tool error carrying the exact message, and
the MCP server process stays alive (FR-1.4). No new catch is needed.

### `runMcpServerFromEnv` is unchanged

The standalone entry point still reads `AGENT_ROUTER_SOCKET` to populate `daemonSocket` — that is
the operator socket for the daemon-side ops and is correct. Only the *agent-socket* resolution
loses its fallback.

### Tests (Tier 1, `test/tier1/mcp-server.test.ts`)

`resolveAgentSocket` is a private closure inside `createMcpServer(ctx)`. Tests exercise it
indirectly through the relay tool calls (e.g. `github_http_forward`, `push_branch`) via the
`handleToolsCall` handler — or by extracting it to a small pure helper
`resolveAgentSocket(ctxSock: string | undefined, envSock: string | undefined): string` that is
unit-tested directly. Either approach satisfies the requirement.

Test matrix (using the coercion semantics from 90.1):

- `ctx.agentSocket = 'real-path'`, env unset → returns `'real-path'`.
- `ctx.agentSocket = undefined`, env = `'real-path'` → returns `'real-path'`.
- `ctx.agentSocket = ''`, env = `'real-path'` → returns `'real-path'` (empty ctx falls through to env).
- `ctx.agentSocket = undefined`, env unset → throws exact message.
- `ctx.agentSocket = ''`, env `''` → throws exact message.
- `AGENT_ROUTER_SOCKET` set, `AGENT_ROUTER_AGENT_SOCK` unset → throws (proves operator-socket fallback is gone).
- A relay tool call (`github_http_forward`) with no agent socket set → `isError: true` result with the error text; MCP server stays alive.

---

## Fix 2 — Agent-server PAT source is the credential token store (FR-2, `src/index.ts`)

### Current state

```typescript
// src/index.ts ~L643
const resolverCfg: Parameters<typeof createTokenResolver>[0] = {
  perRepoTokens,
  envFallback: true,
};
let tokenResolver = createTokenResolver(resolverCfg);
// …
// ~L794
const agentServer: AgentServer = createAgentServer({
  // …
  tokenResolver: (o, r) => tokenResolver(o, r),   // ← envFallback: true
  // …
});
```

`createAgentServer` requires `tokenResolver: TokenResolver` where
`TokenResolver = (owner: string, repo: string) => string` (`src/github.ts`). The agent server's
`resolvePat(repo)` splits `owner/repo` and calls it; the PAT then feeds `push_branch`'s
`GIT_ASKPASS_PASSWORD` and the `github_forward` auth header. Because the resolver was built with
`envFallback: true`, a repo with no configured token silently resolves the daemon's inherited
`GITHUB_TOKEN`.

The corrected design §H (push_branch step 6) requires: *"PAT comes from `credentialTokenStore`
for the session's bound repo — no env fallback"*, failing closed when no project token exists.

### Exportable helper required

`credentialTokenStore` is a `const` in `index.ts` and is never reassigned — `reload()` swaps its
internal token map in place. An inline closure at the `createAgentServer` call site therefore
cannot be tested from outside `main()`. The implementation MUST factor the adapter into an
exported pure helper:

```typescript
// src/token-resolver.ts (or co-located with token-store.ts)
export function credentialTokenResolver(store: TokenStore): TokenResolver {
  return (owner: string, repo: string) => {
    const slug = `${owner}/${repo}`;
    const projectName = store.findProjectByRepo(slug);
    const secret = projectName !== undefined ? store.getToken(projectName) : undefined;
    if (secret === undefined) {
      throw new Error(`No token configured for repo ${slug}`);
    }
    return secret.reveal();
  };
}
```

Usage in `index.ts`:

```typescript
const agentServer: AgentServer = createAgentServer({
  // …
  tokenResolver: credentialTokenResolver(credentialTokenStore),
  // …
});
```

Key points:
- Because `credentialTokenStore` is a `const` (never reassigned), passing it directly is safe —
  `reload()` mutates the store's internal map in place, and subsequent helper calls see the new
  tokens without any extra indirection.
- No path to `GITHUB_TOKEN`: the daemon's envFallback `tokenResolver` is not referenced.
- Fails closed: a repo with no stored project token throws `No token configured for repo <slug>`.
- The daemon's other `tokenResolver` consumers (`github` client, `acpSpawner` token env) are
  unchanged (FR-2.3).

### `_fallback` mode compatibility (FR-2.4)

When `tokens.json` is absent, `credentialTokenStore` creates a synthetic `_fallback` project
with an **empty** repo index. After Fix 2, `credentialTokenResolver` THROWS for every repo in
this mode (and for repos relying on `config.json` `perRepoTokens`/`defaultGithubToken`), so
`push_branch`, `pr_create`, `pr_view`, and authenticated `github_http_forward` all fail closed.

The daemon MUST emit an advisory WARNING at startup. Implement this as an exported helper
`checkAgentSocketTokenSource(store: TokenStore, log: Logger)` in `src/token-store-startup.ts`
(alongside the existing `validateTokenStoreStartup`), using the established `getProject('_fallback')`
detection (already used at `src/token-store-startup.ts:26`):

```typescript
export function checkAgentSocketTokenSource(store: TokenStore, log: Logger): void {
  if (store.getProject('_fallback') !== undefined) {
    log.warn(
      'tokens.json not found — agent-socket PAT operations (push_branch, pr_create, pr_view) ' +
      'require a tokens.json with project-scoped credentials',
      { hint: 'create tokens.json — see docs/security-setup.md' },
    );
  }
}
```

Call `checkAgentSocketTokenSource(credentialTokenStore, log)` from `main()` after the store
is initialized. The function is exported and independently testable (no `main()` needed). This
warning is added on item 90's branch. `docs/security-setup.md` and `README.md` are updated.

### Error propagation in PAT-dependent ops

When the adapter throws, the two consumers handle it as follows:

- **`push_branch`**: the throw from `resolvePat(sessionRepo)` at `~L559` is caught by the
  handler's outer `try/catch` at `~L579`, which returns `{ error: 'push failed' }`. No
  additional catch is needed; the existing pattern satisfies FR-2.2.
- **`github_http_forward`**: wrapped in `try { pat = resolvePat(authRepo); } catch { return
  { error: 'not permitted' }; }` — already surfaces a clean error.

Both PAT-dependent ops fail closed with a `{ error }` response and no push/request is attempted.

### Tests

- Tier 1 (exported helper): resolves a stored project token for a repo in that project's `repos`;
  throws `No token configured for repo <slug>` when the repo maps to no project or the project has
  no token; never reads `process.env['GITHUB_TOKEN']`. Reload test: build a store from a
  `tokens.json`, call the helper once, rewrite `tokens.json` with a different token, call
  `store.reload()`, call the helper again — the new token is returned (confirms `reload()` is
  sufficient, no reassignment needed).
- Tier 2: exercise a `push_branch` op against the agent-server harness with a real
  `createTokenStore` (temp `tokens.json` with no entry for the session repo) and a stub
  `bareClonePathFor` that returns a valid path (so Fix 3's guard does not fire first). Supply an
  `execFileImpl` stub that returns matching tree SHAs for `rev-parse`. Assert: `{ error }` is
  returned, no push command was issued to the stub, no `GITHUB_TOKEN` env var was present in any
  issued command. Also add a `github_http_forward` case asserting `fetchImpl` was never called.

---

## Fix 3 — `.github/` push guard fails closed (FR-3, `src/agent-server.ts`)

### Current state

Inside the `push_branch` handler:

```typescript
const bareClonePath = deps.bareClonePathFor?.(sessionRepo);

if (bareClonePath !== undefined) {
  // fetch base branch into refs/remotes/base/<baseBranch>
}

await execFileImpl('git', ['-C', bareRepo, 'bundle', 'verify', bundleDst], { env: CLEAN_GIT_ENV });
await execFileImpl('git', [/* fetch bundle into refs/heads/<branch> */], { env: CLEAN_GIT_ENV });

// .github tree-SHA comparison (named refs only) — fail closed on error.
if (bareClonePath !== undefined) {
  const tip  = await revParseTree(bareRepo, `refs/heads/${branch}:.github`);
  const base = await revParseTree(bareRepo, `refs/remotes/base/${baseBranch}:.github`);
  if (tip !== base) {
    return { error: 'Bundle modifies .github — workflow pushes are not permitted' };
  }
}

const pat = resolvePat(sessionRepo);
await execFileImpl('git', [/* push to origin */], { env: { …, GIT_ASKPASS_PASSWORD: pat } });
```

When `bareClonePath` is `undefined`, both the base-branch fetch and the `.github` comparison are
skipped, and execution falls straight through to the push.

**Real-world impact.** In production `bareClonePathFor` is always provided and only returns
`undefined` for a malformed `owner/repo` slug. When the bare clone path is valid but the
directory is absent, the base-branch fetch at `~L522` already throws (push fails as
`"push failed"`). The silent-skip therefore only occurs in test harnesses that omit
`bareClonePathFor` (or return `undefined`) and for malformed repo slugs. The fix is
defence-in-depth — any path reaching `push_branch` without a bare clone now fails closed
explicitly rather than silently.

### Target state

Hoist the `bareClonePath === undefined` rejection to immediately after `bareClonePathFor(...)` is
called, before the base-branch fetch and all bundle operations. This is the only correct
placement: it avoids performing side-effecting bundle work on untrusted input when the guard
cannot run. With the check hoisted, the `if (bareClonePath !== undefined)` guard around the
base-branch fetch and the tree-SHA comparison block are both removed — `bareClonePath` is now
known-present:

```typescript
const bareClonePath = deps.bareClonePathFor?.(sessionRepo);
if (bareClonePath === undefined) {
  return { error: 'bare clone not configured; push_branch cannot verify .github/ changes' };
}

// All subsequent code runs with bareClonePath guaranteed non-undefined.
// Fetch base branch:
await execFileImpl('git', ['-C', bareRepo, 'fetch', bareClonePath, …], { env: CLEAN_GIT_ENV });

// … bundle verify + fetch …

// .github tree-SHA comparison (no longer gated):
const tip  = await revParseTree(bareRepo, `refs/heads/${branch}:.github`);
const base = await revParseTree(bareRepo, `refs/remotes/base/${baseBranch}:.github`);
if (tip !== base) {
  return { error: 'Bundle modifies .github — workflow pushes are not permitted' };
}

const pat = resolvePat(sessionRepo);
// git push …
```

Because `return { error: … }` happens before `resolvePat`/push, no remote push occurs when the
guard cannot run (FR-3.2). The existing differing-tree rejection message is preserved verbatim
(FR-3.3).

**Existing test impact.** Any existing test that exercises `push_branch` with
`bareClonePathFor` returning `undefined` (or omitted) — previously relying on the silent-skip —
will now receive the `bare clone not configured …` error. Those tests must be updated to either
supply a defined `bareClonePath` or assert the new error. Do NOT delete such tests.

### Tests (Tier 1/Tier 2 against the agent-server harness)

- `push_branch` with `bareClonePathFor` returning `undefined` → result
  `{ error: 'bare clone not configured; push_branch cannot verify .github/ changes' }`, and the
  fake remote records **no** push.
- `push_branch` with a defined bare clone and a bundle touching `.github/` → existing
  `Bundle modifies .github …` rejection (regression guard).
- `push_branch` with a defined bare clone and a clean bundle → push proceeds (happy path).

---

## Fix 4 — Setup script adds `agentrouter` to `agentworker` group (FR-4, `scripts/setup-agent-user.sh`)

### Current state

The script creates `WORKER_USER="agentworker"` and its home, writes sudoers, hardens `$rootDir`,
etc., but never runs `usermod`. Per the corrected design §C ("Socket group ownership"), the
daemon's `fs.chownSync(sockPath, -1, agentworkerGid)` + `fs.chmodSync(sockPath, 0o660)` require
`agentrouter` to be a supplementary member of `agentworker`; otherwise the daemon gets `EACCES`
on the `0660` agent socket.

### Target state

Add, in the user-provisioning section (after `agentworker` is created), an idempotent step:

```bash
# The daemon user must be a supplementary member of the worker group so it can
# chown/chmod and open the 0660 agent socket (design §C, "Socket group ownership").
usermod -aG "$WORKER_USER" "$DAEMON_USER"
```

Where `$DAEMON_USER` is the script's existing daemon-user variable (the account that owns
`$rootDir`, i.e. `agentrouter`); if the script has no such variable, use the literal
`agentrouter` consistent with the rest of the script. `usermod -aG` is append-only and idempotent
— re-running when membership already exists is a no-op success (FR-4.2).

**Forbidden reverse membership.** The script must not add `agentworker` to the `agentrouter`
group; that would hand `agentworker` read access to `$rootDir` (mode 750). If the corrected spec
mandates an assertion, keep/extend it; this fix does not introduce the reverse (FR-4.3).

---

## Fix 5 — Startup warning when `agentworker` is missing under `useWorkerUid` (FR-5)

### Placement

A new advisory check joins the existing pair in `src/isolation-startup.ts`
(`checkTokenFilePermissions`, `checkIptablesRules`). It follows the same contract: injectable
dependency, logs a WARNING, never throws, safe to run unprivileged.

### Design

```typescript
/** Minimal user/group lookup surface, injectable for tests. */
export interface AgentUserLookup {
  /** True when the agentworker user (or group) exists on the host. */
  agentWorkerExists: () => boolean;
}

const defaultAgentUserLookup: AgentUserLookup = {
  agentWorkerExists: () => {
    // Non-throwing probe. Checks both /etc/passwd (for the user) and /etc/group
    // (for the group), since `sudo -u agentworker` needs the user to exist.
    // On systems using NSS/LDAP these files may not have the entry; the probe
    // returns false and the startup warning fires, which is the safe default.
    try {
      const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
      const group  = fs.readFileSync('/etc/group', 'utf-8');
      const userOk  = passwd.split('\n').some((l) => l.startsWith('agentworker:'));
      const groupOk = group.split('\n').some((l) => l.startsWith('agentworker:'));
      return userOk && groupOk;
    } catch {
      return false;
    }
  },
};

/**
 * FR-5: when the daemon is configured for uid isolation (`useWorkerUid: true`)
 * but the `agentworker` account was never provisioned (setup script not run),
 * the `sudo -u agentworker` spawn path is inert. Warn loudly at startup so the
 * operator runs `scripts/setup-agent-user.sh`. Non-fatal; no-op when
 * `useWorkerUid` is false.
 */
export function checkAgentWorkerUser(
  useWorkerUid: boolean,
  log: Logger,
  lookup: AgentUserLookup = defaultAgentUserLookup,
): void {
  if (!useWorkerUid) return;
  let exists: boolean;
  try {
    exists = lookup.agentWorkerExists();
  } catch {
    exists = false;  // treat a throwing lookup as "missing" — warn rather than crash
  }
  if (exists) return;
  log.warn('useWorkerUid is true but the agentworker account is missing — ' +
    'uid isolation is inert; run `sudo scripts/setup-agent-user.sh`', {
    useWorkerUid,
    hint: 'sudo scripts/setup-agent-user.sh',
  });
}
```

Notes:

- The probe must be **non-throwing** and must not require elevated privileges. Reading
  `/etc/group` is sufficient and matches the no-`CAP_NET_ADMIN` philosophy of the existing
  `checkIptablesRules`. An `execFileSync('getent', …)` wrapped in `try/catch` is an acceptable
  alternative; whichever is chosen, errors resolve to `false` (treat as "missing" and warn).
- The injectable `AgentUserLookup` keeps the function unit-testable without a real account
  (FR-5.3). This mirrors the existing `IsolationFsReader` injection pattern.

### Wiring in `src/index.ts`

Alongside the existing advisory calls early in `main()`:

```typescript
checkTokenFilePermissions(rootDir, log);
checkIptablesRules(log);
checkAgentWorkerUser(config.useWorkerUid ?? false, log);   // ← added (FR-5.4)
```

Placed with the other isolation startup checks (before/near DB init), so the warning appears
early in `daemon.log`.

### Tests (Tier 1, `test/tier1/isolation-startup.test.ts`)

- `useWorkerUid: false` → no warning regardless of lookup result.
- `useWorkerUid: true` + `agentWorkerExists() → false` → exactly one WARNING with the hint.
- `useWorkerUid: true` + `agentWorkerExists() → true` → no warning.
- `useWorkerUid: true` + `agentWorkerExists() → throws` → exactly one WARNING (the outer
  try/catch in `checkAgentWorkerUser` treats a throwing lookup as missing); no exception escapes
  the function.

### Docs (FR-5.5)

`README.md` gains an explicit provisioning step in the isolation/deploy section:
`sudo scripts/setup-agent-user.sh` is required before enabling `useWorkerUid: true`, and the
daemon logs a startup warning if the account is missing. The deploy/runbook doc at `docs/security-setup.md` is the natural home for the
provisioning step; add the restart requirement there and cross-link from README. Docs land on the
item-91 branch, not as a follow-up.

---

## Fix 6 — iptables chain rename `TPROXY_SSRF_BLOCK` → `TINYPROXY_OUT` (FR-6, `scripts/setup-agent-user.sh`)

### Current state

The tinyproxy SSRF-blocking chain is created and referenced as `TPROXY_SSRF_BLOCK`. The corrected
design §F/§G names this chain `TINYPROXY_OUT` consistently (create/flush, the metadata + RFC1918
REJECT rules, the owner-matched jump from `OUTPUT`, and the `:TINYPROXY_OUT - [0:0]` block in the
persisted `agent-router-rules.v4`/`.v6` files).

### Target state

Rename every occurrence of `TPROXY_SSRF_BLOCK` to `TINYPROXY_OUT` in the script. Because the
chain is self-referential within the script (it is created, filled, jumped-to, and persisted all
under the same name), the rename is a consistency change. Note: on a host that already ran the old script, the
live `TPROXY_SSRF_BLOCK` chain remains in memory until the next boot/iptables-restore; this is
safe since both chains REJECT, and since setup was never run on this host (Bug 5), no live chain
exists in practice. After the change, `grep -rn TPROXY_SSRF_BLOCK scripts README.md docs`
returns `0` and the chain name matches design §F/§G everywhere (FR-6.2).

### Verification

- `grep -rn TPROXY_SSRF_BLOCK scripts README.md docs` returns 0 results.
- The chain create (`iptables -N TINYPROXY_OUT`), flush, REJECT rules, the OUTPUT jump, and the
  `:TINYPROXY_OUT - [0:0]` lines in the persisted v4/v6 files all use the new name.
- `bash -n scripts/setup-agent-user.sh` (syntax check) passes.

---

## Testing summary

| Fix | Tier 1 | Tier 2 | Script assertion |
|---|---|---|---|
| 1 — MCP socket fallback | yes | — | — |
| 2 — PAT source | yes | yes (no-token path) | — |
| 3 — `.github` fail-closed | yes | yes (no push on reject) | — |
| 4 — usermod step | — | — | `grep -E 'usermod -aG.*WORKER_USER' scripts/setup-agent-user.sh`; absence of reverse |
| 5 — startup warning | yes | — | — |
| 6 — chain rename | — | — | grep absence of `TPROXY_SSRF_BLOCK`; `bash -n` |

Behavioral fixes (1, 2, 3, 5) require vitest coverage per the project's testing rules. The two
shell-only fixes (4, 6) are verified by grep/syntax assertions since they have no runtime surface
reachable from the daemon test harness. All work must leave `npm run typecheck` and the
Tier 1 + Tier 2 suites green.

## Non-goals / invariants preserved

- The corrected `agent-process-isolation` spec files are not modified.
- No new runtime dependency.
- `daemonSocket` keeps serving the non-relay daemon ops; only the agent-socket fallback is removed.
- The daemon's `tokenResolver` (with envFallback) remains in use for the `github` client and the
  per-session spawn env; only `createAgentServer`'s token source changes.
- The reverse group membership (`agentworker` → `agentrouter`) is never introduced.

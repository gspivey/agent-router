# Design: Claude Code Adapter for agent-router

## Architecture Overview

The design follows the existing adapter pattern established by `KiroAdapter`. A new file `src/adapters/claude-code.ts` implements `AgentAdapter`, and the adapter selection moves from a hardcoded `createKiroAdapter()` call to a per-repo lookup at spawn time.

```
┌─────────────────────────────────────────────────────────┐
│  src/index.ts                                           │
│                                                         │
│  configHolder.current.repos[i].adapter?.type            │
│       │                                                 │
│       ├── "kiro" (or absent) ──► createKiroAdapter()    │
│       └── "claude-code" ──► createClaudeCodeAdapter()   │
│                                                         │
│  acpSpawner lambda selects adapter per repo slug        │
└─────────────────────────────────────────────────────────┘
```

## Component Design

### 1. `src/adapters/claude-code.ts`

Mirrors `src/adapters/kiro.ts` in structure (~50 lines). Implements `AgentAdapter`.

```typescript
import type { ACPClient } from '../acp.js';
import type { AgentAdapter, AdapterCapabilities, SpawnOpts } from '../agent-adapter.js';
import type { Logger } from '../log.js';
import { spawnACPClient } from '../acp.js';

export interface ClaudeCodeAdapterDeps {
  /** Optional model override (e.g. "claude-opus-5"). Injected as ANTHROPIC_MODEL. */
  model?: string;
  log: Logger;
  /** Override spawn for testing. */
  spawnImpl?: (bin: string, args: string[], env: Record<string, string>) => ACPClient;
}

export function createClaudeCodeAdapter(deps: ClaudeCodeAdapterDeps): AgentAdapter {
  const spawnFn = deps.spawnImpl ?? spawnACPClient;

  return {
    name: 'claude-code',

    capabilities(): AdapterCapabilities {
      return {
        events: ['session.start', 'tool.post', 'turn.end', 'session.end'],
        perToolMatching: true,
      };
    },

    spawn(opts: SpawnOpts): ACPClient {
      const env: Record<string, string> = {
        ...(opts.env ?? {}),
        AGENT_ROUTER_SESSION_ID: opts.sessionId,
      };
      if (deps.model) {
        env['ANTHROPIC_MODEL'] = deps.model;
      }
      return spawnFn('npx', ['@agentclientprotocol/claude-agent-acp@latest', '--acp'], env);
    },

    async installHooks(_daemonUrl: string, _token: string): Promise<void> {
      deps.log.info(
        'ClaudeCodeAdapter.installHooks is a stub in this version',
      );
    },

    async uninstallHooks(): Promise<void> {
      // No-op stub
    },
  };
}
```

**Key decisions:**

- Uses `npx @agentclientprotocol/claude-agent-acp@latest --acp` as the spawn command. The `--acp` flag puts the package into stdio ACP server mode (JSON-RPC 2.0 over stdin/stdout).
- Does NOT add the package as a `dependencies` entry in package.json — `npx` handles download and caching. This avoids version pinning issues and keeps the adapter zero-install for operators who don't use Claude Code.
- Model override via `ANTHROPIC_MODEL` env var (the standard Claude Code mechanism).
- No "maxThinkingTokens" env var — Claude Code does not expose one. The original spec's reference to `MAX_THINKING_TOKENS` is incorrect; this field is dropped from the config schema.

### 2. Config Schema Extension (`src/config.ts`)

Add an optional `adapter` field to `RepoConfig`:

```typescript
export interface RepoAdapterConfig {
  type: 'kiro' | 'claude-code';
  /** Model override for Claude Code (e.g. "claude-opus-5"). Ignored for kiro. */
  model?: string;
}

export interface RepoConfig {
  owner: string;
  name: string;
  roadmapPath?: string;
  token?: string;
  webhookSecret?: string;
  /** Optional adapter override. Defaults to kiro when absent. */
  adapter?: RepoAdapterConfig;
}
```

**Validation rules (in `validateConfig`):**

- If `adapter` is present, it must be an object.
- `adapter.type` is required and must be `"kiro"` or `"claude-code"`. Unknown values throw `FatalError`.
- `adapter.model` is optional. If present, must be a non-empty string.

### 3. Adapter Selection in `src/index.ts`

Currently the adapter is a single instance created at startup:

```typescript
const adapter = createKiroAdapter({ kiroPath: config.kiroPath, log });
```

**Change:** Build an adapter map keyed by repo slug. The `acpSpawner` lambda looks up the correct adapter per `repo` argument.

```typescript
// Build adapter instances per-repo based on config
const adapters = new Map<string, AgentAdapter>();
const defaultAdapter = createKiroAdapter({ kiroPath: config.kiroPath, log });

for (const repo of config.repos) {
  const slug = `${repo.owner}/${repo.name}`;
  if (!repo.adapter || repo.adapter.type === 'kiro') {
    adapters.set(slug, defaultAdapter);
  } else if (repo.adapter.type === 'claude-code') {
    adapters.set(slug, createClaudeCodeAdapter({
      model: repo.adapter.model,
      log,
    }));
  }
}

// In acpSpawner:
acpSpawner: (sessionId: string, repo?: string) => {
  const adapterForRepo = repo ? (adapters.get(repo) ?? defaultAdapter) : defaultAdapter;
  // ... env building unchanged ...
  return adapterForRepo.spawn({ sessionId, env });
},
```

### 4. MCP Config Passthrough

The agent-router daemon's MCP tools (`register_pr`, `complete_session`, `session_status`) are made available to Claude Code sessions through the same mechanism as Kiro: the `AGENT_ROUTER_MCP_CONFIG` env var (or equivalent) is already part of the `buildChildEnv` overrides. No new work needed — the existing env passthrough handles this.

### 5. Session Recovery

The `@agentclientprotocol/claude-agent-acp` package supports `session/load` via the same ACP protocol. Session IDs (`AGENT_ROUTER_SESSION_ID`) are tracked identically in session-files. Resume works via the existing `sessionMgr.resumeSessions()` path — it calls `loadSession(sessionId)` on the ACPClient, which is adapter-agnostic.

## Data Flow

```
Cron fires for repo "gspivey/edit-director"
  → sessionMgr.createSession(prompt, "gspivey/edit-director")
    → acpSpawner("sess_abc123", "gspivey/edit-director")
      → adapters.get("gspivey/edit-director") → ClaudeCodeAdapter
      → buildChildEnv(parentEnv, overrides, allowlist)
        overrides include: GITHUB_TOKEN, WORKDIR, AGENT_ROUTER_SESSION_ID, ANTHROPIC_MODEL
      → spawnACPClient("npx", ["@agentclientprotocol/claude-agent-acp@latest", "--acp"], env)
        → child process: JSON-RPC 2.0 over stdio
          → ACPClient.initialize()
          → ACPClient.newSessionWithPrompt(cwd, prompt)
```

## Config Hot-Reload Considerations

The `adapter` field within `repos` is classified as restart-required (it changes which process type is spawned). The `classifyConfigChange` function should detect adapter changes. However, since the per-repo adapter map is rebuilt on reload, and active sessions aren't affected until next spawn, this is safe to treat as reloadable for new sessions while existing sessions continue with their original adapter.

**Decision:** Treat adapter config changes as reloadable. The adapter map is rebuilt on config reload. Active sessions are unaffected (they already have a running subprocess).

## Files Changed

| File | Change |
|------|--------|
| `src/adapters/claude-code.ts` | New file (~50 lines) |
| `src/config.ts` | Add `RepoAdapterConfig` interface, `adapter` field to `RepoConfig`, validation logic |
| `src/index.ts` | Build adapter map, modify `acpSpawner` to select adapter per repo |
| `package.json` | No change (npx handles the package) |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `npx` cold-start latency on first spawn | Acceptable for cron-driven daemon; operator can pre-warm with `npx @agentclientprotocol/claude-agent-acp@latest --version` |
| Package version drift with `@latest` | Operator can pin by specifying exact version in a wrapper script; future enhancement to add `adapterVersion` config field |
| `ANTHROPIC_API_KEY` not available at spawn | Log warning at startup if Claude Code adapter is configured but key isn't in env or allowlist |

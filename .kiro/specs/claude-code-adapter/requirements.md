# Requirements: Claude Code Adapter for agent-router

## Overview

Add a second `AgentAdapter` implementation that spawns `@agentclientprotocol/claude-agent-acp` instead of `kiro-cli`, enabling per-repo selection of Claude Code as the coding agent backend.

## User Stories

### 1. Per-Repo Adapter Selection

**As a** daemon operator,
**I want to** configure individual repos to use Claude Code instead of Kiro,
**so that** I can run different agent backends for different projects without changing the global daemon config.

**Acceptance Criteria:**

- A repo config can include an optional `adapter` field with `type: "claude-code"`.
- When `adapter` is absent or `adapter.type` is `"kiro"`, the existing KiroAdapter is used (no behavioral change).
- When `adapter.type` is `"claude-code"`, cron triggers and webhook-driven sessions for that repo spawn a Claude Code ACP subprocess.
- The `adapter` field supports an optional `model` string (e.g., `"claude-opus-5"`) passed via `ANTHROPIC_MODEL` env var.

### 2. Config Validation

**As a** daemon operator,
**I want** clear startup errors if I misconfigure the adapter field,
**so that** I catch problems before any session is spawned.

**Acceptance Criteria:**

- Unknown `adapter.type` values (anything other than `"kiro"` or `"claude-code"`) cause a `FatalError` at config validation time with a descriptive message.
- If `adapter.type` is `"claude-code"` and `ANTHROPIC_API_KEY` is not resolvable in the child environment, a warning is logged at startup (not fatal — the key may be in the allowlist or resolved later).
- `adapter.model` must be a non-empty string if present; empty string is rejected.

### 3. Environment Passthrough

**As a** daemon operator,
**I want** the Claude Code adapter to inherit the same session env semantics as Kiro (token injection, worktree WORKDIR, AGENT_ROUTER_SESSION_ID),
**so that** MCP tools and session tracking work identically regardless of adapter.

**Acceptance Criteria:**

- `AGENT_ROUTER_SESSION_ID` is injected into the Claude Code subprocess env, matching Kiro behavior.
- `GITHUB_TOKEN` (resolved per-repo) is passed through identically.
- `WORKDIR` from the worktree manager is set when available.
- Agent-router MCP config is available to the subprocess so `register_pr`, `complete_session`, `session_status` tools work.
- The `childEnvAllowlist` config is respected for the Claude Code subprocess.

### 4. Session Lifecycle Compatibility

**As a** session manager,
**I want** Claude Code sessions to participate in the same lifecycle (create, inject prompt, cancel, timeout, resume) as Kiro sessions,
**so that** no session-manager logic needs adapter-specific branches.

**Acceptance Criteria:**

- The Claude Code adapter returns an `ACPClient` from `spawn()` — the same interface used by Kiro.
- Session timeout (inactivity + max lifetime) applies identically.
- Session resume (item 48) works via the `kiro_session_id`-equivalent mechanism the package exposes.
- `sessionMgr.injectPrompt()` works for Claude Code sessions without modification.

### 5. Backward Compatibility

**As an** existing user with repos that have no `adapter` config,
**I want** zero behavioral changes after the upgrade,
**so that** I can adopt Claude Code incrementally.

**Acceptance Criteria:**

- All repos without an `adapter` field continue using KiroAdapter exactly as before.
- The global `kiroPath` config field remains required and validated (it's still the default adapter).
- No changes to `ACPClient` or `AgentAdapter` interfaces.
- Existing tests pass without modification.

## Out of Scope

- Session resume across daemon restarts specifically for Claude Code (covered by session-recovery spec, item 48).
- Multiple adapter configs for the same repo.
- Dynamic adapter switching mid-session.
- Claude Code–specific hook installation (installHooks remains a stub for now).

# Agent Router — Product Overview

## What it is

Agent Router is a single-user TypeScript daemon that bridges external events to ACP-compatible coding agents. It runs on the developer's machine behind a Cloudflare tunnel.

## What it does

**Core loop.** Receives GitHub webhooks, applies a multi-stage wake policy, spawns a coding agent (Kiro CLI today) over ACP, and routes events to persistent agent sessions mapped to PRs. Streams all activity to append-only NDJSON files for observability.

**Multi-entrypoint session routing.** The same session can receive prompts from a webhook, a CLI command, a cron job, an editor, or a web dashboard. Sessions are the hub; input sources are pluggable.

**Trust-tiered wake policy.** Webhook events are filtered by author trust: repo owners and CI bots wake on any event, collaborators wake only on `/agent` prefix, untrusted commenters never wake. Computed from `comment.author_association` on every webhook payload — no allowlist to maintain.

**Agent-agnostic via ACP.** The session management layer is independent of the agent runtime. Today it drives Kiro. Tomorrow it could drive Hermes, Claude Code, or a custom agent. Anything that speaks ACP over stdio works.

**Observable file-based streaming.** `tail -f stream.log` from any terminal. No special client needed. Multiple terminals can watch the same session simultaneously.

## Architecture

```
GitHub webhooks ──→ POST /webhook ──→ HMAC verify ──→ wake policy ──→ session lookup
CLI ──────────────→ Unix socket ───→ new_session / inject_prompt / list / terminate
Cron ─────────────→ CLI ───────────→ new_session with roadmap task
                                          │
                                          ▼
                                    Session Manager
                                    (in-memory registry + meta.json persistence)
                                          │
                                          ▼
                                    ACP Client ──→ Kiro CLI (subprocess)
                                          │
                                          ▼
                                    stream.log / prompts.log / meta.json
```

Entrypoints:

1. **GitHub webhooks** — event-driven, daemon processes automatically
2. **CLI IPC** — `agent-router prompt --new`, `ls`, `tail`, `terminate`
3. **Cron** — OS scheduler invokes CLI to create sessions from a roadmap
4. **MCP (reverse)** — agent calls back to daemon to register PRs, signal completion

Future entrypoints (see `ROADMAP.md`): ACP server for editor integration, web dashboard.

## What sets Agent Router apart

### Genuinely differentiating

1. **PR-scoped persistent sessions.** No other tool maintains a `(repo, PR) → agent session` mapping where multiple events for the same PR accumulate context in the same conversation. Hermes, Claude Code, and Cursor all create fresh contexts per interaction.

2. **Session-aware wake policy with trust tiers.** The daemon only wakes an agent if a session is registered for the PR, AND the event author is trusted enough to direct the agent. This prevents both runaway agent spawning and prompt-injection from untrusted commenters.

3. **Multi-entrypoint session routing.** The session is the hub, not the input source. Same session, multiple input channels, consistent context.

4. **Observable file-based streaming.** Plain `tail -f` works. No client app, no API tokens, no auth flow.

5. **Agent-agnostic via ACP.** Pluggable agent runtime. Pluggable UI surfaces. Only the session router itself is fixed.

### Overlaps with existing tools (not differentiating)

- Webhook intake and HMAC verification (Hermes, GitHub Actions)
- Prompt composition from event payloads (Hermes templates)
- Per-PR rate limiting (standard practice)
- Cron-triggered runs (Hermes has built-in cron with platform delivery; ours is simpler)

### The thesis

Agent Router is a **session router for coding agents** — not an agent itself, not a webhook processor, not a chat interface. Its value is the session registry and the ability to route inputs from any source to the right agent session. The agent, the UI, and the event sources are all pluggable.

## Phased plan

The strategic direction, in dependency order. This is *what* we build over months and *in what order*; the PR-sized, ready-to-build slice of it lives in [`ROADMAP.md`](ROADMAP.md), and tactical fixes in [`BACKLOG.md`](BACKLOG.md). Phases are not strict gates — later-phase work can begin once its dependencies are stable.

1. **Production Stability.** Reliable unattended operation: deterministic session completion, self-wake prevention, token-expiry monitoring, collision handling, git worktrees per session, cleanup automation, health endpoint, restart survival. Most of `BACKLOG.md` P0–P1 lives here. The current focus.

2. **ACP Server — editor integration.** Expose agent-router's own ACP endpoint over stdio so any ACP editor (Zed, Cline, JetBrains) can drive sessions — mapping `session/new`, `session/prompt`, `session/load` and streaming `session/update`. Depends on Phase 1 (sessions must survive restarts and be resumable first).

3. **Web Dashboard.** Static SPA served by the daemon, REST + SSE over the existing IPC ops, session list/detail, prompt input, token/Cloudflare-Access auth. Primary use: checking overnight cron runs from a phone. Independent of Phase 2 — parallel entrypoints to the same session manager. (The web server and browser-test-harness work is the start of this.)

4. **Multi-Repo Projects & Sandboxing.** A project = a named group of repos with shared context; a feature = coordinated worktrees across them, spanning multiple PRs. Docker-based sandboxing isolates agent execution; project-level shared memory persists across features. Needs at least one UI (Phase 2 or 3).

5. **Swappable Agent Backends.** Abstract the backend behind a spawn/initialize/prompt/stream interface, refactor the Kiro driver to it, add a second backend (Hermes), per-session selection with health-monitored fallback. Informed by Phase 2's interface work.

**Sequencing:** Phases 2 and 3 are independent and can run in parallel (Phase 3 has more user-facing value if you only do one). Phase 4 needs a UI. Phase 5 is architecturally independent but most valuable once a dashboard exists.

## Open questions

1. **Web dashboard process model.** Embedded in the daemon (simpler, shared state) or separate process (better isolation)?

2. **Agent commit and push credentials.** Currently the agent has full filesystem access and uses an env-injected PAT. With worktree sandboxing, it needs scoped credentials per session. SSH deploy keys per repo? GitHub App installation tokens? See `BACKLOG.md` P3.1 (credential proxy spec).

3. **Session resumption across daemon restarts.** Sessions are in-memory today. Daemon restart loses them. ACP supports `session/load`; should we persist enough state to resume? See `BACKLOG.md` P2.1.

4. **Multi-agent coordination.** A feature touching 3 repos could run 3 agents in parallel (one per repo) or 1 agent with access to all repos. Which model works better? The subagent pattern (Kiro's `subagent` tool) might handle this natively.

## Where to look next

- **`ROADMAP.md`** — the serialized, dependency-ordered work queue; the next thing to build is the first unchecked item.
- **`BACKLOG.md`** — tactical next-week-to-next-month bug list and small specs (mini-spec source for queue items).
- **`prompts/agent-router.md`** — the per-session contract the daemon-driven agent follows to advance the queue.
- **`AGENTS.md`** — conventions for agents (and humans) working in this repo.
- **`README.md`** — first-run guide, current capabilities, how to operate the daemon.
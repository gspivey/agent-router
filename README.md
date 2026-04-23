# Agent Router

A single-user TypeScript daemon that bridges GitHub events to ACP-compatible coding agents. It listens for GitHub webhooks, applies a multi-stage wake policy to decide whether an event warrants agent attention, and spawns a Kiro CLI subprocess over stdio using the Agent Client Protocol (JSON-RPC 2.0).

Runs on the developer's own machine behind a cloudflared tunnel. This is an MVP proof of concept; once validated, it will be rewritten in Rust.

## Why Not Hermes?

[Hermes Agent](https://hermes-agent.nousresearch.com/) by Nous Research is a general-purpose AI agent platform with a [webhook adapter](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks) that can receive GitHub events, filter by event type, compose prompts from payloads, and deliver responses to 18+ messaging platforms. It also supports zero-LLM direct delivery, dynamic subscriptions, HMAC verification, rate limiting, and idempotency. On paper, it covers a lot of the same ground.

We evaluated building on top of Hermes and decided against it. Here's why:

**Hermes is a Swiss army knife. Agent Router is a scalpel.**

Hermes wants to be your everything-agent — 18 messaging adapters, a skill marketplace, voice mode, RL training, memory systems, context compression, 47 tools across 19 toolsets. Agent Router wants to do one thing well: route GitHub events to persistent coding agent sessions.

**What Hermes can do that overlaps:**
- Receive webhooks with HMAC-SHA256 verification
- Filter by event type
- Compose prompts from payloads via templates
- Rate limit and deduplicate
- Deliver responses to chat platforms or GitHub PR comments

**What Hermes cannot do that Agent Router needs:**
- **PR-scoped persistent sessions** — Hermes creates a fresh agent per webhook event. Agent Router maintains a `(repo, PR) → session` mapping so multiple events for the same PR accumulate context in the same session.
- **Session-aware wake policy** — Agent Router only wakes an agent if a session is already registered for that PR. Hermes fires an agent run for every matching webhook.
- **Per-session event queuing** — Multiple events for the same PR are processed sequentially in order. Hermes processes each webhook independently.
- **ACP lifecycle management** — Agent Router drives Kiro CLI over stdio with full subprocess lifecycle control: spawn, initialize, load session, inject prompt, stream notifications, enforce timeouts, handle crashes.
- **File-based session streaming** — Append-only NDJSON logs (`stream.log`, `prompts.log`) designed for `tail -f` from multiple terminals. Hermes persists sessions in SQLite but doesn't expose a tailable stream.

Trying to bolt these onto Hermes via plugins or skills would mean fighting its architecture. Hermes' webhook adapter is an intake layer that feeds into a general-purpose agent loop. Agent Router's value is everything *after* intake: the session registry, wake policy, ACP client, per-session queuing, and observable file streaming.

**They're orthogonal, not competing.** You could run both — Hermes for general-purpose agent work and notifications, Agent Router for deterministic GitHub-to-coding-agent routing. They don't need to talk to each other.

## How It Works

```
GitHub webhook → POST /webhook → HMAC verify → event log (SQLite)
    → wake policy: event type filter → PR resolution → session lookup → rate limit
    → compose prompt → spawn Kiro CLI via ACP → stream output to session files
```

The daemon exposes a Unix domain socket for CLI communication:

```
agent-router prompt --new < prompt.txt    # Create a session
agent-router ls                           # List sessions
agent-router tail <session_id>            # Follow session output
agent-router tail <session_id> --raw      # Raw NDJSON
```

## Supported Events

| Event | Condition | Action |
|---|---|---|
| `check_run` | `completed` + `failure` | Wake agent to fix CI |
| `pull_request_review_comment` | `created` | Wake agent to address review feedback |
| `issue_comment` | `created` + starts with `/agent` | Wake agent with user command |

All other events are logged and ignored.

## Quick Start

```bash
# Install dependencies
npm install

# Configure
cp config.example.json config.json
# Edit config.json with your webhook secret, kiro path, and repos

# Run
npm run dev

# Type check
npm run typecheck

# Test (Tier 1 + Tier 2)
npm test
```

## Project Structure

```
src/
├── index.ts          # Entry point: config → logger → DB → servers → shutdown
├── config.ts         # Config loading, ENV: resolution, validation
├── db.ts             # SQLite schema, prepared statements, query helpers
├── log.ts            # Structured NDJSON logger
├── server.ts         # Hono HTTP: POST /webhook, HMAC verification
├── router.ts         # Wake policy pipeline
├── queue.ts          # Per-session FIFO event queues
├── prompt.ts         # Prompt composition per event type
├── acp.ts            # ACP client: spawn Kiro CLI, JSON-RPC over stdio
├── session-mgr.ts    # Session lifecycle: spawn, inject, register PR, terminate
├── session-files.ts  # Session directory layout, atomic meta writes, NDJSON append
├── cli-server.ts     # Unix domain socket for CLI IPC
├── mcp-server.ts     # MCP server per session for agent-to-daemon tools
└── errors.ts         # FatalError, EventError, WakeError
```

## Testing

Three tiers, run independently:

```bash
npm test                  # Tier 1 (unit) + Tier 2 (fake backends) — seconds
npm run test:watch        # Tier 1 only with file watching
npm run test:integration  # Tier 3 (real GitHub + real Kiro) — minutes
npm run test:all          # All three tiers
```

Tier 2 tests exercise the full daemon against fake backends (FakeGitHubBackend with a real local git repo, FakeKiroBackend with scriptable ACP scenarios). No network access, no real API tokens required.

### Tier 3 Setup (Real GitHub + Real Kiro)

Tier 3 tests run against real GitHub and a real Kiro CLI installation. They require the following environment variables:

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | A GitHub personal access token with `repo` scope for the scratch test repository |
| `GITHUB_TEST_REPO` | The scratch repository in `owner/repo` format (e.g., `myorg/agent-router-test`) |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret configured on the scratch repository |
| `WEBHOOK_URL` | The public URL for webhook delivery (e.g., your cloudflared tunnel URL + `/webhook`) |
| `KIRO_PATH` | Absolute path to the Kiro CLI executable |

#### Prerequisites

1. Create a dedicated scratch repository on GitHub for testing. Do not use a production repository.
2. Configure a webhook on the scratch repository pointing to your tunnel URL with the secret.
3. Set up a cloudflared tunnel (see `scripts/setup-tunnel.sh` if available) to expose your local daemon.
4. Install Kiro CLI and note its path.

#### Running Tier 3 Tests

```bash
# Set required env vars
export GITHUB_TOKEN="ghp_..."
export GITHUB_TEST_REPO="myorg/agent-router-test"
export GITHUB_WEBHOOK_SECRET="your-webhook-secret"
export WEBHOOK_URL="https://your-tunnel.trycloudflare.com/webhook"
export KIRO_PATH="/usr/local/bin/kiro"

# Run Tier 3 only
npm run test:integration

# Run all tiers
npm run test:all
```

Tests skip gracefully if the required environment variables are not set. Tier 3 tests are slow (minutes) and consume real API quota — run them before shipping, not on every change.

#### CI Configuration

- Tier 1 + Tier 2 run on every push (fast, no credentials needed)
- Tier 3 runs as a nightly scheduled job (requires GitHub secrets)

## License

MIT

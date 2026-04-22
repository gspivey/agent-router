# Product: Agent Router

Agent Router is a single-user TypeScript daemon that bridges GitHub events to ACP-compatible coding agents. It listens for GitHub webhooks (and cron triggers), applies a multi-stage wake policy to decide whether an event warrants agent attention, and spawns a Kiro CLI subprocess over stdio using the Agent Client Protocol (JSON-RPC 2.0).

Key characteristics:
- Runs on the developer's own machine behind a cloudflared tunnel
- Single HTTP endpoint (`POST /webhook`) for GitHub webhook delivery
- SQLite-backed event log and session registry
- File-based session streaming (append-only NDJSON) for CLI tailing
- Unix domain socket IPC for CLI-to-daemon communication
- Per-session event queues with sequential processing
- This is an MVP proof of concept; once validated, it will be rewritten in Rust

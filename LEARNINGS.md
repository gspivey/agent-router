# Learnings

Notes and observations from building Agent Router. Update this as the project evolves.

## Architecture Decisions

<!-- Record significant design choices and the reasoning behind them. -->

- **Hono over raw http** — Cleaner 404/405 handling, first-class TypeScript, minimal overhead.
- **Synchronous SQLite** — `better-sqlite3` avoids async complexity. WAL mode gives concurrent reads during writes.
- **File-based session streaming** — Append-only NDJSON files (`stream.log`, `prompts.log`) enable `tail -f` from multiple terminals without daemon involvement.
- **Unix socket for CLI IPC** — Separates CLI traffic from webhook HTTP. Different security model, different protocol.

## What Worked

<!-- Things that went well — patterns, tools, approaches worth repeating. -->

## What Didn't

<!-- Things that caused friction, wasted time, or need rethinking. -->

## Open Questions

<!-- Unresolved design questions, deferred decisions, things to revisit. -->

- When should sessions be auto-cleaned up vs. manually pruned?
- Should the Rust rewrite preserve the file-based streaming model or switch to a different approach?
- Is the 10-minute max wake duration sufficient for complex multi-file changes?

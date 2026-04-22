# Project Structure

## Source (`src/`)

| File | Role |
|---|---|
| `index.ts` | Entry point: load config → init logger → init DB → start servers → shutdown |
| `config.ts` | Config loading, `ENV:` resolution, validation |
| `db.ts` | SQLite schema init, prepared statements, query helpers |
| `log.ts` | Structured NDJSON logger to stdout |
| `server.ts` | Hono HTTP app: `POST /webhook`, HMAC signature verification |
| `router.ts` | Wake policy: event type filter → PR resolution → session lookup → rate limit |
| `queue.ts` | In-memory FIFO event queue with sequential worker |
| `prompt.ts` | Prompt composition for each event type (pure functions) |
| `acp.ts` | ACP client: spawn Kiro CLI, JSON-RPC 2.0 over stdio |
| `session-mgr.ts` | Session lifecycle: spawn, inject prompt, register PR, terminate |
| `session-files.ts` | Session directory layout, atomic meta writes, NDJSON append |
| `cli-server.ts` | Unix domain socket listener for CLI IPC |
| `mcp-server.ts` | MCP server spawned per session for agent-to-daemon tools |
| `errors.ts` | `FatalError`, `EventError`, `WakeError` classes |

## Error Classes
- `FatalError` — daemon exits non-zero (config, DB init)
- `EventError` — log + mark event processed with `wake_triggered=0` (bad payload, no session)
- `WakeError` — log + mark event processed with `wake_triggered=1` (spawn failure, ACP error)

## Tests (`test/`)

```
test/
├── harness/           # Test infrastructure
│   ├── interfaces.ts  # GitHubBackend, KiroBackend, TestDaemon interfaces
│   ├── fake-github.ts # Fake GitHub HTTP server + local git fixture
│   ├── fake-kiro.ts   # Scriptable ACP subprocess via scenario files
│   ├── test-daemon.ts # Daemon wrapper with temp dirs + backend injection
│   ├── test-cli.ts    # Programmatic CLI client
│   └── scripts/       # make-fixture-repo.sh
├── scenarios/         # Declarative FakeKiro behavior scripts (JSON)
├── fixtures/repos/    # Local bare git repo for fake GitHub
├── tier1/             # Unit + property tests
├── tier2/             # Full daemon vs fake backends
└── tier3/             # Full daemon vs real GitHub + real Kiro
```

## Runtime Filesystem Layout

```
$AGENT_ROUTER_HOME (default: $HOME/.agent-router)
├── agent-router.db    # SQLite database
├── sock               # Unix domain socket for CLI IPC
├── daemon.log         # Daemon's own structured logs
└── sessions/
    └── <session_id>/
        ├── meta.json    # Session state (atomic writes via temp+rename)
        ├── stream.log   # NDJSON stream of router + agent events (append-only)
        └── prompts.log  # NDJSON log of prompts sent to agent (append-only)
```

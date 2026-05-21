# Kiro hooks → agent-router `/hooks/event`

> **Status:** Hand-installation only. `KiroAdapter.installHooks` is a stub in
> this version; this page documents the contract so users can wire Kiro to
> POST verification triggers to the daemon by hand.
>
> The daemon works correctly without any hooks installed — the ACP-layer
> fallback (post-`sendPrompt` + inactivity watchdog) guarantees verification
> still fires. Hooks reduce the verification latency from "seconds to one
> inactivity window" down to milliseconds-after-the-event.

## What the daemon expects

The daemon exposes `POST /hooks/event` on its HTTP port. Every request must
include a bearer-token `Authorization` header. The body is a small JSON
object identifying the session and the lifecycle event.

### Authentication

The daemon generates a fresh token on every start, written to
`$rootDir/daemon-token` with mode `0600`. By default `$rootDir` is
`~/.agent-router/`.

Hook scripts should read the file at fire time (not at install time) so they
survive daemon restarts:

```bash
TOKEN="$(cat ~/.agent-router/daemon-token)"
```

### Request body

```json
{
  "event_type": "tool.post",
  "session_id": "<the AGENT_ROUTER_SESSION_ID env var Kiro got at spawn>",
  "agent_name": "kiro",
  "tool_name": "merge_pr",
  "timestamp": "2026-05-20T22:00:00.000Z"
}
```

Required fields:

- `session_id`: matches the `AGENT_ROUTER_SESSION_ID` env var the daemon
  injected into the Kiro child process at spawn. Get it inside hook scripts
  from `$AGENT_ROUTER_SESSION_ID`.

Recommended fields (logged for diagnostics, no behavioral effect today):

- `event_type`: one of `session.start | tool.post | turn.end | session.end`.
  Unknown values are accepted (forward-compat) but logged at `warn`.
- `agent_name`: free-form, e.g. `"kiro"`.
- `tool_name`: for `tool.post` events, the MCP tool name (e.g. `merge_pr`).
- `timestamp`: ISO 8601.

### Response

- `202 Accepted` with `{ "accepted": true }` — the daemon queued a
  `verifySession` call asynchronously. Hook scripts should treat 202 as
  success and not block waiting for verification to complete.
- `401 Unauthorized` — missing or wrong bearer token.
- `400 Bad Request` — malformed JSON or missing `session_id`.

## Hand-wiring it into Kiro

The agent-router profile lives at `~/.kiro/agents/agent-router.json`. To
add hooks, edit that file and merge the following snippet into its `hooks`
object. **Read the existing file first and preserve any user customizations
already present** — Kiro's settings file is yours, the daemon doesn't own it.

```json
{
  "hooks": {
    "agentSpawn": [],
    "userPromptSubmit": [],
    "postToolUse": [
      {
        "name": "agent-router: fire verifySession on merge_pr",
        "match": { "toolName": "@agent-router/merge_pr" },
        "command": "curl -s -X POST http://127.0.0.1:8080/hooks/event -H \"Authorization: Bearer $(cat ~/.agent-router/daemon-token)\" -H 'Content-Type: application/json' -d \"{\\\"event_type\\\":\\\"tool.post\\\",\\\"session_id\\\":\\\"$AGENT_ROUTER_SESSION_ID\\\",\\\"agent_name\\\":\\\"kiro\\\",\\\"tool_name\\\":\\\"merge_pr\\\"}\" >/dev/null 2>&1 || true"
      }
    ],
    "agentStop": [
      {
        "name": "agent-router: fire verifySession on turn end",
        "command": "curl -s -X POST http://127.0.0.1:8080/hooks/event -H \"Authorization: Bearer $(cat ~/.agent-router/daemon-token)\" -H 'Content-Type: application/json' -d \"{\\\"event_type\\\":\\\"turn.end\\\",\\\"session_id\\\":\\\"$AGENT_ROUTER_SESSION_ID\\\",\\\"agent_name\\\":\\\"kiro\\\"}\" >/dev/null 2>&1 || true"
      }
    ]
  }
}
```

Replace `http://127.0.0.1:8080` with whatever `port` your daemon uses
(see `~/.agent-router/config.json`).

The trailing `|| true` is intentional: a hook should never fail the agent
session, even if the daemon is unreachable. The ACP-layer fallback will
pick up the slack.

## Why these specific hooks

- **`postToolUse` matched on `@agent-router/merge_pr`**: fires immediately
  after the agent calls the daemon-provided `merge_pr` MCP tool. The
  daemon's GitHub poll inside `merge_pr` already confirms the merge before
  returning, so this hook tells the daemon "the agent is done with the merge
  step — go run verification now." Without it, verification waits for the
  next ACP fallback trigger.

- **`agentStop`**: fires when the agent's turn ends from Kiro's side. Acts
  as a turn-end signal independent of whether the daemon injected the prompt
  or not. Useful for prompts the agent initiates without `injectPrompt`.

The daemon ignores the request body fields beyond `session_id`. They exist
for log/forensic value, not for routing or behavior.

## Verifying the wire-up

Once installed:

1. Restart Kiro so the new hooks load.
2. Run a session that calls `merge_pr` (or have the agent call it on a test
   PR).
3. `tail -f ~/.agent-router/sessions/<id>/stream.log` and look for a
   `{"type":"session_verified",...}` entry shortly after the `pr_merged`
   entry. If the hook is wired correctly, that gap is milliseconds; if
   you're relying on the fallback, it'll be up to the inactivity window
   (default 5 minutes).
4. Check the daemon's log for `Hook event received` entries from
   `/hooks/event` — confirms the POST landed and was authenticated.

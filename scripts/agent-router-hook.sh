#!/usr/bin/env bash
set -euo pipefail

# agent-router-hook.sh — Kiro postToolUse hook script for auto-completion.
#
# Called by Kiro after every shell tool call. Reads the tool call result
# from stdin (JSON), checks if the command was a successful `gh pr merge`,
# and if so calls `agent-router complete-session --reason merged`.
#
# Environment:
#   AGENT_ROUTER_SESSION_ID — set by the daemon when spawning Kiro
#   AGENT_ROUTER_HOME       — optional, defaults to ~/.agent-router
#   AGENT_ROUTER_BIN        — optional, path to agent-router CLI binary

SESSION_ID="${AGENT_ROUTER_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Read JSON event from stdin
EVENT=$(cat)

# Use the TypeScript hook parser to detect merge completion
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RESULT=$(echo "$EVENT" | node --import tsx/esm -e "
import { checkHookEventForCompletion } from '${PROJECT_DIR}/src/hook-parser.js';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  const signal = checkHookEventForCompletion(lines.join(''));
  process.stdout.write(signal.shouldComplete ? 'complete' : 'skip');
});
" 2>/dev/null || echo "skip")

if [ "$RESULT" = "complete" ]; then
  AGENT_ROUTER_BIN="${AGENT_ROUTER_BIN:-agent-router}"
  echo "[agent-router-hook] Detected successful gh pr merge, completing session $SESSION_ID" >&2
  "$AGENT_ROUTER_BIN" complete-session --session-id "$SESSION_ID" --reason merged 2>&1 || true
fi

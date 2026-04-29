#!/usr/bin/env bash
set -euo pipefail

# install-hooks.sh — Install Kiro agent definition and hook script for agent-router.
#
# Creates:
#   ~/.kiro/agents/agent-router/agent.json   — agent definition with postToolUse hook
#   ~/.kiro/agents/agent-router/hooks/post-tool-use.sh — hook script
#
# Usage:
#   ./scripts/install-hooks.sh

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_SCRIPT="${PROJECT_DIR}/scripts/agent-router-hook.sh"

AGENT_DIR="${HOME}/.kiro/agents/agent-router"
HOOKS_DIR="${AGENT_DIR}/hooks"

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[warn]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2; }

# ---------- Validate hook script exists ----------

if [ ! -f "$HOOK_SCRIPT" ]; then
  error "Hook script not found: $HOOK_SCRIPT"
  error "Run this script from the agent-router project root."
  exit 1
fi

# ---------- Create agent directory structure ----------

info "Creating agent directory: $AGENT_DIR"
mkdir -p "$HOOKS_DIR"

# ---------- Copy hook script ----------

info "Installing hook script to $HOOKS_DIR/post-tool-use.sh"
cp "$HOOK_SCRIPT" "$HOOKS_DIR/post-tool-use.sh"
chmod +x "$HOOKS_DIR/post-tool-use.sh"

# ---------- Write agent definition ----------

AGENT_JSON="${AGENT_DIR}/agent.json"
info "Writing agent definition to $AGENT_JSON"

cat > "$AGENT_JSON" << 'AGENT_EOF'
{
  "name": "agent-router",
  "version": "1.0.0",
  "description": "Agent Router agent with auto-completion hooks for merge detection",
  "hooks": [
    {
      "name": "Auto-complete on merge",
      "version": "1.0.0",
      "description": "Detects successful gh pr merge commands and signals session completion",
      "when": {
        "type": "postToolUse",
        "toolTypes": ["shell"]
      },
      "then": {
        "type": "runCommand",
        "command": "~/.kiro/agents/agent-router/hooks/post-tool-use.sh"
      }
    },
    {
      "name": "Session stop fallback",
      "version": "1.0.0",
      "description": "Fallback completion signal when agent stops",
      "when": {
        "type": "agentStop"
      },
      "then": {
        "type": "runCommand",
        "command": "agent-router complete-session --session-id \"$AGENT_ROUTER_SESSION_ID\" --reason completed 2>/dev/null || true"
      }
    }
  ]
}
AGENT_EOF

info "Agent definition installed successfully."
info ""
info "To use this agent with the daemon, ensure the daemon spawns Kiro with:"
info "  kiro acp --agent agent-router"
info ""
info "Or update the daemon's acpSpawner to pass ['acp', '--agent', 'agent-router']."

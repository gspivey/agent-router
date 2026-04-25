#!/usr/bin/env bash
set -euo pipefail

# install-mcp-config.sh — Add Agent Router MCP server entry to Kiro's MCP config.
#
# Usage:
#   ./scripts/install-mcp-config.sh
#
# This script adds the agent-router MCP server to ~/.kiro/settings/mcp.json
# without overwriting existing entries. It sets the required static environment
# variable AGENT_ROUTER_SOCKET. AGENT_ROUTER_SESSION_ID is inherited at runtime
# from the daemon via the Kiro subprocess environment.
#
# Self-healing: if an existing config contains the stale literal
# ${AGENT_ROUTER_SESSION_ID} in the env block, the entry is removed and
# rewritten automatically.

MCP_CONFIG_DIR="${HOME}/.kiro/settings"
MCP_CONFIG_FILE="${MCP_CONFIG_DIR}/mcp.json"
AGENT_ROUTER_ROOT="${AGENT_ROUTER_HOME:-${HOME}/.agent-router}"
SOCKET_PATH="${AGENT_ROUTER_ROOT}/sock"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MCP_SERVER_PATH="${PROJECT_DIR}/src/mcp-server.ts"

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[warn]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2; }

# ---------- Validate MCP server file exists ----------

if [ ! -f "$MCP_SERVER_PATH" ]; then
  error "MCP server file not found: $MCP_SERVER_PATH"
  error "Run this script from the agent-router project root."
  exit 1
fi

# ---------- Ensure config directory exists ----------

if [ ! -d "$MCP_CONFIG_DIR" ]; then
  info "Creating Kiro settings directory: $MCP_CONFIG_DIR"
  mkdir -p "$MCP_CONFIG_DIR"
fi

# ---------- Create or update mcp.json ----------

SERVER_KEY="agent-router"

if [ -f "$MCP_CONFIG_FILE" ]; then
  # Check if entry already exists
  if command -v node &>/dev/null; then
    EXISTS=$(node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$MCP_CONFIG_FILE', 'utf-8'));
      const servers = cfg.mcpServers || {};
      console.log(servers['$SERVER_KEY'] ? 'yes' : 'no');
    " 2>/dev/null || echo "no")
  else
    # Fallback: grep for the key
    if grep -q "\"$SERVER_KEY\"" "$MCP_CONFIG_FILE" 2>/dev/null; then
      EXISTS="yes"
    else
      EXISTS="no"
    fi
  fi

  if [ "$EXISTS" = "yes" ]; then
    # ---------- Self-healing: detect stale ${AGENT_ROUTER_SESSION_ID} in env block ----------
    STALE="no"
    if command -v node &>/dev/null; then
      STALE=$(node -e "
        const cfg = JSON.parse(require('fs').readFileSync('$MCP_CONFIG_FILE', 'utf-8'));
        const env = (cfg.mcpServers || {})['$SERVER_KEY']?.env || {};
        console.log(env.AGENT_ROUTER_SESSION_ID !== undefined ? 'yes' : 'no');
      " 2>/dev/null || echo "no")
    elif grep -q 'AGENT_ROUTER_SESSION_ID' "$MCP_CONFIG_FILE" 2>/dev/null; then
      STALE="yes"
    fi

    if [ "$STALE" = "yes" ]; then
      warn "Stale AGENT_ROUTER_SESSION_ID found in '$SERVER_KEY' env block — rewriting entry."
      if command -v node &>/dev/null; then
        node -e "
          const fs = require('fs');
          const cfg = JSON.parse(fs.readFileSync('$MCP_CONFIG_FILE', 'utf-8'));
          delete cfg.mcpServers['$SERVER_KEY'];
          fs.writeFileSync('$MCP_CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
        "
      else
        error "Node.js is required to rewrite stale config."
        exit 1
      fi
      # Fall through to re-add the entry below
    else
      warn "Entry '$SERVER_KEY' already exists in $MCP_CONFIG_FILE — skipping."
      info "To update, remove the '$SERVER_KEY' entry and re-run this script."
      exit 0
    fi
  fi

  # Merge new entry into existing config
  if command -v node &>/dev/null; then
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$MCP_CONFIG_FILE', 'utf-8'));
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers['$SERVER_KEY'] = {
        command: 'npx',
        args: ['tsx', '$MCP_SERVER_PATH'],
        env: {
          AGENT_ROUTER_SOCKET: '$SOCKET_PATH'
        }
      };
      fs.writeFileSync('$MCP_CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
    "
    info "Added '$SERVER_KEY' entry to existing $MCP_CONFIG_FILE"
  else
    error "Node.js is required to safely merge into existing mcp.json."
    error "Install Node.js or manually add the agent-router entry."
    exit 1
  fi
else
  # Create new mcp.json
  cat > "$MCP_CONFIG_FILE" <<EOF
{
  "mcpServers": {
    "${SERVER_KEY}": {
      "command": "npx",
      "args": ["tsx", "${MCP_SERVER_PATH}"],
      "env": {
        "AGENT_ROUTER_SOCKET": "${SOCKET_PATH}"
      }
    }
  }
}
EOF
  info "Created $MCP_CONFIG_FILE with '$SERVER_KEY' entry."
fi

# ---------- Print result ----------

echo ""
info "========================================="
info "MCP config updated!"
info "========================================="
info "Config file  : $MCP_CONFIG_FILE"
info "MCP server   : $MCP_SERVER_PATH"
info "Socket path  : $SOCKET_PATH"
info ""
info "The MCP server will receive these env vars at runtime:"
info "  AGENT_ROUTER_SESSION_ID — inherited from daemon via Kiro subprocess"
info "  AGENT_ROUTER_SOCKET     — $SOCKET_PATH"
info "========================================="

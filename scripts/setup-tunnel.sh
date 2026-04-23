#!/usr/bin/env bash
set -euo pipefail

# setup-tunnel.sh — Install cloudflared and create a named tunnel for Agent Router.
#
# Usage:
#   ./scripts/setup-tunnel.sh [TUNNEL_NAME] [PORT]
#
# Defaults:
#   TUNNEL_NAME = agent-router
#   PORT        = 3000

TUNNEL_NAME="${1:-agent-router}"
PORT="${2:-3000}"

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2; }

# ---------- Platform detection ----------

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)
      error "Unsupported platform: $(uname -s)"
      exit 1
      ;;
  esac
}

PLATFORM="$(detect_platform)"
info "Detected platform: $PLATFORM"

# ---------- Install cloudflared if missing ----------

install_cloudflared() {
  if command -v cloudflared &>/dev/null; then
    info "cloudflared already installed: $(cloudflared --version)"
    return
  fi

  info "Installing cloudflared..."

  case "$PLATFORM" in
    macos)
      if ! command -v brew &>/dev/null; then
        error "Homebrew is required to install cloudflared on macOS."
        error "Install it from https://brew.sh and re-run this script."
        exit 1
      fi
      brew install cloudflared
      ;;
    linux)
      if command -v apt-get &>/dev/null; then
        info "Installing via apt..."
        sudo apt-get update -qq
        sudo apt-get install -y -qq cloudflared 2>/dev/null || install_cloudflared_binary
      else
        install_cloudflared_binary
      fi
      ;;
  esac

  if ! command -v cloudflared &>/dev/null; then
    error "cloudflared installation failed."
    exit 1
  fi

  info "cloudflared installed: $(cloudflared --version)"
}

install_cloudflared_binary() {
  info "Downloading cloudflared binary..."
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64)  arch="amd64" ;;
    aarch64) arch="arm64" ;;
    armv7l)  arch="arm"   ;;
    *)
      error "Unsupported architecture: $arch"
      exit 1
      ;;
  esac

  local url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
  curl -fsSL "$url" -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
}

install_cloudflared

# ---------- Authenticate (if needed) ----------

if ! cloudflared tunnel list &>/dev/null 2>&1; then
  info "Authenticating with Cloudflare..."
  info "A browser window will open. Log in and authorize the tunnel."
  cloudflared tunnel login
fi

# ---------- Create named tunnel ----------

if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
  info "Tunnel '$TUNNEL_NAME' already exists."
else
  info "Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
fi

# ---------- Configure tunnel to route to localhost ----------

CLOUDFLARED_DIR="${HOME}/.cloudflared"
CONFIG_FILE="${CLOUDFLARED_DIR}/config.yml"

info "Writing tunnel config to $CONFIG_FILE..."

TUNNEL_ID="$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')"

if [ -z "$TUNNEL_ID" ]; then
  error "Could not determine tunnel ID for '$TUNNEL_NAME'."
  exit 1
fi

cat > "$CONFIG_FILE" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CLOUDFLARED_DIR}/${TUNNEL_ID}.json

ingress:
  - hostname: ${TUNNEL_ID}.cfargotunnel.com
    service: http://localhost:${PORT}
  - service: http_status:404
EOF

# ---------- Print result ----------

TUNNEL_URL="https://${TUNNEL_ID}.cfargotunnel.com"

echo ""
info "========================================="
info "Tunnel setup complete!"
info "========================================="
info "Tunnel name : $TUNNEL_NAME"
info "Tunnel ID   : $TUNNEL_ID"
info "Stable URL  : $TUNNEL_URL"
info "Local target: http://localhost:${PORT}"
info ""
info "To start the tunnel:"
info "  cloudflared tunnel run $TUNNEL_NAME"
info ""
info "Set your GitHub webhook URL to:"
info "  ${TUNNEL_URL}/webhook"
info "========================================="

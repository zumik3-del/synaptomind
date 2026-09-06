#!/usr/bin/env bash
# SynaptoMind installer — curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/scripts/install.sh | bash
set -euo pipefail

INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"
DATA_DIR="${SYNAPTOMIND_DATA_DIR:-/var/lib/synaptomind}"
REPO_URL="https://github.com/zumik3-del/synaptomind.git"
INSTALL_PORT=3005
NO_SERVICE=false

# --- Parse arguments ---

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)
        INSTALL_DIR="$2"
        shift 2
        ;;
      --port)
        INSTALL_PORT="$2"
        shift 2
        ;;
      --no-service)
        NO_SERVICE=true
        shift
        ;;
      --help|-h)
        echo "Usage: curl -fsSL ... | bash -s -- [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --dir DIR        Install directory (default: /opt/synaptomind)"
        echo "  --port PORT      API port (default: 3005)"
        echo "  --no-service     Skip systemd service installation"
        echo "  --help, -h       Show this help"
        exit 0
        ;;
      *)
        echo "[synaptomind] Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done
}

# --- Helpers ---

info()  { echo "[synaptomind] $*"; }
warn()  { echo "[synaptomind] WARNING: $*" >&2; }
error() { echo "[synaptomind] ERROR: $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" &>/dev/null || error "Required command not found: $1"
}

# Check if systemd is actually running.
# Accepts "running" and "degraded" — both mean systemd is up.
# "degraded" is normal in containers (some units fail, systemd works).
systemd_running() {
  local state
  state=$(systemctl is-system-running 2>&1)
  [ "$state" = "running" ] || [ "$state" = "degraded" ]
}

# --- Install system dependencies ---

install_system_deps() {
  local missing=()

  for cmd in unzip git; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done

  if [ ${#missing[@]} -eq 0 ]; then
    info "System dependencies OK"
    return
  fi

  info "Installing missing dependencies: ${missing[*]}"

  if command -v apt &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq "${missing[@]}" 2>/dev/null
  elif command -v yum &>/dev/null; then
    yum install -y -q "${missing[@]}" 2>/dev/null
  elif command -v apk &>/dev/null; then
    apk add --no-cache "${missing[@]}" 2>/dev/null
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm "${missing[@]}" 2>/dev/null
  else
    warn "Cannot detect package manager — install manually: ${missing[*]}"
    return
  fi

  info "Dependencies installed: ${missing[*]}"
}

# --- Detect platform ---

detect_os() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$os" in
    linux)  OS="linux" ;;
    darwin) OS="macos" ;;
    *)      error "Unsupported OS: $os" ;;
  esac
  case "$arch" in
    x86_64|amd64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)             error "Unsupported architecture: $arch" ;;
  esac
}

# --- Install Bun ---

install_bun() {
  if command -v bun &>/dev/null; then
    BUN_BIN=$(command -v bun)
    info "Bun found: $BUN_BIN"
    return
  fi

  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash

  # Detect install path
  if [ -f "$HOME/.bun/bin/bun" ]; then
    BUN_BIN="$HOME/.bun/bin/bun"
  elif [ -f "/root/.bun/bin/bun" ]; then
    BUN_BIN="/root/.bun/bin/bun"
  else
    error "Bun installation failed — binary not found"
  fi
  export PATH="$(dirname "$BUN_BIN"):$PATH"
  info "Bun installed: $($BUN_BIN --version)"
}

# --- Clone or update repo ---

clone_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing installation..."
    git -C "$INSTALL_DIR" fetch --tags origin 2>/dev/null || true
    # Checkout latest stable tag (no hyphen = no prerelease)
    local tag
    tag=$(git -C "$INSTALL_DIR" tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1)
    if [ -n "$tag" ]; then
      git -C "$INSTALL_DIR" checkout "$tag"
      info "Checked out $tag"
    else
      git -C "$INSTALL_DIR" checkout main
      info "Checked out main"
    fi
  else
    info "Cloning repository..."
    git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
    # Fetch tags for version detection
    git -C "$INSTALL_DIR" fetch --tags origin 2>/dev/null || true
    local tag
    tag=$(git -C "$INSTALL_DIR" tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1)
    if [ -n "$tag" ]; then
      git -C "$INSTALL_DIR" checkout "$tag"
      info "Checked out $tag"
    fi
  fi
}

# --- Install dependencies ---

install_deps() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"
  "$BUN_BIN" install --production
}

# --- Setup vec0 ---

setup_vec0() {
  if [ -f "$INSTALL_DIR/scripts/setup-vec0.sh" ]; then
    info "Setting up vec0..."
    bash "$INSTALL_DIR/scripts/setup-vec0.sh"
  fi
}

# --- Create config ---

create_config() {
  if [ ! -f "$INSTALL_DIR/.env" ]; then
    local secret
    secret=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || date +%s | sha256sum | head -c 36)
    echo "SYNAPTOMIND_SECRET=${secret}" > "$INSTALL_DIR/.env"
    info "Created .env with random secret"
  fi

  if [ ! -f "$INSTALL_DIR/config.json" ]; then
    cp "$INSTALL_DIR/config.json.example" "$INSTALL_DIR/config.json"
    info "Created config.json from example"
  fi
}

# --- Setup data directory ---

setup_data() {
  mkdir -p "$DATA_DIR"
  # Symlink data dir into install dir if not already
  if [ ! -e "$INSTALL_DIR/data" ]; then
    ln -sf "$DATA_DIR" "$INSTALL_DIR/data"
    info "Linked data directory: $DATA_DIR -> $INSTALL_DIR/data"
  fi
}

# --- Install systemd service ---

install_service() {
  if [ "$NO_SERVICE" = true ]; then
    info "Skipping systemd service (--no-service)"
    return
  fi

  # Check if systemd directory exists AND systemd is actually running
  if [ ! -d /etc/systemd/system ]; then
    info "systemd not found — skipping service installation"
    return
  fi

  if ! systemd_running; then
    warn "systemd not running — skipping service installation"
    warn "Start manually: cd $INSTALL_DIR && bun run src/index.ts"
    return
  fi

  local service_file="/etc/systemd/system/synaptomind.service"
  local current_user
  current_user=$(whoami)

  cat > "$service_file" <<EOF
[Unit]
Description=SynaptoMind — Thought Graph Engine
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${current_user}
WorkingDirectory=${INSTALL_DIR}
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=SYNAPTOMIND_PORT=${INSTALL_PORT}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${BUN_BIN} run src/index.ts
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable synaptomind 2>/dev/null || true
  info "Systemd service installed"
}

# --- Verify installation ---

verify_installation() {
  info "Verifying installation..."

  if ! systemd_running; then
    info "systemd not running — skip verification"
    return
  fi

  systemctl start synaptomind
  sleep 3
  if curl -sf "http://127.0.0.1:${INSTALL_PORT}/health" &>/dev/null; then
    info "Service started and healthy"
  else
    warn "Service installed but health check failed"
    warn "Check logs: journalctl -u synaptomind -f"
  fi
}

# --- Print summary ---

print_summary() {
  local version="unknown"
  if [ -f "$INSTALL_DIR/package.json" ]; then
    version=$(grep -o '"version": *"[^"]*"' "$INSTALL_DIR/package.json" | head -1 | sed 's/"version": *"//;s/"//' || echo "unknown")
  fi
  local secret
  secret=$(grep SYNAPTOMIND_SECRET "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "")

  local systemd_ok=true
  if ! systemd_running; then
    systemd_ok=false
  fi

  echo ""
  echo "=== SynaptoMind installed ==="
  echo ""
  echo "  Version:    $version"
  echo "  Location:   $INSTALL_DIR"
  echo "  Data:       $DATA_DIR"
  echo "  Config:     $INSTALL_DIR/config.json"
  echo "  Token:      $secret"
  echo ""

  if [ "$systemd_ok" = true ]; then
    echo "  Start:      sudo systemctl start synaptomind"
    echo "  Stop:       sudo systemctl stop synaptomind"
    echo "  Logs:       journalctl -u synaptomind -f"
  else
    echo "  Start:      cd $INSTALL_DIR && bun run src/index.ts"
    echo "  Logs:       stdout"
  fi

  echo "  Health:     curl http://127.0.0.1:${INSTALL_PORT}/health"
  echo "  Update:     bash $INSTALL_DIR/scripts/update.sh"
  echo "  Uninstall:  sudo bash $INSTALL_DIR/scripts/uninstall.sh"
  echo ""
}

# --- Main ---

main() {
  parse_args "$@"

  info "Installing SynaptoMind..."

  detect_os
  install_system_deps
  install_bun
  clone_or_update
  install_deps
  setup_vec0
  create_config
  setup_data
  install_service
  verify_installation
  print_summary
}

main "$@"

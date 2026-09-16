#!/usr/bin/env bash
# SynaptoMind installer — curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/scripts/install.sh | bash
set -euo pipefail

INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"
DATA_DIR="${SYNAPTOMIND_DATA_DIR:-/var/lib/synaptomind}"
REPO_URL="https://github.com/zumik3-del/synaptomind.git"
INSTALL_PORT=3005
NO_SERVICE=false

# Directory this script was loaded from. Empty for `curl ... | bash` (stdin),
# where BASH_SOURCE is unset — see load_deploy_common below.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""

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
        echo "  --port PORT      API port for a newly created config.json (default: 3005)."
        echo "                   config.json governs the port; an existing file is not rewritten."
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

# Source the shared deploy helpers (tag/version/secret). Normally they sit next
# to this script; under `curl ... | bash` there is no sibling file, so fetch
# them from the same upstream ref the installer is published under.
load_deploy_common() {
  local dir tmp
  if [ -n "$SCRIPT_DIR" ]; then
    for dir in "${SCRIPT_DIR}/lib" "${SCRIPT_DIR}/scripts/lib"; do
      if [ -f "${dir}/deploy-common.sh" ]; then
        . "${dir}/deploy-common.sh"
        return 0
      fi
    done
  fi

  tmp="$(mktemp)" || error "cannot create a temporary file"
  if ! curl -fsSL "https://raw.githubusercontent.com/zumik3-del/synaptomind/main/scripts/lib/deploy-common.sh" -o "$tmp"; then
    rm -f "$tmp"
    error "cannot load deploy-common.sh: no local copy and download failed"
  fi
  . "$tmp"
  rm -f "$tmp"
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
    tag=$(latest_stable_tag "$INSTALL_DIR")
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
    tag=$(latest_stable_tag "$INSTALL_DIR")
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
  "$BUN_BIN" install --frozen-lockfile --production
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
    secret=$(generate_secret)
    ( umask 077; echo "SYNAPTOMIND_SECRET=${secret}" > "$INSTALL_DIR/.env" )
    info "Created .env with random secret"
  fi
  # Tighten permissions even on pre-existing files written with a loose umask.
  chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true

  if [ ! -f "$INSTALL_DIR/config.json" ]; then
    cp "$INSTALL_DIR/config.json.example" "$INSTALL_DIR/config.json"
    # config.json is the governing port source; --port only seeds a new file.
    if [ "$INSTALL_PORT" != "3005" ]; then
      sed -i "s/\"port\": *[0-9][0-9]*/\"port\": ${INSTALL_PORT}/" "$INSTALL_DIR/config.json"
    fi
    info "Created config.json from example"
  fi
}

# Effective API port: config.json governs (env vars are no longer forced into
# the unit), so health checks and printed guidance must read the same source.
resolve_port() {
  local port="$INSTALL_PORT"
  if [ -f "$INSTALL_DIR/config.json" ]; then
    local cfg_port
    cfg_port=$(grep -o '"port": *[0-9][0-9]*' "$INSTALL_DIR/config.json" | head -1 | grep -o '[0-9][0-9]*')
    if [ -n "$cfg_port" ]; then
      port="$cfg_port"
    fi
  fi
  echo "$port"
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
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${current_user}
WorkingDirectory=${INSTALL_DIR}
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${BUN_BIN} run src/index.ts
Restart=on-failure
RestartSec=5

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

  validate_unit "$service_file"
  systemctl daemon-reload
  systemctl enable synaptomind 2>/dev/null || true
  info "Systemd service installed"
}

# Best-effort sanity check of the rendered unit. Never fails the install:
# systemd-analyze can report issues for paths that only exist post-boot.
validate_unit() {
  local unit_file="$1"
  command -v systemd-analyze &>/dev/null || return 0
  if systemd-analyze verify "$unit_file" &>/dev/null; then
    info "Unit verified: ${unit_file}"
  else
    warn "systemd-analyze verify reported issues for ${unit_file}"
  fi
}

# --- Verify installation ---

verify_installation() {
  if [ "$NO_SERVICE" = true ]; then
    info "Skipping service verification (--no-service)"
    return
  fi

  info "Verifying installation..."

  if ! systemd_running; then
    info "systemd not running — skip verification"
    return
  fi

  local port
  port=$(resolve_port)
  systemctl start synaptomind
  sleep 3
  if curl -sf "http://127.0.0.1:${port}/health" &>/dev/null; then
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
    version=$(read_package_version "$INSTALL_DIR/package.json")
    [ -n "$version" ] || version="unknown"
  fi
  local secret
  secret=$(grep SYNAPTOMIND_SECRET "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "")

  local port
  port=$(resolve_port)

  local systemd_ok=true
  if [ "$NO_SERVICE" = true ] || ! systemd_running; then
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

  echo "  Health:     curl http://127.0.0.1:${port}/health"
  echo "  Update:     bash $INSTALL_DIR/scripts/update.sh"
  echo "  Uninstall:  sudo bash $INSTALL_DIR/scripts/uninstall.sh"
  echo ""
}

# --- Main ---

main() {
  parse_args "$@"

  load_deploy_common

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

#!/usr/bin/env bash
# SynaptoMind uninstaller
set -euo pipefail

INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"
DATA_DIR="${SYNAPTOMIND_DATA_DIR:-/var/lib/synaptomind}"

info()  { echo "[synaptomind] $*"; }
warn()  { echo "[synaptomind] WARNING: $*" >&2; }

# Run command as root if not already root
run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

echo "This will remove SynaptoMind:"
echo "  - Service: /etc/systemd/system/synaptomind.service"
echo "  - Install: $INSTALL_DIR"
echo "  - Data:    $DATA_DIR"
echo ""
read -p "Continue? [y/N] " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Stop service
if systemctl is-active synaptomind &>/dev/null; then
  info "Stopping service..."
  run_root systemctl stop synaptomind
fi

# Disable service
if systemctl is-enabled synaptomind &>/dev/null; then
  info "Disabling service..."
  run_root systemctl disable synaptomind 2>/dev/null || true
fi

# Remove service file
if [ -f /etc/systemd/system/synaptomind.service ]; then
  info "Removing service file..."
  run_root rm /etc/systemd/system/synaptomind.service
  run_root systemctl daemon-reload
fi

# Remove install dir
if [ -d "$INSTALL_DIR" ]; then
  info "Removing $INSTALL_DIR..."
  run_root rm -rf "$INSTALL_DIR"
fi

# Remove data dir (ask first)
if [ -d "$DATA_DIR" ]; then
  read -p "Remove data directory ($DATA_DIR)? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Removing $DATA_DIR..."
    run_root rm -rf "$DATA_DIR"
  else
    info "Keeping $DATA_DIR"
  fi
fi

echo ""
info "SynaptoMind uninstalled."

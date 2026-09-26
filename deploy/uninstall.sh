#!/usr/bin/env bash

# Provenance: vendored verbatim from https://forgejo.home.lan/authelia/bun-templates commit 89be318daf8adab5ddca957162b3b7df8429e725
# ════════════════════════════════════════════════════════════════════════════
#  uninstall.sh — remove an app installed by the deploy/ framework
#
#  Usage:
#      bash <state-dir>/scripts/uninstall.sh [OPTIONS]
#
#  Options:
#      --purge      Also remove INSTALL_DIR and DATA_DIR
#      --yes        Do not prompt (required when no TTY is attached)
#      --help, -h   Show this help
#
#  By default only the service and the helper scripts are removed; code, data
#  and state are kept so a reinstall can pick up where the app left off.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""

load_common() {
  local cand
  for cand in "${SCRIPT_DIR}/lib/common.sh" "${SCRIPT_DIR}/common.sh"; do
    if [ -f "$cand" ]; then
      # shellcheck source=lib/common.sh
      . "$cand"
      return 0
    fi
  done
  echo "[app] ERROR: cannot find lib/common.sh next to $0" >&2
  exit 1
}
load_common
trap cleanup_run EXIT

PURGE=false
ASSUME_YES=false

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge)   PURGE=true;      shift ;;
      --yes|-y)  ASSUME_YES=true; shift ;;
      --help|-h) sed -n '2,15p' "$0" 2>/dev/null || echo "See the comment header of uninstall.sh"; exit 0 ;;
      *) error "unknown option: $1 (try --help)" ;;
    esac
  done
}

main() {
  parse_args "$@"
  load_app_env
  [ -n "${APP_NAME:-}" ] || error "APP_NAME is not set in app.env"
  resolve_target_user

  INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
  UNIT="/etc/systemd/system/${APP_NAME}.service"
  CLI_BIN="${BIN_DIR:-/usr/local/bin}/${APP_NAME}"

  # Refuse to `rm -rf` a path that is obviously too broad.
  case "$INSTALL_DIR" in
    ""|"/"|"/opt"|"/usr"|"/var") error "refusing unsafe INSTALL_DIR: '${INSTALL_DIR}'" ;;
  esac
  if [ -n "${DATA_DIR:-}" ]; then
    case "$DATA_DIR" in
      "/"|"/var"|"/var/lib"|"/usr") error "refusing unsafe DATA_DIR: '${DATA_DIR}'" ;;
    esac
  fi

  echo "This will remove ${APP_NAME}:"
  echo "  - Service:  ${UNIT}"
  echo "  - Helpers:  ${RUN_DIR}/scripts"
  [ -e "$CLI_BIN" ] && echo "  - CLI:      ${CLI_BIN}"
  if [ "$PURGE" = true ]; then
    echo "  - Install:  ${INSTALL_DIR}"
    [ -n "${DATA_DIR:-}" ] && echo "  - Data:     ${DATA_DIR}"
  else
    echo ""
    echo "  Kept (re-run with --purge to remove):"
    echo "    ${INSTALL_DIR}"
    [ -n "${DATA_DIR:-}" ] && echo "    ${DATA_DIR}"
    echo "    ${RUN_DIR} (except scripts/)"
  fi
  echo ""

  if ! confirm "Continue?"; then
    info "Aborted."
    exit 0
  fi

  # -- service --
  if systemd_running; then
    if systemctl is-active "$APP_NAME" >/dev/null 2>&1; then
      info "Stopping ${APP_NAME}..."
      run_root systemctl stop "$APP_NAME"
    fi
    if systemctl is-enabled "$APP_NAME" >/dev/null 2>&1; then
      info "Disabling ${APP_NAME}..."
      run_root systemctl disable "$APP_NAME" 2>/dev/null || true
    fi
  fi
  if [ -f "$UNIT" ]; then
    info "Removing ${UNIT}..."
    run_root rm -f "$UNIT"
    if systemd_running; then run_root systemctl daemon-reload; fi
  fi

  # -- CLI symlink --
  if [ -e "$CLI_BIN" ] || [ -L "$CLI_BIN" ]; then
    info "Removing CLI: ${CLI_BIN}"
    run_root rm -f "$CLI_BIN"
  fi

  # -- helper scripts (state dir itself is kept) --
  if [ -d "${RUN_DIR}/scripts" ]; then
    info "Removing helper scripts: ${RUN_DIR}/scripts"
    rm -rf "${RUN_DIR}/scripts"
  fi

  # -- code & data (only with --purge) --
  if [ "$PURGE" = true ]; then
    if [ -d "$INSTALL_DIR" ]; then
      info "Removing ${INSTALL_DIR}..."
      run_root rm -rf "$INSTALL_DIR"
    fi
    if [ -n "${DATA_DIR:-}" ] && [ -d "$DATA_DIR" ]; then
      info "Removing ${DATA_DIR}..."
      run_root rm -rf "$DATA_DIR"
    fi
  else
    info "Kept ${INSTALL_DIR}${DATA_DIR:+ and ${DATA_DIR}}"
  fi

  echo ""
  info "${APP_NAME} uninstalled."
}

main "$@"

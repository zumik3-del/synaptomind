#!/usr/bin/env bash

# Provenance: vendored verbatim from https://forgejo.home.lan/authelia/bun-templates commit 89be318daf8adab5ddca957162b3b7df8429e725
# ════════════════════════════════════════════════════════════════════════════
#  update.sh — move an installed app to a newer version
#
#  Usage:
#      bash <state-dir>/scripts/update.sh [OPTIONS]
#
#  Options:
#      --version TAG   Update to a specific version (default: resolve latest)
#      --yes           Do not prompt (required for downgrades / non-interactive)
#      --help, -h      Show this help
#
#  Order of operations:
#      compare versions -> refuse same/downgrade -> pre-update hook
#      -> fetch + swap -> post-update hook -> refresh unit -> restart + health
#      -> rollback hint
#
#  DIST=binary swaps a release tarball's payload (executable + vec0.so +
#  lib/libonnxruntime.so.1) instead of a git checkout; see
#  docs/adr/0001-self-contained-binary-tarball-deployment.md.
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

ARG_VERSION=""
ASSUME_YES=false

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) ARG_VERSION="$2"; shift 2 ;;
      --yes|-y)  ASSUME_YES=true;  shift   ;;
      --help|-h) sed -n '2,16p' "$0" 2>/dev/null || echo "See the comment header of update.sh"; exit 0 ;;
      *) error "unknown option: $1 (try --help)" ;;
    esac
  done
}

# ── Current / target version ───────────────────────────────────────────────
current_version() {
  if [ "$DIST" = "binary" ]; then
    local bin="${INSTALL_DIR}/${APP_NAME}"
    if [ -x "$bin" ]; then app_version "$bin"; else echo "unknown"; fi
  else
    local v
    v="$(read_package_version "${INSTALL_DIR}/package.json")"
    echo "${v:-unknown}"
  fi
}

# package.json version at origin/<branch> (source branch policy only).
remote_pkg_version() {
  local tmp
  tmp="$(mktemp)"; cleanup_add "$tmp"
  if git -C "$INSTALL_DIR" show "origin/${1}:package.json" > "$tmp" 2>/dev/null; then
    read_package_version "$tmp"
  fi
}

# ── Hooks ──────────────────────────────────────────────────────────────────
run_hook() {
  local hook="${HOOKS_DIR}/$1" rc=0
  if [ -x "$hook" ]; then
    info "Running ${1} hook..."
    "$hook" || rc=$?
    if [ "$rc" -ne 0 ]; then warn "${1} hook failed (continuing)"; fi
  fi
  return "$rc"
}

# ── Rollback guidance (no automatic revert) ────────────────────────────────
print_recovery() {
  warn "update did not finish cleanly — previous state:"
  if [ "$DIST" = "binary" ]; then
    # The payload is three files, not one commit, and migrations are forward-only
    # (src/db/init.ts), so a rollback MUST restore the DB backup as well (ADR 0001 §2.9).
    warn "  rollback:"
    warn "    sudo systemctl stop ${APP_NAME}"
    warn "    cd ${INSTALL_DIR}"
    warn "    for f in ${BINARY_ROLLBACK_FILES}; do [ -f \"\$f.prev\" ] && sudo mv -f \"\$f.prev\" \"\$f\"; done"
    warn "    sudo cp data/synaptomind.db.backup/synaptomind.db.<timestamp>.bak data/synaptomind.db"
    warn "    sudo rm -f data/synaptomind.db-wal data/synaptomind.db-shm"
    warn "    sudo systemctl start ${APP_NAME}"
    warn "  The cp/rm pair must be repeated for EVERY database the pre-update hook"
    warn "  backed up (the main DB plus logDbPath from config.json) — the hook"
    warn "  printed each backup path. Restoring the DB is mandatory: a pre-upgrade"
    warn "  binary against a post-upgrade schema is unsafe."
  else
    warn "  previous commit: ${PREV_REF}"
    warn "  rollback:        git -C ${INSTALL_DIR} checkout --force ${PREV_REF} && (cd ${INSTALL_DIR} && bun install --frozen-lockfile --production)"
  fi
}

# ── systemd unit ────────────────────────────────────────────────────────────
# render_systemd_unit() has exactly ONE call site in the framework
# (install.sh). A unit written before the LD_LIBRARY_PATH line existed therefore
# kept its old body through every update, so a host that updates INTO binary mode
# would run a binary whose embedder cannot dlopen libonnxruntime.so.1
# (ADR 0001 §2.2). Binary mode re-renders and reinstalls the unit here.
#
# Scope is deliberately narrow: source mode returns immediately, because the
# rendered body is unchanged for it and re-rendering would clobber an operator's
# hand edits to the unit.
refresh_unit() {
  # UNIT_FILE is overridable so a non-standard unit path (and the deploy tests)
  # need not write to /etc/systemd/system.
  local unit="${UNIT_FILE:-/etc/systemd/system/${APP_NAME}.service}" tmpdir tmp
  [ "${UNIT_FILE:-}" ] || UNIT_FILE_DEFAULT=1
  [ "$DIST" = "binary" ] || return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  systemd_running || return 0
  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    warn "sudo not available — keeping the existing unit (a binary install needs"
    warn "  Environment=LD_LIBRARY_PATH=${INSTALL_DIR}/lib; re-run as root to refresh it)"
    return 0
  fi

  tmpdir="$(mktemp -d)"; tmp="${tmpdir}/${APP_NAME}.service"
  cleanup_add "$tmp"
  render_systemd_unit "$EXEC_START" > "$tmp"

  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "$tmp" >/dev/null 2>&1 || warn "systemd-analyze verify reported issues"
  fi

  # `enable` is deliberately NOT repeated: that is install.sh's job.
  if run_root cp -f "$tmp" "$unit" && run_root chmod 644 "$unit"; then
    rm -f "$tmp"; rmdir "$tmpdir" 2>/dev/null || true
    run_root systemctl daemon-reload || warn "systemctl daemon-reload failed"
    info "Refreshed ${unit}"
  else
    warn "cannot write ${unit} — keeping the existing unit"
  fi
}

# ── Fetch & swap ───────────────────────────────────────────────────────────
update_source() {
  local bun=""
  git -C "$INSTALL_DIR" fetch --tags --force origin
  if [ -n "$ARG_VERSION" ]; then
    TARGET_REF="$ARG_VERSION"; TARGET_KIND="tag"
  else
    resolve_source_ref "$INSTALL_DIR"
    if [ "$TARGET_KIND" = "branch" ]; then
      local head want
      head="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
      want="$(git -C "$INSTALL_DIR" rev-parse "origin/${TARGET_REF}" 2>/dev/null || true)"
      if [ -n "$head" ] && [ "$head" = "$want" ]; then
        info "Already up to date (${TARGET_REF} @ ${head:0:8})."
        exit 0
      fi
    fi
  fi

  PREV_REF="$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if [ "$TARGET_KIND" = "tag" ]; then
    git -C "$INSTALL_DIR" checkout --force "$TARGET_REF"
  else
    git -C "$INSTALL_DIR" checkout --force -B "$TARGET_REF" --track "origin/${TARGET_REF}"
  fi
  info "Checked out ${TARGET_REF}"

  if [ "${REQUIRES_BUN:-}" = "yes" ]; then
    bun="$(locate_bun || true)"
    [ -n "$bun" ] || error "Bun not found; re-run install.sh"
    info "Installing dependencies..."
    ( cd "$INSTALL_DIR" && "$bun" install --frozen-lockfile --production )
  fi
}

update_binary() {
  binary_install_payload
}

# ── Restart & verify ───────────────────────────────────────────────────────
restart_and_verify() {
  local restarted=false expected="$TARGET_VERSION"
  if [ "$expected" = "unknown" ]; then expected=""; fi
  if systemd_running && systemctl is-active "$APP_NAME" >/dev/null 2>&1; then
    info "Restarting ${APP_NAME}..."
    run_root systemctl restart "$APP_NAME"
    restarted=true
  else
    info "${APP_NAME} is not running under systemd — start it manually:"
    info "  sudo systemctl start ${APP_NAME}"
  fi

  if [ "$restarted" = true ]; then
    if ! wait_health "$HEALTH_URL" "$expected" "$HEALTH_TIMEOUT"; then
      print_recovery
      exit 1
    fi
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  load_app_env
  [ -n "${APP_NAME:-}" ] || error "APP_NAME is not set in app.env"
  detect_os
  detect_arch
  resolve_target_user

   INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
   PORT="${PORT:-3000}"
   HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
   HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:$(resolve_port)/health}"
   HOOKS_DIR="${HOOKS_DIR:-${RUN_DIR}/hooks}"
   # Export RUN_DIR so hook scripts (pre-update / post-update) can locate
   # ${RUN_DIR}/scripts/app.env even when update.sh does not pass it explicitly.
   export RUN_DIR

  if [ "$DIST" = "source" ]; then
    [ -d "${INSTALL_DIR}/.git" ] || error "not installed at ${INSTALL_DIR} — run install.sh first"
    need_cmd git
  elif [ "$DIST" = "binary" ]; then
    [ -x "${INSTALL_DIR}/${APP_NAME}" ] || error "not installed at ${INSTALL_DIR} — run install.sh first"
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || error "need curl or wget"
  else
    error "DIST must be 'source' or 'binary' (got '${DIST}')"
  fi

  CURRENT="$(current_version)"
  CURRENT="${CURRENT:-unknown}"

  # -- resolve target --
  if [ "$DIST" = "binary" ]; then
    if [ -n "$ARG_VERSION" ]; then
      TAG="$(normalize_v "$ARG_VERSION")"
    else
      release_resolve_tag
      TAG="$RESOLVED_TAG"
    fi
    TARGET_VERSION="${TAG#v}"
    TARGET_REF="$TAG"
    # refresh_unit needs it; binary mode has no bun, so the default is the
    # artefact itself (mirrors install.sh default_exec_start).
    [ -n "${EXEC_START:-}" ] || EXEC_START="${INSTALL_DIR}/${APP_NAME}"
  else
    TARGET_VERSION=""
    TARGET_REF=""
    git -C "$INSTALL_DIR" fetch --tags --force origin
    if [ -n "$ARG_VERSION" ]; then
      ARG_VERSION="$(normalize_v "$ARG_VERSION")"
      TARGET_REF="$ARG_VERSION"; TARGET_KIND="tag"; TARGET_VERSION="${ARG_VERSION#v}"
    else
      resolve_source_ref "$INSTALL_DIR"
      if [ "$TARGET_KIND" = "tag" ]; then
        TARGET_VERSION="${TARGET_REF#v}"
      else
        TARGET_VERSION="$(remote_pkg_version "$TARGET_REF")"
        TARGET_VERSION="${TARGET_VERSION:-unknown}"
      fi
    fi
  fi

  info "Current:  ${CURRENT}"
  info "Target:   ${TARGET_VERSION:-unknown}"

  # -- guards --
  if [ -n "$TARGET_VERSION" ] && [ "$TARGET_VERSION" != "unknown" ] && [ "$CURRENT" != "unknown" ]; then
    # BOTH operands normalised. current_version() returns app_version's
    # v-prefixed output for a binary install but a bare package.json version for
    # a source one, and TARGET_VERSION is bare — so without this,
    # `ver_cmp "v0.8.0" "0.9.0"` answers "newer" and a plain upgrade is
    # misreported as a downgrade needing confirmation (ADR 0001 §2.6).
    case "$(ver_cmp "$(normalize_v "$CURRENT")" "$(normalize_v "$TARGET_VERSION")")" in
      same)
        info "Already up to date."
        exit 0 ;;
      newer)
        info "installed ${CURRENT} is newer than ${TARGET_VERSION} (downgrade)."
        if ! confirm "Downgrade ${CURRENT} -> ${TARGET_VERSION}?"; then
          info "Aborted."
          exit 0
        fi ;;
    esac
  fi

  # -- hooks around the swap --
  # SynaptoMind deviation: pre-update is treated as FATAL — a failed DB backup
  # must never be followed by an unchecked code swap.  The upstream template
  # treats all hooks as non-fatal (warn + continue).
  if ! run_hook pre-update; then
    error "pre-update hook failed — aborting before switching code"
  fi
  if [ "$DIST" = "binary" ]; then update_binary; else update_source; fi
  run_hook post-update

  # -- restart & health --
  # The unit is refreshed BEFORE the restart, so the service comes back with the
  # Environment=LD_LIBRARY_PATH a binary payload needs.
  refresh_unit
  restart_and_verify

  echo ""
  info "Done. Now at ${TARGET_VERSION:-${TARGET_REF}}."
}

main "$@"

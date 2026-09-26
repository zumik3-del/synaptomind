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
#      -> fetch + swap -> post-update hook -> restart + health -> rollback hint
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
    warn "  previous binary: ${INSTALL_DIR}/${APP_NAME}.prev"
    warn "  rollback:        mv -f ${INSTALL_DIR}/${APP_NAME}.prev ${INSTALL_DIR}/${APP_NAME} && systemctl restart ${APP_NAME}"
  else
    warn "  previous commit: ${PREV_REF}"
    warn "  rollback:        git -C ${INSTALL_DIR} checkout --force ${PREV_REF} && (cd ${INSTALL_DIR} && bun install --frozen-lockfile --production)"
  fi
}

# ── Fetch & swap ───────────────────────────────────────────────────────────
update_source() {
  local bun=""
  if [ -n "$ARG_VERSION" ]; then
    TARGET_REF="$ARG_VERSION"; TARGET_KIND="tag"
  else
    git -C "$INSTALL_DIR" fetch --tags --force origin
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
  local asset url tmp got
  asset="$(render_template "$ASSET_PATTERN")"
  url="${RELEASES_BASE}/${TAG}/${asset}"
  tmp="${INSTALL_DIR}/.${APP_NAME}.$$.tmp"
  cleanup_add "$tmp"

  info "Downloading ${asset} ${TAG}..."
  url_get "$url" "$tmp" || error "download failed: ${url}"
  chmod +x "$tmp"

  got="$(app_version "$tmp")"
  if [ "$got" != "${TAG#v}" ]; then
    error "downloaded binary failed version check (got '${got:-nothing}', expected '${TAG#v}')"
  fi

  # Keep exactly one previous binary for rollback, then swap atomically.
  if [ -f "${INSTALL_DIR}/${APP_NAME}" ]; then
    cp -f "${INSTALL_DIR}/${APP_NAME}" "${INSTALL_DIR}/${APP_NAME}.prev"
  fi
  mv -f "$tmp" "${INSTALL_DIR}/${APP_NAME}"
  info "Installed ${INSTALL_DIR}/${APP_NAME} (${got})"
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
      [ -n "${RELEASE_API:-}" ] || error "RELEASE_API is empty; set it or pass --version"
      TAG="$(release_latest_tag || true)"
      [ -n "$TAG" ] || error "could not resolve the latest version from ${RELEASE_API}"
      TAG="$(normalize_v "$TAG")"
    fi
    TARGET_VERSION="${TAG#v}"
    TARGET_REF="$TAG"
  else
    TARGET_VERSION=""
    TARGET_REF=""
    if [ -n "$ARG_VERSION" ]; then
      ARG_VERSION="$(normalize_v "$ARG_VERSION")"
      TARGET_REF="$ARG_VERSION"; TARGET_KIND="tag"; TARGET_VERSION="${ARG_VERSION#v}"
    else
      git -C "$INSTALL_DIR" fetch --tags --force origin
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
    case "$(ver_cmp "$CURRENT" "$TARGET_VERSION")" in
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
  restart_and_verify

  echo ""
  info "Done. Now at ${TARGET_VERSION:-${TARGET_REF}}."
}

main "$@"

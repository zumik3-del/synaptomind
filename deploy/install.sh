#!/usr/bin/env bash

# Provenance: vendored verbatim from https://forgejo.home.lan/authelia/bun-templates commit 89be318daf8adab5ddca957162b3b7df8429e725
# ════════════════════════════════════════════════════════════════════════════
#  install.sh — install (or reinstall) one app from app.env
#
#  Local run (deploy/ copied into your app repo):
#      sudo bash deploy/install.sh [OPTIONS]
#
#  One-liner (publish deploy/ and your app.env somewhere reachable):
#      curl -fsSL https://HOST/deploy/install.sh \
#        | APP_ENV_URL=https://HOST/myapp/app.env \
#          LIB_RAW_URL=https://HOST/deploy/lib/common.sh bash -s -- [OPTIONS]
#
#  Options:
#      --dir DIR       Install directory        (default: INSTALL_DIR in app.env)
#      --port PORT     Port for the seeded config + health check (default: PORT)
#      --version TAG   Pin a version instead of resolving the latest
#      --force         Reinstall even when the same version is already present
#      --no-service    Skip systemd unit installation and start
#      --help, -h      Show this help
#
#  Pipeline (see the phase banners in main):
#      config -> platform + OS deps -> fetch code/binary -> seed state
#      -> data symlink -> helper scripts -> systemd unit -> health check
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# Directory this script was loaded from. Empty for `curl ... | bash` (stdin),
# where BASH_SOURCE is unset — see load_common() below.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""

# ── Argument state (overrides app.env after it is loaded) ──────────────────
ARG_DIR=""
ARG_PORT=""
ARG_VERSION=""
FORCE=false
NO_SERVICE=false

# ── Load lib/common.sh ─────────────────────────────────────────────────────
# Normally a sibling file. Under `curl | bash` there is none, so fetch it from
# LIB_RAW_URL (set in the environment before the pipe, since app.env is not
# readable yet).
load_common() {
  local cand tmp
  if [ -n "$SCRIPT_DIR" ]; then
    for cand in "${SCRIPT_DIR}/lib/common.sh" "${SCRIPT_DIR}/common.sh"; do
      if [ -f "$cand" ]; then
        # shellcheck source=lib/common.sh
        . "$cand"
        return 0
      fi
    done
  fi
  if [ -n "${LIB_RAW_URL:-}" ]; then
    tmp="$(mktemp)" || { echo "[app] ERROR: cannot create a temporary file" >&2; exit 1; }
    if curl -fsSL "$LIB_RAW_URL" -o "$tmp" 2>/dev/null; then
      # shellcheck source=/dev/null
      . "$tmp"
      rm -f "$tmp"
      return 0
    fi
    rm -f "$tmp"
  fi
  echo "[app] ERROR: cannot load lib/common.sh (set LIB_RAW_URL when using curl|bash)" >&2
  exit 1
}

load_common

# Best-effort cleanup of temp files registered by the helpers.
trap cleanup_run EXIT

# ── Argument parsing ───────────────────────────────────────────────────────
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)        ARG_DIR="$2";     shift 2 ;;
      --port)       ARG_PORT="$2";    shift 2 ;;
      --version)    ARG_VERSION="$2"; shift 2 ;;
      --force)      FORCE=true;       shift   ;;
      --no-service) NO_SERVICE=true;  shift   ;;
      --help|-h)
        sed -n '2,24p' "$0" 2>/dev/null || echo "See the comment header of install.sh"
        exit 0 ;;
      *) error "unknown option: $1 (try --help)" ;;
    esac
  done
}

# ── Config finalization ────────────────────────────────────────────────────
apply_overrides() {
  if [ -n "$ARG_DIR" ];  then INSTALL_DIR="$ARG_DIR"; fi
  if [ -n "$ARG_PORT" ]; then PORT="$ARG_PORT"; fi
  if [ -n "$ARG_VERSION" ]; then ARG_VERSION="$(normalize_v "$ARG_VERSION")"; fi
}

# Default start command when EXEC_START is left empty in app.env.
default_exec_start() {
  if [ "$DIST" = "binary" ]; then
    printf '%s' "${INSTALL_DIR}/${APP_NAME}"
  elif [ -n "${BUN_BIN:-}" ]; then
    if grep -q '"start"' "${INSTALL_DIR}/package.json" 2>/dev/null; then
      printf '%s' "${BUN_BIN} run start"
    else
      printf '%s' "${BUN_BIN} run src/index.ts"
    fi
  else
    printf '%s' "${INSTALL_DIR}/start.sh"
  fi
}

# ── Phase: platform & OS dependencies ──────────────────────────────────────
install_system_deps() {
  local pkgs="${SYSTEM_DEP_CMDS:-}" missing=() cmd
  if [ -z "$pkgs" ]; then info "No system dependencies configured"; return 0; fi
  for cmd in $pkgs; do
    if ! command -v "$cmd" >/dev/null 2>&1; then missing+=("$cmd"); fi
  done
  if [ ${#missing[@]} -eq 0 ]; then info "System dependencies OK"; return 0; fi

  info "Installing missing dependencies: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update -qq && run_root apt-get install -y -qq "${missing[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y -q "${missing[@]}"
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y -q "${missing[@]}"
  elif command -v apk >/dev/null 2>&1; then
    run_root apk add --no-cache "${missing[@]}"
  elif command -v pacman >/dev/null 2>&1; then
    run_root pacman -S --noconfirm "${missing[@]}"
  else
    warn "No known package manager — install manually: ${missing[*]}"
  fi
}

# ── Phase: reach the target version ────────────────────────────────────────
require_source_config() {
  [ -n "${REPO_URL:-}" ] || error "REPO_URL is empty (required for DIST=source)"
  need_cmd git
}

require_binary_config() {
  [ -n "${RELEASES_BASE:-}" ]  || error "RELEASES_BASE is empty (required for DIST=binary)"
  [ -n "${ASSET_PATTERN:-}" ]  || error "ASSET_PATTERN is empty (required for DIST=binary)"
  [ -n "${APP_VERSION_CMD:-}" ] || error "APP_VERSION_CMD is empty (required for DIST=binary)"
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || error "need curl or wget"
}

# Install Bun (source mode) when the app declares REQUIRES_BUN=yes.
install_bun_if_needed() {
  if [ "${REQUIRES_BUN:-}" != "yes" ]; then
    info "REQUIRES_BUN is not 'yes' — skipping Bun"
    return 0
  fi
  if BUN_BIN="$(locate_bun)"; then info "Bun: ${BUN_BIN}"; return 0; fi

  need_cmd curl
  info "Installing Bun for ${TARGET_USER}..."
  HOME="$TARGET_HOME" curl -fsSL https://bun.sh/install | HOME="$TARGET_HOME" bash
  if BUN_BIN="$(locate_bun)"; then
    info "Bun installed: $("$BUN_BIN" --version)"
  else
    error "Bun installation failed — binary not found"
  fi
}

# Fetch source and check out the selected ref. Exits early when up to date.
source_prepare() {
  local cur head want fresh=false
  if [ -d "${INSTALL_DIR}/.git" ]; then
    info "Updating existing checkout in ${INSTALL_DIR}..."
    git -C "$INSTALL_DIR" fetch --tags --force origin
  else
    info "Cloning ${REPO_URL}..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --tags --force origin
    fresh=true
  fi

  if [ -n "$ARG_VERSION" ]; then
    TARGET_REF="$ARG_VERSION"; TARGET_KIND="tag"
  else
    resolve_source_ref "$INSTALL_DIR"
  fi

  if [ "$FORCE" != true ] && [ "$fresh" != true ]; then
    if [ "$TARGET_KIND" = "tag" ]; then
      cur="$(read_package_version "${INSTALL_DIR}/package.json")"
      case "$(ver_cmp "${cur:-0}" "${TARGET_REF#v}")" in
        same)  up_to_date_exit "${cur:-${TARGET_REF#v}}" ;;
        newer) error "newer version ${cur} is already installed; use --force to override" ;;
      esac
    else
      head="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
      want="$(git -C "$INSTALL_DIR" rev-parse "origin/${TARGET_REF}" 2>/dev/null || true)"
      if [ -n "$head" ] && [ "$head" = "$want" ]; then
        up_to_date_exit "$(read_package_version "${INSTALL_DIR}/package.json" || echo unknown)"
      fi
    fi
  fi

  if [ "$TARGET_KIND" = "tag" ]; then
    git -C "$INSTALL_DIR" checkout --force "$TARGET_REF"
  else
    git -C "$INSTALL_DIR" checkout --force -B "$TARGET_REF" --track "origin/${TARGET_REF}"
  fi
  info "Checked out ${TARGET_REF}"
}

# Source mode: install dependencies for Bun apps.
install_deps() {
  if [ "${REQUIRES_BUN:-}" != "yes" ]; then
    info "Not a Bun app — skipping dependency install"
    return 0
  fi
  [ -f "${INSTALL_DIR}/package.json" ] || return 0
  info "Installing dependencies..."
  ( cd "$INSTALL_DIR" && "$BUN_BIN" install --frozen-lockfile --production )
}

# Binary mode: resolve the tag to install.
resolve_binary_version() {
  if [ -n "$ARG_VERSION" ]; then
    TAG="$ARG_VERSION"
  else
    [ -n "${RELEASE_API:-}" ] || error "RELEASE_API is empty; set it or pass --version"
    TAG="$(release_latest_tag || true)"
    [ -n "$TAG" ] || error "could not resolve the latest version from ${RELEASE_API}"
    TAG="$(normalize_v "$TAG")"
  fi
  info "Target version: ${TAG#v}"
}

# Binary mode: exit early when the installed binary is current.
binary_up_to_date_check() {
  local bin="${INSTALL_DIR}/${APP_NAME}" cur
  [ -f "$bin" ] || return 0
  [ "$FORCE" = true ] && return 0
  cur="$(app_version "$bin")"
  case "$(ver_cmp "${cur:-0}" "${TAG#v}")" in
    same)  up_to_date_exit "${cur}" ;;
    newer) error "newer version ${cur} is already installed; use --force to override" ;;
  esac
}

# Binary mode: download, verify, atomic swap.
install_binary() {
  local asset url tmp got
  asset="$(render_template "$ASSET_PATTERN")"
  url="${RELEASES_BASE}/${TAG}/${asset}"
  mkdir -p "$INSTALL_DIR"
  tmp="${INSTALL_DIR}/.${APP_NAME}.$$.tmp"
  cleanup_add "$tmp"

  info "Downloading ${asset} ${TAG}..."
  url_get "$url" "$tmp" || error "download failed: ${url}"
  chmod +x "$tmp"

  got="$(app_version "$tmp")"
  if [ "$got" != "${TAG#v}" ]; then
    error "downloaded binary failed version check (got '${got:-nothing}', expected '${TAG#v}')"
  fi

  # Atomic swap: replaces the directory entry without truncating a running binary.
  mv -f "$tmp" "${INSTALL_DIR}/${APP_NAME}"
  info "Installed ${INSTALL_DIR}/${APP_NAME} (${got})"
}

# ── Phase: seed state (config files, secret, data dir) ─────────────────────
SEEDED_SECRET_FILE=false
seed_files() {
  local pair src dest base
  SEEDED_SECRET_FILE=false
  for pair in ${SEED_FILES:-}; do
    src="${pair%%:*}"; dest="${pair#*:}"
    if [ -e "${INSTALL_DIR}/${dest}" ]; then
      info "Preserved existing ${dest}"
      continue
    fi
    if [ ! -f "${INSTALL_DIR}/${src}" ]; then
      warn "seed source not found: ${src} (skipping ${dest})"
      continue
    fi
    base="$(basename "$dest")"
    ( umask 077; cp "${INSTALL_DIR}/${src}" "${INSTALL_DIR}/${dest}" )
    case "$base" in .*) chmod 600 "${INSTALL_DIR}/${dest}" ;; esac
    # A seeded config.json is the port source: align it with PORT.
    if [ "$base" = "config.json" ] && grep -q '"port"' "${INSTALL_DIR}/${dest}" 2>/dev/null; then
      sed -i "s/\"port\"[[:space:]]*:[[:space:]]*[0-9][0-9]*/\"port\": ${PORT}/" "${INSTALL_DIR}/${dest}"
    fi
    if [ -n "${GENERATE_SECRET_IN:-}" ] && [ "$dest" = "$GENERATE_SECRET_IN" ]; then
      SEEDED_SECRET_FILE=true
    fi
    info "Seeded ${dest} from ${src}"
  done
}

# Insert/refresh `<APP_NAME>_SECRET` in GENERATE_SECRET_IN. A pre-existing
# secret is never rotated; an empty placeholder is filled in.
generate_secret_into() {
  [ -n "${GENERATE_SECRET_IN:-}" ] || return 0
  local file="${INSTALL_DIR}/${GENERATE_SECRET_IN}" key secret
  key="$(printf '%s' "$APP_NAME" | tr '[:lower:]-' '[:upper:]_')_SECRET"

  if [ ! -e "$file" ]; then
    secret="$(generate_secret)"
    ( umask 077; printf '%s=%s\n' "$key" "$secret" > "$file" )
    info "Generated ${key} in ${GENERATE_SECRET_IN}"
    return 0
  fi
  if [ "$SEEDED_SECRET_FILE" != true ]; then return 0; fi

  if ! grep -q "^${key}=" "$file" 2>/dev/null; then
    secret="$(generate_secret)"
    printf '%s=%s\n' "$key" "$secret" >> "$file"
    info "Added ${key} to ${GENERATE_SECRET_IN}"
  elif ! grep -q "^${key}=.\+" "$file" 2>/dev/null; then
    secret="$(generate_secret)"
    ( umask 077; awk -v k="$key" -v v="$secret" '{ if ($0 == (k"=")) print k"="v; else print }' "$file" > "$file.tmp" && mv "$file.tmp" "$file" )
    info "Generated ${key} in ${GENERATE_SECRET_IN}"
  else
    info "Preserved existing ${key} in ${GENERATE_SECRET_IN}"
  fi
}

setup_data() {
  if [ -z "${DATA_DIR:-}" ]; then info "DATA_DIR is empty — no data symlink"; return 0; fi
  mkdir -p "$DATA_DIR"
  if [ ! -e "${INSTALL_DIR}/data" ]; then
    ln -s "$DATA_DIR" "${INSTALL_DIR}/data"
    info "Linked ${INSTALL_DIR}/data -> ${DATA_DIR}"
  fi
}

# ── Phase: helper scripts in RUN_DIR/scripts ───────────────────────────────
# update.sh / uninstall.sh / common.sh / app.env are installed together so the
# app can be managed later without the original deploy/ directory.
install_helper_scripts() {
  local dest="${RUN_DIR}/scripts" base f src cand
  mkdir -p "$dest"
  # Directory of the published deploy/, derived from LIB_RAW_URL (…/deploy/lib/common.sh).
  base="${LIB_RAW_URL:-}"; base="${base%/*}"; base="${base%/*}"

  for f in update.sh uninstall.sh common.sh app.env; do
    src=""
    for cand in "${SCRIPT_DIR}/${f}" "${SCRIPT_DIR}/lib/${f}" "${SCRIPT_DIR}/app.env"; do
      if [ "$f" = "app.env" ] && [ -n "${APP_ENV_FILE:-}" ] && [ -f "${APP_ENV_FILE}" ]; then
        src="$APP_ENV_FILE"; break
      fi
      if [ -f "$cand" ] && [ "$(basename "$cand")" = "$f" ]; then src="$cand"; break; fi
    done
    if [ -n "$src" ]; then
      cp -f "$src" "${dest}/${f}"
    elif [ -n "${LIB_RAW_URL:-}" ] && url_get "${base}/${f}" "${dest}/${f}" 2>/dev/null; then
      :
    else
      warn "could not install helper: ${f}"
      continue
    fi
    if [ "$f" = "app.env" ]; then chmod 600 "${dest}/${f}"; else chmod +x "${dest}/${f}"; fi
  done
  info "Helpers installed in ${dest}"
}

# ── Phase: update hooks in RUN_DIR/hooks ───────────────────────────────────
# install_hook_scripts installs pre-update / post-update hooks next to the
# helper scripts so update.sh finds them via its default HOOKS_DIR
# (${RUN_DIR}/hooks).  update.sh calls run_hook {pre,post}-update before and
# after the code swap; the hooks are executable scripts sourced from this
# directory.  See deploy/update.sh:run_hook for the contract.
install_hook_scripts() {
  local dest="${RUN_DIR}/hooks" base f src cand
  mkdir -p "$dest"
  # Directory of the published deploy/, derived from LIB_RAW_URL.
  base="${LIB_RAW_URL:-}"; base="${base%/*}"; base="${base%/*}"

  for f in pre-update post-update; do
    src=""
    for cand in "${SCRIPT_DIR}/hooks/${f}" "${SCRIPT_DIR}/${f}"; do
      if [ -f "$cand" ] && [ "$(basename "$cand")" = "$f" ]; then src="$cand"; break; fi
    done
    if [ -n "$src" ]; then
      cp -f "$src" "${dest}/${f}"
    elif [ -n "${LIB_RAW_URL:-}" ] && url_get "${base}/hooks/${f}" "${dest}/${f}" 2>/dev/null; then
      :
    else
      warn "could not install hook: ${f}"
      continue
    fi
    chmod +x "${dest}/${f}"
  done
  info "Hooks installed in ${dest}"
}

# ── Phase: systemd unit ────────────────────────────────────────────────────
SERVICE_INSTALLED=false
install_service() {
  if [ "$NO_SERVICE" = true ]; then info "Skipping systemd service (--no-service)"; return 0; fi
  if [ ! -d /etc/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
    info "systemd not found — skipping service installation"
    return 0
  fi
  if ! systemd_running; then
    warn "systemd not running — skipping service installation"
    return 0
  fi
  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    warn "sudo not available — skipping service installation"
    return 0
  fi

  local unit="/etc/systemd/system/${APP_NAME}.service" tmpdir tmp
  # Render under a valid unit name: systemd-analyze verify rejects other suffixes.
  tmpdir="$(mktemp -d)"; tmp="${tmpdir}/${APP_NAME}.service"
  cleanup_add "$tmp"
  render_systemd_unit "$EXEC_START" > "$tmp"

  # Best-effort: systemd-analyze can complain about paths that only exist post-boot.
  if command -v systemd-analyze >/dev/null 2>&1; then
    if systemd-analyze verify "$tmp" >/dev/null 2>&1; then info "Unit verified"; else warn "systemd-analyze verify reported issues"; fi
  fi

  if run_root cp -f "$tmp" "$unit" && run_root chmod 644 "$unit"; then
    rm -f "$tmp"; rmdir "$tmpdir" 2>/dev/null || true
  else
    warn "cannot write ${unit} — skipping service installation"
    return 0
  fi
  run_root systemctl daemon-reload || warn "systemctl daemon-reload failed"
  if run_root systemctl enable "$APP_NAME" >/dev/null 2>&1; then info "Enabled ${APP_NAME}"; else warn "could not enable ${APP_NAME}"; fi
  SERVICE_INSTALLED=true
}

# ── Phase: start & verify ──────────────────────────────────────────────────
HEALTH_OK=true
start_and_verify() {
  if [ "$NO_SERVICE" = true ]; then info "Skipping service start (--no-service)"; return 0; fi
  if [ "$SERVICE_INSTALLED" != true ]; then return 0; fi
  run_root systemctl start "$APP_NAME" || true
  if ! wait_health "$HEALTH_URL" "$EXPECTED_VERSION" "$HEALTH_TIMEOUT"; then
    HEALTH_OK=false
    warn "check: journalctl -u ${APP_NAME} -n 100 --no-pager"
  fi
}

# ── Helpers: early exit & guidance ─────────────────────────────────────────
up_to_date_exit() {
  echo ""
  info "${APP_NAME} ${1} is already installed at ${INSTALL_DIR} — up to date."
  print_rerun_guide
  exit 0
}

print_rerun_guide() {
  echo ""
  echo "[${APP_NAME}] Update:    bash ${RUN_DIR}/scripts/update.sh"
  echo "[${APP_NAME}] Uninstall: bash ${RUN_DIR}/scripts/uninstall.sh"
  echo "[${APP_NAME}] Health:    curl ${HEALTH_URL}"
}

print_summary() {
  local version="${EXPECTED_VERSION:-unknown}"
  echo ""
  echo "=== ${APP_NAME} installed ==="
  echo ""
  echo "  Version:    ${version}"
  echo "  Mode:       ${DIST}"
  echo "  Location:   ${INSTALL_DIR}"
  [ -n "${DATA_DIR:-}" ] && echo "  Data:       ${DATA_DIR}"
  echo "  State:      ${RUN_DIR}"
  echo "  Config:     ${RUN_DIR}/scripts/app.env"
  echo ""
  if [ "$SERVICE_INSTALLED" = true ]; then
    echo "  Service:    /etc/systemd/system/${APP_NAME}.service"
    echo "  Stop:       sudo systemctl stop ${APP_NAME}"
    echo "  Logs:       journalctl -u ${APP_NAME} -f"
  else
    echo "  Service:    skipped"
    echo "  Start:      ${EXEC_START}"
  fi
  echo "  Health:     curl ${HEALTH_URL}"
  echo "  Update:     bash ${RUN_DIR}/scripts/update.sh"
  echo "  Uninstall:  bash ${RUN_DIR}/scripts/uninstall.sh"
  echo ""
}

# ── Main ───────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"

  # -- config --
  load_app_env
  apply_overrides
  [ -n "${APP_NAME:-}" ] || error "APP_NAME is not set in app.env"
  detect_os
  detect_arch
  resolve_target_user

  INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
  PORT="${PORT:-3000}"
  HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
  HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:$(resolve_port)/health}"
  HOOKS_DIR="${HOOKS_DIR:-${RUN_DIR}/hooks}"

  info "Installing ${APP_NAME} (dist=${DIST})..."

  # -- platform & OS deps --
  install_system_deps

  # -- reach the target version --
  if [ "$DIST" = "source" ]; then
    require_source_config
    install_bun_if_needed
    source_prepare
    install_deps
    EXPECTED_VERSION="$(read_package_version "${INSTALL_DIR}/package.json")"
  elif [ "$DIST" = "binary" ]; then
    require_binary_config
    resolve_binary_version
    binary_up_to_date_check
    install_binary
    EXPECTED_VERSION="${TAG#v}"
  else
    error "DIST must be 'source' or 'binary' (got '${DIST}')"
  fi
  EXPECTED_VERSION="${EXPECTED_VERSION:-unknown}"

  # -- seed state, data, helpers + hooks --
  seed_files
  generate_secret_into
  setup_data
  install_helper_scripts
  install_hook_scripts

  # -- service --
  EXEC_START="${EXEC_START:-$(default_exec_start)}"
  install_service
  start_and_verify

  print_summary
  if [ "$HEALTH_OK" != true ]; then
    error "installed but the service did not pass the health check"
  fi
  info "Done."
}

main "$@"

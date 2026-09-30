#!/usr/bin/env bash

# Provenance: vendored from https://forgejo.home.lan/authelia/bun-templates commit 89be318daf8adab5ddca957162b3b7df8429e725
# Locally extended: piped-form default raw base (DEPLOY_RAW_URL) for the one-liner below.
# ════════════════════════════════════════════════════════════════════════════
#  install.sh — install (or reinstall) one app from app.env
#
#  Local run (deploy/ copied into your app repo):
#      sudo bash deploy/install.sh [OPTIONS]
#
#  One-liner (published SynaptoMind deploy/; no environment variables needed):
#      curl -fsSL https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy/install.sh | bash
#
#  Forks/mirrors can point elsewhere; DEPLOY_RAW_URL moves the base used for
#  lib/common.sh and app.env, and an explicit LIB_RAW_URL/APP_ENV_URL wins:
#      DEPLOY_RAW_URL=https://HOST/deploy curl -fsSL https://HOST/deploy/install.sh | bash
#
#  Options:
#      --dir DIR       Install directory        (default: INSTALL_DIR in app.env)
#      --port PORT     Port for the seeded config + health check (default: PORT)
#      --version TAG   Pin a version instead of resolving the latest
#      --force         Reinstall even when the same version is already present
#      --no-service    Skip systemd unit installation and start
#      --help, -h      Show this help
#
#  Seeded ports: a FRESH config.json gets server.port = PORT and
#  mcp.httpPort = MCP_PORT (app.env, optional — defaults to PORT + 1). An
#  existing config.json is preserved verbatim, so an installed host keeps its
#  own MCP port. See resolve_mcp_port() in lib/common.sh.
#
#  Pipeline (see the phase banners in main):
#      config -> platform + OS deps -> fetch code/binary -> seed state
#      -> data symlink -> helper scripts -> systemd unit -> health check
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# Directory this script was loaded from. Empty for `curl ... | bash` (stdin),
# where BASH_SOURCE is unset — see load_common() below. Falling back to $0 would
# resolve to the caller's cwd and misdetect a piped run as a local one, so the
# fallback is deliberately empty.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""
fi

# ── Raw base for the piped form (`curl … | bash`) ──────────────────────────
# A piped run has no SCRIPT_DIR, so lib/common.sh and app.env must be fetched.
# Default to the published SynaptoMind deploy/ base so the one-liner needs no
# environment; an explicit LIB_RAW_URL/APP_ENV_URL wins over the derived value,
# and DEPLOY_RAW_URL relocates the base (forks, mirrors). Local/checkout runs
# (SCRIPT_DIR non-empty) keep using the sibling files, so the defaults below
# are never applied there.
if [ -z "$SCRIPT_DIR" ]; then
  DEPLOY_RAW_URL="${DEPLOY_RAW_URL:-https://raw.githubusercontent.com/zumik3-del/synaptomind/main/deploy}"
  LIB_RAW_URL="${LIB_RAW_URL:-${DEPLOY_RAW_URL}/lib/common.sh}"
  APP_ENV_URL="${APP_ENV_URL:-${DEPLOY_RAW_URL}/app.env}"
fi

# ── Argument state (overrides app.env after it is loaded) ──────────────────
ARG_DIR=""
ARG_PORT=""
ARG_VERSION=""
FORCE=false
NO_SERVICE=false

# ── Load lib/common.sh ─────────────────────────────────────────────────────
# Normally a sibling file. Under `curl | bash` there is none, so fetch it from
# LIB_RAW_URL (defaulted above for the published base, since app.env is not
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
        sed -n '3,33p' "$0" 2>/dev/null || echo "See the comment header of install.sh"
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
  # A host with no published asset must be told so by name, not by a 404 from
  # url_get a few lines later (ADR 0001 §2.7).
  require_binary_platform
  need_cmd tar
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
    release_resolve_tag
    TAG="$RESOLVED_TAG"
  fi
  info "Target version: ${TAG#v}"
}

# Binary mode: exit early when the installed binary is current.
binary_up_to_date_check() {
  local bin="${INSTALL_DIR}/${APP_NAME}" cur
  [ -f "$bin" ] || return 0
  [ "$FORCE" = true ] && return 0
  cur="$(app_version "$bin")"
  # BOTH operands normalised: app_version keeps the leading "v" (common.sh
  # strips only the app name) and the tag is v-prefixed too, while
  # `ver_cmp "v0.8.0" "0.8.0"` answers "newer" — a correct, already-installed
  # payload used to abort with "use --force" (ADR 0001 §2.6).
  case "$(ver_cmp "$(normalize_v "$cur")" "$(normalize_v "$TAG")")" in
    same)  up_to_date_exit "${cur#v}" ;;
    newer) error "newer version ${cur} is already installed; use --force to override" ;;
  esac
}

# Binary mode: download the release tarball, extract it, verify it, swap it in.
# The whole sequence lives in lib/common.sh so update.sh takes the identical
# path (ADR 0001 §2.9).
install_binary() {
  binary_install_payload
}

# ── Phase: seed state (config files, secret, data dir) ─────────────────────
SEEDED_SECRET_FILE=false

# align_config_port FILE KEY VALUE — rewrite `"KEY": <n>` in FILE to
# `"KEY": VALUE`. KEY is matched literally INCLUDING its quotes, which is what
# keeps '"port"' from touching '"httpPort"'. A missing key is a no-op, so a
# payload that ships neither key seeds unchanged.
align_config_port() {
  local file="$1" key="$2" value="$3"
  [ -f "$file" ] || return 0
  sed -i "s/${key}[[:space:]]*:[[:space:]]*[0-9][0-9]*/${key}: ${value}/" "$file"
}

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
    # A seeded config.json is the port source: align BOTH listeners with the
    # ports this install resolved. mcp.httpPort is rewritten for the same
    # reason server.port is — the example ships 3006, and a host that already
    # owns 3006 would otherwise install a service that can never start
    # (resolve_mcp_port in lib/common.sh for the rule; task #1077).
    if [ "$base" = "config.json" ]; then
      align_config_port "${INSTALL_DIR}/${dest}" '"port"' "$PORT"
      align_config_port "${INSTALL_DIR}/${dest}" '"httpPort"' "$MCP_PORT"
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
# update.sh / updater.sh / uninstall.sh / common.sh / app.env are installed together so the
# app can be managed later without the original deploy/ directory.
install_helper_scripts() {
  local dest="${RUN_DIR}/scripts" base f src cand
  mkdir -p "$dest"
  # Directory of the published deploy/, derived from LIB_RAW_URL (…/deploy/lib/common.sh).
  base="${LIB_RAW_URL:-}"; base="${base%/*}"; base="${base%/*}"

  for f in update.sh updater.sh uninstall.sh common.sh app.env; do
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

  # UNIT_FILE is overridable so a non-standard unit path (and the deploy tests)
  # need not write to /etc/systemd/system. Mirrors update.sh's refresh_unit.
  local unit="${UNIT_FILE:-/etc/systemd/system/${APP_NAME}.service}" tmpdir tmp
  # Render under a valid unit name: systemd-analyze verify rejects other suffixes.
  tmpdir="$(mktemp -d)"; tmp="${tmpdir}/${APP_NAME}.service"
  cleanup_add "$tmp"
  render_systemd_unit "$EXEC_START" > "$tmp"

  # Best-effort: systemd-analyze can complain about paths that only exist post-boot.
  if command -v systemd-analyze >/dev/null 2>&1; then
    if systemd-analyze verify "$tmp" >/dev/null 2>&1; then info "Unit verified"; else warn "systemd-analyze verify reported issues"; fi
  fi

  # Keep the body being replaced, so a re-install over a hand-edited unit is
  # recoverable. A fresh install has no unit to lose, and then there is no .bak.
  if [ -e "$unit" ] && ! write_file_atomically "${unit}.bak" "$unit"; then
    warn "  proceeding WITHOUT a recovery copy of the unit this install replaces."
  fi

  # Atomic replacement, staged beside the unit and swapped with rename(2) — the
  # same mechanism update.sh uses, and the same reason: `cp -f` opens the LIVE
  # unit O_TRUNC, so a copy that dies partway (ENOSPC, EIO, killed) truncates an
  # existing hand-edited production unit while this run reports "cannot write".
  # / on this host reached 100% with zero bytes free during the 0.9.0 review, so
  # the trigger is demonstrated rather than theoretical — and this is the path a
  # FRESH install takes, i.e. the 0.9.0 cutover. The mode is preserved rather
  # than forced to 644, so a unit carrying Environment= secrets is not widened.
  if write_file_atomically "$unit" "$tmp"; then
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
  echo "[${APP_NAME}] Update:    bash ${RUN_DIR}/scripts/updater.sh"
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
    echo "  Service:    ${UNIT_FILE:-/etc/systemd/system/${APP_NAME}.service}"
    echo "  Stop:       sudo systemctl stop ${APP_NAME}"
    echo "  Logs:       journalctl -u ${APP_NAME} -f"
  else
    echo "  Service:    skipped"
    echo "  Start:      ${EXEC_START}"
  fi
  echo "  Health:     curl ${HEALTH_URL}"
  echo "  Update:     bash ${RUN_DIR}/scripts/updater.sh"
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
  # Seeding target for mcp.httpPort. Resolved before seed_files() and NOT from
  # an existing config.json: that file is preserved verbatim (see
  # resolve_mcp_port), so an already-installed host keeps its own MCP port.
  MCP_PORT="$(resolve_mcp_port)"
  # The one way the two listeners can collide is an explicit MCP_PORT equal to
  # PORT. Reject it here — before the payload is fetched — rather than install a
  # service whose only possible outcome is EADDRINUSE on the second listener.
  if [ "$MCP_PORT" = "$PORT" ]; then
    error "MCP_PORT (${MCP_PORT}) must differ from PORT (${PORT})"
  fi
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

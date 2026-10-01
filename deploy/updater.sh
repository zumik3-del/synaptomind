#!/usr/bin/env bash
# deploy/updater.sh — FROZEN bootstrap (contract v1). See
# plans/2026-09-27-updater-bootstrap-adr.md. Installed to ${RUN_DIR}/scripts/updater.sh.
# Resolves the newest stable release, stages that release's deploy/update.sh +
# deploy/lib/common.sh (+ installed app.env) in mktemp -d, and runs update.sh.
#
# Usage: bash updater.sh [--version TAG] [--yes|-y] [--help|-h]
#   --version TAG   Update to a specific stable tag (skips the menu)
#   --yes, -y       Non-interactive: pick the newest stable, forward --yes
#   --help, -h      Show this help
#
# FROZEN: name/location, flags --version/--yes/--help, exit codes, stable-only policy.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""

# Reuse the installed helpers (logging, app.env, url_get, version read/compare, resolve_port).
load_common() {
  local cand
  for cand in "${SCRIPT_DIR}/lib/common.sh" "${SCRIPT_DIR}/common.sh"; do
    [ -f "$cand" ] && { . "$cand"; return 0; }
  done
  echo "[app] ERROR: cannot find lib/common.sh next to $0" >&2; exit 1
}
load_common

STAGE_ROOT=""
# The trap must always return 0: under `set -e` a failing last command would
# override the pending status (e.g. `exit 0` from --help) and make the script
# exit 1. Stage cleanup is best-effort and never changes the exit code.
#
# STAGE_ROOT keeps its own `rm -rf` here rather than joining the shared
# cleanup_add registry (mktemp_owned, lib/common.sh), unlike every other temp
# path in deploy/. That is deliberate: this file is the FROZEN bootstrap, and
# its own fixture (updater.sh.test.ts MINIMAL_COMMON_SH) provides a cleanup_run
# that removes FILES only — folding a directory in would make this script's
# stage cleanup depend on an `rm -rf` the contract it is tested against does not
# promise. This path never leaked (the trap removes it, success and failure
# alike), so there is nothing here to fix; consolidating it would be a
# refactor of a frozen contract for no leak removed.
_on_exit() { cleanup_run; if [ -n "$STAGE_ROOT" ]; then rm -rf -- "$STAGE_ROOT"; fi; return 0; }
trap _on_exit EXIT

ARG_VERSION=""; ASSUME_YES="${ASSUME_YES:-false}"
TAG_RE='^v[0-9][0-9A-Za-z.+-]*$'          # validates remote tag strings (no injection)

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || error "--version requires a tag"; ARG_VERSION="$2"; shift 2 ;;
      --yes|-y)  ASSUME_YES=true;  shift   ;;
      --help|-h) sed -n '2,12p' "$0" 2>/dev/null || echo "See updater.sh header"; exit 0 ;;
      *) error "unknown option: $1 (try --help)" ;;
    esac
  done
}

# Newest-first list of stable tags from the remote (no local clone, no fetch).
resolve_stable_tags() {
  mapfile -t TAGS < <(
    git ls-remote --tags --refs "$REPO_URL" 2>/dev/null \
      | awk '{print $2}' | sed 's#^refs/tags/##' \
      | grep -E '^v[0-9]' | grep -v -- '-' | sort -Vr || true
  )
  [ "${#TAGS[@]}" -gt 0 ] || error "no stable release tags found in ${REPO_URL}"
}

current_version() {
  local v=""
  # Binary install: the artefact itself is authoritative — offline, no HTTP, and
  # exact. app_version() returns a v-PREFIXED string (it strips only the app-name
  # prefix), so the consumers below normalise with ${CURRENT#v}.
  if [ "${DIST:-source}" = "binary" ] && [ -x "${INSTALL_DIR}/${APP_NAME}" ]; then
    v="$(app_version "${INSTALL_DIR}/${APP_NAME}")"
  fi
  [ -n "$v" ] || v="$(read_package_version "${INSTALL_DIR}/package.json" 2>/dev/null || true)"
  # Health is the fallback: it reports the bare VERSION (src/services/health.service.ts),
  # so it is the only source that works before a binary install exists.
  [ -n "$v" ] || v="$(url_get "$HEALTH_URL" 2>/dev/null | parse_json_version || true)"
  printf '%s' "${v:-unknown}"
}

select_target() {                 # sets $CHOSEN
  if [ -n "$ARG_VERSION" ]; then
    [[ "$ARG_VERSION" =~ $TAG_RE ]] || error "invalid version: ${ARG_VERSION}"
    CHOSEN="$(normalize_v "$ARG_VERSION")"
    printf '%s\n' "${TAGS[@]}" | grep -qxF -- "$CHOSEN" \
      || error "version ${CHOSEN} is not a known stable release"
    return
  fi
  if [ "$ASSUME_YES" = true ]; then CHOSEN="${TAGS[0]}"; return; fi
  if [ ! -t 0 ]; then error "non-interactive shell — re-run with --yes or --version"; fi
  local n=${#TAGS[@]} i sel; [ "$n" -gt 10 ] && n=10
  for ((i=0; i<n; i++)); do
    # ${CURRENT#v}: app_version keeps the leading "v", the tag list does not
    # compare equal against it without stripping both sides.
    local mark=""; [ "${TAGS[$i]#v}" = "${CURRENT#v}" ] && mark=" *"
    printf '  %2d) %s%s\n' "$((i+1))" "${TAGS[$i]}" "$mark"
  done
  read -r -p "Select version [1-${n}] (default 1): " sel || sel=""
  sel="${sel:-1}"
  { [ "$sel" -ge 1 ] 2>/dev/null && [ "$sel" -le "$n" ] 2>/dev/null; } || error "invalid selection"
  CHOSEN="${TAGS[$((sel-1))]}"
}

# Shallow-clone the tag and stage update.sh + lib/common.sh + app.env together.
stage_release() {
  local tag="$1" clone
  STAGE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/synaptomind-updater.XXXXXX")" \
    || error "cannot create staging dir"
  clone="${STAGE_ROOT}/src"
  git clone --depth 1 --branch "$tag" --quiet "$REPO_URL" "$clone" \
    || error "cannot fetch release ${tag} from ${REPO_URL}"
  mkdir -p "${STAGE_ROOT}/run/lib"
  # Tolerate a tag without deploy/ (pre-v0.8.0): assert_contract reports it clearly.
  cp -f "${clone}/deploy/update.sh"      "${STAGE_ROOT}/run/update.sh"     2>/dev/null || true
  cp -f "${clone}/deploy/lib/common.sh"  "${STAGE_ROOT}/run/lib/common.sh" 2>/dev/null || true
  cp -f "${RUN_DIR}/scripts/app.env"     "${STAGE_ROOT}/run/app.env"
  chmod +x "${STAGE_ROOT}/run/update.sh" 2>/dev/null || true
  STAGE_DIR="${STAGE_ROOT}/run"
}

assert_contract() {
  [ -s "${STAGE_DIR}/update.sh" ] && [ -s "${STAGE_DIR}/lib/common.sh" ] \
    || error "release ${CHOSEN} has no deploy/update.sh (stable releases before v0.8.0 lack deploy/)"
  bash "${STAGE_DIR}/update.sh" --version 0.0.0 --yes --help >/dev/null 2>&1 \
    || error "frozen contract violated: release update.sh no longer accepts --version/--yes/--help"
}

run_update() {
  local rc=0
  info "Running release update.sh for ${CHOSEN}..."
  if [ "$ASSUME_YES" = true ]; then
    bash "${STAGE_DIR}/update.sh" --version "$CHOSEN" --yes || rc=$?
  else
    bash "${STAGE_DIR}/update.sh" --version "$CHOSEN" || rc=$?
  fi
  exit "$rc"
}

main() {
  parse_args "$@"
  load_app_env
  resolve_target_user
  INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
  PORT="${PORT:-3000}"
  HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:$(resolve_port)/health}"
  # Binary mode is accepted: REPO_URL stays required because this bootstrap
  # shallow-clones the tag to stage that release's own deploy/update.sh. A
  # binary host therefore needs git and network access to the repository, but
  # neither the repository on disk nor a checkout in INSTALL_DIR (ADR 0001 §2.9).
  case "${DIST:-source}" in
    source|binary) ;;
    *) error "updater supports DIST=source or DIST=binary (got '${DIST}')" ;;
  esac
  [ -n "${REPO_URL:-}" ] || error "REPO_URL is empty (required for the updater bootstrap in both modes)"
  need_cmd git
  export RUN_DIR
  CURRENT="$(current_version)"
  resolve_stable_tags
  info "Current: ${CURRENT#v}   Latest stable: ${TAGS[0]#v}"
  select_target
  confirm "Update ${CURRENT#v} -> ${CHOSEN#v}?" || { info "Aborted."; exit 0; }
  stage_release "$CHOSEN"
  assert_contract
  run_update
}
main "$@"

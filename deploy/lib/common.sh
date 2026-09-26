#!/usr/bin/env bash

# Provenance: vendored verbatim from https://forgejo.home.lan/authelia/bun-templates commit 89be318daf8adab5ddca957162b3b7df8429e725
# ════════════════════════════════════════════════════════════════════════════
#  lib/common.sh — shared helpers for the deploy/ framework
#
#  Sourced, never executed:   . "${SCRIPT_DIR}/lib/common.sh"
#
#  The helpers expect APP_NAME (from app.env) only for the "[app]" log prefix;
#  every function degrades to the prefix "app" when called before app.env.
#
#  Conventions
#    * human output goes through info/warn/error;
#    * data-returning helpers write to stdout and say nothing else there;
#    * no helper changes the caller's working directory.
# ════════════════════════════════════════════════════════════════════════════

# Guard against double sourcing (install.sh + a hook may both source it).
if [ -n "${_DEPLOY_COMMON_LOADED:-}" ]; then return 0; fi
_DEPLOY_COMMON_LOADED=1

# --yes flips this in the entry point; every prompt goes through confirm().
: "${ASSUME_YES:=false}"

# Files registered by cleanup_add() and removed by the entry point's EXIT trap.
_DEPLOY_TMP_FILES=()
cleanup_add() { _DEPLOY_TMP_FILES+=("$1"); }
cleanup_run() {
  local f
  if [ "${#_DEPLOY_TMP_FILES[@]}" -gt 0 ]; then
    for f in "${_DEPLOY_TMP_FILES[@]}"; do rm -f "$f"; done
  fi
}

# ── Logging & input ────────────────────────────────────────────────────────
info()  { echo "[${APP_NAME:-app}] $*"; }
warn()  { echo "[${APP_NAME:-app}] WARNING: $*" >&2; }
error() { echo "[${APP_NAME:-app}] ERROR: $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || error "required command not found: $1"
}

# Ask before a destructive step. --yes answers automatically; a non-interactive
# shell without --yes refuses instead of hanging or silently proceeding.
confirm() {
  if [ "$ASSUME_YES" = true ]; then return 0; fi
  if [ ! -t 0 ]; then
    warn "non-interactive shell — refusing to continue; re-run with --yes"
    return 1
  fi
  local reply
  read -r -p "[${APP_NAME:-app}] $1 [y/N] " reply || return 1
  case "$reply" in
    [Yy]*) return 0 ;;
    *)     return 1 ;;
  esac
}

# ── Privileges & target user ───────────────────────────────────────────────
run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# Decide which user owns the install and where its state lives.
# `curl | sudo bash` runs as root: the target is the invoking user, not root.
# SERVICE_USER (app.env) wins when set, then SUDO_USER, then the caller.
# Sets TARGET_USER, TARGET_HOME and the default RUN_DIR.
resolve_target_user() {
  if [ -n "${SERVICE_USER:-}" ]; then
    TARGET_USER="$SERVICE_USER"
  elif [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    TARGET_USER="$SUDO_USER"
  else
    TARGET_USER="$(id -un)"
  fi

  TARGET_HOME=""
  if command -v getent >/dev/null 2>&1; then
    TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [ -z "$TARGET_HOME" ]; then
    if [ "$TARGET_USER" = "$(id -un)" ]; then
      TARGET_HOME="${HOME:-/tmp}"
    else
      TARGET_HOME="/home/${TARGET_USER}"
    fi
  fi

  if [ -z "${RUN_DIR:-}" ]; then RUN_DIR="${TARGET_HOME}/.${APP_NAME}"; fi
}

# Locate an existing Bun binary: PATH first, then the usual install dirs.
locate_bun() {
  local c
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  for c in "${TARGET_HOME:-$HOME}/.bun/bin/bun" "/root/.bun/bin/bun" "/usr/local/bin/bun"; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

# ── Platform detection ─────────────────────────────────────────────────────
# Sets OS=linux|darwin, ARCH=x86_64|arm64 and ARCH_SRC=x64|arm64 (for Bun assets).
detect_os() {
  case "$(uname -s)" in
    Linux)  OS="linux"  ;;
    Darwin) OS="darwin" ;;
    *) error "unsupported OS: $(uname -s) (expected Linux or Darwin)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  ARCH="x86_64"; ARCH_SRC="x64"   ;;
    aarch64|arm64) ARCH="arm64";  ARCH_SRC="arm64" ;;
    *) error "unsupported architecture: $(uname -m) (expected x86_64 or arm64)" ;;
  esac
}

# systemd is usable when it reports "running" or "degraded" (the latter is
# normal in containers where a few units fail but systemd itself works).
systemd_running() {
  command -v systemctl >/dev/null 2>&1 || return 1
  local state
  state="$(systemctl is-system-running 2>&1 || true)"
  [ "$state" = "running" ] || [ "$state" = "degraded" ]
}

# ── Git tag resolution (callers fetch tags first) ──────────────────────────
latest_stable_tag()     { git -C "$1" tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1 || true; }
latest_prerelease_tag() { git -C "$1" tag --sort=-v:refname 2>/dev/null | grep -E -- '-alpha\.|-beta\.|-rc\.' | head -1 || true; }
latest_any_tag()        { git -C "$1" tag --sort=-v:refname 2>/dev/null | head -1 || true; }

# Default branch of a clone (origin/HEAD, then the checked-out branch).
default_branch() {
  local ref
  ref="$(git -C "$1" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  ref="${ref#origin/}"
  if [ -z "$ref" ]; then ref="$(git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"; fi
  if [ -z "$ref" ] || [ "$ref" = "HEAD" ]; then ref="main"; fi
  printf '%s' "$ref"
}

# Resolve CHECKOUT_POLICY into TARGET_REF + TARGET_KIND (tag|branch).
# stable|latest|prerelease pick a tag; anything else is treated as a branch,
# with the default branch as the fallback when no tag exists yet.
resolve_source_ref() {
  local policy="${CHECKOUT_POLICY:-stable}"
  case "$policy" in
    stable)     TARGET_REF="$(latest_stable_tag "$1")";     TARGET_KIND="tag" ;;
    latest)     TARGET_REF="$(latest_any_tag "$1")";        TARGET_KIND="tag" ;;
    prerelease) TARGET_REF="$(latest_prerelease_tag "$1")"; TARGET_KIND="tag" ;;
    *)          TARGET_REF="$policy";                       TARGET_KIND="branch" ;;
  esac
  if [ -z "$TARGET_REF" ]; then
    TARGET_REF="$(default_branch "$1")"
    TARGET_KIND="branch"
  fi
}

# ── Version reading ────────────────────────────────────────────────────────
# `version` field of a package.json-style file; empty when absent/unreadable.
read_package_version() {
  grep -o '"version": *"[^"]*"' "$1" 2>/dev/null | head -1 | sed 's/"version": *"//;s/"//' || true
}

# `version` field of a JSON document read from stdin (e.g. a /health body).
parse_json_version() {
  sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p'
}

# Run APP_VERSION_CMD against a concrete binary and print the bare version.
# APP_VERSION_CMD prints "APP_NAME <version>"; the app-name prefix is stripped.
app_version() {
  local bin="$1" out cmd
  cmd="${APP_VERSION_CMD:-\${BIN} --version}"
  out="$(BIN="$bin" sh -c "$cmd" 2>/dev/null || true)"
  out="${out%%$'\n'*}"
  printf '%s' "${out#"${APP_NAME}" }"
}

# ── Version comparison & normalization ─────────────────────────────────────
# Ensure a leading "v" (release tags) on stdout.
normalize_v() {
  case "$1" in
    v*) printf '%s' "$1" ;;
    *)  printf 'v%s' "$1" ;;
  esac
}

# Compare two versions with `sort -V`; prints older|same|newer (A relative to B).
ver_cmp() {
  local a="$1" b="$2" first
  if [ "$a" = "$b" ]; then printf 'same'; return 0; fi
  first="$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)"
  if [ "$first" = "$a" ]; then printf 'older'; else printf 'newer'; fi
}

# Expand ${APP_NAME} ${OS} ${ARCH} ${TAG} in a template string (no eval).
render_template() {
  local t="$1"
  t="${t//\$\{APP_NAME\}/${APP_NAME:-}}"
  t="${t//\$\{OS\}/${OS:-}}"
  t="${t//\$\{ARCH\}/${ARCH:-}}"
  t="${t//\$\{TAG\}/${TAG:-}}"
  printf '%s' "$t"
}

# ── Secrets ────────────────────────────────────────────────────────────────
# 36-char random secret: kernel UUID, then uuidgen, then time+sha256.
generate_secret() {
  cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || date +%s%N | sha256sum | head -c 36
}

# ── Network ────────────────────────────────────────────────────────────────
# Fetch a URL to stdout (no $2) or to a file ($2). curl, with wget fallback.
url_get() {
  local url="$1" out="${2:-}"
  if [ -n "$out" ]; then
    if command -v curl >/dev/null 2>&1; then curl -fLsS -o "$out" "$url"
    elif command -v wget >/dev/null 2>&1; then wget -q -O "$out" "$url"
    else error "need curl or wget"; fi
  else
    if command -v curl >/dev/null 2>&1; then curl -fLsS --max-time 30 "$url"
    elif command -v wget >/dev/null 2>&1; then wget -q -O- "$url"
    else error "need curl or wget"; fi
  fi
}

# Latest release tag from RELEASE_API (JSON with "tag_name"); prints the tag.
release_latest_tag() {
  if [ -z "${RELEASE_API:-}" ]; then warn "RELEASE_API is not set"; return 1; fi
  local json tag
  json="$(url_get "$RELEASE_API" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  if [ -z "$tag" ]; then
    warn "no \"tag_name\" in release metadata from ${RELEASE_API}"
    return 1
  fi
  printf '%s' "$tag"
}

# ── Port resolution ────────────────────────────────────────────────────────
# Effective API port: config.json governs when present (install.sh seeds it and
# an existing file may carry a custom port), app.env PORT is the fallback.
resolve_port() {
  local cfg p
  cfg="${INSTALL_DIR:-}/config.json"
  if [ -f "$cfg" ]; then
    p="$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$cfg" | head -1 | grep -o '[0-9][0-9]*' || true)"
    if [ -n "$p" ]; then printf '%s' "$p"; return 0; fi
  fi
  printf '%s' "${PORT:-3000}"
}

# ── Health check ───────────────────────────────────────────────────────────
# wait_health URL [EXPECTED_VERSION] [TIMEOUT]
# Polls URL until it answers. With EXPECTED_VERSION the body must also carry
# "version":"<expected>" (the /health contract). Returns 0 on success, 1 on
# timeout; progress is printed with the app prefix.
#
# SynaptoMind deviation: accepts status "ok" OR "degraded". The upstream
# template requires exactly "ok", but SynaptoMind returns "degraded" when
# non-fatal checks fail (e.g. embedder not yet ready) — src/services/
# health.service.ts:32. A reachable service must not fail install/update.
wait_health() {
  local url="$1" expected="${2:-}" timeout="${3:-60}" deadline body status version
  case "$timeout" in ''|*[!0-9]*) timeout=60 ;; esac
  deadline=$((SECONDS + timeout))
  if [ -n "$expected" ]; then
    info "Waiting for ${url} (version ${expected}, up to ${timeout}s)..."
  else
    info "Waiting for ${url} (up to ${timeout}s)..."
  fi

  while [ "$SECONDS" -lt "$deadline" ]; do
    body="$(url_get "$url" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      status="$(printf '%s' "$body" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      version="$(printf '%s' "$body" | parse_json_version)"
      if [ -z "$expected" ]; then
        info "Service is healthy."
        return 0
      fi
      if { [ "$status" = "ok" ] || [ "$status" = "degraded" ]; } && [ -n "$version" ] && [ "$version" = "$expected" ]; then
        info "Service is healthy, reported version ${version}."
        return 0
      fi
    fi
    sleep 2
  done

  warn "health check timed out after ${timeout}s (expected ${expected:-any version})"
  return 1
}

# ── systemd unit rendering ─────────────────────────────────────────────────
# render_systemd_unit EXEC_START — print a hardened unit for the current app.
# Reads APP_DESC, TARGET_USER, TARGET_HOME, INSTALL_DIR, DATA_DIR, BUN_BIN.
render_systemd_unit() {
  local exec_start="$1" rw="${INSTALL_DIR}" bun_path=""
  if [ -n "${DATA_DIR:-}" ]; then rw="${rw} ${DATA_DIR}"; fi
  if [ -n "${BUN_BIN:-}" ]; then bun_path="$(dirname "$BUN_BIN"):"; fi

  cat <<EOF
[Unit]
Description=${APP_DESC}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
# --- process ---
Type=simple
User=${TARGET_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=HOME=${TARGET_HOME}
Environment=PATH=${bun_path}/usr/local/bin:/usr/bin:/bin
ExecStart=${exec_start}
Restart=on-failure
RestartSec=5

# --- hardening ---
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${rw}
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
}

# ── app.env loading ────────────────────────────────────────────────────────
# Source app.env from SCRIPT_DIR, or from APP_ENV_URL for `curl | bash`.
# Sets APP_ENV_FILE to the sourced path and fails loudly when neither exists.
load_app_env() {
  local dir="${SCRIPT_DIR:-}" f tmp
  if [ -n "$dir" ]; then
    for f in "$dir/app.env" "$dir/../app.env"; do
      if [ -f "$f" ]; then
        # shellcheck source=/dev/null
        . "$f"
        APP_ENV_FILE="$f"
        return 0
      fi
    done
  fi

  if [ -n "${APP_ENV_URL:-}" ]; then
    tmp="$(mktemp)" || error "cannot create a temporary file"
    if url_get "$APP_ENV_URL" "$tmp"; then
      # shellcheck source=/dev/null
      . "$tmp"
      APP_ENV_FILE="$tmp"
      return 0
    fi
    rm -f "$tmp"
    error "cannot download app.env from ${APP_ENV_URL}"
  fi

  error "app.env not found — copy app.env.example to app.env next to the scripts, or set APP_ENV_URL for curl|bash"
}

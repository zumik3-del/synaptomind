#!/usr/bin/env bash

# Provenance: vendored from https://forgejo.home.lan/authelia/bun-templates commit 89be318daf8adab5ddca957162b3b7df8429e725
# Locally extended for DIST=binary per docs/adr/0001-self-contained-binary-tarball-deployment.md:
#   * cleanup_run      — rm -rf, so a registered staging *directory* is removed too.
#   * release_resolve_tag() — CHECKOUT_POLICY over the RELEASE_API list (§2.10).
#   * binary_stage_payload() and friends — tarball extract/verify/swap (§2.9).
#   * render_systemd_unit() — Environment=LD_LIBRARY_PATH when DIST=binary (§2.2).
#   * wait_health()         — also reads checks.embedder, so an embedder that can
#                             never load fails the gate instead of passing as ok.
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
# `rm -rf` (not `rm -f`) so a registered staging *directory* is removed as well;
# for a regular file the behaviour is identical. The explicit `return 0` keeps
# the trap from overriding the script's pending exit status.
_DEPLOY_TMP_FILES=()
cleanup_add() { _DEPLOY_TMP_FILES+=("$1"); }
cleanup_run() {
  local f
  if [ "${#_DEPLOY_TMP_FILES[@]}" -gt 0 ]; then
    for f in "${_DEPLOY_TMP_FILES[@]}"; do rm -rf -- "$f"; done
  fi
  return 0
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

# `checks.embedder` field of a JSON document read from stdin; empty when the
# payload predates the field (or carries no `checks`), which callers treat as
# "no signal" rather than as a failure.
parse_json_embedder() {
  sed -n 's/.*"embedder"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# Run APP_VERSION_CMD against a concrete binary and print the bare version.
# APP_VERSION_CMD prints "APP_NAME <version>"; the app-name prefix is stripped.
# The result KEEPS a leading "v" (synaptomind --version prints "synaptomind
# v0.8.0"), so every comparison must run both operands through normalize_v.
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
# NOTE: sort -V does NOT ignore a leading "v", so `ver_cmp "v0.8.0" "0.8.0"`
# answers "newer" and `ver_cmp "v0.8.0" "0.9.0"` also answers "newer". Binary
# mode mixes the two spellings (app_version keeps the v, tags may not), so
# callers must pass both operands through normalize_v first.
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

# Resolve CHECKOUT_POLICY into a release tag from the RELEASE_API list.
# Sets RESOLVED_TAG (v-prefixed). Mirrors resolve_source_ref()'s policy matrix,
# applied to the API list instead of `git tag`:
#   stable     newest tag without '-'      latest   newest tag of any kind
#   prerelease newest -alpha./-beta./-rc.  <branch> rejected — no release asset
# Sets RESOLVED_TAG rather than printing it: a command substitution would run
# this in a subshell, where error()'s exit and cleanup_add() would not reach the
# caller's EXIT trap.
#
# RELEASE_API is the LIST endpoint on purpose: /releases/latest silently
# excludes prereleases and cannot express a channel (ADR 0001 §2.8/§2.10).
# The unauthenticated API never returns drafts, so every entry is published.
RESOLVED_TAG=""
release_resolve_tag() {
  local policy="${CHECKOUT_POLICY:-stable}" json tags=""
  case "$policy" in
    stable|latest|prerelease) ;;
    *) error "CHECKOUT_POLICY=${policy} requires DIST=source (a branch has no release asset)" ;;
  esac
  [ -n "${RELEASE_API:-}" ] || error "RELEASE_API is empty; set it in app.env or pass --version <tag>"

  json="$(url_get "$RELEASE_API" 2>/dev/null || true)"
  [ -n "$json" ] || error "could not read ${RELEASE_API} (GitHub API rate limit or network); re-run with --version <tag>"

  local names
  names="$(printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  case "$policy" in
    stable)     tags="$(printf '%s\n' "$names" | grep -E '^v[0-9]' | grep -v -- '-'          | sort -V | tail -1 || true)" ;;
    latest)     tags="$(printf '%s\n' "$names" | grep -E '^v[0-9]'                             | sort -V | tail -1 || true)" ;;
    prerelease) tags="$(printf '%s\n' "$names" | grep -E '^v[0-9].*-(alpha|beta|rc)\.'         | sort -V | tail -1 || true)" ;;
  esac
  # The tag is interpolated into a download URL: accept only what a release tag
  # may look like (same shape updater.sh's TAG_RE enforces).
  [[ "$tags" =~ ^v[0-9][0-9A-Za-z.+-]*$ ]] \
    || error "no ${policy} release tag in ${RELEASE_API} (last entry: '${tags:-none}'); re-run with --version <tag>"
  RESOLVED_TAG="$tags"
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

# Effective MCP HTTP port for a SEEDED config.json: the optional app.env knob
# MCP_PORT when set, otherwise the API port + 1.
#
# Why the offset is the default (task #1077): the payload ships
# config.json.example with mcp.httpPort 3006, so a seeded config that never
# inherits the instance's own ports binds whatever the host happens to be using
# at 3006 — an install that succeeds and then dies on EADDRINUSE. Deriving both
# listeners from the SAME PORT value is what makes the rule deterministic and
# collision-free: server.port and mcp.httpPort differ by construction, and the
# layout matches production (API 3105 / MCP 3106).
#
# This only ever runs on the SEEDING path. seed_files() skips a config.json that
# already exists ("Preserved existing config.json"), so an installed host keeps
# its own mcp.httpPort verbatim — prod's deliberate 3106 included — and update.sh
# never seeds at all.
resolve_mcp_port() {
  if [ -n "${MCP_PORT:-}" ]; then printf '%s' "$MCP_PORT"; return 0; fi
  printf '%s' "$((${PORT:-3000} + 1))"
}

# ── Health check ───────────────────────────────────────────────────────────
# wait_health URL [EXPECTED_VERSION] [TIMEOUT]
# Polls URL until it answers. With EXPECTED_VERSION the body must also carry
# "version":"<expected>" (the /health contract). Returns 0 on success, 1 on
# timeout; progress is printed with the app prefix.
#
# SynaptoMind deviation: accepts status "ok" OR "degraded". The upstream
# template requires exactly "ok", but SynaptoMind returns "degraded" when
# non-fatal checks fail (e.g. embedder not yet ready) — getHealthService() in
# src/services/health.service.ts. A reachable service must not fail
# install/update.
#
# Second SynaptoMind deviation: `checks.embedder` is read as well, because
# status alone cannot separate a first install from a dead one. A fresh binary
# install answers "not ready" for as long as the model downloads (ADR 0001 §2.2
# relies on that), while a unit rendered WITHOUT Environment=LD_LIBRARY_PATH
# makes the embedder child die on ERR_DLOPEN_FAILED in a loop — and the client
# keeps respawning it, so the payload stays "not ready" forever. That is the
# blind spot this closes: src/embedder/client-core.ts latches the crashed state
# and the payload reports it as "failed" (src/services/health.service.ts).
#
# An embedder that reported "failed" is not waved through: the loop keeps
# polling so a self-healing child can still pass, and the failure is reported
# when the timeout expires — the gate then exits non-zero, so install.sh and
# update.sh surface it instead of printing clean success.
wait_health() {
  local url="$1" expected="${2:-}" timeout="${3:-60}" deadline body status version embedder
  local embedder_dead=false
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
      embedder="$(printf '%s' "$body" | parse_json_embedder)"
      # Re-derived from every sample, NOT latched: the app clears its own latch
      # once the embedder becomes ready, and a crash that recovers on the retry
      # must not fail the install it actually left healthy.
      if [ "$embedder" = "failed" ]; then embedder_dead=true; else embedder_dead=false; fi
      if [ -z "$expected" ]; then
        if [ "$embedder_dead" != true ]; then
          info "Service is healthy."
          return 0
        fi
      elif [ "$embedder_dead" != true ] \
        && { [ "$status" = "ok" ] || [ "$status" = "degraded" ]; } \
        && [ -n "$version" ] && [ "$version" = "$expected" ]; then
        info "Service is healthy, reported version ${version}."
        return 0
      fi
    fi
    sleep 2
  done

  if [ "$embedder_dead" = true ]; then
    warn "health check failed after ${timeout}s: /health reports checks.embedder=failed."
    warn "  The embedder child dies before the model loads — it cannot load its native runtime."
    warn "  For DIST=binary the unit needs Environment=LD_LIBRARY_PATH=${INSTALL_DIR:-<install-dir>}/lib (ADR 0001 §2.2)."
    warn "  Fix it and re-run, or roll back; embeddings stay permanently dead until then."
    warn "check: journalctl -u ${APP_NAME:-app} -n 100 --no-pager"
    return 1
  fi

  warn "health check timed out after ${timeout}s (expected ${expected:-any version})"
  return 1
}

# ── systemd unit rendering ─────────────────────────────────────────────────
# render_systemd_unit EXEC_START — print a hardened unit for the current app.
# Reads APP_DESC, TARGET_USER, TARGET_HOME, INSTALL_DIR, DATA_DIR, BUN_BIN, DIST.
render_systemd_unit() {
  local exec_start="$1" rw="${INSTALL_DIR}" bun_path=""
  local -a env_lines
  if [ -n "${DATA_DIR:-}" ]; then rw="${rw} ${DATA_DIR}"; fi
  if [ -n "${BUN_BIN:-}" ]; then bun_path="$(dirname "$BUN_BIN"):"; fi

  env_lines=("Environment=NODE_ENV=production")
  # ADR 0001 §2.2: a compiled binary dlopens an embedded addon whose RUNPATH
  # ($ORIGIN) resolves inside /$bunfs, so libonnxruntime.so.1 is only found when
  # the loader searches the payload's lib/ directory. LD_LIBRARY_PATH is the one
  # verified mechanism; the value is exactly ${INSTALL_DIR}/lib, with no
  # inheritance of an administrator's value. The embedder child inherits the
  # server's environment, so one line covers both roles.
  if [ "${DIST:-source}" = "binary" ]; then
    env_lines+=("Environment=LD_LIBRARY_PATH=${INSTALL_DIR}/lib")
  fi
  env_lines+=("Environment=HOME=${TARGET_HOME}"
              "Environment=PATH=${bun_path}/usr/local/bin:/usr/bin:/bin")

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
$(printf '%s\n' "${env_lines[@]}")
ExecStart=${exec_start}
# Restart=always, not on-failure (2026-09-30 incident, 12 min outage). The app
# registers SIGTERM/SIGINT handlers (src/index.ts:117-123), so an EXTERNAL signal
# ends in a graceful shutdown and exit status 0 — which on-failure deliberately
# does not restart, turning a signal into a one-way outage. on-abnormal is not
# the fix either: a handler that exits 0 is a CLEAN exit, which on-abnormal also
# ignores; only `always` closes that door. Deliberate operator intent is still
# honoured — `systemctl stop` sets the unit inactive and systemd does not restart
# it (verified by reproduction against a transient `systemd-run --user` unit, not
# by CI: see the header of deploy/systemd-unit.test.ts). StartLimit* above bounds
# a genuine crash loop, so `always` cannot become a respawn storm. The policy and
# that bound are both asserted in deploy/systemd-unit.test.ts.
Restart=always
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

# ── Binary payload: download, stage, verify, ordered swap ──────────────────
# Shared by install.sh and update.sh so both take the identical path
# (ADR 0001 §2.9). Reads $TAG, $INSTALL_DIR, $ASSET_PATTERN, $RELEASES_BASE.

# Platforms with a published release asset (§2.7). v1 ships linux-x86_64 only:
# onnxruntime-node has no darwin/x64 build, and shipping an asset no runner ever
# executed is not allowed. A host outside this set must fail here with a named
# message rather than with a 404 from url_get.
BINARY_SUPPORTED_PLATFORMS="linux-x86_64"

# Required in every payload (§2.1). A missing one aborts before anything is
# touched, instead of leaving a unit that starts and dies on ERR_DLOPEN_FAILED.
BINARY_REQUIRED_FILES="synaptomind vec0.so lib/libonnxruntime.so.1"

# Kept as <file>.prev for a no-git rollback (§2.9 step 6). A fresh install has
# none of them, so the existence guard skips this step without a special case.
BINARY_ROLLBACK_FILES="vec0.so lib/libonnxruntime.so.1 synaptomind"

# Swap order (§2.9 step 7). THE EXECUTABLE IS MOVED LAST ON PURPOSE: a multi-file
# swap is not atomic, so the only question is which interrupted state is
# detectable. Last ⇒ an interrupted swap leaves old executable + new data files,
# which is the state a deliberate downgrade produces — app_version still reports
# the old version. Executable-first would report the NEW version while running
# the OLD library, which no existing check would catch.
BINARY_SWAP_ORDER="vec0.so lib/libonnxruntime.so.1 config.json.example .env.example synaptomind"

# require_binary_platform — refuse a host that has no asset.
require_binary_platform() {
  case "$BINARY_SUPPORTED_PLATFORMS" in
    *"${OS}-${ARCH}"*) return 0 ;;
  esac
  error "no release asset for ${OS}-${ARCH}; supported: ${BINARY_SUPPORTED_PLATFORMS}"
}

# binary_stage_payload — download and extract the release tarball for $TAG,
# verify the required file set, and set STAGED_PAYLOAD to the payload directory.
# Nothing in $INSTALL_DIR is modified except the temporary tarball and the
# staging directory, both registered with cleanup_add() so the EXIT trap removes
# them (a ~119 MB tarball per install would otherwise leak).
#
# Sets STAGED_PAYLOAD instead of printing it: inside a command substitution this
# would run in a subshell, where cleanup_add() would not reach the caller's trap.
STAGED_PAYLOAD=""
binary_stage_payload() {
  local asset url archive staging entry got f
  local -a entries=()

  asset="$(render_template "$ASSET_PATTERN")"
  url="${RELEASES_BASE}/${TAG}/${asset}"

  # A fresh install has no INSTALL_DIR yet, and both the download and the
  # staging dir live inside it so that every later mv is a same-filesystem
  # rename rather than a copy across devices.
  mkdir -p "$INSTALL_DIR" || error "cannot create ${INSTALL_DIR}"
  archive="${INSTALL_DIR}/.${APP_NAME}.$$.tar.gz"
  cleanup_add "$archive"
  staging="$(mktemp -d "${INSTALL_DIR}/.stage.XXXXXX")" || error "cannot create a staging directory in ${INSTALL_DIR}"
  cleanup_add "$staging"

  info "Downloading ${asset} ${TAG}..."
  url_get "$url" "$archive" || error "download failed: ${url}"
  # Never extract straight into INSTALL_DIR: a dedicated staging dir is what
  # makes a malformed archive harmless.
  tar -xzf "$archive" -C "$staging" --no-same-owner \
    || error "cannot extract ${url} — is it a gzip tarball, and is tar installed?"

  # Require exactly one top-level directory.
  mapfile -t entries < <(find "$staging" -mindepth 1 -maxdepth 1 -print)
  [ "${#entries[@]}" -eq 1 ] \
    || error "malformed archive ${asset}: expected exactly one top-level directory, found ${#entries[@]}"
  entry="${entries[0]}"
  [ -d "$entry" ] || error "malformed archive ${asset}: top-level entry is not a directory"

  # §2.1 required set, before anything is touched.
  for f in $BINARY_REQUIRED_FILES; do
    [ -f "${entry}/${f}" ] \
      || error "release payload is incomplete: missing ${f} (required: ${BINARY_REQUIRED_FILES})"
  done
  # The executable bit is re-applied rather than required: the version check
  # below proves executability by running it, and a mode-mangling umask or a
  # non-root extraction must not fail an otherwise good payload.
  chmod +x "${entry}/${APP_NAME}" 2>/dev/null || true

  STAGED_PAYLOAD="$entry"
}

# binary_check_version — the payload's binary must report the tag it was
# downloaded for. Prints the bare version. BOTH operands are normalised:
# app_version keeps the leading "v" while the tag comparison used "${TAG#v}",
# and comparing "v0.8.0" against "0.8.0" sorts as "newer" — an install that
# aborts on a correct payload (§2.6, and the must-not-improvise list).
binary_check_version() {
  local got want
  got="$(app_version "$1")"
  want="$(normalize_v "$TAG")"
  [ -n "$got" ] || error "${1} did not report a version (is it a ${APP_NAME} binary?)"
  [ "$(normalize_v "$got")" = "$want" ] \
    || error "downloaded payload failed version check (got '${got}', expected '${want}')"
  printf '%s' "${want#v}"
}

# binary_keep_previous — one previous copy per rollback-critical file (§2.9 step 6).
binary_keep_previous() {
  local f
  for f in $BINARY_ROLLBACK_FILES; do
    if [ -f "${INSTALL_DIR}/${f}" ]; then
      mkdir -p "$(dirname "${INSTALL_DIR}/${f}")"
      cp -f "${INSTALL_DIR}/${f}" "${INSTALL_DIR}/${f}.prev" \
        || error "cannot keep the previous ${INSTALL_DIR}/${f}"
    fi
  done
}

# binary_swap_payload — ordered swap from the staging dir into INSTALL_DIR (§2.9
# step 7). Optional seed files are skipped when the payload omits them.
binary_swap_payload() {
  local payload="$1" f dest
  mkdir -p "${INSTALL_DIR}/lib"
  for f in $BINARY_SWAP_ORDER; do
    [ -f "${payload}/${f}" ] || continue
    dest="${INSTALL_DIR}/${f}"
    mkdir -p "$(dirname "$dest")"
    mv -f "${payload}/${f}" "$dest"
  done
}

# binary_install_payload — the whole §2.9 sequence: stage, version-check, keep
# the previous files, swap, drop the staging dir. Prints the installed version.
binary_install_payload() {
  local got
  binary_stage_payload                 # §2.9 steps 1-4
  got="$(binary_check_version "${STAGED_PAYLOAD}/${APP_NAME}")"   # step 5
  binary_keep_previous                 # step 6
  binary_swap_payload "$STAGED_PAYLOAD" # step 7
  rm -rf -- "$STAGED_PAYLOAD"          # step 8
  info "Installed ${INSTALL_DIR}/${APP_NAME} (${got})"
  printf '%s' "$got"
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

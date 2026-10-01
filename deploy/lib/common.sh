#!/usr/bin/env bash

# Provenance: vendored from https://forgejo.home.lan/authelia/bun-templates commit
#            89be318daf8adab5ddca957162b3b7df8429e725.
#
# This file is the deploy/ framework's single maintained copy, shared BYTE-IDENTICALLY
# by the fleet: synaptomind is the source of truth, and ziptask and subagentix carry a
# mechanical copy of this exact text (sha256 equal across all three). Fixes land HERE
# first and are then re-vendored; a hand-edit in a copy breaks that equality, so if the
# digests differ, re-vendor from synaptomind rather than reconciling in place.
#
# Locally extended for DIST=binary per docs/adr/0001-self-contained-binary-tarball-deployment.md:
#   * cleanup_run      — rm -rf, so a registered staging *directory* is removed too.
#   * release_resolve_tag() — CHECKOUT_POLICY over the RELEASE_API list (§2.10).
#   * binary_stage_payload() and friends — tarball extract/verify/swap (§2.9).
#   * render_systemd_unit() — Environment=LD_LIBRARY_PATH when DIST=binary (§2.2).
#   * wait_health()         — also reads checks.embedder, so an embedder that can
#                             never load fails the gate instead of passing as ok.
#   * app.env-keyed defaults with the previous hardcoded values as defaults
#     (ADR plans/2026-10-01-unify-deploy-framework-adr.md §3): the health
#     contract (HEALTH_STATUS_FIELD/HEALTH_OK_VALUES/HEALTH_VERSION_FIELD), the
#     binary file lists (BINARY_*), the source build step (INSTALL_FLAGS/
#     BUILD_CMD/BUILD_TIMEOUT) and the unit extras (UNIT_STATE_DIRECTORY/
#     UNIT_ENV_FILE/UNIT_EXTRA_ENV, plus Group= and a bounded stop).
#
# For a DIST=source app (subagentix) the DIST=binary branches above never execute and the
# BINARY_* defaults — which name synaptomind's payload files — are never read. They are
# carried verbatim and inert on purpose: a re-vendor is a mechanical copy, and this file
# has to stay diffable against its source or drift becomes invisible.
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

# ── Temp-path ownership ─────────────────────────────────────────────────────
# mktemp_owned VARNAME [MKTEM ARGS...] — the ONLY supported way to create a
# temporary path in these scripts. It creates the path AND registers it for the
# entry point's EXIT trap, in one step, so no site can create without owning.
#
# WHY A CREATION FUNCTION AND NOT A PER-SITE `cleanup_add`. The previous shape
# was `tmp="$(mktemp)"; cleanup_add "$tmp"` at each site, and the second half is
# exactly what the next edit forgets: run_hook() (update.sh) gained a `mktemp`
# for its hook transcript and never gained the registration, so every install
# and every update left a transcript on disk. The tests in this directory are
# the same story on the TS side — see ../tmp-fixtures.ts, which fixed the
# fixture-side twin of this defect the same way. A registration is a statement a
# site can omit; a constructor cannot be omitted.
#
# WHY IT SETS A VARIABLE INSTEAD OF PRINTING THE PATH. `x="$(mktemp_owned x)"`
# would run the whole function — including cleanup_add — inside a command
# substitution, which is a SUBSHELL: the array append happens in the subshell's
# copy and the parent's EXIT trap never sees the path, so the file survives
# exactly as if it had never been registered. Measured, not assumed: with the
# printing form the parent's registry stayed empty and the file was still
# present after cleanup_run. This is the same trap binary_stage_payload()'s
# STAGED_PAYLOAD and updater.sh's STAGE_ROOT/CHOSEN already sidestep, and the
# guard below turns the mistake into a loud failure instead of a silent leak.
# The caller's variable must be declared `local` (bash scopes these by
# dynamic scope, so printf -v reaches it).
mktemp_owned() {
  local __var="${1:-}" __path=""
  [ -n "$__var" ] || { echo "[${APP_NAME:-app}] ERROR: mktemp_owned needs a variable name" >&2; return 1; }
  # A subshell cannot register anything in its parent's registry. Refuse loudly
  # here rather than leaking a file the operator will only find as ENOSPC.
  if [ "$$" != "$BASHPID" ]; then
    error "mktemp_owned was called inside a subshell (\$(), a pipeline stage or ( )) — its cleanup registration would never reach this script's EXIT trap, so the path would leak. Set a variable instead of printing the path."
  fi
  shift
  __path="$(mktemp "$@")" || return 1
  cleanup_add "$__path"
  printf -v "$__var" '%s' "$__path"
}

# cleanup_release PATH — drop PATH from the EXIT trap's registry, so the trap
# leaves it alone. The ONE sanctioned exception to ownership-at-creation, for a
# path that must OUTLIVE the run: refresh_unit's rendered unit when RUN_DIR is
# unwritable, which the operator's remedy names (update.sh), and app.env
# downloaded from APP_ENV_URL, which install.sh reads after load_app_env
# returns. Both are deliberate hand-offs to a path outside the temp tree, and
# both say so where they happen. Releasing is explicit; the alternative —
# relying on the ABSENCE of a registration — is the defect this file exists to
# remove, because an unstated non-registration is indistinguishable from an
# oversight.
cleanup_release() {
  [ "${#_DEPLOY_TMP_FILES[@]}" -gt 0 ] || return 0
  local keep=() f
  # Length-guarded above, so the loop never expands an empty array into the
  # single empty word `${arr[@]:-}` would produce — an empty registry entry
  # would reach cleanup_run's `rm -rf -- ""` and fail the trap under set -e.
  for f in "${_DEPLOY_TMP_FILES[@]}"; do
    [ "$f" = "$1" ] || keep+=("$f")
  done
  if [ "${#keep[@]}" -gt 0 ]; then _DEPLOY_TMP_FILES=("${keep[@]}"); else _DEPLOY_TMP_FILES=(); fi
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
# Sets TARGET_USER, TARGET_HOME, TARGET_GROUP and the default RUN_DIR.
resolve_target_user() {
  if [ -n "${SERVICE_USER:-}" ]; then
    TARGET_USER="$SERVICE_USER"
  elif [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    TARGET_USER="$SUDO_USER"
  else
    TARGET_USER="$(id -un)"
  fi

  # The group the unit runs as, resolved HERE and not at the point of use,
  # because TARGET_USER is only known once the branch above has run.
  #
  # Precedence: TARGET_GROUP (the resolved name, when something already set it),
  # then SERVICE_GROUP (the app.env key — this is what makes THAT key work; it
  # was documented in app.env.example and read by nothing, so an app.env that
  # set it got the user's group and a unit that disagreed with its own config),
  # then the user. The framework never creates a group, so the user's own primary
  # group is the last fallback because it is the only value that cannot name a
  # group that does not exist (ADR §3e).
  : "${TARGET_GROUP:=${SERVICE_GROUP:-$TARGET_USER}}"

  # A group that does not exist is refused HERE, named, rather than rendered into
  # Group= and left for systemd to fail on at start time: by then the payload is
  # in place and the message is systemd's, which names neither app.env nor this
  # function. Only checked when the operator named a group explicitly — the
  # default is the user's own primary group, which exists by construction — and
  # skipped entirely when getent is absent, so a host without it is not refused
  # over a check it cannot run.
  if [ -n "${SERVICE_GROUP:-}" ] && command -v getent >/dev/null 2>&1; then
    if ! getent group "$TARGET_GROUP" >/dev/null 2>&1; then
      error "SERVICE_GROUP='${SERVICE_GROUP}' is not a group on this host — the unit's Group= would fail to start. Fix it in app.env, or leave it empty to use ${TARGET_USER}'s primary group."
    fi
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

# run_as_target_user CMD... — run CMD as the user the unit runs as.
#
# WHY THIS EXISTS. A root install (`sudo bash install.sh`) is the documented way
# to install anything under /opt, so every command it runs — `bun install`, and
# a build if one is configured — belongs to root, and everything it produces is
# root-owned. The service, however, runs as TARGET_USER: a build that must write
# `build/` and `.svelte-kit/` into a root-owned INSTALL_DIR cannot, and the
# failure (EACCES, deep inside a bundler) names nothing that points here.
#
# WHY HOME IS FORCED. bun, vite and svelte-kit all cache under HOME. A build
# running as TARGET_USER with root's HOME writes the cache into /root and fails
# on the first write, or pollutes the operator's home; TARGET_HOME is the home
# the service itself gets from the unit's Environment=HOME line, so the build
# and the service agree.
#
# NEVER FATAL. With no runuser and no sudo the command runs as the caller and
# says so: a warning plus a completed build beats a refusal, and the caller
# still sees the build's own exit status. PATH is deliberately NOT reset — the
# command must resolve the same bun the install just located.
run_as_target_user() {
  local me home
  me="$(id -un)"
  home="${TARGET_HOME:-$HOME}"
  if [ "$me" = "${TARGET_USER:-$me}" ]; then
    HOME="$home" "$@"
    return $?
  fi
  # runuser first: it needs no password, no tty and no sudoers entry, and it
  # keeps PATH, which `su -` would not.
  if [ "$(id -u)" -eq 0 ] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$TARGET_USER" -- env HOME="$home" "$@"
    return $?
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo -u "$TARGET_USER" env HOME="$home" "$@"
    return $?
  fi
  warn "cannot run as ${TARGET_USER} (no runuser, no sudo) — running as ${me} instead"
  "$@"
}

# ── Ownership ───────────────────────────────────────────────────────────────
# WHY THIS SECTION EXISTS. Install and update both run as root (they must, for
# /opt, /var/lib and /etc/systemd/system), so everything they create is
# root-owned — including DATA_DIR, which the service writes to, and RUN_DIR's
# scripts/app.env, which the updater and the pre-update hook READ as
# TARGET_USER. The service runs as TARGET_USER, so the failure is always an
# EACCES somewhere the operator is not looking: the app's first database write
# (after the health check has already passed), or `app.env: Permission denied`
# from the pre-update hook, which then aborts the update with no backup taken.
#
# Before this section `grep -n chown deploy/*.sh deploy/lib/common.sh` returned
# exactly one hit and it was a WARNING STRING: nothing in the framework ever
# applied ownership. The hosts' /var/lib/<app> dirs were owned by the service
# user only because an operator chowned them by hand.
#
# WHY IT LIVES HERE AND NOT IN install.sh. Two entry points create root-owned
# files: install.sh (clone, binary swap, seed) and update.sh (checkout, binary
# swap). The first cutovers left a swapped binary root-owned (#1113) because only
# install.sh owned this logic, so update.sh had no way to fix what it created.
# One implementation, called from both, is the only shape in which "every
# install AND update leaves the tree owned by the service user" is true.

# ownership_target — the `user:group` spec every chown in the framework uses.
# TARGET_GROUP defaults to TARGET_USER in resolve_target_user; the fallback is
# repeated here because the unit renderer and these helpers must not disagree if
# that default is ever moved.
ownership_target() {
  printf '%s:%s' "${TARGET_USER}" "${TARGET_GROUP:-${TARGET_USER}}"
}

# ownership_mismatch PATH — true when PATH ITSELF, or ANY entry beneath it, is
# not owned by TARGET_USER:TARGET_GROUP.
#
# WHY NOT THE TOP DIRECTORY ALONE. The first version compared only
# `stat -c '%U:%G' "$p"` and skipped the chown when it matched, which is wrong in
# exactly the case that matters: a `git clone` run by root creates the top
# directory AND every file under it as root, but an operator (or an earlier
# partial run) may already have chowned the top directory alone, or the build
# may have written a subtree as TARGET_USER afterwards. #1114 left 387
# root-owned entries under /opt/subagentix — whose top directory read
# opencode:opencode — including .git/index, which is what a `git status` as the
# service user then fails on. A top-level check cannot see any of that.
#
# `-print -quit` stops at the FIRST offender, so a mismatched tree costs one
# stat and a clean tree costs one read-only walk (no writes). A find without
# -quit support, or one that cannot descend, exits non-zero: that is treated as
# a MISMATCH, so an unverifiable tree is chowned rather than trusted. The
# degraded behaviour is a redundant chown, never a skipped one.
ownership_mismatch() {
  local p="$1" hit rc=0
  [ "$(stat -c '%U:%G' "$p" 2>/dev/null || true)" = "$(ownership_target)" ] || return 0
  command -v find >/dev/null 2>&1 || return 0
  hit="$(find "$p" \( ! -user "${TARGET_USER}" -o ! -group "${TARGET_GROUP:-${TARGET_USER}}" \) \
    -print -quit 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] || return 0
  [ -n "$hit" ]
}

# chown_target PATH — recursive chown of PATH to the service user, through
# run_root, and NOT FATAL.
#
# Never fatal by decision (ADR §3c): a run without root and without sudo cannot
# chown anything to another user, and that is a legitimate configuration
# (`--no-service` in a container, a `--dir` install under your own home where
# you are already TARGET_USER). A warning names the mismatch and the run
# continues; aborting would turn a cosmetic-ownership difference into a failed
# install and leave the service no better off. run_root is what makes the
# non-root case work at all: root runs chown directly, a user with sudo goes
# through sudo, a user without either gets the warning.
chown_target() {
  local p="$1" spec
  [ -n "$p" ] || return 0
  [ -e "$p" ] || return 0
  spec="$(ownership_target)"
  if run_root chown -R "$spec" "$p" 2>/dev/null; then
    info "Ownership: ${p} -> ${spec}"
  else
    warn "cannot chown ${p} to ${spec}."
    warn "  The service runs as ${TARGET_USER}; if it cannot write there, its first"
    warn "  database write will fail with EACCES — after the health check has passed."
    warn "fix: sudo chown -R ${spec} ${p}"
  fi
  return 0
}

# apply_ownership — INSTALL_DIR and DATA_DIR owned by the user the unit runs as.
#
# WHY -R ON BOTH. INSTALL_DIR holds node_modules, the built artefacts and the
# seeded config, all of which the service reads; DATA_DIR is where it writes. A
# non-recursive chown of the two top directories fixes neither, because the
# payload inside them is what the service touches.
apply_ownership() {
  local p
  # ${VAR:-} on both: a host whose app.env omits DATA_DIR (the setup_data path
  # already tolerates exactly that) must not abort here on `set -u`, and this
  # runs before the unit exists, so an abort is a failed install over an
  # unsettable-to-empty key.
  for p in "${INSTALL_DIR:-}" "${DATA_DIR:-}"; do
    [ -n "$p" ] || continue
    [ -e "$p" ] || continue
    # Already owned, tree-wide: say nothing. A non-root install into the
    # caller's own directory hits this on every run, and a chown that changes
    # nothing is noise — as is a recursive chown over a large node_modules.
    ownership_mismatch "$p" || continue
    chown_target "$p"
  done
  return 0
}

# apply_run_dir_ownership — the framework's own state under RUN_DIR owned by the
# service user: RUN_DIR itself, the helper scripts (including the mode-600
# app.env) and the hooks.
#
# WHY THIS IS SEPARATE FROM apply_ownership. RUN_DIR is not part of the install
# payload: it is written by install_helper_scripts() / install_hook_scripts(),
# which run AFTER apply_ownership in install.sh's main. Chowning it from there
# would chown an empty or absent directory.
#
# WHY IT MATTERS. update.sh, updater.sh and the pre-update hook all run as
# TARGET_USER (the operator's `bash ${RUN_DIR}/scripts/updater.sh`, not sudo),
# and the hook reads ${RUN_DIR}/scripts/app.env for INSTALL_DIR. app.env is
# installed mode 600, so a root-owned one is unreadable to exactly the process
# that takes the pre-update database backup: #1113's backup failed silently with
# "app.env: Permission denied".
#
# Scoped to these three paths on purpose. RUN_DIR may also hold app state the
# framework does not own (a legacy data/ dir, a settings.json); a blind
# `chown -R ${RUN_DIR}` would silently take that too.
apply_run_dir_ownership() {
  local d
  # Guarded BEFORE the loop, not inside it: the loop list is expanded when the
  # `for` runs, so a `[ -n "$RUN_DIR" ]` test in the body would be reached only
  # after "${RUN_DIR}/scripts" had already tripped `set -u` on a host whose
  # app.env leaves RUN_DIR empty and never reached resolve_target_user.
  [ -n "${RUN_DIR:-}" ] || return 0
  for d in "$RUN_DIR" "${RUN_DIR}/scripts" "${RUN_DIR}/hooks"; do
    [ -e "$d" ] || continue
    ownership_mismatch "$d" || continue
    chown_target "$d"
  done
  return 0
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
#
# The file branch and the stdout branch are NOT the same transfer. The stdout
# branch reads small API/metadata bodies, so --max-time 30 is the whole safety
# net and silence is desirable (the body is piped into a parser).
#
# The file branch fetches multi-megabyte release assets (an ~82 MB ziptask
# tarball), and the plain `curl -fLsS -o $out $url` it used to carry had no
# progress, no stall guard and no retry: a link that accepted the connection
# and then stopped delivering hung the install indefinitely, indistinguishable
# from a dead one. It also hid the fact that anything was happening at all.
# So this branch keeps -S (errors still print) but drops -s, and adds:
#   --connect-timeout 15  bound the TCP/TLS handshake, not just the transfer
#   --speed-limit/-time   abort when throughput sits under 1 KB/s for 30 s —
#                         this is the stall guard, and it is what turns a
#                         silent hang into a fast, reported failure
#   --retry 3             ride out transient failures
#   -C -                  resume rather than restart, so a retry over an 82 MB
#                         asset costs the remaining bytes, not the whole file
# The stall guard makes --speed-limit/--speed-time fire as error 28, which is
# retried, so the stall case recovers by resuming instead of failing outright.
url_get() {
  local url="$1" out="${2:-}"
  if [ -n "$out" ]; then
    if command -v curl >/dev/null 2>&1; then
      curl -fLS --connect-timeout 15 --speed-limit 1024 --speed-time 30 \
        --retry 3 --retry-delay 2 -C - -o "$out" "$url"
    elif command -v wget >/dev/null 2>&1; then
      wget -c --tries=3 --waitretry=2 --timeout=30 -O "$out" "$url"
    else error "need curl or wget"; fi
  else
    if command -v curl >/dev/null 2>&1; then curl -fLsS --max-time 30 "$url"
    elif command -v wget >/dev/null 2>&1; then wget -q -O- "$url"
    else error "need curl or wget"; fi
  fi
}

# The tag names in a release-metadata payload, in payload order, one per line.
#
# NOT line-based, and that is the whole point of this helper. A JSON array of
# releases is served as ONE minified line — `[{"tag_name":…},{"tag_name":…},…]`
# — so a `sed` that transforms a line sees a single entry in it: the LAST one,
# and reports it as the only release that exists. The consequences were not
# cosmetic (task #1079 F3): with the newest prerelease last, CHECKOUT_POLICY=stable
# hard-failed with "no stable release tag" while that prerelease was the answer
# for `latest` and `prerelease` alike.
#
# `grep -o` emits EVERY match on a line, so a minified array, a pretty-printed
# one and a single release object all yield the same list of names. Both shapes
# are pinned in deploy/updater.sh.test.ts.
release_tag_names() {
  grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
}

# release_sort_key TAG — a sort key that ranks a release ABOVE its own
# prereleases, which `sort -V` does not.
#
# MEASURED, GNU coreutils 9.x: `sort -V` compares "0.9.0beta.1" against "0.9.0"
# as text once the digit runs are exhausted, so it answers
#     printf '%s\n' v0.9.0 v0.8.2 v0.9.0-beta.1 | sort -V | tail -1  ->  v0.9.0-beta.1
# — a prerelease of 0.9.0 ranked above 0.9.0 itself. `latest` is "newest tag of
# ANY kind", so that turned the channel into "prefer a beta of the version just
# below the newest one" (task #1079 F3). The key splits the tag into its core
# version and its channel marker, so the core decides first and a stable tag
# wins its own core: 0.9.0-beta.1 < 0.9.0 < 0.10.0-rc.1, and alpha.2 < alpha.10
# (digit runs still compare numerically, so `sort -V` is kept rather than
# replaced by a hand-rolled comparator).
release_sort_key() {
  local tag="$1" core pre
  core="${tag%%-*}"
  if [ "$core" = "$tag" ]; then pre="1-"; else pre="0-${tag#*-}-"; fi
  printf '%s-%s' "$core" "$pre"
}

# release_newest — the newest tag on stdin, by release_sort_key. Prints nothing
# for an empty stream. The key is emitted alongside the tag and the tag is read
# back out, because the key is not the tag: the keys are prefix-free (a stable
# key ends in the 1-marker, a prerelease key in 0-<pre>-), so the tab-delimited
# line sorts exactly as the key alone would.
release_newest() {
  while IFS= read -r t; do
    if [ -n "$t" ]; then printf '%s\t%s\n' "$(release_sort_key "$t")" "$t"; fi
  done | sort -V | cut -f2 | tail -1
}

# Latest release tag from RELEASE_API (JSON with "tag_name"); prints the tag.
release_latest_tag() {
  if [ -z "${RELEASE_API:-}" ]; then warn "RELEASE_API is not set"; return 1; fi
  local json tag
  json="$(url_get "$RELEASE_API" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" | release_tag_names | head -1)"
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
  # Every tag in the payload, not the one that happens to sit last on a line.
  # RELEASE_API is the LIST endpoint, and a JSON array arrives as a single
  # minified line: a line-based read saw one entry in it and treated the last as
  # the only release, so `stable` hard-failed whenever a prerelease was listed
  # last and every channel silently resolved to that prerelease (task #1079 F3).
  # The channel selection below then sorts what is really there, so the order the
  # API happens to use (newest first) cannot change the answer either.
  names="$(printf '%s' "$json" | release_tag_names)"
  case "$policy" in
    stable)     tags="$(printf '%s\n' "$names" | grep -E '^v[0-9]' | grep -v -- '-'         | release_newest)" ;;
    latest)     tags="$(printf '%s\n' "$names" | grep -E '^v[0-9]'                           | release_newest)" ;;
    prerelease) tags="$(printf '%s\n' "$names" | grep -E '^v[0-9].*-(alpha|beta|rc)\.'       | release_newest)" ;;
  esac
  # The tag is interpolated into a download URL: accept only what a release tag
  # may look like (same shape updater.sh's TAG_RE enforces).
  local listed
  listed="$(printf '%s\n' "$names" | grep -c . || true)"
  [[ "$tags" =~ ^v[0-9][0-9A-Za-z.+-]*$ ]] \
    || error "no ${policy} release tag in ${RELEASE_API} (${listed} tag(s) listed, none of them ${policy}); re-run with --version <tag>"
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

# ── Health contract (app.env) ──────────────────────────────────────────────
# wait_health() used to read two JSON keys as LITERALS — "status", compared
# against the literal set ok|degraded, and "version". That is SynaptoMind's own
# /health shape, so the gate declared a contract violation on a perfectly healthy
# service of any other app: both live endpoints measured during the ADR analysis
# answer `{"ok":true}` — no status, no version — and the first poll of their
# cutover would have set HEALTH_FAILURE="contract" and aborted the install.
#
# Three keys, each defaulting to today's literal, so an app.env that sets none
# of them is byte-for-byte the behaviour this file had before (ADR §3d):
#
#   HEALTH_STATUS_FIELD   the key carrying state       (default "status")
#   HEALTH_OK_VALUES      values of it that are healthy (default "ok degraded"),
#                         SPACE separated, each compared as a LITERAL — a `*` in
#                         one narrows the gate to a status no /health reports,
#                         and is never a pathname pattern (see wait_health)
#   HEALTH_VERSION_FIELD  the key carrying the version  (default "version")
#
# HEALTH_VERSION_FIELD is the only one of the three whose EMPTY value means
# something: the version check is DISABLED, and one explicit warning says so.
# Skipping it by silence would turn a missing contract into a vacuous pass —
# exactly the failure class the comments above this function keep warning about.
# An empty HEALTH_STATUS_FIELD is NOT honoured (it falls back to "status"): a
# health gate with no identity arm is the vacuous pass again, so the one key
# that must not be blank is given the default instead.
#
# `:=` (and NOT a plain `=`) on purpose: common.sh is sourced BEFORE
# load_app_env(), so a plain assignment is overridden by app.env only by
# ORDERING — the implicit contract the ADR calls out. `:=` yields to a value
# that is already set (app.env, the environment, an earlier source) whatever
# the load order, and still defines one when the key is absent, so every caller
# keeps working under `set -u`.
: "${HEALTH_STATUS_FIELD:=status}"
: "${HEALTH_OK_VALUES:=ok degraded}"
# `:=` would be WRONG here: it assigns on an EMPTY value as well as on an unset
# one, and empty is this key's documented value — `HEALTH_VERSION_FIELD=""` is
# how an app whose /health carries no version says "the version check is
# disabled". With `:=` that instruction was silently replaced by "version" and
# the setting had no effect at all. The test is therefore "is it set", not "is it
# non-empty". (Measured, not assumed: the first version of this used `:=` and a
# run with the key exported empty came back with version_field=[version].)
[ "${HEALTH_VERSION_FIELD+set}" = "set" ] || HEALTH_VERSION_FIELD="version"

# require_health_contract — fail the run before anything is fetched when the
# configured contract cannot be read. The two field names are interpolated into
# a sed pattern below, so a name carrying `.`/`*`/`[`/`/` is not a field name
# any more but a PATTERN that matches more than the field it names — and a gate
# widened by a typo accepts a body the operator never described. Same reasoning
# as assert_unit_value, one parser instead of two, and it names the key.
require_health_contract() {
  # The defaults are resolved HERE as well as at source time, so this function
  # judges the contract the gate will actually use. A caller that sources
  # common.sh and then unsets a key gets the documented default rather than a
  # refusal for a value it never wrote — the guard must not fail a host over a
  # key that is simply absent.
  : "${HEALTH_STATUS_FIELD:=status}"
  : "${HEALTH_OK_VALUES:=ok degraded}"
  # NOT `:=` for the version field: empty is its documented value and means the
  # version check is disabled, so a default would make that unreachable.
  [ "${HEALTH_VERSION_FIELD+set}" = "set" ] || HEALTH_VERSION_FIELD="version"

  # Only a field the operator actually wrote is validated, and the empty version
  # field is the "disabled" value rather than a mistake.
  local f v
  for f in HEALTH_STATUS_FIELD HEALTH_VERSION_FIELD; do
    v="${!f-}"
    [ -n "$v" ] || continue
    case "$v" in
      [A-Za-z_]*) ;;
      *) error "${f}='${v}' is not a JSON key (letters, digits and _; it may not start with a digit) — fix it in app.env" ;;
    esac
    case "$v" in
      *[!A-Za-z0-9_]*) error "${f}='${v}' is not a JSON key (letters, digits and _ only) — fix it in app.env" ;;
    esac
  done
  # At least one non-blank value. An all-blank list is a gate in which NOTHING is
  # healthy, so every install and every update would fail at the health check
  # with a message about the port rather than about this key.
  case "$HEALTH_OK_VALUES" in
    *[![:space:]]*) ;;
    *) error "HEALTH_OK_VALUES='${HEALTH_OK_VALUES}' names no value of '${HEALTH_STATUS_FIELD}', so no body could ever count as healthy and every health check would fail; set e.g. \"ok degraded\" in app.env" ;;
  esac
  return 0
}

# json_field_value FIELD — the value of JSON key FIELD in a document on stdin;
# empty when the document carries no such field, which callers treat as "no
# signal" rather than as a failure (same contract as parse_json_version).
# A FIELD that require_health_contract() would have refused yields empty rather
# than a pattern: this is the second gate, and it fails the same way — closed.
#
# BOTH a quoted string and a BARE token are accepted, because the two shapes
# this has to read are exactly the two shapes apps actually ship:
# `{"status":"ok","version":"0.9.0"}` and `{"ok":true}`. A quoted-only reader
# returns nothing for the second, so the gate called a healthy service a contract
# violation — the very failure the configurable contract exists to fix, moved
# from one key to the other. (Measured, not assumed: with the quoted form only,
# `{"ok":true}` under HEALTH_STATUS_FIELD=ok / HEALTH_OK_VALUES=true came back
# `HEALTH_FAILURE=contract`.)
#
# The bare-token class stops at the JSON delimiters, so `{"ok":true,"dbPath":…}`
# reads `true` and not `true,"dbPath":"/x"}` — the greedy `.*` before the key
# already picks the LAST `"field":` in the document, exactly as the string form
# does, so a key that also appears as a VALUE elsewhere cannot be matched by
# accident: the value `"ok"` is followed by `}` or `,`, never by `:`.
json_field_value() {
  case "$1" in
    ''|[0-9]*|*[!A-Za-z0-9_]*) return 0 ;;
  esac
  # The document is read ONCE, into a variable, and both patterns run against
  # that. Two `sed` calls on the same pipe would NOT work: the first consumes
  # stdin to EOF, so the second reads nothing and every unquoted value came back
  # empty — which is why `{"ok":true}` failed the identity arm until this was
  # written down and measured. (It is also the reason this helper takes a
  # document rather than a stream: a caller passing a pipe cannot use it twice.)
  local doc v
  doc="$(cat)"
  v="$(printf '%s' "$doc" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p")"
  [ -n "$v" ] || v="$(printf '%s' "$doc" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([^,}[:space:]]\{1,\}\).*/\1/p")"
  printf '%s' "$v"
}

# ── Health check ───────────────────────────────────────────────────────────
# The verdict of the last wait_health call, for the caller's own reporting:
#   timeout   nobody answered as this service inside the window
#   contract  something answered, and it is not this app's /health
#   version   this app's /health answered with a version we did not ask for
#   embedder  /health reports checks.embedder=failed
# Empty on success. Only the last three are an OBSERVED failure; a timeout is a
# silence, and a remedy that stops a unit and restores a database must never be
# printed for one (task #1079 F4: a healthy 0.8.2 upgrade was declared failed,
# with that remedy, while it served fine eight seconds later).
#
# The verdict is read off the LAST sample, never latched across samples
# (task #1099): a body that dies mid-transfer — curl rc=18 with a short body — is
# an ordinary transient during a rolling restart, and the silence that follows it
# asserts nothing, so it must not be able to decide the window on its own.
HEALTH_FAILURE=""

# wait_health URL [EXPECTED_VERSION] [TIMEOUT]
# Polls URL until it answers. With EXPECTED_VERSION the body must also carry
# "version":"<expected>" (the /health contract). Returns 0 on success, 1 on
# timeout; progress is printed with the app prefix, and HEALTH_FAILURE says why.
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
#
# IDENTITY (task #1079 F4): a sample counts only when it carries this app's
# /health CONTRACT — a `status` of ok|degraded AND a `version`. Without the
# version arm, an empty EXPECTED_VERSION accepted ANY non-empty body: a reverse
# proxy, a stale second instance, or anything else on the port passed as "Service
# is healthy" and the run reported success for a service that never answered.
# Requiring the contract always is what lets the gate tell its own service from
# another process on the port; `version` is what it compares when it has an
# expectation, and requiring it always is what keeps the version-less call from
# passing on a stranger.
#
# An EXPECTED_VERSION of "unknown" is treated as no expectation: install.sh
# passes that when the payload carries no readable version, and a gate demanding
# the literal string "unknown" could never pass on any payload.
#
# The IDENTITY arm below reads the three app.env keys above instead of the
# literals they replace, so `version` is required only when
# HEALTH_VERSION_FIELD is set: an app whose /health carries no version at all
# ({"ok":true}) still has to pass its own gate, and saying so once is what
# keeps the disabled check from reading as a contract that happens to hold.
wait_health() {
  local url="$1" expected="${2:-}" timeout="${3:-60}" deadline
  # Every sample field is initialised: a window in which NOTHING ever answered
  # still reaches the verdict below, and `set -u` treats an unset `local` as an
  # error — which turned "the service never answered" into a crash instead of
  # the `timeout` verdict it is.
  local body="" status="" version="" embedder=""
  local embedder_dead=false foreign=false
  HEALTH_FAILURE=""
  if [ "$expected" = "unknown" ]; then expected=""; fi
  case "$timeout" in ''|*[!0-9]*) timeout=60 ;; esac
  deadline=$((SECONDS + timeout))

  # The contract, resolved ONCE per window and read by every sample below. The
  # keys are re-read here rather than captured once at source time so a caller
  # that exports them (the test harnesses, an operator overriding one key for a
  # single run) gets the same treatment as app.env.
  local status_field="${HEALTH_STATUS_FIELD:-status}"
  local ok_values="${HEALTH_OK_VALUES:-ok degraded}"
  # Split ONCE, on a space and on nothing else, into the array the identity arm
  # below iterates. The first version was `for v in $ok_values`, an UNQUOTED
  # expansion, which does both things an unquoted expansion does: it word-splits
  # on IFS and it PATHNAME-EXPANDS. Measured in this repo's own deploy/ dir,
  # HEALTH_OK_VALUES='ok * *' came back as 28 tokens — every file in the working
  # directory — so one extra character in a value made the gate accept a body
  # whose status field was the NAME OF A FILE. That is verbatim the defect #1117
  # fixed for UNIT_EXTRA_ENV ~300 lines below, and this was the last path where
  # a typo WIDENS what counts as healthy instead of narrowing it.
  #
  # Splitting this way means a `*` that survives is compared as a LITERAL: it can
  # only narrow the gate (no /health ever reports the status `*`), never widen
  # it. Same shape and same reason as extra_pairs — one idiom for "a list of
  # tokens this framework reads" — so a run of spaces separates instead of
  # adding an empty value.
  local -a ok_list=()
  local ok_rest="$ok_values" ok_v
  while [ -n "$ok_rest" ]; do
    case "$ok_rest" in
      *" "*) ok_v="${ok_rest%% *}"; ok_rest="${ok_rest#* }" ;;
      *)      ok_v="$ok_rest"; ok_rest="" ;;
    esac
    [ -n "$ok_v" ] || continue
    ok_list+=("$ok_v")
  done
  # `${VAR-default}`, NOT `${VAR:-default}`: the latter substitutes on an EMPTY
  # value as well as on an unset one, and empty is this key's documented value —
  # `HEALTH_VERSION_FIELD=""` is how an app whose /health carries no version says
  # "the version check is disabled". With `:-` that instruction was overwritten
  # with "version" here and the check could never be turned off, while the
  # configuration looked correct. (Measured: with `:-`, a run with the key
  # exported empty still printed "a body without … and a 'version'", i.e. the
  # version arm was live.)
  local version_field="${HEALTH_VERSION_FIELD-version}"
  # An empty version field disables BOTH the identity requirement and the
  # comparison. ONE warning per gate call, printed here rather than per poll: a
  # poll loop would repeat it every two seconds for the whole window, and the
  # point is that the operator is TOLD, not that they are told often.
  local version_check=true
  if [ -z "$version_field" ]; then
    version_check=false
    if [ -n "$expected" ]; then
      warn "HEALTH_VERSION_FIELD is empty — the version check is DISABLED, so this gate cannot tell ${APP_NAME:-app} from any other process answering ${url}."
    else
      warn "HEALTH_VERSION_FIELD is empty — the version check is DISABLED; this gate only requires ${status_field} to be one of: ${ok_values}."
    fi
  fi

  if [ -n "$expected" ] && [ "$version_check" = true ]; then
    info "Waiting for ${url} (version ${expected}, up to ${timeout}s)..."
  else
    info "Waiting for ${url} (up to ${timeout}s)..."
  fi

  while [ "$SECONDS" -lt "$deadline" ]; do
    body="$(url_get "$url" 2>/dev/null || true)"
    # Every signal is re-derived from THIS sample, and a poll that read NO body
    # derives none of them (task #1099). They used to be latched across samples,
    # which turned one partial answer into a verdict about the whole window: a
    # server that closes mid-body leaves real curl rc=18 with a SHORT body — 25
    # bytes of a promised 4096, measured on this host — so a rolling restart was
    # enough to set `foreign`, and the silence that followed inherited it. The
    # verdict came out `contract`, which update.sh treats as OBSERVED: it skipped
    # health_recheck (the re-check that exists to keep a destructive remedy off
    # an unconfirmed failure) and printed the per-database restore.
    #
    # Silence is not evidence. A poll that read no body asserts no contract
    # violation, no dead embedder and no version at all, so a malformed sample
    # decides the window only if a LATER sample confirms it.
    status=""
    version=""
    embedder=""
    embedder_dead=false
    foreign=false
    if [ -n "$body" ]; then
      status="$(printf '%s' "$body" | json_field_value "$status_field")"
      version="$(printf '%s' "$body" | json_field_value "$version_field")"
      embedder="$(printf '%s' "$body" | parse_json_embedder)"
      # Re-derived from every sample, NOT latched: the app clears its own latch
      # once the embedder becomes ready, and a crash that recovers on the retry
      # must not fail the install it actually left healthy.
      if [ "$embedder" = "failed" ]; then embedder_dead=true; else embedder_dead=false; fi
      # Is this our /health at all? Re-derived per sample like the latch: a
      # foreign responder that goes away must not fail a run it did not break —
      # and, since #1099, neither may one that never finished talking.
      #
      # The `version` arm is conditional on the contract: with
      # HEALTH_VERSION_FIELD set it is required exactly as before (that is what
      # keeps the version-less call from passing on a stranger), and with it
      # empty the identity is the status field alone — the one thing an app
      # whose /health is `{"ok":true}` can actually offer.
      local status_ok=false v
      if [ "${#ok_list[@]}" -gt 0 ]; then
        for v in "${ok_list[@]}"; do
          if [ "$status" = "$v" ]; then status_ok=true; break; fi
        done
      fi
      if [ -n "$status" ] && [ "$status_ok" = true ] \
        && { [ "$version_check" != true ] || [ -n "$version" ]; }; then
        foreign=false
      else
        foreign=true
      fi
      # The version COMPARISON is part of the same arm as the version
      # REQUIREMENT: an empty HEALTH_VERSION_FIELD switches both off. It has to,
      # because the alternative is a gate that can never pass. install.sh always
      # passes an expectation for a source install (the package.json version) and
      # update.sh derives one from the checked-out ref, so a version field that is
      # merely not read from the body would leave `$version` empty, the comparison
      # unsatisfiable, and EVERY install of such an app failing at its own health
      # gate. What is given up is stated above, once, in a warning: identity rests
      # on the status field alone.
      if [ "$embedder_dead" != true ] && [ "$foreign" != true ] \
        && { [ "$version_check" != true ] || [ -z "$expected" ] || [ "$version" = "$expected" ]; }; then
        if [ "$version_check" = true ]; then
          info "Service is healthy, reported version ${version}."
        else
          info "Service is healthy (${status_field}=${status}; no version field configured, so none was compared)."
        fi
        return 0
      fi
    fi
    sleep 2
  done

  if [ "$embedder_dead" = true ]; then
    HEALTH_FAILURE="embedder"
    warn "health check failed after ${timeout}s: /health reports checks.embedder=failed."
    warn "  The embedder child dies before the model loads — it cannot load its native runtime."
    warn "  For DIST=binary the unit needs Environment=LD_LIBRARY_PATH=${INSTALL_DIR:-<install-dir>}/lib (ADR 0001 §2.2)."
    warn "  Fix it and re-run, or roll back; embeddings stay permanently dead until then."
    warn "check: journalctl -u ${APP_NAME:-app} -n 100 --no-pager"
    return 1
  fi
  if [ "$foreign" = true ]; then
    HEALTH_FAILURE="contract"
    warn "health check failed after ${timeout}s: ${url} answered, but not with a ${APP_NAME:-app} /health payload."
    warn "  Something else is on that port, or the service is not the one this deploy manages:"
    if [ "$version_check" = true ]; then
      warn "  a body without a '${status_field}' of [${ok_values}] and a '${version_field}' is not this app's health check."
    else
      warn "  a body without a '${status_field}' of [${ok_values}] is not this app's health check."
    fi
    warn "check: sudo ss -ltnp | grep ':$(health_url_port "$url")'   # who holds the port"
    return 1
  fi
  if [ -n "$expected" ] && [ -n "$version" ] && [ "$version" != "$expected" ]; then
    HEALTH_FAILURE="version"
    warn "health check failed after ${timeout}s: /health reports ${version_field} ${version}, expected ${expected}."
    warn "  The service answering is NOT the payload this update installed."
    return 1
  fi

  HEALTH_FAILURE="timeout"
  if [ -n "$expected" ]; then
    warn "health check timed out after ${timeout}s (expected ${expected})"
  else
    warn "health check timed out after ${timeout}s (no expected version)"
  fi
  return 1
}

# health_url_port URL — the TCP port in a health URL, for a diagnostic that has
# to name what holds it. Empty when the URL carries none.
health_url_port() {
  printf '%s' "$1" | sed -n 's#^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*:\([0-9][0-9]*\).*#\1#p'
}

# installed_version — the version THIS install directory holds, read the way each
# entry point reads its own: the artefact itself for DIST=binary (exact, offline)
# and package.json for a source checkout. BARE — the leading "v" is stripped,
# because /health reports a bare version (src/services/health.service.ts).
#
# Sets INSTALLED_VERSION instead of printing it, like RESOLVED_TAG and
# STAGED_PAYLOAD: a command substitution would run this in a subshell, where
# app_version's own command substitution and any cleanup_add would not reach the
# caller. Empty means "cannot be read", which callers must treat as CANNOT
# VERIFY rather than as "any version will do".
INSTALLED_VERSION=""
installed_version() {
  local v=""
  if [ "${DIST:-source}" = "binary" ] && [ -x "${INSTALL_DIR:-}/${APP_NAME:-app}" ]; then
    v="$(app_version "${INSTALL_DIR}/${APP_NAME}")"
  fi
  [ -n "$v" ] || v="$(read_package_version "${INSTALL_DIR:-}/package.json" 2>/dev/null || true)"
  INSTALLED_VERSION="${v#v}"
}

# health_recheck URL EXPECTED [TIMEOUT] — one more wait_health window, after a
# verdict of `timeout` (task #1079 F4).
#
# A timeout is a bound this run chose, not a fact about the service: with
# HEALTH_TIMEOUT=2 a healthy upgrade was declared failed while the service went
# on answering eight seconds later, and the remedy handed to the operator stopped
# the unit and restored the database. So the caller re-checks before it calls a
# timeout a failure.
#
# It re-polls; it does not decide. A second window that answers returns 0, and a
# second window that times out leaves the verdict at `timeout` — UNCONFIRMED,
# still not a failure. Only a sample that contradicts the update (wrong version,
# dead embedder, a foreign responder) is a verdict.
health_recheck() {
  local url="$1" expected="${2:-}" timeout="${3:-30}"
  case "$timeout" in ''|*[!0-9]*) timeout=30 ;; esac
  info "no answer in the first window; re-checking ${url} for up to ${timeout}s before calling this a failure..."
  if wait_health "$url" "$expected" "$timeout"; then
    info "the service answered on the re-check — the update is healthy, just slow to start."
    return 0
  fi
  return 1
}


# ── Values that would not be values once systemd parses them ───────────────
# The unit body is DATA, rendered by printf from single-quoted formats, so a
# substituted value is inert as shell — and NOT inert as unit text. systemd's
# unit-file parser has several ways a value stops being the value that was
# written, and every one of them is silent unless the operator reads verify(1)'s
# output:
#
#   * a line ending in `\` CONTINUES onto the next line, so the directive that
#     follows is absorbed into this value and the hardening it carried is gone.
#     `ReadWritePaths=/opt/x\` + `PrivateTmp=true` leaves ProtectSystem=strict
#     with NO writable path, and systemd-analyze verify still exits 0;
#   * `\x` anywhere in a value is unescaped, so the value systemd sees is not the
#     one that was written (`S` + `\` + `INEL` parses as `SINEL`);
#   * a quote (`"` or `'`) is a quote, not a character, so the value it delimits
#     is read as something shorter;
#   * `%` is a specifier (%I is the machine id), and expands;
#   * `#` and `;` are the config parser's comment characters;
#   * a leading or trailing space is stripped.
#
# The rule is therefore not "reject \n" — a newline was the first instance of
# this bug and `\` was the same bug in another character. It is: reject every
# character this parser reads as SYNTAX, so a value that is inert text on its
# own line cannot forge, fold or rewrite the directive it lands in.
#
# DECIDED 2026-09-30 (task #1094 for the newline, #1096 for the class): guard,
# do not accept. The values are operator-sourced from app.env, so "the operator
# wrote it" is true — and useless: none of these characters is ever needed in a
# path or a user name, and accepting one means silently shipping a unit whose
# hardening the operator never wrote. Two of them are plausible in a DESCRIPTION
# and are refused anyway (a quote, a %), because the guard does not want a
# per-variable rule. Refusing fails CLOSED, before anything has been written, and
# names the variable.
#
# MEASURED about that %, and the reason is narrower than "systemd rewrites the
# value either way" (which is what this comment claimed until task #1079 — the
# '100% coverage' description the suite once asserted passed through systemd 255
# VERBATIM). A % is read as a specifier only when a letter follows it, and then it
# is not a character any more:
#   * `%co`  → the value became `…/r1.serviceoINEL` (the config-file path);
#   * `%n`   → `…r4.serviceINEL`, silently, with no diagnostic at all;
#   * `%zz`  → "Failed to resolve unit specifiers …: Invalid slot", the whole
#              assignment DROPPED;
#   * `% ` (a space, as in "100% coverage") → not a specifier, passed through as
#              written.
# So the rule is per-character and the refusal is right for that value too: a
# description one edit away from '%n' must not hinge on the guard knowing the
# difference. What would be wrong is claiming the value was mangled when it was
# not.
#
# MEASURED, not assumed (systemd 255; deploy/systemd-unit.test.ts repeats the
# sweep against whatever systemd the host has and fails if these numbers move):
# of the 127 ASCII values, systemd mangles eight — TAB, LF, CR, space, `"`, `'`,
# `%`, `\` — and exactly one CONTINUES a line, the backslash. The other 119 pass
# through verbatim, which is why the guard is a list of eight and not a regex
# over "anything suspicious". Two characters are refused WITHOUT being in that
# measurement: `#` and `;`, the config parser's comment characters, which systemd
# 255 passes through mid-value but which are syntax to this parser by
# construction. Bytes above 127 are NOT refused: valid UTF-8 — the em dash in the
# shipped APP_DESC — passes through verbatim, and a lone invalid byte is reported
# loudly by systemd itself ("String is not UTF-8 clean, ignoring assignment").
unit_value_defect() {
  case "$1" in
    *$'\n'*|*$'\r'*)
      printf 'a line break' ;;
    *[[:cntrl:]]*)
      printf 'a control character' ;;
    *\\*)
      printf 'a backslash (to systemd, a line continuation or an escape)' ;;
    # BOTH quotes are matched here, and the measurement agrees they belong: the
    # sweep in deploy/systemd-unit.test.ts finds systemd mangling `"` (34) as well
    # as `'` (39). This arm was written that way from the start; task #1112 filed
    # finding #3 against it ("a double quote in a UNIT_EXTRA_ENV pair renders
    # rc=0"), which does NOT reproduce — unit_value_defect '"' returns "a quote,
    # which systemd reads as quoting" and a render of UNIT_EXTRA_ENV='FOO=ba"r'
    # exits 1. The rc=0 came from the PROBE, not the guard: a value written raw as
    # UNIT_EXTRA_ENV=FOO=ba"r is a bash syntax error, so the sourcing shell aborted
    # on that line, the key stayed at its default empty and the render succeeded on
    # nothing. The single quote survives the same probe only because it happens to
    # be the delimiter the probe's own quoting used. The message below therefore
    # keeps saying "a quote" — one arm covers both, as it always did.
    *'"'*|*"'"*)
      printf 'a quote, which systemd reads as quoting' ;;
    *%*)
      printf 'a %%, which systemd expands as a specifier' ;;
    *'#'*|*";"*)
      printf 'a # or ;, the comment characters' ;;
    " "*|*" ")
      printf 'leading or trailing whitespace, which systemd strips' ;;
  esac
}

# assert_unit_value NAME VALUE — the guard, one value at a time. Returns 1 and
# says why, or returns 0 silently. It does NOT exit: the caller knows whether
# the failure is fatal before anything was written (install.sh) or after the
# payload was swapped (update.sh's refresh_unit), and only the caller can report
# that difference — see #1096 F3, where a bare exit(1) here skipped main()'s
# recovery block entirely.
assert_unit_value() {
  local name="$1" defect
  defect="$(unit_value_defect "$2")"
  [ -n "$defect" ] || return 0
  warn "${name} contains ${defect} — systemd's unit parser reads that as syntax, not as data."
  warn "  it would not just render oddly: it folds, forges or rewrites the directive it"
  warn "  lands in, and systemd drops what it cannot read WITHOUT failing. e.g. an"
  warn "  INSTALL_DIR ending in a backslash renders 'ReadWritePaths=…\\', which swallows"
  warn "  the next directive and cancels ProtectSystem=strict — with verify still ok."
  warn "  fix ${name} in app.env; the value is used as a path, a user name or a description."
  return 1
}

# ── Unit extras (app.env) ──────────────────────────────────────────────────
# The template below is a fixed body, and three of its needs are per-app: an app
# whose state lives in a systemd-managed directory, an app that carries its
# configuration in an EnvironmentFile, and an app that needs one more environment
# variable. Before these keys the framework could express NONE of them
# (`grep -n 'EnvironmentFile\|StateDirectory'` found no hits), so adopting it for
# such an app meant hand-editing the unit after every update — and a source-mode
# update rewrites only the Restart= line, so the hand edit survived only by luck.
#
# Each is rendered ONLY when non-empty, so an app.env that sets none produces the
# body this template has always produced. Empty is the default, not "unset":
#
#   UNIT_STATE_DIRECTORY  e.g. "subagentix" -> StateDirectory= + StateDirectoryMode=0700
#   UNIT_ENV_FILE         e.g. "/etc/subagentix/subagentix.env" -> EnvironmentFile=
#   UNIT_EXTRA_ENV        "K=V" pairs, SPACE separated, one Environment= line each
#                         (a TAB or newline separates nothing: it is refused —
#                          see render_systemd_unit, task #1117)
: "${UNIT_STATE_DIRECTORY:=}"
: "${UNIT_ENV_FILE:=}"
: "${UNIT_EXTRA_ENV:=}"

# ── systemd unit rendering ─────────────────────────────────────────────────
# render_systemd_unit EXEC_START — print a hardened unit for the current app.
# Reads APP_DESC, TARGET_USER, TARGET_GROUP, TARGET_HOME, INSTALL_DIR, DATA_DIR,
# BUN_BIN, DIST, UNIT_STATE_DIRECTORY, UNIT_ENV_FILE, UNIT_EXTRA_ENV.
# Returns 1 (without printing a partial body) if any value would not survive
# systemd's parser; it never exits, so the caller controls what the operator is
# told. See assert_unit_value.
render_systemd_unit() {
  local exec_start="$1" rw="${INSTALL_DIR}" bun_path=""
  local -a env_lines lines
  if [ -n "${DATA_DIR:-}" ]; then rw="${rw} ${DATA_DIR}"; fi
  if [ -n "${BUN_BIN:-}" ]; then bun_path="$(dirname "$BUN_BIN"):"; fi

  # Every substituted value is checked as a value, not as a line: the class of
  # characters systemd's parser reads as syntax is guarded in one place
  # (unit_value_defect) rather than one character at a time here.
  local vname
  for vname in APP_DESC TARGET_USER TARGET_GROUP TARGET_HOME INSTALL_DIR DATA_DIR BUN_BIN \
               UNIT_STATE_DIRECTORY UNIT_ENV_FILE; do
    assert_unit_value "$vname" "${!vname-}" || return 1
  done
  assert_unit_value "ExecStart" "$exec_start" || return 1
  # The unit extras are guarded EXACTLY like every other substituted value
  # (ADR §3f). UNIT_EXTRA_ENV is the sharpest case: it is free text that lands in
  # a unit file, and a value systemd cannot read is dropped in silence — the app
  # then runs with a variable the operator believes it has, and nothing says so.
  #
  # The pairs are guarded one PAIR at a time, never as a whole blob, because a
  # blob of pairs is SPACE separated by construction and unit_value_defect
  # refuses a space. That is also why the split below is parameter expansion and
  # not `for pair in ${UNIT_EXTRA_ENV:-}` (task #1117). Unquoted, bash splits on
  # IFS — space, TAB and newline — so the split ran FIRST and no pair could ever
  # contain a line break: the newline arm of the guard was unreachable here, and
  # this comment claimed otherwise until #1117. MEASURED before the change, with
  # UNIT_EXTRA_ENV="GOOD=1<newline>ExecStartPre=/bin/rm -rf /":
  #   rc=0, Environment=GOOD=1, Environment=ExecStartPre=/bin/rm,
  #        Environment=-rf, Environment=/
  # — SAFE, because an Environment= value is an assignment and never a
  # directive, but UNREFUSED, which is the half of it that had to change. The same
  # expansion also pathname-expanded, so "FOO=*" rendered as whichever files in
  # the working directory matched it.
  #
  # So: split on a space and on nothing else. A TAB or a newline then stays
  # INSIDE its pair and unit_value_defect refuses it (TAB and LF are two of the
  # eight characters systemd mangles), so every refused class reaches the guard
  # instead of being shredded before it. Splitting once, into extra_pairs, is
  # what makes the guard and the renderer below read the SAME tokens: two copies
  # of the expansion were one edit away from disagreeing about where a pair
  # ended, and that gap is where a value could pass the guard and then render as
  # something else.
  local -a extra_pairs=()
  local rest="${UNIT_EXTRA_ENV:-}" pair
  while [ -n "$rest" ]; do
    case "$rest" in
      *" "*) pair="${rest%% *}"; rest="${rest#* }" ;;
      *)      pair="$rest"; rest="" ;;
    esac
    [ -n "$pair" ] || continue   # a run of spaces separates; it adds no pair
    assert_unit_value "UNIT_EXTRA_ENV entry" "$pair" || return 1
    extra_pairs+=("$pair")
  done

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
  if [ "${#extra_pairs[@]}" -gt 0 ]; then
    for pair in "${extra_pairs[@]}"; do
      env_lines+=("Environment=${pair}")
    done
  fi

  # ── The unit body is DATA, never shell ────────────────────────────────────
  # Assembled into an array, then emitted with a single printf '%s\n'. Every
  # literal below is SINGLE-quoted, and each substituted line is built by printf
  # from a single-quoted format string with its value passed as an ARGUMENT. So
  # the unit's text is never re-parsed as shell: a backtick, $(...) or $VAR in
  # it renders as those characters and executes nothing, whatever a future edit
  # writes into the comment.
  #
  # This replaced `cat <<EOF`, an UNQUOTED heredoc. The restart comment below
  # carries the words 'systemctl stop' and 'systemd-run --user', and the heredoc
  # EXECUTED them at render time — on install.sh's path, as root — while
  # install.sh rendered the unit and update.sh re-rendered it on every binary
  # refresh. The comment also lost five words to the substitutions. Rendering a
  # unit is a side-effect-free print; that is now structural, not a convention:
  # deploy/systemd-unit.test.ts renders with recording systemctl/systemd-run/
  # sudo stubs first on PATH and fails if any of them is invoked.
  local desc_line user_line group_line workdir_line exec_line rw_line env_block
  printf -v desc_line    'Description=%s'       "$APP_DESC"
  printf -v user_line    'User=%s'              "$TARGET_USER"
  printf -v workdir_line 'WorkingDirectory=%s'  "$INSTALL_DIR"
  printf -v exec_line    'ExecStart=%s'         "$exec_start"
  printf -v rw_line      'ReadWritePaths=%s'    "$rw"
  printf -v env_block '%s\n' "${env_lines[@]}"
  env_block="${env_block%$'\n'}"   # a command substitution ate this newline; same here

  # Group= is rendered from TARGET_GROUP, which resolve_target_user() defaults to
  # TARGET_USER. That makes the unit and the install AGREE: the tree the service
  # reads is chowned to TARGET_USER:TARGET_GROUP, and the unit then runs as
  # exactly that pair, instead of leaving the group to systemd's own lookup of
  # the user's primary group. The two are the same group on an ordinary account,
  # so this changes no behaviour for an app that sets nothing — it states the
  # group instead of leaving it implied (ADR §3e, closing the §1 caveat).
  printf -v group_line 'Group=%s' "${TARGET_GROUP:-${TARGET_USER}}"
  # StateDirectory= is systemd's own creation of /var/lib/<name>, OWNED
  # User:Group, and it exports STATE_DIRECTORY into the process. The mode is set
  # explicitly because the systemd default is 0755, and an app that resolves its
  # state through that variable would otherwise write a settings file into a
  # world-readable directory. Rendered from app.env rather than derived from
  # DATA_DIR on purpose: the two are not interchangeable. DATA_DIR is a plain
  # mkdir this framework performs; STATE_DIRECTORY is a NAME systemd exports, and
  # an app that reads it needs systemd to have made the directory.
  local -a state_lines=()
  if [ -n "${UNIT_STATE_DIRECTORY:-}" ]; then
    state_lines+=("StateDirectory=${UNIT_STATE_DIRECTORY}" "StateDirectoryMode=0700")
  fi
  # EnvironmentFile= is load-bearing for an app whose configuration lives outside
  # the unit (a separate 640 root:opencode file an operator can edit without
  # touching a unit this framework re-renders). It is placed in the process block
  # rather than at the end, so an operator reading the unit sees where the values
  # ExecStart runs with come from.
  if [ -n "${UNIT_ENV_FILE:-}" ]; then
    state_lines+=("EnvironmentFile=${UNIT_ENV_FILE}")
  fi
  local state_block=""
  if [ "${#state_lines[@]}" -gt 0 ]; then
    printf -v state_block '%s\n' "${state_lines[@]}"
    state_block="${state_block%$'\n'}"
  fi

  # The process block is assembled on its own and spliced in, because the state
  # lines are OPTIONAL. A conditional entry inside the literal below would render
  # as an EMPTY line when the key is unset, so an app.env that configures nothing
  # new would still get a unit that differs from the one this template has always
  # produced — by blank lines. The array is expanded as one element per line, and
  # a section separator is a deliberate '' below, so an optional entry must be
  # absent rather than empty.
  local -a proc_lines=("$user_line" "$group_line" "$workdir_line" "$env_block")
  [ -z "$state_block" ] || proc_lines+=("$state_block")

  lines=(
    '[Unit]'
    "$desc_line"
    'After=network-online.target'
    'Wants=network-online.target'
    'StartLimitIntervalSec=60'
    'StartLimitBurst=5'
    ''
    '[Service]'
    '# --- process ---'
    'Type=simple'
    "${proc_lines[@]}"
    "$exec_line"
    '# Restart=always, not on-failure (2026-09-30 incident, 12 min outage). The app'
    '# registers SIGTERM/SIGINT handlers (src/index.ts:117-123), so an EXTERNAL signal'
    '# ends in a graceful shutdown and exit status 0 — which on-failure deliberately'
    '# does not restart, turning a signal into a one-way outage. on-abnormal is not'
    '# the fix either: a handler that exits 0 is a CLEAN exit, which on-abnormal also'
    '# ignores; only Restart=always closes that door. Deliberate operator intent is'
    '# still honoured: "systemctl stop" sets the unit inactive and systemd does not'
    '# restart it (reproduced by hand against a transient systemd-run --user unit,'
    '# NOT by CI — see the header of deploy/systemd-unit.test.ts). The StartLimit*'
    '# above bounds a genuine crash loop, so always cannot become a respawn storm.'
    '# The policy and that bound are both asserted in deploy/systemd-unit.test.ts.'
    'Restart=always'
    'RestartSec=5'
    '# A BOUNDED stop, not the systemd default of 90 s. A process that never'
    '# reaches its shutdown path (a wedged event loop, a build in the same tree,'
    '# a request that never times out) leaves the unit in deactivating for the'
    '# whole TimeoutStopSec, so every dependent deploy run and every operator'
    '# watching "systemctl stop" waits 90 s for nothing. 15 s is what makes'
    '# "systemctl restart" (install.sh, update.sh) a predictable step.'
    '# KillSignal is deliberately NOT set. Its default SIGTERM is the FIRST step'
    '# of a stop, and the app registers a SIGTERM handler (src/index.ts:123) that'
    '# checkpoints the WAL and stops the embedder. Setting KillSignal to SIGKILL'
    '# replaced that with an immediate unblockable kill, so every stop ended in'
    '# status=9/KILL and the shutdown path never ran (journals of 2026-10-01,'
    '# #1124/#1125). SIGKILL still arrives and is what BOUNDS the stop:'
    '# SendSIGKILL=yes (the systemd default) sends it to whatever is left once'
    '# TimeoutStopSec expires. The unit is already deactivating by then, so the'
    '# kill cannot make the state worse.'
    'TimeoutStopSec=15'
    ''
    '# --- hardening ---'
    'NoNewPrivileges=true'
    'ProtectSystem=strict'
    "$rw_line"
    'PrivateTmp=true'
    'ProtectKernelTunables=true'
    'ProtectKernelModules=true'
    'ProtectControlGroups=true'
    'RestrictSUIDSGID=true'
    ''
    '[Install]'
    'WantedBy=multi-user.target'
  )
  printf '%s\n' "${lines[@]}"
}

# ── Atomic file replacement ────────────────────────────────────────────────
# The ONE mechanism every unit write goes through: install.sh's install_service,
# update.sh's refresh_unit and ensure_restart_policy all use this, so a fix
# cannot reach one entry point and miss the others (that is how `cp -f` onto the
# live unit survived in the two paths outside #1092's diff).
#
# Reports: $ATOMIC_WRITE_REASON on failure, $ATOMIC_WRITE_DEST (the path really
# written) and $ATOMIC_WRITE_NOTE (a link that was followed) on success.
ATOMIC_WRITE_REASON=""
ATOMIC_WRITE_DEST=""
ATOMIC_WRITE_NOTE=""

# A failed replacement, reported honestly: the reason, the file that was NOT
# replaced, and what is really on disk. Naming the INTENDED state instead is how
# a unit truncated to 24 bytes came to be reported as "left unchanged".
_atomic_write_failed() {
  local dest="$1" reason="$2" staged="$3" state
  ATOMIC_WRITE_REASON="$reason"
  [ -n "$staged" ] && run_root rm -f -- "$staged" 2>/dev/null
  if [ -L "$dest" ] && [ ! -e "$dest" ]; then
    # A dangling link is not "absent" — the path is still there, it just has
    # nothing behind it. Reporting it as missing is how a reader ends up
    # hunting for a file that is present.
    state="it is a dangling link, with nothing behind it"
  elif [ ! -e "$dest" ]; then
    state="it does not exist"
  elif ! state="$(wc -c <"$dest" 2>/dev/null | tr -d ' ')"; then
    state="it cannot be READ"
  else
    state="${state} bytes"
  fi
  warn "not replaced: ${dest} — ${reason}"
  warn "  on disk now: ${state}"
  return 1
}

# write_file_atomically DEST SRC [MODE]
#   Install SRC as DEST so no reader can observe a half-written DEST, and so a
#   write that FAILS leaves DEST byte for byte as it was.
#
#   Each property below is a defect this replaced, reproduced against the code
#   that had it (task #1094 — the same pattern was a review blocker in #1092):
#
#   1. The payload never touches DEST. `cp -f SRC DEST` opens DEST O_TRUNC, so
#      a copy that dies partway (ENOSPC, EIO, a killed process — / on this host
#      reached 100% with zero bytes free during the 0.9.0 review) leaves DEST
#      TRUNCATED. On a unit file that destroys a hand-edited production unit
#      while the run reports "cannot write … skipping", and — in refresh_unit —
#      while the very message claims the installed unit was "left unchanged".
#   2. The swap is rename(2) out of DEST's own directory, so it is atomic and
#      cannot fail partway. Same directory = same filesystem by construction, so
#      the rename can never degrade into a copy.
#   3. The staging file is created EMPTY and narrowed to 600 BEFORE a byte of
#      SRC lands in it, and MODE is applied only after the copy SUCCEEDED.
#      cp(1) never changes the mode of an EXISTING destination, so the 600 holds
#      for the whole copy. A failed copy therefore leaves at most a mode-600
#      fragment — an operator's Environment= secrets readable by root alone —
#      never a world-readable partial unit in the directory systemd scans. The
#      staging file is created by root (touch), so the unit keeps root
#      ownership; `cp -p` from an unprivileged render left the unit owned by the
#      INVOKING user, which in /etc/systemd/system is a privilege-escalation
#      vector. (Root ownership cannot be asserted in the deploy suite, which
#      runs unprivileged with sudo stubbed; the suite asserts the rest.)
#   4. The staging file is removed on EVERY failure, so a dead run leaves no
#      litter for the next one to trip over.
#
#   A symlinked DEST (the `systemctl link` shape) is FOLLOWED, deliberately: the
#   old `cp -f` wrote through the link, so replacing the link with a regular file
#   silently changes the unit's shape, and stat(1) without -L reports the LINK's
#   own mode — always 777 — which installed a world-writable unit systemd refuses
#   to load. A DANGLING link has no file to write through, and it is REPLACED by
#   the rename below rather than removed first: the destination moves from the
#   link to the new file in one step and never passes through an absent state.
#   Both cases say so on stdout.
#
#   MODE defaults to the mode DEST already has (an operator's 600 unit with
#   secrets stays 600), else the mode of SRC (a recovery copy inherits what it
#   copies), else 644.
write_file_atomically() {
  local dest="$1" src="$2" mode="${3:-}" dir staged target
  ATOMIC_WRITE_REASON=""; ATOMIC_WRITE_DEST=""; ATOMIC_WRITE_NOTE=""

  if [ -L "$dest" ]; then
    target="$(readlink -f -- "$dest" 2>/dev/null || true)"
    if [ -n "$target" ] && [ -e "$target" ]; then
      ATOMIC_WRITE_NOTE="${dest} is a link; wrote through it to ${target}"
      dest="$target"
    else
      # A DANGLING link: leave it in place. rename(2) replaces the LINK ITSELF,
      # so the destination goes from the link to the new file in one step and
      # never passes through an absent state — which is the whole invariant this
      # function exists for. It used to `rm -f` the link first (a state change
      # nothing can undo) and then run four fallible steps, so a failure in any
      # of them — and the window spanned the whole touch -> chmod -> cp
      # sequence — left NO unit at the destination at all. That is a regression
      # against the code it replaced: GNU `cp -f` refuses a dangling symlink
      # outright ("not writing through dangling symlink"), so the old writer
      # left the link in place and reported the failure. One fewer privileged
      # call, and the same end shape either way.
      ATOMIC_WRITE_NOTE="${dest} is a dangling link; replaced it with a regular file"
    fi
  fi

  dir="$(dirname -- "$dest")"
  # A name systemd never loads (its suffix is the PID, not a unit type) and
  # beside DEST, which is what keeps the swap a rename(2) on one filesystem.
  staged="${dir}/.${APP_NAME:-app}.service.new.$$"
  # Never inherit a previous run's bytes: a leftover from a dead process whose
  # PID got recycled is content nobody rendered.
  run_root rm -f -- "$staged" 2>/dev/null || true

  if [ -z "$mode" ]; then
    # The file being replaced keeps its mode (an operator's 600 unit with
    # secrets is not widened); a NEW file — a <unit>.bak — inherits the mode of
    # the file it is a copy of, since that is what "recovery copy" means.
    if [ -e "$dest" ]; then
      mode="$(stat -L -c '%a' -- "$dest" 2>/dev/null || printf '644')"
    elif [ -e "$src" ]; then
      mode="$(stat -L -c '%a' -- "$src" 2>/dev/null || printf '644')"
    else
      mode="644"
    fi
  fi

  if ! run_root touch -- "$staged" 2>/dev/null; then
    _atomic_write_failed "$dest" "cannot create a staging file in ${dir} (no write access?)" "$staged"
    return 1
  fi
  if ! run_root chmod 600 -- "$staged" 2>/dev/null; then
    _atomic_write_failed "$dest" "cannot restrict the staging file in ${dir} to mode 600" "$staged"
    return 1
  fi
  if ! run_root cp -- "$src" "$staged" 2>/dev/null; then
    _atomic_write_failed "$dest" "cannot write the replacement into ${dir} (out of space, or no write access)" "$staged"
    return 1
  fi
  if [ "$mode" != "600" ] && ! run_root chmod "$mode" -- "$staged" 2>/dev/null; then
    # Not fatal: the bytes are right and the file stays root-only, so the swap
    # still delivers. Say which mode landed rather than leaving it unchosen.
    warn "cannot set mode ${mode} on the replacement for ${dest}; it will be installed mode 600."
  fi
  if ! run_root mv -f -- "$staged" "$dest" 2>/dev/null; then
    _atomic_write_failed "$dest" "cannot swap the replacement in (rename failed)" "$staged"
    return 1
  fi

  ATOMIC_WRITE_DEST="$dest"
  [ -n "$ATOMIC_WRITE_NOTE" ] && info "$ATOMIC_WRITE_NOTE"
  return 0
}

# ── Source mode: dependencies & build (app.env) ─────────────────────────────
# Shared by install.sh and update.sh so both take the identical path — the same
# reason binary_install_payload() lives here rather than in either entry point
# (ADR §3a). Before this, `bun install --frozen-lockfile --production` appeared
# as a literal in BOTH entry points and there was no build step anywhere, which
# is only correct for an app whose production dependencies are everything it
# runs:
#
#   * The flags cannot be implied. An app whose build needs a devDependency —
#     every SvelteKit/Vite app does, and `bun run build` is the only thing that
#     produces the file its start script runs — has those packages PRUNED by
#     --production, so the build cannot run at all. The failure surfaces INSIDE
#     a bundler as a missing module, naming neither the flag nor app.env.
#   * The build cannot be implied either. `default_exec_start()` renders
#     `${BUN_BIN} run start` for any package.json carrying a start script, and
#     that script may point at a file which exists only after a build.
#
# So both are keys, and the defaults are exactly what the framework did before:
# an app.env that sets neither behaves as it did on the last release. `:=` for
# the same reason as the health keys above — app.env wins regardless of the load
# order, and a missing key keeps today's value.
: "${INSTALL_FLAGS:=--frozen-lockfile --production}"
: "${BUILD_CMD:=}"
: "${BUILD_TIMEOUT:=600}"

# install_deps — `bun install` in INSTALL_DIR, as TARGET_USER. The user is the
# point, not a nicety: a root install leaves node_modules root-owned, and the
# service — which runs as TARGET_USER — then cannot read the tree it depends on.
install_deps() {
  if [ "${REQUIRES_BUN:-}" != "yes" ]; then
    info "Not a Bun app — skipping dependency install"
    return 0
  fi
  [ -f "${INSTALL_DIR}/package.json" ] || return 0
  # BUN_BIN is set by install.sh's install_bun_if_needed; update.sh resolves its
  # own. Falling back to locate_bun keeps this usable when neither ran.
  local bun="${BUN_BIN:-}"
  if [ -z "$bun" ]; then bun="$(locate_bun || true)"; fi
  [ -n "$bun" ] || error "Bun not found; re-run install.sh"
  # INSTALL_FLAGS is deliberately UNQUOTED: it is a list of arguments, and
  # quoting it hands bun a single argument named "--frozen-lockfile --production",
  # which it rejects. A flag whose own value contains a space is not expressible
  # this way; none is needed, and an app that needs one is a one-line change here
  # rather than a silent misparse.
  # shellcheck disable=SC2086
  info "Installing dependencies (bun install ${INSTALL_FLAGS})..."
  ( cd "$INSTALL_DIR" && run_as_target_user "$bun" install ${INSTALL_FLAGS} )
}

# run_build — the app's build step, in INSTALL_DIR, as TARGET_USER, under
# `timeout`, because a build that hangs must not hang the install: a deploy run
# that never returns is indistinguishable from a slow download, and the operator's
# options are Ctrl-C on a half-installed app or a reboot.
#
# Non-zero ABORTS. A build that fails leaves a payload with no build output in
# it, and the health gate would then poll a service that cannot start and report
# a plain timeout — naming neither the build nor its error. A non-empty BUILD_CMD
# that the operator typed is an instruction to produce the artefact, so failing to
# produce it is a failed install, not a warning.
run_build() {
  [ -n "$BUILD_CMD" ] || return 0
  need_cmd timeout
  case "$BUILD_TIMEOUT" in ''|*[!0-9]*) BUILD_TIMEOUT=600 ;; esac
  info "Building (${BUILD_CMD}, up to ${BUILD_TIMEOUT}s)..."
  if ! ( cd "$INSTALL_DIR" && run_as_target_user timeout "$BUILD_TIMEOUT" bash -c "$BUILD_CMD" ); then
    error "build failed: ${BUILD_CMD} — the output above is the reason. Nothing was installed; fix it and re-run."
  fi
  info "Build finished"
}

# install_deps_and_build — the pair, as ONE step, so the update path cannot skip
# half of what install does. A source update that installs production-only
# dependencies and no build, while the install does the opposite, is a host that
# updates itself into a payload it cannot run.
install_deps_and_build() {
  install_deps
  run_build
}

# ── Binary payload: download, stage, verify, ordered swap ──────────────────
# Shared by install.sh and update.sh so both take the identical path
# (ADR 0001 §2.9). Reads $TAG, $INSTALL_DIR, $ASSET_PATTERN, $RELEASES_BASE.
#
# The four lists below are SynaptoMind's PAYLOAD SHAPE, not framework knowledge:
# the executable name, the two native libraries and the two example files are
# this app's release tarball. They used to be plain assignments here, which
# worked only by ORDERING — common.sh is sourced before load_app_env(), so an
# app.env assignment overwrote them by arriving later, and an app with a
# different payload had no way to say so except by editing vendored framework
# code. `:=` makes the override EXPLICIT and order-independent (see the same
# note above HEALTH_STATUS_FIELD): app.env wins whatever the load order, and a
# key that is absent keeps today's value, so synaptomind is unchanged.

# Platforms with a published release asset (§2.7). v1 ships linux-x86_64 only:
# onnxruntime-node has no darwin/x64 build, and shipping an asset no runner ever
# executed is not allowed. A host outside this set must fail here with a named
# message rather than with a 404 from url_get.
: "${BINARY_SUPPORTED_PLATFORMS:=linux-x86_64}"

# Required in every payload (§2.1). A missing one aborts before anything is
# touched, instead of leaving a unit that starts and dies on ERR_DLOPEN_FAILED.
: "${BINARY_REQUIRED_FILES:=synaptomind vec0.so lib/libonnxruntime.so.1}"

# Kept as <file>.prev for a no-git rollback (§2.9 step 6). A fresh install has
# none of them, so the existence guard skips this step without a special case.
: "${BINARY_ROLLBACK_FILES:=vec0.so lib/libonnxruntime.so.1 synaptomind}"

# Swap order (§2.9 step 7). THE EXECUTABLE IS MOVED LAST ON PURPOSE: a multi-file
# swap is not atomic, so the only question is which interrupted state is
# detectable. Last ⇒ an interrupted swap leaves old executable + new data files,
# which is the state a deliberate downgrade produces — app_version still reports
# the old version. Executable-first would report the NEW version while running
# the OLD library, which no existing check would catch.
: "${BINARY_SWAP_ORDER:=vec0.so lib/libonnxruntime.so.1 config.json.example .env.example synaptomind}"

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
  mktemp_owned staging -d "${INSTALL_DIR}/.stage.XXXXXX" \
    || error "cannot create a staging directory in ${INSTALL_DIR}"

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
# A fresh install has no previous payload, so the existence guard below skips this
# step without a special case.
#
# The rollback point is the state from BEFORE this run, so a copy is only worth
# making when it would differ from the one already there. A --force re-install of
# the SAME payload wrote a ~119 MB set of byte-identical .prev files on every run
# and never pruned them: no new rollback point, the whole payload written again
# onto the same filesystem as the database (/ on this host reached 100% with zero
# bytes free during the 0.9.0 review), for a copy that describes this very
# version (task #1079 F7).
#
# So the decision is by CONTENT, never by existence: `cmp -s` against the kept
# copy, and only a real difference is written. A version change always differs in
# the executable, so the rollback point is refreshed exactly when it has to be.
#
# WHAT THE ROLLBACK STORY BECOMES, which is the part an operator has to be told
# rather than infer: a copy left in place is byte-identical to what is installed,
# so `mv "$f.prev" "$f"` after a --force re-install restores THIS version — a
# no-op for the payload, and no protection either. The real rollback point is
# written by the next run that changes a payload. print_recovery repeats this
# where the remedy is printed.
#
# The write goes through write_file_atomically, the one mechanism every payload
# write uses: `cp -f` opens the destination O_TRUNC, so a copy of a 119 MB file
# that dies partway (ENOSPC, EIO, a killed process) left a TRUNCATED .prev — the
# rollback point destroyed by the very run meant to create it, silently, since the
# executable is last in the list and the data files are what get clobbered first.
binary_keep_previous() {
  local f src prev kept=0 same=0
  for f in $BINARY_ROLLBACK_FILES; do
    src="${INSTALL_DIR}/${f}"
    prev="${src}.prev"
    [ -f "$src" ] || continue
    mkdir -p "$(dirname "$src")"
    if [ -f "$prev" ] && cmp -s -- "$src" "$prev"; then
      same=$((same + 1))
      info "previous ${f} left as it is: the kept copy is byte-identical, so a rollback to it restores this same version"
      continue
    fi
    if ! write_file_atomically "$prev" "$src"; then
      error "cannot keep the previous ${src} — ${ATOMIC_WRITE_REASON}"
    fi
    kept=$((kept + 1))
  done
  if [ "$same" -gt 0 ]; then
    info "rollback point: ${kept} of $((kept + same)) payload file(s) refreshed, ${same} already identical"
  fi
  return 0
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
# the previous files, swap, drop the staging dir. Sets INSTALLED_VERSION; it does
# NOT print the version.
#
# The trailing `printf '%s' "$got"` it used to end with leaked a bare version into
# stdout, because BOTH callers invoke this uncaptured (install.sh: install_binary,
# update.sh: update_binary) — the operator saw "0.8.0[synaptomind] Running
# post-update hook…", a fragment glued to whatever came next (task #1079 F5).
# A variable is also the only shape that could work: capturing it in `$( )` would
# run the whole swap in a subshell, where cleanup_add() could not reach the
# caller's EXIT trap — the reason STAGED_PAYLOAD and RESOLVED_TAG are variables.
# No caller needed the value: install.sh reads it from $TAG and update.sh from
# $TARGET_VERSION.
INSTALLED_VERSION=""
binary_install_payload() {
  local got
  INSTALLED_VERSION=""
  binary_stage_payload                 # §2.9 steps 1-4
  got="$(binary_check_version "${STAGED_PAYLOAD}/${APP_NAME}")"   # step 5
  binary_keep_previous                 # step 6
  binary_swap_payload "$STAGED_PAYLOAD" # step 7
  rm -rf -- "$STAGED_PAYLOAD"          # step 8
  INSTALLED_VERSION="$got"
  info "Installed ${INSTALL_DIR}/${APP_NAME} (${got})"
  return 0
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
    # Owned, then explicitly released: APP_ENV_FILE is a HAND-OFF, not a temp
    # file. install_files() copies this path into ${RUN_DIR}/scripts/app.env
    # later in the same run, so the trap must not take it away at the end —
    # but leaving the release unstated is what let two other sites here leak for
    # a month, so the hand-off says so where it happens.
    mktemp_owned tmp || error "cannot create a temporary file"
    cleanup_release "$tmp"
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

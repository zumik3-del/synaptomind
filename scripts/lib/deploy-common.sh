#!/usr/bin/env bash
# Shared deploy helpers — sourced (never executed) by the install/update/deploy
# surface (install.sh, update.sh, deploy.sh, synaptomind, release.sh) so tag,
# version and secret logic cannot drift between entry points.
#
# Requires bash. All functions print to stdout; callers keep their own
# error/fallback policy.

# --- Tag resolution (reads local refs; callers fetch before calling) ---

# Latest stable tag: any tag without a hyphen (no prerelease suffix).
# $1 = git work tree or repo directory.
latest_stable_tag() {
  git -C "$1" tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1
}

# Latest prerelease tag (alpha/beta/rc).
# $1 = git work tree or repo directory.
latest_prerelease_tag() {
  git -C "$1" tag --sort=-v:refname 2>/dev/null | grep -E -- '-alpha\.|-beta\.|-rc\.' | head -1
}

# Newest tag of any kind (prerelease or stable).
# $1 = git work tree or repo directory.
latest_any_tag() {
  git -C "$1" tag --sort=-v:refname 2>/dev/null | head -1
}

# --- Version reading ---

# `version` field of a package.json-style file; empty when absent/unreadable.
# $1 = path to package.json.
read_package_version() {
  grep -o '"version": *"[^"]*"' "$1" 2>/dev/null | head -1 | sed 's/"version": *"//;s/"//' || true
}

# `version` field of a JSON document read from stdin (e.g. a /health body).
parse_json_version() {
  sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p'
}

# --- Secret generation ---

# 36-character random secret (UUID sysfs, then uuidgen, then time+sha256).
generate_secret() {
  cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || date +%s | sha256sum | head -c 36
}

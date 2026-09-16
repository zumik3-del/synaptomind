#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/deploy-common.sh
. "${SCRIPT_DIR}/lib/deploy-common.sh"

REPO_URL="${SYNAPTOMIND_REPO:-https://github.com/zumik3-del/synaptomind.git}"
INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"
CHANNEL="stable"
HEALTH_TIMEOUT="${SYNAPTOMIND_HEALTH_TIMEOUT:-60}"

# The health poll below does arithmetic on this value.
case "$HEALTH_TIMEOUT" in
  ''|*[!0-9]*) HEALTH_TIMEOUT=60 ;;
esac

info() { echo "[synaptomind] $*"; }
err()  { echo "[synaptomind] ERROR: $*" >&2; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --alpha|--prerelease)
        CHANNEL="prerelease"
        shift
        ;;
      --help|-h)
        echo "Usage: bash $INSTALL_DIR/scripts/update.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --alpha, --prerelease   Update to latest prerelease (alpha/beta/rc)"
        echo "  --help, -h              Show this help"
        exit 0
        ;;
      *)
        echo "[synaptomind] Unknown option: $1" >&2
        exit 1
        ;;
    esac
  done
}

# --- Deployment configuration resolution ---

# Effective API port: config.json server.port, overridden by SYNAPTOMIND_PORT
# (mirrors src/config.ts ENV_MAPPINGS precedence), defaulting to 3005.
resolve_port() {
  local port="3005"
  if [ -f config.json ]; then
    local cfg_port
    cfg_port=$(grep -o '"port": *[0-9][0-9]*' config.json | head -1 | grep -o '[0-9][0-9]*' || true)
    if [ -n "$cfg_port" ]; then
      port="$cfg_port"
    fi
  fi
  if [ -n "${SYNAPTOMIND_PORT:-}" ]; then
    port="$SYNAPTOMIND_PORT"
  fi
  printf '%s' "$port"
}

# Health endpoint derived from the deployment configuration so the poll can
# never target an unrelated service on a hardcoded default port.
resolve_health_url() {
  if [ -n "${SYNAPTOMIND_HEALTH_URL:-}" ]; then
    printf '%s' "$SYNAPTOMIND_HEALTH_URL"
    return 0
  fi
  printf 'http://127.0.0.1:%s/health' "$(resolve_port)"
}

# Configured SQLite paths, one per line (relative to INSTALL_DIR, which is the
# systemd WorkingDirectory). logDbPath is empty when file logging is disabled.
resolve_db_paths() {
  local main="./data/synaptomind.db" logp=""
  if [ -f config.json ]; then
    local cfg_main
    cfg_main=$(grep -o '"path": *"[^"]*"' config.json | head -1 | sed 's/.*"path": *"//;s/"//' || true)
    [ -n "$cfg_main" ] && main="$cfg_main"
    logp=$(grep -o '"logDbPath": *"[^"]*"' config.json | head -1 | sed 's/.*"logDbPath": *"//;s/"//' || true)
  fi
  printf '%s\n' "$main"
  [ -n "$logp" ] && printf '%s\n' "$logp"
  return 0
}

# WAL-safe backups via sqlite3 `.backup` (never a plain `cp`). Skips cleanly
# when a database does not exist yet; aborts the update when an existing
# database cannot be backed up, so code is never switched without a copy.
DB_BACKUPS=()
backup_databases() {
  local ts db rel backup_dir out
  ts=$(date +%Y%m%d-%H%M%S)
  DB_BACKUPS=()

  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in
      /*) db="$rel" ;;
      *)  db="$INSTALL_DIR/$rel" ;;
    esac

    if [ ! -f "$db" ]; then
      info "No database at ${db} — skipping backup."
      continue
    fi

    if ! command -v sqlite3 >/dev/null 2>&1; then
      err "sqlite3 not found — cannot back up ${db}; aborting before switching code"
      return 1
    fi

    backup_dir="${SYNAPTOMIND_BACKUP_DIR:-$(dirname "$db")/backup}"
    if ! mkdir -p "$backup_dir"; then
      err "cannot create backup directory ${backup_dir}; aborting before switching code"
      return 1
    fi
    out="${backup_dir}/$(basename "$db").${ts}.bak"

    if sqlite3 "$db" ".backup '${out}'"; then
      info "Database backed up: ${out}"
      DB_BACKUPS+=("$out")
    else
      err "failed to back up ${db} — aborting before switching code"
      return 1
    fi
  done < <(resolve_db_paths)
  return 0
}

# Print concrete recovery instructions (no automatic revert).
print_recovery() {
  echo "" >&2
  echo "[synaptomind] Recovery (no automatic revert was performed):" >&2
  echo "[synaptomind]   1. Previous code revision: ${PREV_TAG} (${PREV_REV})" >&2
  echo "[synaptomind]      cd ${INSTALL_DIR} && git checkout ${PREV_TAG}" >&2
  if [ ${#DB_BACKUPS[@]} -gt 0 ]; then
    echo "[synaptomind]   2. Database backup created just now:" >&2
    local b
    for b in "${DB_BACKUPS[@]}"; do
      echo "[synaptomind]      ${b}" >&2
    done
  else
    echo "[synaptomind]   2. No database backup was created (no database existed)." >&2
  fi
}

# Poll /health until the running service reports the selected version.
verify_health() {
  local expected="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local url body reported status

  url="$(resolve_health_url)"
  info "Verifying ${url} (expected version ${expected}, up to ${HEALTH_TIMEOUT}s)..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    body=$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)
    if [ -n "$body" ]; then
      status=$(printf '%s' "$body" | sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p')
      reported=$(printf '%s' "$body" | parse_json_version)
      if [ "$status" = "ok" ] && [ -n "$reported" ] && [ "$reported" = "$expected" ]; then
        info "Verified running version: ${reported}"
        return 0
      fi
    fi
    sleep 2
  done

  echo "[synaptomind] ERROR: health verification failed after ${HEALTH_TIMEOUT}s" >&2
  echo "[synaptomind]   URL:      ${url}" >&2
  echo "[synaptomind]   Expected: ${expected}" >&2
  echo "[synaptomind]   Got:      ${reported:-<unreachable or no version in response>}" >&2
  echo "[synaptomind]   Check:    journalctl -u synaptomind -n 100 --no-pager" >&2
  print_recovery
  return 1
}

parse_args "$@"

# Ensure we're in a git repo
if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "[synaptomind] Not installed. Run scripts/install.sh first."
  exit 1
fi

cd "$INSTALL_DIR"

# Read current version (grep/sed — no node dependency)
CURRENT="unknown"
if [ -f package.json ]; then
  CURRENT=$(read_package_version package.json)
  [ -n "$CURRENT" ] || CURRENT="unknown"
fi

# Fetch tags and find latest release
git fetch --tags origin 2>/dev/null || true

# Determine channel and latest tag
if [ "$CHANNEL" = "prerelease" ]; then
  LATEST_TAG=$(latest_prerelease_tag .)
else
  if echo "$CURRENT" | grep -qE -- '-(alpha|beta|rc)\.'; then
    # If currently on a prerelease, pick the newest tag (prerelease or stable)
    LATEST_TAG=$(latest_any_tag .)
  else
    LATEST_TAG=$(latest_stable_tag .)
  fi
fi

if [ -z "$LATEST_TAG" ]; then
  echo "[synaptomind] No releases found. Repository has no tags."
  echo "[synaptomind] To update to latest development: git pull origin main"
  exit 1
fi

LATEST="${LATEST_TAG#v}"

echo "[synaptomind] Current:  ${CURRENT}"
echo "[synaptomind] Latest:   ${LATEST}"

if [ "$CURRENT" = "$LATEST" ]; then
  echo "[synaptomind] Already up to date."
  exit 0
fi

echo ""
echo "[synaptomind] Changes since ${CURRENT}:"
echo "---"
git log "v${CURRENT}..${LATEST_TAG}" --oneline --no-merges 2>/dev/null | head -30 || \
git log "${LATEST_TAG}" --oneline --no-merges --max-count=30 2>/dev/null
echo "---"

echo ""
read -p "[synaptomind] Update to ${LATEST}? (y/N) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "[synaptomind] Aborted."
  exit 0
fi

# Record the revision to return to, then back up the database(s) BEFORE
# switching code so a failed upgrade is always recoverable.
PREV_TAG="v${CURRENT}"
PREV_REV=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
info "Previous revision: ${PREV_TAG} (${PREV_REV})"

backup_databases

echo "[synaptomind] Checking out ${LATEST_TAG}..."
git checkout "$LATEST_TAG"

echo "[synaptomind] Installing dependencies..."
bun install --frozen-lockfile --production

# Restart service if running via systemd
RESTARTED=false
if systemctl is-active synaptomind &>/dev/null; then
  echo "[synaptomind] Restarting service..."
  if [ "$(id -u)" -eq 0 ]; then
    systemctl restart synaptomind
  else
    sudo systemctl restart synaptomind
  fi
  RESTARTED=true
  echo "[synaptomind] Service restarted."
fi

# Self-verification: the running service must report the version we selected.
if [ "$RESTARTED" = true ]; then
  if ! verify_health "$LATEST"; then
    echo "[synaptomind] Update FAILED — service did not reach version ${LATEST}." >&2
    exit 1
  fi
else
  info "Service is not running under systemd — skipping health verification."
fi

echo ""
echo "[synaptomind] Done. Now at ${LATEST}."

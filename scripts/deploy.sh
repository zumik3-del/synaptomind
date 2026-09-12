#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SYNAPTOMIND_REPO:-https://github.com/zumik3-del/synaptomind.git}"
INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"
HEALTH_URL="${SYNAPTOMIND_HEALTH_URL:-http://127.0.0.1:3005/health}"
HEALTH_TIMEOUT="${SYNAPTOMIND_HEALTH_TIMEOUT:-60}"
VERSION="${1:-}"

# Non-interactive by contract: safe to call from the CLI, CI, or cron.
export GIT_TERMINAL_PROMPT=0

# The health poll below does arithmetic on this value.
case "$HEALTH_TIMEOUT" in
  ''|*[!0-9]*) HEALTH_TIMEOUT=60 ;;
esac

info() { echo "[synaptomind] $*"; }
err()  { echo "[synaptomind] Error: $*" >&2; exit 1; }

# --- Tag helpers (read local refs; refreshed by the fetch below) ---

# Latest stable tag (no hyphen = no prerelease).
find_latest_stable() {
  git -C "$INSTALL_DIR" tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1
}

# Latest prerelease tag (alpha/beta/rc).
find_latest_prerelease() {
  git -C "$INSTALL_DIR" tag --sort=-v:refname 2>/dev/null | grep -E -- '-alpha\.|-beta\.|-rc\.' | head -1
}

read_version() {
  grep -o '"version": *"[^"]*"' package.json 2>/dev/null | head -1 | sed 's/"version": *"//;s/"//' || true
}

# --- Ensure a checkout exists and refresh refs ---

if [ ! -d "$INSTALL_DIR/.git" ]; then
  info "Cloning ${REPO_URL} into ${INSTALL_DIR}..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# --tags -f force-updates LOCAL tags only, so newly published releases become
# visible without rewriting any remote history.
info "Fetching tags..."
if ! git -C "$INSTALL_DIR" fetch --tags -f origin; then
  info "WARNING: git fetch failed — using existing local refs"
fi

# --- Resolve the target ref ---

TARGET=""
TARGET_REF=""
CHANNEL="release"

if [ "$VERSION" = "--dev" ]; then
  CHANNEL="dev"
  TARGET="main"
  TARGET_REF="origin/main"
  info "Deploying development (main branch)..."
elif [ "$VERSION" = "--alpha" ]; then
  TARGET=$(find_latest_prerelease || true)
  [ -n "$TARGET" ] || err "no prerelease tags found"
  TARGET_REF="refs/tags/${TARGET}"
  info "Deploying latest prerelease: ${TARGET}..."
elif [ -n "$VERSION" ]; then
  # Accept both "0.6.1" and "v0.6.1" (release tags carry the leading "v").
  if git -C "$INSTALL_DIR" rev-parse --verify --quiet "refs/tags/${VERSION}" >/dev/null; then
    TARGET="$VERSION"
  elif git -C "$INSTALL_DIR" rev-parse --verify --quiet "refs/tags/v${VERSION}" >/dev/null; then
    TARGET="v$VERSION"
  else
    err "release tag not found: ${VERSION} (tried refs/tags/${VERSION} and refs/tags/v${VERSION})"
  fi
  TARGET_REF="refs/tags/${TARGET}"
  info "Deploying ${TARGET}..."
else
  TARGET=$(find_latest_stable || true)
  [ -n "$TARGET" ] || err "no release tags found. Use --dev to install from main."
  TARGET_REF="refs/tags/${TARGET}"
  info "Deploying latest stable release: ${TARGET}..."
fi

# `checkout -f` discards local modifications to TRACKED files (production hosts
# have a diverged docker-compose.yml) while leaving UNTRACKED files (.env,
# config.json, data/) untouched. Never rewrites remote history.
info "Checking out ${TARGET_REF}..."
git -C "$INSTALL_DIR" checkout -f "$TARGET_REF"

cd "$INSTALL_DIR"

# Copy config if not exists
if [ ! -f config.json ]; then
  cp config.json.example config.json
  info "Created config.json from example — edit it before starting"
fi

# Create .env if not exists
if [ ! -f .env ]; then
  secret=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || date +%s | sha256sum | head -c 36)
  echo "SYNAPTOMIND_SECRET=${secret}" > .env
  info "Created .env with random secret"
fi

# Show version
DEPLOYED_VERSION=""
if [ -f package.json ]; then
  DEPLOYED_VERSION=$(read_version)
fi
[ -n "$DEPLOYED_VERSION" ] || DEPLOYED_VERSION="unknown"
info "Version: ${DEPLOYED_VERSION}"

# Resolve image for docker-compose.yml: image: ${SYNAPTOMIND_IMAGE:-...:local}
if [ "$CHANNEL" = "dev" ]; then
  # Pin explicitly so a stray SYNAPTOMIND_IMAGE in the operator's shell
  # cannot retag the dev build
  export SYNAPTOMIND_IMAGE="ghcr.io/zumik3-del/synaptomind:local"
else
  [ "$DEPLOYED_VERSION" != "unknown" ] || err "could not determine version from package.json"
  IMAGE="ghcr.io/zumik3-del/synaptomind:${DEPLOYED_VERSION}"
  export SYNAPTOMIND_IMAGE="$IMAGE"
  # Persist so later manual `docker compose up` keeps the same image
  if [ -f .env ]; then
    if grep -q '^SYNAPTOMIND_IMAGE=' .env; then
      sed -i "s|^SYNAPTOMIND_IMAGE=.*|SYNAPTOMIND_IMAGE=${IMAGE}|" .env
    else
      echo "SYNAPTOMIND_IMAGE=${IMAGE}" >> .env
    fi
  fi
  info "Image: ${IMAGE}"
fi

# Prepare ./data for the non-root container user (uid 10001).
# Existing installs have a root-owned ./data — without this the
# container crash-loops with EACCES after upgrading to the non-root image.
mkdir -p data
if [ "$(id -u)" -eq 0 ]; then
  chown -R 10001:10001 data || true
elif command -v sudo >/dev/null 2>&1; then
  sudo chown -R 10001:10001 data || true
else
  echo "[synaptomind] WARNING: could not chown ./data for uid 10001 — if the container fails to write, run: sudo chown -R 10001:10001 data" >&2
fi

# --- Start/restart ---

echo "[synaptomind] Starting..."
if [ "$CHANNEL" = "dev" ]; then
  docker compose up -d --build
else
  # Pull the published image; fall back to building the checked-out tag locally
  docker compose pull 2>/dev/null || info "WARNING: image pull failed — using a local image if present"
  docker compose up -d
fi

# --- Post-start verification: /health must report the expected version ---

verify_health() {
  local expected="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local body="" reported=""

  info "Verifying /health (expected version ${expected}, up to ${HEALTH_TIMEOUT}s)..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
    if [ -n "$body" ]; then
      reported=$(printf '%s' "$body" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')
      if [ -n "$reported" ] && [ "$reported" = "$expected" ]; then
        info "Verified running version: ${reported}"
        return 0
      fi
    fi
    sleep 2
  done

  echo "[synaptomind] ERROR: health verification failed after ${HEALTH_TIMEOUT}s" >&2
  echo "[synaptomind]   URL:      ${HEALTH_URL}" >&2
  echo "[synaptomind]   Expected: ${expected}" >&2
  echo "[synaptomind]   Got:      ${reported:-<no version in response>}" >&2
  echo "[synaptomind]   Check:    docker compose logs --tail 100" >&2
  return 1
}

# Best-effort: install/refresh the versioned CLI on PATH after a verified
# deploy. Never fails the deploy — warns if the install target is not writable.
install_cli() {
  local bin_dir="${SYNAPTOMIND_BIN_DIR:-/usr/local/bin}"
  local src="${INSTALL_DIR}/scripts/synaptomind"

  if [ ! -f "$src" ]; then
    echo "[synaptomind] WARNING: CLI script not found: ${src} — skipping CLI install" >&2
    return 0
  fi

  if install -m 0755 "$src" "${bin_dir}/synaptomind" 2>/dev/null; then
    info "CLI installed: ${bin_dir}/synaptomind"
  elif command -v sudo >/dev/null 2>&1 && sudo install -m 0755 "$src" "${bin_dir}/synaptomind" 2>/dev/null; then
    info "CLI installed: ${bin_dir}/synaptomind"
  else
    echo "[synaptomind] WARNING: could not install CLI to ${bin_dir}/synaptomind — run: sudo install -m 0755 ${src} ${bin_dir}/synaptomind" >&2
  fi
  return 0
}

verify_health "$DEPLOYED_VERSION"

install_cli || true

echo "[synaptomind] Done. Check: docker compose logs -f"

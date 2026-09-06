#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SYNAPTOMIND_REPO:-https://github.com/zumik3-del/synaptomind.git}"
INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"
VERSION="${1:-}"

# Find latest stable tag (no hyphen = no prerelease)
find_latest_stable() {
  git -C "$INSTALL_DIR" tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1
}

# Find latest prerelease tag (contains hyphen)
find_latest_prerelease() {
  git -C "$INSTALL_DIR" tag --sort=-v:refname 2>/dev/null | grep -E -- '-alpha\.|-beta\.|-rc\.' | head -1
}

# Determine target
if [ "$VERSION" = "--dev" ]; then
  TARGET="main"
  echo "[synaptomind] Deploying development (main branch)..."
elif [ "$VERSION" = "--alpha" ]; then
  # Ensure we have tags
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch --tags origin 2>/dev/null || true
  fi
  TARGET=$(find_latest_prerelease)
  if [ -z "$TARGET" ]; then
    echo "[synaptomind] Error: no prerelease tags found."
    exit 1
  fi
  echo "[synaptomind] Deploying latest prerelease: ${TARGET}..."
elif [ -n "$VERSION" ]; then
  TARGET="$VERSION"
  echo "[synaptomind] Deploying ${TARGET}..."
else
  # Default: deploy latest stable release
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch --tags origin 2>/dev/null || true
  else
    echo "[synaptomind] Detecting latest release tag..."
    git clone --filter=blob:none --bare "$REPO_URL" "$INSTALL_DIR.tmp-bare" 2>/dev/null || true
    if [ -d "$INSTALL_DIR.tmp-bare" ]; then
      TARGET=$(git -C "$INSTALL_DIR.tmp-bare" tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1)
      rm -rf "$INSTALL_DIR.tmp-bare"
    fi
  fi

  # If tag was not yet determined (existing repo or bare clone failed)
  if [ -z "${TARGET:-}" ]; then
    TARGET=$(find_latest_stable)
  fi

  if [ -z "${TARGET:-}" ]; then
    echo "[synaptomind] Error: no release tags found. Use --dev to install from main."
    exit 1
  fi
  echo "[synaptomind] Deploying latest stable release: ${TARGET}..."
fi

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[synaptomind] Fetching..."
  git -C "$INSTALL_DIR" fetch origin 2>/dev/null || true
  git -C "$INSTALL_DIR" fetch --tags origin 2>/dev/null || true
  git -C "$INSTALL_DIR" checkout "$TARGET"
else
  echo "[synaptomind] Cloning..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" checkout "$TARGET"
fi

cd "$INSTALL_DIR"

# Copy config if not exists
if [ ! -f config.json ]; then
  cp config.json.example config.json
  echo "[synaptomind] Created config.json from example — edit it before starting"
fi

# Create .env if not exists
if [ ! -f .env ]; then
  secret=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || date +%s | sha256sum | head -c 36)
  echo "SYNAPTOMIND_SECRET=${secret}" > .env
  echo "[synaptomind] Created .env with random secret"
fi

# Show version
if [ -f package.json ]; then
  DEPLOYED_VERSION=$(grep -o '"version": *"[^"]*"' package.json | sed 's/"version": *"//;s/"//' || echo "unknown")
  echo "[synaptomind] Version: ${DEPLOYED_VERSION}"
fi

# Resolve image for docker-compose.yml: image: ${SYNAPTOMIND_IMAGE:-...:local}
if [ "$VERSION" = "--dev" ]; then
  # Pin explicitly so a stray SYNAPTOMIND_IMAGE in the operator's shell
  # cannot retag the dev build
  export SYNAPTOMIND_IMAGE="ghcr.io/zumik3-del/synaptomind:local"
else
  DEPLOYED_VERSION=$(grep -o '"version": *"[^"]*"' package.json | sed 's/"version": *"//;s/"//' || echo "")
  if [ -n "$DEPLOYED_VERSION" ]; then
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
    echo "[synaptomind] Image: ${IMAGE}"
  fi
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

# Start/restart
echo "[synaptomind] Starting..."
if [ "$VERSION" = "--dev" ]; then
  docker compose up -d --build
else
  # Pull the published image; fall back to building the checked-out tag locally
  docker compose pull 2>/dev/null || true
  docker compose up -d
fi

echo "[synaptomind] Done. Check: docker compose logs -f"

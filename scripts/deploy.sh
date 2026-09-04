#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SYNAPTOMIND_REPO:-https://github.com/zumik3-del/synaptomind.git}"
INSTALL_DIR="${SYNAPTOMIND_DIR:-/opt/synaptomind}"
VERSION="${1:-}"

# Determine target
if [ "$VERSION" = "--dev" ]; then
  TARGET="main"
  echo "[synaptomind] Deploying development (main branch)..."
elif [ -n "$VERSION" ]; then
  TARGET="${VERSION#v}"
  TARGET="v${TARGET}"
  echo "[synaptomind] Deploying v${TARGET}..."
else
  # Default: deploy latest release tag
  # On fresh install, clone bare to detect tags from remote
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch --tags origin 2>/dev/null || true
  else
    echo "[synaptomind] Detecting latest release tag..."
    git clone --filter=blob:none --bare "$REPO_URL" "$INSTALL_DIR.tmp-bare" 2>/dev/null || true
    if [ -d "$INSTALL_DIR.tmp-bare" ]; then
      TARGET=$(git -C "$INSTALL_DIR.tmp-bare" tag --sort=-v:refname 2>/dev/null | head -1)
      rm -rf "$INSTALL_DIR.tmp-bare"
    fi
  fi

  # If tag was not yet determined (existing repo or bare clone failed)
  if [ -z "${TARGET:-}" ]; then
    TARGET=$(git -C "$INSTALL_DIR" tag --sort=-v:refname 2>/dev/null | head -1)
  fi

  if [ -z "${TARGET:-}" ]; then
    echo "[synaptomind] Error: no release tags found. Use --dev to install from main."
    exit 1
  fi
  echo "[synaptomind] Deploying latest release: ${TARGET}..."
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

# Show version
if [ -f package.json ]; then
  DEPLOYED_VERSION=$(node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null || echo "unknown")
  echo "[synaptomind] Version: v${DEPLOYED_VERSION}"
fi

# Start/restart
echo "[synaptomind] Starting..."
docker compose up -d --build

echo "[synaptomind] Done. Check: docker compose logs -f"

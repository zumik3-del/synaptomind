#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SYNAPTOMIND_REPO:-https://github.com/zumik3-del/synaptomind.git}"
INSTALL_DIR="${SYNAPTOMIND_DIR:-/opt/synaptomind}"

# Ensure we're in a git repo
if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "[update] Not installed. Run scripts/deploy.sh first."
  exit 1
fi

cd "$INSTALL_DIR"

# Read current version
if [ -f package.json ]; then
  CURRENT=$(node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null || echo "unknown")
else
  CURRENT="unknown"
fi

# Fetch tags and find latest release
git fetch --tags origin 2>/dev/null || true
LATEST_TAG=$(git tag --sort=-v:refname | head -1)

if [ -z "$LATEST_TAG" ]; then
  echo "[update] No releases found. Repository has no tags."
  echo "[update] To update to latest development: git pull origin main"
  exit 1
fi

LATEST=${LATEST_TAG#v}

echo "[update] Current:  v${CURRENT}"
echo "[update] Latest:   v${LATEST}"

if [ "$CURRENT" = "$LATEST" ]; then
  echo "[update] Already up to date."
  exit 0
fi

echo ""
echo "[update] Changes since v${CURRENT}:"
echo "---"
git log "v${CURRENT}..${LATEST_TAG}" --oneline --no-merges 2>/dev/null | head -30
echo "---"

echo ""
read -p "[update] Update to v${LATEST}? (y/N) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "[update] Aborted."
  exit 0
fi

echo "[update] Checking out ${LATEST_TAG}..."
git checkout "$LATEST_TAG"

echo "[update] Installing dependencies..."
bun install

echo ""
echo "[update] Done. Now at v${LATEST}."
echo "[update] Restart synaptomind to apply."

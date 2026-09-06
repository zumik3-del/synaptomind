#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SYNAPTOMIND_REPO:-https://github.com/zumik3-del/synaptomind.git}"
INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"

# Ensure we're in a git repo
if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "[synaptomind] Not installed. Run scripts/install.sh first."
  exit 1
fi

cd "$INSTALL_DIR"

# Read current version (grep/sed — no node dependency)
if [ -f package.json ]; then
  CURRENT=$(grep -o '"version": *"[^"]*"' package.json | head -1 | sed 's/"version": *"//;s/"//' || echo "unknown")
else
  CURRENT="unknown"
fi

# Fetch tags and find latest release
git fetch --tags origin 2>/dev/null || true

# Determine if current version is a prerelease
if echo "$CURRENT" | grep -qE -- '-(alpha|beta|rc)\.'; then
  LATEST_TAG=$(git tag --sort=-v:refname 2>/dev/null | grep -E -- '-(alpha|beta|rc)\.' | head -1)
else
  LATEST_TAG=$(git tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1)
fi

if [ -z "$LATEST_TAG" ]; then
  echo "[synaptomind] No releases found. Repository has no tags."
  echo "[synaptomind] To update to latest development: git pull origin main"
  exit 1
fi

LATEST="$LATEST_TAG"

echo "[synaptomind] Current:  ${CURRENT}"
echo "[synaptomind] Latest:   ${LATEST}"

if [ "$CURRENT" = "$LATEST" ]; then
  echo "[synaptomind] Already up to date."
  exit 0
fi

echo ""
echo "[synaptomind] Changes since ${CURRENT}:"
echo "---"
git log "${CURRENT}..${LATEST_TAG}" --oneline --no-merges 2>/dev/null | head -30
echo "---"

echo ""
read -p "[synaptomind] Update to ${LATEST}? (y/N) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "[synaptomind] Aborted."
  exit 0
fi

echo "[synaptomind] Checking out ${LATEST_TAG}..."
git checkout "$LATEST_TAG"

echo "[synaptomind] Installing dependencies..."
bun install --production

# Restart service if running via systemd
if systemctl is-active synaptomind &>/dev/null; then
  echo "[synaptomind] Restarting service..."
  sudo systemctl restart synaptomind
  echo "[synaptomind] Service restarted."
fi

echo ""
echo "[synaptomind] Done. Now at ${LATEST}."

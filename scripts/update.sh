#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SYNAPTOMIND_REPO:-https://github.com/zumik3-del/synaptomind.git}"
INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"
CHANNEL="stable"

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

parse_args "$@"

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

# Determine channel and latest tag
if [ "$CHANNEL" = "prerelease" ]; then
  LATEST_TAG=$(git tag --sort=-v:refname 2>/dev/null | grep -E -- '-(alpha|beta|rc)\.' | head -1)
else
  if echo "$CURRENT" | grep -qE -- '-(alpha|beta|rc)\.'; then
    # If currently on a prerelease, pick the newest tag (prerelease or stable)
    LATEST_TAG=$(git tag --sort=-v:refname 2>/dev/null | head -1)
  else
    LATEST_TAG=$(git tag --sort=-v:refname 2>/dev/null | grep -v -- '-' | head -1)
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
git log "${CURRENT}..${LATEST_TAG}" --oneline --no-merges 2>/dev/null | head -30 || \
git log "${LATEST_TAG}" --oneline --no-merges --max-count=30 2>/dev/null
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
bun install --frozen-lockfile --production

# Restart service if running via systemd
if systemctl is-active synaptomind &>/dev/null; then
  echo "[synaptomind] Restarting service..."
  if [ "$(id -u)" -eq 0 ]; then
    systemctl restart synaptomind
  else
    sudo systemctl restart synaptomind
  fi
  echo "[synaptomind] Service restarted."
fi

echo ""
echo "[synaptomind] Done. Now at ${LATEST}."

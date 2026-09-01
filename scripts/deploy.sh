#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SYNAPTOMIND_REPO:-https://github.com/zumik3-del/synaptomind.git}"
INSTALL_DIR="${SYNAPTOMIND_DIR:-/opt/synaptomind}"

echo "[synaptomind] Deploying from ${REPO_URL}..."

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[synaptomind] Fetching latest..."
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  echo "[synaptomind] Cloning..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# Copy config if not exists
if [ ! -f config.json ]; then
  cp config.json.example config.json
  echo "[synaptomind] Created config.json from example — edit it before starting"
fi

# Start/restart
echo "[synaptomind] Starting..."
docker compose up -d --build

echo "[synaptomind] Done. Check: docker compose logs -f"

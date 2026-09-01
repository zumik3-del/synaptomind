#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${SYNAPTOMIND_INSTALL_DIR:-/opt/synaptomind}"
DATA_DIR="${SYNAPTOMIND_DATA_DIR:-/var/lib/synaptomind}"
USER="${SYNAPTOMIND_USER:-synaptomind}"

echo "[synaptomind] Installing to ${INSTALL_DIR}..."

# Create user
if ! id -u "${USER}" &>/dev/null; then
  echo "[synaptomind] Creating user ${USER}..."
  sudo useradd --system --shell /usr/sbin/nologin "${USER}"
fi

# Create directories
sudo mkdir -p "${INSTALL_DIR}" "${DATA_DIR}"
sudo chown "${USER}:${USER}" "${DATA_DIR}"

# Copy files
echo "[synaptomind] Copying files..."
sudo cp -r src/ "${INSTALL_DIR}/src/"
sudo cp package.json tsconfig.json config.json.example "${INSTALL_DIR}/"
sudo cp -r scripts/ "${INSTALL_DIR}/scripts/"
sudo cp scripts/synaptomind.service "${INSTALL_DIR}/"

# Set ownership
sudo chown -R "${USER}:${USER}" "${INSTALL_DIR}"

# Install dependencies
echo "[synaptomind] Installing dependencies..."
cd "${INSTALL_DIR}"
sudo -u "${USER}" bun install --production

# Setup vec0
echo "[synaptomind] Setting up vec0..."
sudo -u "${USER}" bash scripts/setup-vec0.sh

# Create config if not exists
if [ ! -f "${INSTALL_DIR}/config.json" ]; then
  echo "[synaptomind] Creating default config..."
  sudo cp config.json.example "${INSTALL_DIR}/config.json"
  sudo chown "${USER}:${USER}" "${INSTALL_DIR}/config.json"
fi

# Install systemd service
echo "[synaptomind] Installing systemd service..."
sudo cp "${INSTALL_DIR}/synaptomind.service" /etc/systemd/system/
sudo systemctl daemon-reload

echo "[synaptomind] Installation complete."
echo ""
echo "To start:"
echo "  sudo systemctl enable --now synaptomind"
echo ""
echo "To configure:"
echo "  sudo nano ${INSTALL_DIR}/config.json"

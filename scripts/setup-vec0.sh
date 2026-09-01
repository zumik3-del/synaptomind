#!/usr/bin/env bash
set -euo pipefail

# Downloads the sqlite-vec loadable extension (vec0.so) for the current platform.
# Usage: ./scripts/setup-vec0.sh [VERSION]
#   VERSION defaults to SQLITE_VEC_VERSION env var or 0.1.9

VERSION="${1:-${SQLITE_VEC_VERSION:-0.1.9}}"
TARGET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET_DIR}/vec0.so"

if [ -f "$TARGET" ]; then
  echo "[setup-vec0] vec0.so already exists — skipping"
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  VEC_ARCH="x86_64" ;;
  aarch64) VEC_ARCH="aarch64" ;;
  *)       echo "[setup-vec0] Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux) VEC_OS="linux" ;;
  darwin) VEC_OS="macos" ;;
  *)     echo "[setup-vec0] Unsupported OS: $OS" >&2; exit 1 ;;
esac

TARBALL="sqlite-vec-${VERSION}-loadable-${VEC_OS}-${VEC_ARCH}.tar.gz"
BASE_URL="https://github.com/asg017/sqlite-vec/releases/download/v${VERSION}"
URL="${BASE_URL}/${TARBALL}"
CHECKSUM_URL="${BASE_URL}/SHA256SUMS"

echo "[setup-vec0] Downloading vec0.so ${VERSION} for ${VEC_OS}-${VEC_ARCH} ..."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    echo "[setup-vec0] Neither curl nor wget found" >&2; exit 1
  fi
}

# Download tarball
download "$URL" "${TMP}/${TARBALL}"

# Download and verify checksum
if download "$CHECKSUM_URL" "${TMP}/SHA256SUMS" 2>/dev/null; then
  EXPECTED=$(grep "${TARBALL}" "${TMP}/SHA256SUMS" | awk '{print $1}')
  if [ -z "$EXPECTED" ]; then
    echo "[setup-vec0] WARNING: ${TARBALL} not found in SHA256SUMS, skipping verification" >&2
  else
    ACTUAL=$(sha256sum "${TMP}/${TARBALL}" | awk '{print $1}')
    if [ "$ACTUAL" != "$EXPECTED" ]; then
      echo "[setup-vec0] CHECKSUM MISMATCH: expected ${EXPECTED}, got ${ACTUAL}" >&2
      exit 1
    fi
    echo "[setup-vec0] Checksum verified"
  fi
else
  echo "[setup-vec0] WARNING: SHA256SUMS not available, skipping verification" >&2
fi

# Extract
tar xzf "${TMP}/${TARBALL}" -C "$TMP"

if [ -f "${TMP}/vec0.so" ]; then
  mv "${TMP}/vec0.so" "$TARGET"
elif [ -f "${TMP}/vec.so" ]; then
  mv "${TMP}/vec.so" "$TARGET"
else
  echo "[setup-vec0] vec0.so not found in archive" >&2
  echo "[setup-vec0] archive contents: $(find "$TMP" -type f)" >&2
  exit 1
fi

echo "[setup-vec0] Installed vec0.so ($(wc -c < "$TARGET") bytes)"

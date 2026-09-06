#!/usr/bin/env bash
set -euo pipefail

# Downloads the sqlite-vec loadable extension (vec0.so) for the current platform.
# Usage: ./scripts/setup-vec0.sh [VERSION]
#   VERSION defaults to SQLITE_VEC_VERSION env var or 0.1.9

VERSION="${1:-${SQLITE_VEC_VERSION:-0.1.9}}"
TARGET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET_DIR}/vec0.so"

if [ -f "$TARGET" ]; then
  echo "[synaptomind] vec0.so already exists — skipping"
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  VEC_ARCH="x86_64" ;;
  aarch64) VEC_ARCH="aarch64" ;;
  *)       echo "[synaptomind] Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux) VEC_OS="linux" ;;
  darwin) VEC_OS="macos" ;;
  *)     echo "[synaptomind] Unsupported OS: $OS" >&2; exit 1 ;;
esac

TARBALL="sqlite-vec-${VERSION}-loadable-${VEC_OS}-${VEC_ARCH}.tar.gz"
BASE_URL="https://github.com/asg017/sqlite-vec/releases/download/v${VERSION}"
URL="${BASE_URL}/${TARBALL}"
CHECKSUM_URL="${BASE_URL}/SHA256SUMS"

echo "[synaptomind] Downloading vec0.so ${VERSION} for ${VEC_OS}-${VEC_ARCH} ..."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    echo "[synaptomind] Neither curl nor wget found" >&2; exit 1
  fi
}

# Download tarball
download "$URL" "${TMP}/${TARBALL}"

# Pick an available sha256 tool (sha256sum is Linux, shasum is macOS/BSD)
if command -v sha256sum >/dev/null 2>&1; then
  HASH_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_TOOL="shasum -a 256"
else
  HASH_TOOL=""
fi

# Download and verify checksum
if [ -z "$HASH_TOOL" ]; then
  echo "[synaptomind] WARNING: no sha256sum/shasum found, skipping verification" >&2
elif download "$CHECKSUM_URL" "${TMP}/SHA256SUMS" 2>/dev/null; then
  EXPECTED=$(grep "${TARBALL}" "${TMP}/SHA256SUMS" | awk '{print $1}')
  if [ -z "$EXPECTED" ]; then
    echo "[synaptomind] WARNING: ${TARBALL} not found in SHA256SUMS, skipping verification" >&2
  else
    ACTUAL=$($HASH_TOOL "${TMP}/${TARBALL}" | awk '{print $1}')
    if [ "$ACTUAL" != "$EXPECTED" ]; then
      echo "[synaptomind] CHECKSUM MISMATCH: expected ${EXPECTED}, got ${ACTUAL}" >&2
      exit 1
    fi
    echo "[synaptomind] Checksum verified"
  fi
else
  echo "[synaptomind] WARNING: SHA256SUMS not available, skipping verification" >&2
fi

# Extract
tar xzf "${TMP}/${TARBALL}" -C "$TMP"

if [ -f "${TMP}/vec0.so" ]; then
  mv "${TMP}/vec0.so" "$TARGET"
elif [ -f "${TMP}/vec.so" ]; then
  mv "${TMP}/vec.so" "$TARGET"
else
  echo "[synaptomind] vec0.so not found in archive" >&2
  echo "[synaptomind] archive contents: $(find "$TMP" -type f)" >&2
  exit 1
fi

echo "[synaptomind] Installed vec0.so ($(wc -c < "$TARGET") bytes)"

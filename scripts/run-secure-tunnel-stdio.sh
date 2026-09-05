#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_BIN="${SYNAPTOMIND_BUN_BIN:-bun}"

if ! command -v "$BUN_BIN" >/dev/null 2>&1; then
  echo "[synaptomind] Bun is not available; set SYNAPTOMIND_BUN_BIN to its absolute path" >&2
  exit 127
fi

export SYNAPTOMIND_MCP_INSTRUCTIONS_FILE="${SYNAPTOMIND_MCP_INSTRUCTIONS_FILE:-$PROJECT_DIR/config/secure-tunnel-mcp-instructions.md}"

cd "$PROJECT_DIR"
exec "$BUN_BIN" run src/index.ts --stdio

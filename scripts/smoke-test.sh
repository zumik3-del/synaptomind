#!/usr/bin/env bash
# SynaptoMind release artifact smoke test.
# Spawns the real server on a fresh database over stdio MCP and verifies
# tools/list, memory_store and memory_recall round-trip.
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

cd "$SMOKE_DIR"

SYNAPTOMIND_DB_PATH="$TMP/synaptomind.db" \
SYNAPTOMIND_LOG_DB_PATH="$TMP/telemetry.db" \
SYNAPTOMIND_EMBEDDER_ENABLED=false \
SYNAPTOMIND_EMBEDDER_CACHE_DIR="$TMP/huggingface" \
bun run scripts/smoke-test.ts
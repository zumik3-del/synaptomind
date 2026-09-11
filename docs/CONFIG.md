# Configuration Reference

All settings for SynaptoMind. Priority: **env vars > config.json > defaults**.

---

## Quick Start

```bash
cp config.json.example config.json
# edit config.json as needed
```

Or use environment variables:

```bash
cp .env.example .env
# edit .env
```

---

## Server

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `server.port` | `SYNAPTOMIND_PORT` | `3005` | HTTP API port |
| `server.host` | `SYNAPTOMIND_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose to network |

---

## MCP

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `mcp.httpPort` | `SYNAPTOMIND_MCP_HTTP_PORT` | `3006` | MCP HTTP transport port |
| `mcp.instructionsFile` | `SYNAPTOMIND_MCP_INSTRUCTIONS_FILE` | `""` | Path to custom MCP instructions file (markdown). Falls back to built-in instructions |
| `mcp.stdioStandalone` | `SYNAPTOMIND_MCP_STDIO_STANDALONE` | `false` | When `true`, a `--stdio` process also starts the embedder and background jobs. Default `false` keeps them single-owner: the shared HTTP server runs them and stdio clients only hold an MCP session. See [Stdio ownership](#stdio-ownership) |

### Stdio ownership

A stdio MCP client talks to the same SQLite database as the HTTP server. By
default (`mcp.stdioStandalone=false`) the stdio process does **not** start the
embedder child process, decay, dreamer, self-improve, or TTL-cleanup jobs — the
shared HTTP server is their single owner. This avoids every client spawning its
own embedder and schedulers against one DB.

To run stdio as a fully standalone node (no separate server), enable local
ownership with either:

- CLI flag: `--stdio-standalone` (e.g. `bun run src/index.ts --stdio --stdio-standalone`)
- Env var: `SYNAPTOMIND_MCP_STDIO_STANDALONE=true`
- `config.json`: `"mcp": { "stdioStandalone": true }`

---

## Database

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `db.path` | `SYNAPTOMIND_DB_PATH` | `./data/synaptomind.db` | Main SQLite database path |
| `db.busyTimeout` | `SYNAPTOMIND_DB_BUSY_TIMEOUT` | `5000` | SQLite busy timeout in ms. Increase if you see `SQLITE_BUSY` errors |
| `logDbPath` | `SYNAPTOMIND_LOG_DB_PATH` | `""` | Session logs database path. Empty = disabled |

---

## Embedder

Local embedding model for semantic search. No API keys required.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `embedder.enabled` | `SYNAPTOMIND_EMBEDDER_ENABLED` | `true` | Enable/disable local embeddings. Disabled = vector search unavailable |
| `embedder.model` | `SYNAPTOMIND_EMBEDDER_MODEL` | `Xenova/multilingual-e5-small` | HuggingFace model name |
| `embedder.dimensions` | `SYNAPTOMIND_EMBEDDER_DIMENSIONS` | `384` | Embedding vector dimensions |
| `embedder.pollIntervalMs` | `SYNAPTOMIND_EMBEDDER_POLL_INTERVAL` | `7000` | How often to check for pending embeddings (ms) |
| `embedder.cacheDir` | `SYNAPTOMIND_EMBEDDER_CACHE_DIR` | `./data/huggingface` | Model cache directory (~150MB after first load) |
| `embedder.idleTimeoutMs` | `SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT` | `600000` | Unload model after this idle time (ms). 0 = never unload |
| `embedder.precache` | `SYNAPTOMIND_EMBEDDER_PRECACHE` | `false` | Download model on startup instead of on first use |
| `embedder.resetDeadLetters` | `SYNAPTOMIND_RESET_DEAD_LETTER` | `false` | Re-queue dead-lettered embeddings on startup. Off by default: a poisonous thought would otherwise get fresh attempts on every restart. Enable after fixing an embedding bug to retry failed items |
| `embedder.batchSize` | `SYNAPTOMIND_EMBEDDER_BATCH_SIZE` | `8` | Embeddings per batch. Higher = faster but more RAM |

---

## Thoughts

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `thoughts.softLimit` | `SYNAPTOMIND_THOUGHT_SOFT_LIMIT` | `600` | Recommended content budget per thought. The only limit advertised to agents; content above it is accepted but logged as a warning |
| `thoughts.hardLimitBufferPercent` | `SYNAPTOMIND_THOUGHT_HARD_LIMIT_BUFFER_PERCENT` | `20` | Percent buffer added to the soft limit to derive the enforced hard ceiling: `hardLimit = round(softLimit * (1 + hardLimitBufferPercent / 100))` |

**Note:** The hard ceiling is derived, not configured. With the defaults it is `round(600 * 1.2) = 720`. Content above it is rejected; content between the soft limit and the hard ceiling is accepted with a warning log.

---

## Decay

Automatic importance decay for old thoughts.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `decay.rate` | `SYNAPTOMIND_DECAY_RATE` | `0.95` | Daily decay multiplier. 0.95 = importance × 0.95 per day |
| `decay.archiveThreshold` | `SYNAPTOMIND_ARCHIVE_THRESHOLD` | `0.1` | Archive thoughts below this importance score |
| `decay.archiveMinAgeDays` | `SYNAPTOMIND_ARCHIVE_MIN_AGE_DAYS` | `30` | Don't archive thoughts younger than this |
| `decay.intervalMs` | `SYNAPTOMIND_DECAY_INTERVAL_MS` | `86400000` | How often to run decay (ms). Default: 24h |

---

## TTL Cleanup

Auto-delete archived thoughts after TTL.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `ttl.archivedTtlDays` | `SYNAPTOMIND_ARCHIVED_TTL_DAYS` | `90` | Days before archived thoughts are deleted. 0 = disabled |
| `ttl.cleanupIntervalMs` | `SYNAPTOMIND_CLEANUP_INTERVAL_MS` | `86400000` | How often to run cleanup (ms). Default: 24h |

**Note:** Thoughts with `is_protected: true` are never deleted by TTL cleanup.

---

## Smart Notes

Thoughts with surface conditions that auto-surface when relevant.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `smartNotes.autoPromote` | `SYNAPTOMIND_SMART_NOTES_AUTO_PROMOTE` | `false` | Auto-promote smart notes when conditions are met |
| `smartNotes.evalIntervalMs` | `SYNAPTOMIND_SMART_NOTES_EVAL_INTERVAL` | `3600000` | How often to evaluate smart notes (ms). Default: 1h |

---

## Primer

Compact project summary for quick context injection.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `primer.promoteThreshold` | `SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD` | `5` | Min hits before a thought is primer-eligible |
| `primer.topN` | `SYNAPTOMIND_PRIMER_TOP_N` | `3` | Max thoughts promoted to primer per run |

---

## Verification

Detects stale or drifted thoughts. `POST /api/thought-verify/run` (on-demand job) re-embeds each tracked thought's content and compares it against the stored embedding using cosine distance (same metric as vector search). A thought is flagged when the distance exceeds its drift threshold, or when it hasn't been checked within `staleWarnDays`. Verify entries are armed automatically for every embedded thought, each snapshotted from `verify.driftThreshold` at creation. Runs without a ready embedder degrade to staleness-only checks.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `verify.enabled` | `SYNAPTOMIND_VERIFY_ENABLED` | `true` | Enable/disable thought verification |
| `verify.driftThreshold` | `SYNAPTOMIND_DRIFT_THRESHOLD` | `0.25` | Max allowed embedding drift (cosine distance) before flagging |
| `verify.staleWarnDays` | `SYNAPTOMIND_STALE_WARN_DAYS` | `30` | Days before a thought is considered stale |

---

## Auto-Cluster

Batch grouping by embedding proximity.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `autoCluster.minAgeDays` | `SYNAPTOMIND_AUTO_CLUSTER_MIN_AGE_DAYS` | `3` | Don't cluster thoughts younger than this |
| `autoCluster.minSimilarity` | `SYNAPTOMIND_AUTO_CLUSTER_MIN_SIMILARITY` | `0.3` | Min cosine similarity to include in cluster |
| `autoCluster.minMembers` | `SYNAPTOMIND_AUTO_CLUSTER_MIN_MEMBERS` | `3` | Min thoughts to form a cluster |
| `autoCluster.dryRun` | `SYNAPTOMIND_AUTO_CLUSTER_DRY_RUN` | `false` | Preview without creating clusters |

---

## Auto-Link

Automatically create edges between related thoughts.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `autoLink.minSimilarity` | `SYNAPTOMIND_AUTO_LINK_MIN_SIMILARITY` | `0.65` | Min cosine similarity to auto-link |
| `autoLink.maxEdgesPerRun` | `SYNAPTOMIND_AUTO_LINK_MAX_EDGES` | `20` | Max edges created per auto-link run |
| `autoLink.minEntityOverlap` | `SYNAPTOMIND_AUTO_LINK_MIN_ENTITY_OVERLAP` | `1` | Min shared entities to consider linking |
| `autoLink.dryRun` | `SYNAPTOMIND_AUTO_LINK_DRY_RUN` | `false` | Preview without creating edges |

---

## Self-Improve

Automatic graph maintenance (disabled by default).

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `selfImprove.enabled` | `SYNAPTOMIND_SELF_IMPROVE_ENABLED` | `false` | Enable self-improvement jobs |
| `selfImprove.intervalMs` | `SYNAPTOMIND_SELF_IMPROVE_INTERVAL_MS` | `86400000` | How often to run (ms). Default: 24h |
| `selfImprove.orphanThreshold` | `SYNAPTOMIND_SELF_IMPROVE_ORPHAN_THRESHOLD` | `0.5` | Similarity threshold for orphan detection |
| `selfImprove.activationThreshold` | `SYNAPTOMIND_SELF_IMPROVE_ACTIVATION_THRESHOLD` | `0.3` | Min activation score to consider promoting |
| `selfImprove.hitsThreshold` | `SYNAPTOMIND_SELF_IMPROVE_HITS_THRESHOLD` | `5` | Min recall hits before promoting |
| `selfImprove.maxMergesPerRun` | `SYNAPTOMIND_SELF_IMPROVE_MAX_MERGES` | `3` | Max duplicate merges per run |
| `selfImprove.maxPromotesPerRun` | `SYNAPTOMIND_SELF_IMPROVE_MAX_PROMOTES` | `5` | Max thought promotions per run |
| `selfImprove.maxPrimerPromotesPerRun` | `SYNAPTOMIND_SELF_IMPROVE_MAX_PRIMER_PROMOTES` | `3` | Max primer promotions per run |

---

## Slots

Context windows for agent startup.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `slots.defaultMaxChars` | `SYNAPTOMIND_SLOTS_MAX_CHARS` | `2000` | Default max characters per slot |
| `slots.hardLimit` | `SYNAPTOMIND_SLOTS_HARD_LIMIT` | `20000` | Absolute max characters across all slots |

---

## Graph

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `graph.maxDegree` | `SYNAPTOMIND_GRAPH_MAX_DEGREE` | `50` | Max edges per thought in chain traversal |

---

## Rate Limit

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `rateLimit.max` | `SYNAPTOMIND_RATE_LIMIT` | `200` | Max requests per window |
| `rateLimit.windowMs` | `SYNAPTOMIND_RATE_LIMIT_WINDOW_MS` | `60000` | Window duration (ms). Default: 1 min |
| `rateLimit.trustProxy` | `SYNAPTOMIND_TRUST_PROXY` | `false` | Honor `X-Forwarded-For` / `X-Real-IP` for the client identity. The rightmost `X-Forwarded-For` hop (the one added by the trusted proxy) is used. Enable only behind a trusted reverse proxy; otherwise the socket peer address is used and proxy headers are ignored |

---

## Authentication

Auth applies to the HTTP API (`/api/*`) and the MCP HTTP transport (`/mcp`); the MCP stdio transport is local and unauthenticated by design.

When **neither** `SYNAPTOMIND_SECRET` nor `SYNAPTOMIND_SERVICE_TOKEN` is set the server **fails closed**: authenticated requests are rejected with `401`. Set a secret for any non-local deployment.

| Env Var | Default | Description |
|---------|---------|-------------|
| `SYNAPTOMIND_SECRET` | (none) | Primary bearer token. Required unless `SYNAPTOMIND_SERVICE_TOKEN` is set |
| `SYNAPTOMIND_SERVICE_TOKEN` | `SYNAPTOMIND_SECRET` | Optional secondary bearer token (e.g. for MCP service clients) |
| `SYNAPTOMIND_ALLOW_INSECURE` | `false` | **Local-development only.** When `true`, disables auth entirely and allows anonymous access. Never enable in production |

Unauthenticated probes: `GET /health` on both the API and MCP HTTP servers is unauthenticated and returns minimal liveness. The MCP HTTP `/health` does not disclose the server version or transport details.

---

## General

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `contentLanguage` | `SYNAPTOMIND_CONTENT_LANGUAGE` | `en` | Language for MCP instructions and content normalization |

---

## Docker-Specific

| Env Var | Default | Description |
|---------|---------|-------------|
| `BIND_ADDR` | `127.0.0.1` | Docker port bind address. `0.0.0.0` for network access |
| `SYNAPTOMIND_SECRET` | (none) | Auth token for API and MCP. **Required** — without it the server fails closed with `401` |
| `SYNAPTOMIND_SERVICE_TOKEN` | (none) | Secondary auth token (optional) |

---

## Full Example

```json
{
  "contentLanguage": "en",
  "server": { "port": 3005, "host": "127.0.0.1" },
  "mcp": { "httpPort": 3006, "instructionsFile": "", "stdioStandalone": false },
  "db": { "path": "./data/synaptomind.db", "busyTimeout": 5000 },
  "logDbPath": "",
  "embedder": {
    "enabled": true,
    "model": "Xenova/multilingual-e5-small",
    "dimensions": 384,
    "pollIntervalMs": 7000,
    "cacheDir": "./data/huggingface",
    "idleTimeoutMs": 600000,
    "precache": false,
    "batchSize": 8
  },
  "thoughts": { "softLimit": 600, "hardLimitBufferPercent": 20 },
  "decay": {
    "rate": 0.95,
    "archiveThreshold": 0.1,
    "archiveMinAgeDays": 30,
    "intervalMs": 86400000
  },
  "ttl": { "archivedTtlDays": 90, "cleanupIntervalMs": 86400000 },
  "smartNotes": { "autoPromote": false, "evalIntervalMs": 3600000 },
  "primer": { "promoteThreshold": 5, "topN": 3 },
  "verify": { "enabled": true, "driftThreshold": 0.25, "staleWarnDays": 30 },
  "autoCluster": {
    "minAgeDays": 3, "minSimilarity": 0.3,
    "minMembers": 3, "dryRun": false
  },
  "autoLink": {
    "minSimilarity": 0.65, "maxEdgesPerRun": 20,
    "minEntityOverlap": 1, "dryRun": false
  },
  "selfImprove": {
    "enabled": false, "intervalMs": 86400000,
    "orphanThreshold": 0.5, "activationThreshold": 0.3,
    "hitsThreshold": 5, "maxMergesPerRun": 3,
    "maxPromotesPerRun": 5, "maxPrimerPromotesPerRun": 3
  },
  "slots": { "defaultMaxChars": 2000, "hardLimit": 20000 },
  "graph": { "maxDegree": 50 },
  "rateLimit": { "max": 200, "windowMs": 60000, "trustProxy": false }
}
```

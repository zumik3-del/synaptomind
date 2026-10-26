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
| `mcp.corsOrigins` | `SYNAPTOMIND_MCP_CORS_ORIGINS` | `[]` | Comma-separated allowed CORS origins for the MCP HTTP transport. Empty = no CORS headers |
| `mcp.maxSessions` | `SYNAPTOMIND_MCP_MAX_SESSIONS` | `100` | Max concurrent MCP sessions |
| `mcp.sessionTtlMs` | `SYNAPTOMIND_MCP_SESSION_TTL_MS` | `3600000` | Session idle timeout in ms (1h) |
| `mcp.keepAliveMs` | `SYNAPTOMIND_MCP_KEEPALIVE_MS` | `10000` | Keep-alive interval in ms |
| `mcp.maxEventsPerSession` | `SYNAPTOMIND_MCP_MAX_EVENTS_PER_SESSION` | `1000` | Max events buffered per session |

### Stdio ownership

A stdio MCP client talks to the same SQLite database as the HTTP server. By
default (`mcp.stdioStandalone=false`) the stdio process does **not** start the
embedder child process, or decay job — the
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

---

## Embedder

Local embedding model for semantic search. No API keys required.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `embedder.enabled` | `SYNAPTOMIND_EMBEDDER_ENABLED` | `true` | Enable/disable local embeddings. Disabled = vector search unavailable |
| `embedder.model` | `SYNAPTOMIND_EMBEDDER_MODEL` | `Xenova/multilingual-e5-small` | HuggingFace model name |
| `embedder.dtype` | `SYNAPTOMIND_EMBEDDER_DTYPE` | `q8` | ONNX precision of the local model. `q8` downloads `onnx/model_quantized.onnx` (~113 MB), `fp32` downloads `onnx/model.onnx` (~449 MB). An unknown value fails at startup. Switching needs **no** corpus re-embed (measured fp32↔q8 cosine drift ≤0.0061); an offline host holding only an fp32 cache recovers with `SYNAPTOMIND_EMBEDDER_DTYPE=fp32` — see the note below |
| `embedder.dimensions` | `SYNAPTOMIND_EMBEDDER_DIMENSIONS` | `384` | Embedding vector dimensions |
| `embedder.pollIntervalMs` | `SYNAPTOMIND_EMBEDDER_POLL_INTERVAL` | `7000` | How often to check for pending embeddings (ms) |
| `embedder.cacheDir` | `SYNAPTOMIND_EMBEDDER_CACHE_DIR` | `./data/huggingface` | Model cache directory (~449 MB with `fp32`, ~113 MB with `q8`, after first load) |
| `embedder.idleTimeoutMs` | `SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT` | `600000` | Unload model after this idle time (ms). 0 = never unload |
| `embedder.precache` | `SYNAPTOMIND_EMBEDDER_PRECACHE` | `false` | Download model on startup instead of on first use |
| `embedder.resetDeadLetters` | `SYNAPTOMIND_RESET_DEAD_LETTER` | `false` | Re-queue dead-lettered embeddings on startup. Off by default: a poisonous thought would otherwise get fresh attempts on every restart. Enable after fixing an embedding bug to retry failed items |
| `embedder.batchSize` | `SYNAPTOMIND_EMBEDDER_BATCH_SIZE` | `8` | Embeddings per batch. Higher = faster but more RAM |

**Note:** Switching `embedder.dtype` shifts embedding values only slightly — measured on the default
model with transformers.js 4.2.0, the fp32↔q8 cosine drift is ≤0.0061, far under the ~0.19 median distance between two different
thoughts. An existing corpus therefore does **not** need re-embedding after a switch.

An **offline host with an fp32-only cache** cannot become ready after the `q8` default: the quantized
file is not on disk and cannot be fetched, so the embedder process exits before it reports ready. Recover
by using the file already on disk (`SYNAPTOMIND_EMBEDDER_DTYPE=fp32`) or by pre-placing
`onnx/model_quantized.onnx` in the cache.

A switch leaves the previous dtype's ONNX file in the cache directory. Startup logs one warning naming
that file and its size — it is never deleted, because a switch back reuses it.

---

## Thoughts

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `thoughts.softLimit` | `SYNAPTOMIND_THOUGHT_SOFT_LIMIT` | `600` | Recommended content budget per thought. The only limit advertised to agents; content above it is accepted but logged as a warning |
| `thoughts.hardLimitBufferPercent` | `SYNAPTOMIND_THOUGHT_HARD_LIMIT_BUFFER_PERCENT` | `20` | Percent buffer added to the soft limit to derive the enforced hard ceiling: `hardLimit = round(softLimit * (1 + hardLimitBufferPercent / 100))` |

**Note:** The hard ceiling is derived, not configured. With the defaults it is `round(600 * 1.2) = 720`. Content above it is rejected; content between the soft limit and the hard ceiling is accepted with a warning log.

---

## Retention review

Archived and draft thoughts are not deleted by an age-based background cleanup. This
statement concerns thought deletion; the separate placement-proposal queue has its own
scheduled expiry and pruning job (see [Placement](#placement)). The
retention-review API lists eligible candidates; an operator must explicitly protect,
delete, or compact them. Candidate defaults are:

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `retentionReview.minAgeDays` | `SYNAPTOMIND_RETENTION_REVIEW_MIN_AGE_DAYS` | `30` | Minimum age, measured from `archived_at` or (when absent) `created_at` |
| `retentionReview.importanceFloor` | `SYNAPTOMIND_RETENTION_REVIEW_IMPORTANCE_FLOOR` | `0.3` | Candidate importance must be below this threshold |
| `retentionReview.pageSize` | `SYNAPTOMIND_RETENTION_REVIEW_PAGE_SIZE` | `20` | Default candidate page size (API limit is 1–100) |

Configuration loading normalizes `pageSize` to an integer in the range 1–100 and
clamps `importanceFloor` to 0–1. A non-positive or non-numeric `minAgeDays` uses
the 30-day default. These settings govern the manual retention-review workflow;
they do not enable age-based thought TTL cleanup.

See [API.md](./API.md#retention-review) for candidate eligibility and the
preview-first delete/compact routes.

---

## Decay

Automatic importance decay for old thoughts.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `decay.rate` | `SYNAPTOMIND_DECAY_RATE` | `0.95` | Daily decay multiplier. 0.95 = importance × 0.95 per day |
| `decay.intervalMs` | `SYNAPTOMIND_DECAY_INTERVAL_MS` | `86400000` | How often to run decay (ms). Default: 24h |

**Note:** Decay only lowers importance — it never archives, deletes or otherwise
changes a thought's status. Archiving is explicit (`memory_supersede action=archive`
or `status=archived`), and deletion of archived thoughts is handled by the
retention-review process (the sole deletion path).

---

## Primer

Compact project summary for quick context injection.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `primer.promoteThreshold` | `SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD` | `5` | Min hits before a thought is primer-eligible |
| `primer.topN` | `SYNAPTOMIND_PRIMER_TOP_N` | `3` | Max thoughts promoted to primer per run |

---

## Retired settings (breaking 0.x change)

The standalone verification subsystem and its settings are retired, together with
its data: migration `v043` drops the table that held the per-thought results. Search
no longer excludes anything on that basis, so previously flagged thoughts may appear
in default results; `exclude_flagged` is an ordinary, ignored query parameter. A
configuration file that still carries the retired section loads unchanged and
ignores it. [CHANGELOG.md](../CHANGELOG.md) lists every removal per release.

---

## Auto-Cluster

Batch grouping by embedding proximity.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `autoCluster.minAgeDays` | `SYNAPTOMIND_AUTO_CLUSTER_MIN_AGE_DAYS` | `3` | Don't cluster thoughts younger than this |
| `autoCluster.minSimilarity` | `SYNAPTOMIND_AUTO_CLUSTER_MIN_SIMILARITY` | `0.09` | Max cosine **distance** between neighbours (lower = tighter; 0.3 chains the whole graph into one mega-cluster) |
| `autoCluster.minMembers` | `SYNAPTOMIND_AUTO_CLUSTER_MIN_MEMBERS` | `3` | Min thoughts to form a cluster |

---

## Neighbour search (edge detection bounds)

These four keys bound the neighbour search behind edge proposals. The placement
engine (`memory_status action=propose`, `POST /api/thoughts/propose`) reads all four:
`minSimilarity` sets the recall floor for embedding neighbours, `topK` the neighbour
width, `maxCandidates` the candidate pool loaded for one run, and `maxProposals`
the cap on emitted edge proposals. The draft health check reuses the candidate-pool
bound only.

No standalone detection route or `memory_status` action exists any more: a candidate
is only ever a proposal, produced by the read-only placement engine, and an edge
appears only when it is confirmed with `memory_store action=link`.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `edgeDetect.minSimilarity` | `SYNAPTOMIND_EDGE_DETECT_MIN_SIMILARITY` | `0.75` | Min embedding similarity for a neighbour pair to become a candidate |
| `edgeDetect.topK` | `SYNAPTOMIND_EDGE_DETECT_TOP_K` | `10` | Max nearest neighbours considered per thought |
| `edgeDetect.maxCandidates` | `SYNAPTOMIND_EDGE_DETECT_MAX_CANDIDATES` | `100` | Max candidate thoughts loaded for one run |
| `edgeDetect.maxProposals` | `SYNAPTOMIND_EDGE_DETECT_MAX_PROPOSALS` | `20` | Cap on emitted edge proposals; the review queue applies `placement.maxProposalsPerEnqueue` on top |

---

## Placement

Read-only cluster placement proposed by `POST /api/thoughts/propose` and `memory_status action=propose` (see ADR 2026-09-28), plus the persisted review queue they feed (`edge_review`, `GET/POST /api/proposals` — see [API.md](./API.md) §Review). The engine never writes the graph: `maxClusterSize` only suppresses a proposal, it never mutates; queued proposals are applied only on an explicit `confirm:true`. `proposalTtlDays` sets proposal expiry, controls the daily placement-retention job that expires/prunes queue rows, and bounds the rollback window. This job prunes proposal records, not thoughts.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `placement.maxClusterSize` | `SYNAPTOMIND_PLACEMENT_MAX_CLUSTER_SIZE` | `50` | Skip a cluster placement proposal when the target cluster already holds this many members (`>=`). Re-checked against the live count at apply time. Prevents routing new thoughts into an oversized mega-cluster (lessons #934/#928) |
| `placement.proposalTtlDays` | `SYNAPTOMIND_PLACEMENT_PROPOSAL_TTL_DAYS` | `30` | Proposal expiry interval and rollback window. Newly enqueued/refreshed `pending` rows receive `expires_at`; apply rejects expired rows. The daily placement-retention job marks overdue pending rows expired and prunes terminal proposal rows after this interval; rollback also refuses accepted rows decided outside this window. This retention applies to proposal-queue rows, not thoughts. `0` expires immediately and the job prunes terminal rows at the current cutoff; a negative value disables proposal expiry, the job, and the rollback-window guard |
| `placement.maxPendingProposals` | `SYNAPTOMIND_PLACEMENT_MAX_PENDING_PROPOSALS` | `500` | Cap on live `pending` proposals. Enqueueing a *new* item at the cap throws a validation error; refreshing an existing live row is unaffected |
| `placement.maxProposalsPerEnqueue` | `SYNAPTOMIND_PLACEMENT_MAX_PROPOSALS_PER_ENQUEUE` | `5` | Cap on the number of proposals generated for one thought (enqueue/propose). A caller-supplied `max_proposals` overrides it |

**Note:** The review queue stores `edge` items only. A plan's `placement` and
`lifecycle` items are not queued; `POST /api/proposals` and
`edge_review action=enqueue` return them in `skipped` / `skipped_kinds`. Rows
written by retired subsystems may still exist in an upgraded install — they stay
listable and filterable, but neither apply nor rollback can act on them.

---

## Slots

Context windows for agent startup.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `slots.defaultMaxChars` | `SYNAPTOMIND_SLOTS_MAX_CHARS` | `2000` | Default max characters per slot |

---

## Graph

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `graph.maxDegree` | `SYNAPTOMIND_GRAPH_MAX_DEGREE` | `50` | Max edges per thought in chain traversal |

---

## Search

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `search.confidence.vectorFloor` | `SYNAPTOMIND_SEARCH_CONFIDENCE_VECTOR_FLOOR` | `0.9` | Unitless cosine similarity (0–1) at or above which a hit is not marked `low_confidence` and reaches calibrated `relevance` 1 |
| `search.confidence.unrelatedFloor` | `SYNAPTOMIND_SEARCH_CONFIDENCE_UNRELATED_FLOOR` | `0.8` | Unitless cosine similarity (0–1) of an unrelated query/thought pair; the zero point of the calibrated `relevance` scale (`(similarity - unrelatedFloor) / (vectorFloor - unrelatedFloor)`). The default noise gate drops cosine-only rows below calibrated `relevance` 0.4 |

The calibrated scale maps `unrelatedFloor` to `relevance` 0 and `vectorFloor` to 1, clamped to
`[0, 1]` (`src/services/text-similarity.ts`). The measurement behind the defaults (200 sampled
thoughts, 20 unrelated queries, real e5-small embedder): unrelated pairs reach p50 0.7627,
p95 0.8002, max 0.8355.

**Noise gate.** Cosine-only hits are dropped below calibrated `relevance` **0.4** by default
(`DEFAULT_MIN_RELEVANCE` in `src/services/search-normalize.ts`, a raw similarity of 0.84 on the
default scale). A row with a lexical (BM25) anchor or an id is never gated. The threshold is not a
config file setting and has no environment variable: it is overridden per request — `min_relevance`
on the HTTP search route and on the MCP `memory_recall` `search`/`clusters` actions — where `0`
disables the gate and keeps the pre-calibration fail-open result set.

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

### Debug logging

`SYNAPTOMIND_DEBUG=true` enables verbose debug logging (read directly from the
environment by the logging module, `src/logging/log.ts:112`). Off by default.

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
  "mcp": {
    "httpPort": 3006, "instructionsFile": "", "stdioStandalone": false,
    "corsOrigins": [], "maxSessions": 100, "sessionTtlMs": 3600000,
    "keepAliveMs": 10000, "maxEventsPerSession": 1000
  },
  "db": { "path": "./data/synaptomind.db", "busyTimeout": 5000 },
  "embedder": {
    "enabled": true,
    "model": "Xenova/multilingual-e5-small",
    "dtype": "q8",
    "dimensions": 384,
    "pollIntervalMs": 7000,
    "cacheDir": "./data/huggingface",
    "idleTimeoutMs": 600000,
    "precache": false,
    "batchSize": 8,
    "resetDeadLetters": false
  },
  "thoughts": { "softLimit": 600, "hardLimitBufferPercent": 20 },
  "decay": { "rate": 0.95, "intervalMs": 86400000 },
  "primer": { "promoteThreshold": 5, "topN": 3 },
  "autoCluster": {
    "minAgeDays": 3, "minSimilarity": 0.09,
    "minMembers": 3
  },
  "edgeDetect": {
    "minSimilarity": 0.75, "topK": 10,
    "maxCandidates": 100, "maxProposals": 20
  },
  "placement": { "maxClusterSize": 50, "proposalTtlDays": 30, "maxPendingProposals": 500, "maxProposalsPerEnqueue": 5 },
  "slots": { "defaultMaxChars": 2000 },
  "graph": { "maxDegree": 50 },
  "search": { "confidence": { "vectorFloor": 0.9, "unrelatedFloor": 0.8 } },
  "rateLimit": { "max": 200, "windowMs": 60000, "trustProxy": false }
}
```

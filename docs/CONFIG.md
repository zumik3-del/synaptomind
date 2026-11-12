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
| `server.port` | `SYNAPTOMIND_PORT` | `3005` | HTTP ops port (health, health-check) |
| `server.host` | `SYNAPTOMIND_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose to network |

---

## MCP

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `mcp.httpPort` | `SYNAPTOMIND_MCP_HTTP_PORT` | `3006` | MCP HTTP transport port |
| `mcp.instructionsFile` | `SYNAPTOMIND_MCP_INSTRUCTIONS_FILE` | `""` | Path to custom MCP instructions file (markdown). Falls back to built-in instructions |
| `mcp.stdioStandalone` | `SYNAPTOMIND_MCP_STDIO_STANDALONE` | `false` | When `true`, a `--stdio` process also starts the embedder and background jobs. By default, the shared HTTP server owns scheduled jobs and stdio does not start an embedder at startup; embedding requests can still start a local child on demand. See [Stdio ownership](#stdio-ownership) |
| `mcp.corsOrigins` | `SYNAPTOMIND_MCP_CORS_ORIGINS` | `[]` | Comma-separated allowed CORS origins for the MCP HTTP transport. Empty = no CORS headers |
| `mcp.maxSessions` | `SYNAPTOMIND_MCP_MAX_SESSIONS` | `100` | Max concurrent **legacy** sessions per user (one user exhausting it cannot lock out the others). Legacy (2025-era) transport only: the 2026-07-28 era serves every request with a fresh instance and issues no `mcp-session-id`, so there is no session to cap |
| `mcp.sessionTtlMs` | `SYNAPTOMIND_MCP_SESSION_TTL_MS` | `3600000` | Idle timeout of a **legacy** session in ms (1h). Legacy-only: the 2026-07-28 era keeps no session between requests, so nothing idles |
| `mcp.keepAliveMs` | `SYNAPTOMIND_MCP_KEEPALIVE_MS` | `10000` | SSE keep-alive interval in ms, on both eras |
| `mcp.maxEventsPerSession` | `SYNAPTOMIND_MCP_MAX_EVENTS_PER_SESSION` | `1000` | Max events buffered per **legacy** session for `Last-Event-ID` replay. The 2026-07-28 era has no event store, so no replay to buffer |
| `mcp.maxSubscriptions` | `SYNAPTOMIND_MCP_MAX_SUBSCRIPTIONS` | `128` | Max concurrent `subscriptions/listen` streams on the 2026-07-28 era, process-wide (not per user). The stream past the cap is refused in-band with `-32603 "Subscription limit reached"` |

### HTTP transport and protocol revisions

`/mcp` serves two request eras on the same path. The era is decided per request
from the request itself — its `mcp-protocol-version` header and its body — and no
setting or query parameter chooses it.

- **2026-07-28 (modern, stateless).** Each request is served by a fresh server
  instance and its own single-use transport. No `mcp-session-id` is issued, no
  server or transport outlives the exchange, and there is nothing for a sweep or
  a TTL to expire. A POST is routed here when it carries the 2026-07-28
  per-request `_meta` envelope claim — `params._meta` holding the reserved
  `io.modelcontextprotocol/protocolVersion` key: the `server/discover` probe and
  envelope `tools/call` — or, for a single JSON-RPC request or notification,
  when it carries no claim but presents an `mcp-protocol-version` header naming a
  modern revision (`2026-07-28` or later): this path then answers a claim-less
  request itself with the missing-envelope `400` `-32602`, or with a header/body
  disagreement `400` `-32020` when the body is an `initialize` handshake. This
  path also answers the protocol errors it owns (an unsupported-revision claim, a
  malformed envelope, a body that parses but is not a JSON-RPC message — see
  below). The decision is the `isLegacyRequest` predicate exported by
  `@modelcontextprotocol/server` and called once in `src/mcp/mcp-route.ts`.
- **2025 era (legacy, sessionful).** The 2025-era revisions (latest
  `2025-11-25`), served by the unchanged sessionful transport: `initialize`
  issues an `mcp-session-id`, follow-up requests present it, `GET` opens an SSE
  stream with keep-alive frames, and a dropped stream resumes from
  `Last-Event-ID`. Every POST the modern path does not take is served here —
  the `initialize` handshake and a legacy batch included — as are body-less
  `GET`/`DELETE` session operations and a body that is empty or not valid JSON.

**A body that parses but is not a JSON-RPC message is served here.** `{}`,
`null`, `"x"` and `[1]` all parse as JSON and none is a JSON-RPC message, so the
modern path answers them itself with `400` `-32600` (invalid request) — `"Bad
Request: the request body is not a valid JSON-RPC message"`, or `"Bad Request:
JSON-RPC batch contains an invalid message"` for a bad batch — with or without an
`mcp-session-id`. Only an empty or unparseable body is routed to the legacy path
instead. For an existing client this changes one wire answer: a session request
with such a body used to reach the 2025 transport and get `400` `-32700` `"Parse
error: Invalid JSON-RPC message"`; it now gets the modern `400` `-32600`, and an
unknown session id no longer turns it into `404` `-32001`.

**Observable check order on `/mcp`.** A `POST` is checked in this order:
authentication (`401`), the declared-`Content-Length` bound (`413`, detailed
below), media type (`415` — a `Content-Type` whose type is not `application/json`;
parameters such as `charset` are ignored), era classification, then the legacy
session lookup (`404` `-32001` unknown id, `403` `-32002` a session created by
another token), and only once a session is found does the session transport
parse the body. So a `text/plain` POST is `415` even with an unknown session id,
while a valid JSON-RPC request carrying that same unknown id is still `404`
`-32001`, and an unparseable body with an unknown id is `404` rather than the
transport's `-32700`.

Negotiation is the client's decision, not a server setting. A client that does
not negotiate never sends the probe and opens a 2025 session, exactly as before
this change. A negotiating client probes with `server/discover`; the modern
answer selects the 2026-07-28 era for that connection, and the client then
attaches the envelope to its following requests. A client that falls back after
an unrecognised probe is served by the 2025 handshake; that silent fallback is
expected and needs no action on the server.

**Request body bound: 5 MB (5242880 bytes) on both eras.** A declared
`Content-Length` above it is answered `413` without parsing the body — the
guard decides from the declared length alone — and the body that follows is
drained up to `DRAIN_BODY_BYTES` (64 KiB, `src/mcp/request-body.ts`) and
discarded, never parsed or inspected
(`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Request body too large (max 5MB)"},"id":null}`).
The drain is deliberate: Bun settles a request only once its body reaches the
end, and an unread body makes a graceful shutdown wait on the rejected request.
The same bounded drain applies to any `POST` the chain answers with an error
before consuming the body. Past the cap the drain stops reading — a body whose
declared length is already over it is cancelled without reading a byte, a
chunked one as soon as the running total passes 64 KiB — so the `4xx` does not
wait out the rest of the upload and the drain itself buffers nothing. A rejected
request that has no body, or whose body reaches its end within the cap, is
`consumed`: the answer carries no `Connection: close`, so the connection stays
keep-alive for the next request. Cancelling the stream does not settle the
request, though: Bun writes the `4xx` and keeps the connection in flight with
the rest of the body unread, so a client that still has bytes to send would
leave `server.stop()` waiting. The drain therefore reports `consumed` or
`abandoned` (`DrainOutcome` in `src/mcp/request-body.ts`), and an abandoned body
makes the answer carry `Connection: close` (`src/mcp/http-transport.ts`): the
connection ends with the answer, which is what settles the request. A chunked
body declares no length, so the 5 MB bound is enforced by the read itself: it is
read up to that bound and then answered `413`. Before the 2026-07-28 path
existed, the 5 MB bound was enforced only by the middleware, and the legacy
session path inherited the transport's own 4 MB default, so a 4–5 MB session
request used to be rejected and is now served.

**Modern streams are not resumable.** The 2026-07-28 handler keeps no event
store, so `Last-Event-ID` replay does not exist there: a dropped
`subscriptions/listen` stream is re-opened by the client as a new subscription.
Open listen streams are the only long-lived resource on the modern path, and they
are bounded by `mcp.maxSubscriptions` (default `128`). The stream past the cap is
refused in-band with `-32603 "Subscription limit reached"` — HTTP 200, before
the subscription acknowledgement.

### Stdio ownership

A stdio MCP client talks to the same SQLite database as the HTTP server. By
default (`mcp.stdioStandalone=false`) the stdio process does **not** start an
embedder child or background jobs at startup; the shared HTTP server owns the
scheduled jobs. An embedding request can still start a local child on demand;
stdio does not reuse the HTTP server's embedder process.

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
| `embedder.idleTimeoutMs` | `SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT` | `600000` | Unload after this idle time (ms): the embedder process exits and the next request starts a new one. A queue poll that finds pending embeddings or an IPC request resets the countdown. `0` = never unload, the same effect as `embedder.precache` |
| `embedder.precache` | `SYNAPTOMIND_EMBEDDER_PRECACHE` | `false` | When `true`, keeps the embedder process resident instead of letting it unload after `embedder.idleTimeoutMs` (same effect as `idleTimeoutMs: 0`), so the model stays loaded and the first request after a quiet period pays no reload. It does not download or preload anything at startup: model files are fetched on the first process start either way, and the ONNX session still loads on the first embedding request |
| `embedder.resetDeadLetters` | `SYNAPTOMIND_RESET_DEAD_LETTER` | `false` | Re-queue dead-lettered embeddings on startup. Off by default: a poisonous thought would otherwise get fresh attempts on every restart. Enable after fixing an embedding bug to retry failed items |
| `embedder.batchSize` | `SYNAPTOMIND_EMBEDDER_BATCH_SIZE` | `8` | Embeddings per batch. Higher = faster but more RAM |

**Note:** The embedder child starts with the server, not with the first request:
`startEmbedderProcess()` runs at boot in every process that owns background jobs (see
[Stdio ownership](#stdio-ownership)), unless `embedder.enabled=false` or `--no-embedder`.
`embedder.precache` and `embedder.idleTimeoutMs` never change that; they only decide whether the
child survives between requests. On start the child validates the model files (downloading any
missing one) and then polls the embedding queue; the model itself is loaded into memory by the
first embedding it computes. The queue worker lives inside that child, so a thought queued after an
idle unload stays pending until the next embedding request starts a child — keep
`embedder.precache=true` or `embedder.idleTimeoutMs=0` on a host that must embed with no other
traffic.

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
`retention_review` tool (`action=list`) lists eligible candidates; an operator must explicitly protect,
delete, or compact them. Candidate defaults are:

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `retentionReview.minAgeDays` | `SYNAPTOMIND_RETENTION_REVIEW_MIN_AGE_DAYS` | `30` | Minimum age, measured from `archived_at` or (when absent) `created_at` |
| `retentionReview.importanceFloor` | `SYNAPTOMIND_RETENTION_REVIEW_IMPORTANCE_FLOOR` | `0.3` | Candidate importance must be below this threshold |
| `retentionReview.pageSize` | `SYNAPTOMIND_RETENTION_REVIEW_PAGE_SIZE` | `20` | Default candidate page size (the `retention_review` `limit` argument accepts 1–100) |

Configuration loading normalizes `pageSize` to an integer in the range 1–100 and
clamps `importanceFloor` to 0–1. A non-positive or non-numeric `minAgeDays` uses
the 30-day default. These settings govern the manual retention-review workflow;
they do not enable age-based thought TTL cleanup.

`retention_review action=list` accepts `min_age_days` and `importance_floor` to
override these defaults per call, so candidate eligibility is set here and refined at
the request; the preview-first protect/delete/compact actions are documented in
[mcp-tools.md](./mcp-tools.md#retention_review--retention-candidates).

---

## Decay

Automatic importance decay for old thoughts.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `decay.rate` | `SYNAPTOMIND_DECAY_RATE` | `0.95` | Daily decay multiplier. 0.95 = importance × 0.95 per day |
| `decay.intervalMs` | `SYNAPTOMIND_DECAY_INTERVAL_MS` | `86400000` | How often to run decay (ms). Default: 24h |

**Note:** Decay only lowers importance — it never archives, deletes or otherwise
changes a thought's status. Archiving is explicit (`memory_supersede action=archive`;
`memory_store action=update` rejects `status=archived`), and deletion of archived thoughts is
handled by the retention-review process (the sole deletion path).

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
engine (`memory_status action=propose`) reads all four:
`minSimilarity` sets the recall floor for embedding neighbours, `topK` the neighbour
width, `maxCandidates` the candidate pool loaded for one run, and `maxProposals`
the cap on emitted edge proposals. The draft health check reuses the candidate-pool
bound only.

No standalone detection route or `memory_status` action exists any more: a candidate
is only ever a proposal, produced by the read-only placement engine. An edge can
be created directly with `memory_store action=link`, or by applying a queued
proposal with `edge_review action=apply` or `apply_batch` and explicit confirmation.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `edgeDetect.minSimilarity` | `SYNAPTOMIND_EDGE_DETECT_MIN_SIMILARITY` | `0.75` | Min embedding similarity for a neighbour pair to become a candidate |
| `edgeDetect.topK` | `SYNAPTOMIND_EDGE_DETECT_TOP_K` | `10` | Max nearest neighbours considered per thought |
| `edgeDetect.maxCandidates` | `SYNAPTOMIND_EDGE_DETECT_MAX_CANDIDATES` | `100` | Max candidate thoughts loaded for one run |
| `edgeDetect.maxProposals` | `SYNAPTOMIND_EDGE_DETECT_MAX_PROPOSALS` | `20` | Cap on emitted edge proposals; the review queue applies `placement.maxProposalsPerEnqueue` on top |

---

## Placement

Read-only cluster placement proposed by `memory_status action=propose` (see ADR 2026-09-28), plus the persisted review queue they feed (`edge_review` — see [mcp-tools.md](./mcp-tools.md#edge_review--placement-proposals)). The engine never writes the graph: `maxClusterSize` only suppresses a proposal, it never mutates; queued proposals are applied only on an explicit `confirm:true`. `proposalTtlDays` sets proposal expiry, controls the daily placement-retention job that expires/prunes queue rows, and bounds the rollback window. This job prunes proposal records, not thoughts.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `placement.maxClusterSize` | `SYNAPTOMIND_PLACEMENT_MAX_CLUSTER_SIZE` | `50` | Skip a cluster placement proposal when the target cluster already holds this many members (`>=`). Re-checked against the live count at apply time. Prevents routing new thoughts into an oversized mega-cluster (lessons #934/#928) |
| `placement.proposalTtlDays` | `SYNAPTOMIND_PLACEMENT_PROPOSAL_TTL_DAYS` | `30` | Proposal expiry interval and rollback window. Newly enqueued/refreshed `pending` rows receive `expires_at`; apply rejects expired rows. The daily placement-retention job marks overdue pending rows expired and prunes terminal proposal rows after this interval; rollback also refuses accepted rows decided outside this window. This retention applies to proposal-queue rows, not thoughts. `0` expires immediately and the job prunes terminal rows at the current cutoff; a negative value disables proposal expiry, the job, and the rollback-window guard |
| `placement.maxPendingProposals` | `SYNAPTOMIND_PLACEMENT_MAX_PENDING_PROPOSALS` | `500` | Cap on live `pending` proposals. Enqueueing a *new* item at the cap throws a validation error; refreshing an existing live row is unaffected |
| `placement.maxProposalsPerEnqueue` | `SYNAPTOMIND_PLACEMENT_MAX_PROPOSALS_PER_ENQUEUE` | `5` | Cap on the number of proposals generated for one thought (enqueue/propose). A caller-supplied `max_proposals` overrides it |

**Note:** The review queue stores `edge` items only. A plan's `placement` and
`lifecycle` items are not queued; `edge_review action=enqueue` returns them
in `skipped` / `skipped_kinds`. Rows
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
`[0, 1]` (`src/services/text-similarity.service.ts`). The measurement behind the defaults (200 sampled
thoughts, 20 unrelated queries, real e5-small embedder): unrelated pairs reach p50 0.7627,
p95 0.8002, max 0.8355.

**Noise gate.** Cosine-only hits are dropped below calibrated `relevance` **0.4** by default
(`DEFAULT_MIN_RELEVANCE` in `src/services/search-normalize.service.ts`, a raw similarity of 0.84 on the
default scale). A row with a lexical (BM25) anchor or an id is never gated. The threshold is not a
config file setting and has no environment variable: it is overridden per request —
`min_relevance` on the MCP `memory_recall` `search`/`clusters` actions — where `0`
disables the gate and keeps the pre-calibration fail-open result set.

---

## Rate Limit

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `rateLimit.max` | `SYNAPTOMIND_RATE_LIMIT` | `200` | Max requests per window |
| `rateLimit.windowMs` | `SYNAPTOMIND_RATE_LIMIT_WINDOW_MS` | `60000` | Window duration (ms). Default: 1 min |
| `rateLimit.trustProxy` | `SYNAPTOMIND_TRUST_PROXY` | `false` | Honor `X-Forwarded-For` / `X-Real-IP` for the client identity. The rightmost `X-Forwarded-For` hop (the one added by the trusted proxy) is used. Enable only behind a trusted reverse proxy; otherwise the socket peer address is used and proxy headers are ignored |

---

## Users (multi-user)

Optional list of per-user tenants. An empty list (`users: []`, the default)
preserves today's single-user behaviour (`config.db.path`).

Each entry: `{ id, dbPath, tokenSha256 }`.

| Field | Description |
|-------|-------------|
| `id` | Unique user identifier. Used to derive the env var name for token injection |
| `dbPath` | Absolute path to that user's SQLite database file |
| `tokenSha256` | SHA-256 hex digest of the user's bearer token |

Tokens are never stored in plaintext in `config.json`: provide `tokenSha256`
(the SHA-256 of the bearer token) or inject the plaintext token through the
environment as `SYNAPTOMIND_USER_TOKEN_<ID>` (the id is upper-cased and
non-alphanumeric characters become `_`). When the env var is set it overrides
any `tokenSha256` in the file.

Generate a token hash (the digest must be lowercase hex, 64 characters):

```bash
printf '%s' 'your-bearer-token' | sha256sum | awk '{print $1}'
# or, without sha256sum:
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" 'your-bearer-token'
```

Each user's `dbPath` is a separate SQLite database. Deployments back up every
configured database (the main `db.path` plus each `users[].dbPath`) before an
update; see [DEPLOY.md](DEPLOY.md#rollback).

Validation (applied at startup, aborts load on failure):
- `id` values must be unique
- `dbPath` values must be absolute and must identify distinct, non-overlapping
  paths (one path must not be a directory-prefix of another)
- `tokenSha256` values must be unique
- plaintext `token`/`password`/`secret` keys in a user entry are rejected

For user database paths, startup validation resolves path components in
filesystem order, including symlinks and `..`. It compares the resolved paths
and, for existing files, their device and inode numbers, rejecting aliases
including hard links. A database file need not exist yet; missing path
components are allowed. Dangling symlinks and filesystem inspection errors
other than a missing component abort configuration loading. These comparisons
are between user database paths; the main `db.path` is not included.

**Filesystem trust:** This check is a startup snapshot, not a lock. A path or
file changed after validation, including between validation and opening the
database, can invalidate the result. Keep database files and their parent
directories trusted and non-writable by untrusted users, and restart after path
changes.

Example:
```json
{
  "users": [
    { "id": "alice", "dbPath": "/var/lib/synaptomind/alice.db", "tokenSha256": "..." },
    { "id": "bob", "dbPath": "/var/lib/synaptomind/bob.db", "tokenSha256": "..." }
  ]
}
```

With env injection:
```bash
SYNAPTOMIND_USER_TOKEN_ALICE=plaintext-token-alice
SYNAPTOMIND_USER_TOKEN_BOB=plaintext-token-bob
```

### Adopting multi-user on an existing install

`users: []` is the default and keeps the current single-user behaviour, so
upgrading SynaptoMind does **not** change authentication, data location or the
database it opens until you opt in.

To switch an existing installation over:

1. Back up the current database (`<db>.backup/` after an update, or
   `sqlite3 <db> ".backup '<copy>'"`).
2. Give the existing file to a user: set that user's `dbPath` to the absolute
   path the service opens today (`db.path`).
3. Add the other users with their own absolute `dbPath` files; missing files are
   created and migrated on boot.
4. Add each user's `tokenSha256` (or `SYNAPTOMIND_USER_TOKEN_<ID>`) and restart.
   From then on every HTTP client (`/api/*`, `/mcp`) must send that user's own
   token — `SYNAPTOMIND_SECRET` stops being accepted.
5. `db.path` is no longer opened by the HTTP server in multi-user mode. It is
   still the database of the MCP **stdio** transport, which stays single-user
   and unauthenticated; stdio refuses to start if that path aliases a user
   database, so keep it separate (or unused) if you run `--stdio`.

### Adding, rotating and removing users

The user list is read once at startup. There is no user-management API, CLI or
hot reload: every change below is a `config.json` (or environment) edit plus a
service restart.

**Add a user**

1. Generate a token and its digest:

   ```bash
   TOKEN="$(openssl rand -hex 24)"
   printf '%s' "$TOKEN" | sha256sum | awk '{print $1}'
   ```

2. Append an entry to `users` with a unique `id`, an absolute `dbPath` that is
   not shared with or a directory-prefix of another user's path, and the
   `tokenSha256` from step 1. Keep the plaintext token for the client; it is not
   stored in `config.json`.

3. Restart the service. A missing database file is created and migrated on
   boot. If it cannot be opened, that user is marked unavailable — the other
   users keep serving — and `/health` reports `degraded` with HTTP 503.

4. Verify with the read-only ops check, run with the service's config:

   ```bash
   cd /opt/synaptomind && ./synaptomind ops health-check --user <id>
   # or, from elsewhere:
   SYNAPTOMIND_CONFIG=/var/lib/synaptomind/config.json /opt/synaptomind/synaptomind ops health-check --user <id>
   ```

   It prints that user's health report (it never creates or migrates a
   database). `/health` stays public and aggregate; `/api/health-check` with
   the user's token reports the same data over HTTP.

**Rotate a token.** Replace that user's `tokenSha256` (or its
`SYNAPTOMIND_USER_TOKEN_<ID>`) and restart. The old token stops authenticating
at the first request after the restart. An MCP session created by that user
stays bound to the user id, so it works again as soon as the client presents
the new token.

**Remove a user.** Delete the entry and restart. The database file is left on
disk, and the backup step's discovery pass still covers it while it sits in
`DATA_DIR`; delete it yourself once its data is no longer needed.

---
## Authentication

Auth applies to the HTTP ops endpoints under `/api/*` and the MCP HTTP transport (`/mcp`); the MCP stdio transport is local and unauthenticated by design.

Authentication depends on the mode:

- **Single-user** (`users: []`, the default): the bearer token is
  `SYNAPTOMIND_SECRET`. Without it the server **fails closed**: authenticated
  requests are rejected with `401`. `SYNAPTOMIND_ALLOW_INSECURE=true` disables
  auth for local development only.
- **Multi-user** (`users` non-empty): every request must present one of the
  configured users' own tokens (see [Users](#users-multi-user)), and is served
  that user's database. `SYNAPTOMIND_SECRET` and `SYNAPTOMIND_ALLOW_INSECURE`
  are inert — the server logs a warning at startup if either is set.

`SYNAPTOMIND_SERVICE_TOKEN` has been removed: every token belongs to a user.
Use `SYNAPTOMIND_USER_TOKEN_<ID>` for a user's plaintext token.

| Env Var | Default | Description |
|---------|---------|-------------|
| `SYNAPTOMIND_SECRET` | (none) | Single-user bearer token. Ignored when `users` is configured |
| `SYNAPTOMIND_USER_TOKEN_<ID>` | (none) | Plaintext token for the configured user `<id>`; overrides that entry's `tokenSha256` |
| `SYNAPTOMIND_ALLOW_INSECURE` | `false` | **Local-development only.** Single-user only: when `true`, disables auth entirely and allows anonymous access. Never enable in production |

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
| `SYNAPTOMIND_SECRET` | (none) | Single-user auth token for the HTTP ops endpoints and MCP. **Required** — without it the server fails closed with `401` |
| `SYNAPTOMIND_USER_TOKEN_<ID>` | (none) | Per-user token when `config.json` has a `users` list; `SYNAPTOMIND_SECRET` is then inert |

---

## Full Example

```json
{
  "contentLanguage": "en",
  "server": { "port": 3005, "host": "127.0.0.1" },
  "mcp": {
    "httpPort": 3006, "instructionsFile": "", "stdioStandalone": false,
    "corsOrigins": [], "maxSessions": 100, "sessionTtlMs": 3600000,
    "keepAliveMs": 10000, "maxEventsPerSession": 1000,
    "maxSubscriptions": 128
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
  "rateLimit": { "max": 200, "windowMs": 60000, "trustProxy": false },
  "users": []
}
```

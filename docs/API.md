# HTTP API Reference

REST API served by the SynaptoMind HTTP server. Default base URL: `http://127.0.0.1:3005` (configurable, see docs/CONFIG.md). Server version at time of writing: **0.8.0-beta.2**.

- **Auth:** all `/api/*` endpoints require `Authorization: Bearer <token>` (401 otherwise). The token is set via the `SYNAPTOMIND_SECRET` or `SYNAPTOMIND_SERVICE_TOKEN` environment variable. `GET /health` is the only public endpoint.
- **Body limit:** request bodies over 5 MB are rejected with `413`.
- **Errors:** handlers return `{"error": "..."}` with an appropriate HTTP status (400 validation, 401 auth, 404 not found, 409 conflict, 413 too large, 500 job failure).
- **Thought object:** `id, content, status (draft|active|archived), tags: [{id, name}], source, project_id, project_name?, is_cluster, is_profile, is_protected, created_at, updated_at, archived_at`.
- Curls are abbreviated: GET examples omit `-H "Authorization: Bearer $TOKEN"`; mutating examples additionally use `-X POST/PUT/PATCH/DELETE`, `-H "Content-Type: application/json"`, and `-d '<json>'`.

## Thoughts

### GET /api/thoughts/search

Hybrid (vector + FTS5) search over thoughts. Results can be grouped by cluster and are post-processed to surface primers and profile thoughts.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| q | query | string | required | Search query |
| k | query | int | 10 | Max results |
| status | query | string | active | Status filter |
| project_id | query | string | optional | Project filter |
| tag | query | string | optional | Tag filter |
| cluster | query | bool | false | `true` returns only cluster thoughts |
| exclude_clusters | query | bool | false | `true` excludes cluster thoughts |
| group_by_cluster | query | bool | false | `true` groups results by cluster |
| min_importance | query | float | optional | Minimum importance |
| show_primers | query | bool | true | Set `false` to hide primer results |
| exclude_flagged | query | bool | false | `true` excludes flagged thoughts |
| hybrid | query | bool | true | `0` disables hybrid search |
| recency_weight | query | float | 0 | Opt-in recency boost weight (0-1); `0` preserves relevance-only ranking, `>0` adds `recency_weight × 0.5^(ageDays/recency_half_life_days)` |
| recency_half_life_days | query | int | 30 | Recency decay half-life in days (clamped 1-3650); only meaningful when `recency_weight > 0` |
| min_relevance | query | float | 0 | Opt-in relevance gate (0-1); with `>0` only strong matches are kept (BM25, or vector with `similarity >= min_relevance`) |
| supersession_mode | query | string | suppress | Superseded thoughts: `off` (no annotation), `flag` (annotate), `suppress` (drop) |
| contradiction_mode | query | string | flag | Contradicted thoughts: `off` or `flag`; never suppressed |

curl `'http://127.0.0.1:3005/api/thoughts/search?q=auth+middleware&k=3&supersession_mode=flag'`

Response: `[{"thought": {"id": "...", "content": "...", ...}, "distance": 0.12, "similarity": 0.88, "standing": "current"}, ...]`

**Graph standing** (`supersession_mode` / `contradiction_mode`). `supersession_mode`
controls thoughts marked superseded by an incoming `replaces` edge; `contradiction_mode`
controls thoughts paired by a symmetric `contradicts` edge. The agent-facing defaults are
`suppress` and `flag`; the `searchThoughts` library default stays `flag` for both. The
modes are per-axis: `off` on one axis only stops annotation for that axis, so the other
axis still applies — fully unannotated output requires both to be `off`. Invalid values
return HTTP 400.

When annotation runs, results carry `standing` (`current` | `superseded` | `contradicted`)
plus `superseded_by` / `contradicted_by` id arrays where applicable. `suppress` drops
superseded rows; contradicted rows are always flagged, never suppressed, because
contradiction is symmetric and neither endpoint is authoritative. Results are then
stably partitioned by standing (`current` first, then `contradicted`, then
`superseded`), preserving the underlying relevance order within each group; deeper
relevance re-scoring is out of scope.

### GET /api/thoughts/search/hints

Compact search hints for autocomplete UIs. Returns at most 10 items.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| q | query | string | required | Search query |
| k | query | int | 3 (clamped 1-10) | Max hints |
| max_length | query | int | 80 (min 20) | Max `content_short` length |

curl `'http://127.0.0.1:3005/api/thoughts/search/hints?q=slots'`

Response: `[{"id": "...", "content_short": "...", "similarity": 0.9, "project_name": "...", "tags": [{"id": "...", "name": "..."}], "compact": true}]`

### GET /api/thoughts/timeline

Lists thoughts with pagination and filters.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| status | query | string | optional | Status filter (draft/active/archived) |
| project_id | query | string | optional | Project filter |
| tag | query | string | optional | Comma-separated tag filter |
| limit | query | int | 50 | Max thoughts |
| offset | query | int | 0 | Pagination offset |

curl `'http://127.0.0.1:3005/api/thoughts/timeline?limit=5&status=active'`

Response: `[{"id": "...", "content": "...", "status": "active", ...}]`

### POST /api/thoughts/

Creates a thought. Optionally attaches it under a parent thought via an edge. Returns 201.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| content | body | string | required | Thought content |
| status | body | string | optional | draft/active/archived |
| tags | body | string[] | optional | Tag names |
| source | body | string | optional | Provenance string |
| project_id | body | string | optional | Project scope |
| parent_id | body | string | optional | Parent thought id |
| relation | body | string | optional | Edge type to parent |
| is_profile | body | bool | optional | Mark as profile thought |
| is_protected | body | bool | optional | Protect from auto-deletion |

curl `-d '{"content": "Deploy script uses bun", "tags": ["fact"]}' http://127.0.0.1:3005/api/thoughts/`

### POST /api/thoughts/bulk

Creates up to 10000 thoughts in a single transaction; per-item failures are reported without aborting the batch. Returns 201.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| thoughts | body | array | required | Items with the same fields as POST /api/thoughts/ plus per-item `project_id`, `parent_id`, `relation` (max 10000) |
| project_id | body | string | optional | Fallback project for items without their own |

curl `-d '{"thoughts": [{"content": "a"}, {"content": "b"}]}' http://127.0.0.1:3005/api/thoughts/bulk`

Response: `{"created": 2, "errors": 0, "thoughts": [{...}, {...}], "error_details": [{"index": 0, "error": "..."}]}` (`error_details` only when errors occurred)

### GET /api/thoughts/:id

Fetches a single thought by id. 404 if not found.

curl `http://127.0.0.1:3005/api/thoughts/<id>`

### PUT /api/thoughts/:id

Updates a thought. All body fields optional; only provided fields change. Providing `content` also prunes stale URL links. 404 if not found.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| content | body | string | optional | New content |
| tags | body | string[] | optional | Replacement tag set |
| status | body | string | optional | draft/active/archived |
| project_id | body | string | optional | Move to project |
| is_profile | body | bool | optional | Profile flag |
| is_protected | body | bool | optional | Protection flag |

curl `-d '{"status": "archived"}' http://127.0.0.1:3005/api/thoughts/<id>`

### DELETE /api/thoughts/:id

Archives a thought (soft delete). Idempotent: archiving an already-archived thought returns it unchanged. Returns the archived thought.

curl `-X DELETE http://127.0.0.1:3005/api/thoughts/<id>`

### POST /api/thoughts/:targetId/merge

Merges a source thought into the target. If `merged_content`, `merged_tags`, and `project_id` are all omitted, returns a preview (source with edges + target) without merging.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| source_id | body | string | required | Thought to merge away |
| merged_content | body | string | optional | Resulting content |
| merged_tags | body | string[] | optional | Resulting tags |
| project_id | body | string | optional | Resulting project |

curl `-d '{"source_id": "<source>"}' http://127.0.0.1:3005/api/thoughts/<targetId>/merge`

Preview response: `{"mode": "preview", "source": {"id": "...", "edges": [...]}, "target": {...}}`

### GET /api/thoughts/:id/edges

Returns the edge chain around a thought (its graph neighborhood). 404 if not found.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| direction | query | string | both | `upstream`, `downstream`, or `both` |

curl `'http://127.0.0.1:3005/api/thoughts/<id>/edges?direction=upstream'`

### GET /api/thoughts/members/:id

Returns a cluster thought and its member thoughts. 404 if not found, 400 if the id is not a cluster thought.

curl `http://127.0.0.1:3005/api/thoughts/members/<id>`

Response: `{"cluster": {"id": "...", "is_cluster": 1, ...}, "members": [{...}]}`

### GET /api/thoughts/:id/links

Lists URL links attached to a thought.

curl `http://127.0.0.1:3005/api/thoughts/<id>/links`

Response: `[{"thought_id": "...", "key": "repo", "url": "https://...", "label": "repo", "sort_order": 0}]`

### GET /api/thoughts/links/batch

URL links for many thoughts in one call, grouped by thought id. Note: `GET /api/thoughts/:id/links` with `id=links` is not reachable; the static route wins.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| ids | query | string | required | Comma-separated thought ids (max 200) |

curl `'http://127.0.0.1:3005/api/thoughts/links/batch?ids=<id1>,<id2>'`

Response: `{"<id1>": [{"thought_id": "<id1>", "key": "repo", "url": "https://..."}]}`

### POST /api/thoughts/:id/links

Creates or updates a URL link on a thought. Returns 201.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| key | body | string | required | Link key (unique per thought) |
| url | body | string | required | Link URL |
| label | body | string | optional | Display label (defaults to `key`) |
| sort_order | body | int | 0 | Sort position |

curl `-d '{"key": "repo", "url": "https://github.com/zumik3-del/synaptomind"}' http://127.0.0.1:3005/api/thoughts/<id>/links`

### DELETE /api/thoughts/:id/links/:key

Deletes a URL link by key. 404 if missing. Returns `{"success": true}`.

curl `-X DELETE http://127.0.0.1:3005/api/thoughts/<id>/links/repo`

### POST /api/thoughts/auto-link

Runs the auto-link job: it finds active, low-connectivity thoughts, computes embedding-proximity pairs, and creates `related` edges between them.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| dry_run | body | bool | false | Compute without writing |
| max_edges | body | int | optional | Cap edges per run |

curl `-d '{"dry_run": true}' http://127.0.0.1:3005/api/thoughts/auto-link`

### POST /api/thoughts/edge-detect

Proposes unconfirmed `related` candidate pairs among active, non-cluster thoughts. Read-only: it never creates or modifies an edge. Confirm a proposal by linking the pair (`POST /api/thoughts/:id/link`). Returns an empty proposal list (never an error) when there are fewer than two candidates or the embedder is unavailable (`degraded: true`).

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | body | string | optional | Scope detection to one project |
| min_similarity | body | number | `edgeDetect.minSimilarity` (0.75) | Minimum embedding similarity for a neighbor pair |
| max_proposals | body | number | `edgeDetect.maxProposals` (20) | Cap on returned proposals |

`topK` and `maxCandidates` are read only from `edgeDetect.*` in config.

curl `-d '{"project_id": "<id>", "min_similarity": 0.8}' http://127.0.0.1:3005/api/thoughts/edge-detect`

Response: `{"proposals": [{"source_id": "...", "target_id": "...", "type": "related", "confidence": 0.86, "rationale": "embedding_similarity_only", "review_required": true, "signals": {"embeddingSimilarity": 0.86}}], "candidates": 120, "pairs_evaluated": 8, "degraded": false}`

`type` is always emitted as `related` with `review_required: true`: the detector ranks by embedding similarity alone, which means the pair is about the same subject matter, not necessarily in conflict. Consumers must read both thoughts and decide the real type (`contradicts`/`supports`/other) themselves; never treat a proposal as a settled contradiction.

### POST /api/thoughts/propose

Proposes a read-only placement/link plan for one thought: where it belongs (`placement`), which typed edges to add (`edges[]`), and which lifecycle move to make (`lifecycle`). Read-only: it never creates an edge or cluster and never changes a status. Provide at least one of `thought_id` (an existing thought) or `content` (an unpersisted draft) — otherwise 400; when both are passed, `thought_id` takes precedence. An unknown `thought_id` returns 404.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| thought_id | body | string | optional | Existing thought to analyse (provide this or `content`) |
| content | body | string | optional | Draft content to analyse before it is persisted (provide this or `thought_id`) |
| project_id | body | string | optional | Project scope; defaults to the thought's own project, then the default project |

curl `-d '{"thought_id": "<id>"}' http://127.0.0.1:3005/api/thoughts/propose`

Response: `{"thought_id": "...", "placement": {...} | null, "edges": [...], "lifecycle": {...}, "degraded": false, "generated_at": "..."}`

- `placement` — `{"kind": "cluster" | "parent", "target_id", "confidence", "rationale", "review_required"}`, or `null` when no cluster majority or parent/`develops` chain node applies.
- `edges[]` — at most one proposal per unordered pair: `{"source_id", "target_id", "type", "direction", "confidence", "rationale", "review_required", "rule_id", "signals"}`. `type` is the `related` fallback (similarity-only) or a typed `contradicts`/`supports`/`develops`/`depends_on`/`replaces` when a non-embedding cue fired; `rule_id` names the fired rule and `signals` is the exact `PairSignals` input that produced it. Pairs that already carry any edge are excluded.
- `lifecycle` — `{"action": "keep" | "link" | "merge" | "replaces+archive", "confidence", "rationale", "review_required", "blocked_by[]"}`. `blocked_by` lists the reasons a proposed move cannot be confirmed (e.g. `"source is profile"`).
- `degraded` — `true` when the embedder is unavailable: the plan falls back to lexical-only signals (no embedding-derived placement or edges) and still returns a `keep`/`merge` decision instead of failing.

Example:

```json
{
  "thought_id": "<id>",
  "placement": {"kind": "cluster", "target_id": "<cluster-id>", "confidence": 0.80, "rationale": "cluster majority: 3/4 clustered embedding neighbours belong to cluster <cluster-id> (avg similarity 0.85)", "review_required": true},
  "edges": [{"source_id": "<id>", "target_id": "<other-id>", "type": "related", "direction": "symmetric", "confidence": 0.87, "rationale": "embedding_similarity_only", "review_required": true, "rule_id": "fallback.embedding_related", "signals": {"sourceId": "<id>", "targetId": "<other-id>", "embeddingSimilarity": 0.87, "lexicalOverlap": 0.18, "negationDelta": 0, "evidentialCue": false, "evolutionCue": false, "temporalOrder": "older", "tagOverlap": 0, "dependencyCue": false, "existingEdgeType": null, "sourceStatus": "active", "targetStatus": "active", "sourceStanding": "current", "targetStanding": "current", "sameProject": true}}],
  "lifecycle": {"action": "link", "confidence": 0.87, "rationale": "1 edge proposal(s); highest confidence 0.87 (fallback.embedding_related)", "review_required": true, "blocked_by": []},
  "degraded": false,
  "generated_at": "2026-09-28T19:30:00.000Z"
}
```

Every proposal carries `review_required: true` and an **ordinal** (not calibrated) `confidence` in `[0,1]`. The result is a filter, never a source of truth — there is deliberately no `apply` endpoint. Confirm its proposals with the existing writers:

| Proposal | Confirm via |
|---|---|
| edge (`edges[]`, `lifecycle.action: link`) | `POST /api/thoughts/:id/link` (`target_id`, `type`) |
| merge | `POST /api/thoughts/:targetId/merge` (`source_id`) |
| replaces + archive | `POST /api/thoughts/:id/link` (`type: replaces`), then archive the **target** — the superseded (older) thought (`PUT /api/thoughts/:targetId` `{"status":"archived"}`, or `DELETE /api/thoughts/:targetId`). The newer thought is the source and survives |
| placement `kind: cluster` | `POST /api/cluster` (create the cluster from the thought and its members) |
| placement `kind: parent` | `POST /api/thoughts/:id/link` to `target_id` with `type: parent`/`develops` |

Typed edge proposals require a non-embedding cue (negation, evidential, evolution, temporal ordering). Embedding similarity alone yields `type: related` with `rationale: embedding_similarity_only` — similarity means "same subject matter", not conflict; `contradicts` is never inferred from similarity. See ADR #142 and task #927. MCP parity: `memory_status action=propose`.

### POST /api/thoughts/self-improve/run

Runs the self-improve analysis job (orphan detection, merge suggestions).

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| dry_run | body | bool | false | Analyze without writing |

curl `-d '{}' http://127.0.0.1:3005/api/thoughts/self-improve/run`

### GET /api/thoughts/self-improve/status

Returns the result of the last self-improve run, or `{"last_run": null, "result": null}` if none.

curl `http://127.0.0.1:3005/api/thoughts/self-improve/status`

## Tags

### GET /api/tags/

Lists all tags, optionally filtered by substring.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| q | query | string | optional | Substring filter |

curl `'http://127.0.0.1:3005/api/tags/?q=dec'`

Response: `[{"id": "...", "name": "decision"}]`

### PUT /api/tags/:id

Renames a tag. 404 if missing, 400 on validation error.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| name | body | string | required | New tag name |

curl `-d '{"name": "fact"}' http://127.0.0.1:3005/api/tags/<id>`

### DELETE /api/tags/:id

Deletes a tag. 404 if missing. Returns `{"success": true}`.

curl `-X DELETE http://127.0.0.1:3005/api/tags/<id>`

## Links

### POST /api/thoughts/:id/link

Creates a typed edge between two thoughts. Returns 201; 409 if the same directed edge already exists; 400 on invalid ids, an unknown edge type, or a conflicting edge pair.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| target_id | body | string | required | Target thought id |
| type | body | string | optional | Edge type, default `related`. One of: `related`, `parent`, `develops`, `replaces`, `contradicts`, `supports`, `cluster`, `references`, `depends_on` |

curl `-d '{"target_id": "<target>", "type": "references"}' http://127.0.0.1:3005/api/thoughts/<id>/link`

Response: `{"id": "<edge-id>", "source_id": "<id>", "target_id": "<target>", "type": "references"}`

Edge types:

- `related` — general association (default).
- `parent` — source is the parent of target.
- `develops` — source evolves into target.
- `replaces` — source supersedes target.
- `contradicts` — two live, mutually exclusive claims; **symmetric** (A↔B), neither side authoritative.
- `supports` — source provides evidence for target; **directed**.
- `cluster` — cluster → member thought.
- `references` — cluster ↔ cluster.
- `depends_on` — source is blocked until target is done.

One edge per unordered pair. Linking a pair that already has a `related` placeholder with a specific type upgrades it in place. Symmetric types (`related`, `contradicts`) are idempotent in both directions; a reverse `supports` on an existing forward `supports` is rejected as an edge conflict (400).

### DELETE /api/edges/:id

Deletes an edge by id. 404 if missing. Returns `{"success": true}`.

curl `-X DELETE http://127.0.0.1:3005/api/edges/<edge-id>`

## Graph

### GET /api/graph

Returns the full thought graph (nodes + edges) for visualization or traversal. 400 on invalid `status`.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | query | string | optional | Project filter |
| status | query | string | active | One of: `active`, `draft`, `archived`, `all` |
| limit | query | int | 500 (clamped 1-2000) | Max nodes |

curl `'http://127.0.0.1:3005/api/graph?limit=50'`

Response: `{"nodes": [{...}], "edges": [{...}]}`

## Cluster

### POST /api/cluster

Creates a cluster thought from existing thoughts. Returns 201.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| thought_ids | body | string[] | required | Member thought ids |
| title | body | string | optional | Cluster title |
| tags | body | string[] | optional | Cluster tags |
| source | body | string | api | Provenance (defaults to `api`) |
| project_id | body | string | optional | Project scope |

curl `-d '{"thought_ids": ["<id1>", "<id2>"], "title": "Auth notes"}' http://127.0.0.1:3005/api/cluster`

## Review

The persisted placement-proposal queue. `POST /api/thoughts/propose` is read-only and persists nothing; the review queue stores its confirmable items so a reviewer can apply or reject them one at a time. The queue never re-runs the engine and never auto-applies: an apply is an explicit, per-item write gated by `confirm:true`. MCP parity: `memory_review` (actions `enqueue`/`list`/`apply`/`apply_batch`/`rollback`/`reject`); only `apply`/`apply_batch`/`rollback` execute a write, and no read tool can reach them.

A queued item carries an `item_kind` (`edge` | `placement` | `lifecycle` | `triage_activate` | `triage_archive`) and a `state`: `pending` (live) → `accepted` | `rejected` | `expired` | `stale` | `rolled_back` (terminal). Enqueueing a non-active source is rejected: the thought must be persisted **and** `active`, because placement is the phase *after* a triage verdict activates a draft. The `triage_*` kinds are the deterministic draft-triage verdicts (ADR 2026-09-29): they mutate a *draft* source, require a `run_id`, and obey the per-run caps `triage.maxItemsPerRun` / `triage.maxArchivesPerRun`.

### GET /api/proposals

Lists queued proposals, newest first. Read-only; never applies anything. Defaults to live `pending` rows and drops `pending` rows whose `expires_at` has passed, so terminal/expired rows appear only when an explicit `state` is requested.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| state | query | string | pending | One of: `pending`, `accepted`, `rejected`, `expired`, `stale`, `rolled_back` |
| item_kind | query | string | optional | Item-kind filter: `edge`, `placement`, `lifecycle`, `triage_activate`, `triage_archive` |
| project_id | query | string | optional | Project scope |
| limit | query | int | 100 | Max rows (clamped to 1..1000) |

curl `'http://127.0.0.1:3005/api/proposals?state=pending'`

Response: `[{"id": "...", "project_id": "...", "source_thought_id": "...", "item_kind": "edge", "target_id": "...", "edge_type": "related", "lifecycle_action": null, "direction": "symmetric", "state": "pending", "confidence": 0.8, "rationale": "...", "rule_id": "...", "run_id": null, "created_at": "...", "expires_at": "...", "decided_at": null, "decided_by": null, "applied_at": null, "result": null}]`

Telemetry: `action: read`, tool `list_placement_proposals`.

### POST /api/proposals

Proposes a plan for a persisted thought and queues its confirmable items (plan shape in §Propose above). Returns 201 with the enqueued/refreshed rows, or `[]` when the plan has no confirmable item. Re-enqueueing the same item refreshes its live `pending` row instead of inserting a duplicate. 400 without `thought_id`, 404 for an unknown thought, 400 when the source thought is not `active`, and 400 when the queue already holds `placement.maxPendingProposals` live rows and the plan would add a new item. The cap covers the whole queue: draft-triage rows share it, so triage backs off (skips, never throws) once the queue is full.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| thought_id | body | string | required | Persisted **active** thought to analyse (drafts and other non-active statuses are rejected) |
| project_id | body | string | optional | Project scope |

curl `-d '{"thought_id": "<id>"}' http://127.0.0.1:3005/api/proposals`

Telemetry: `action: write`, tool `enqueue_placement_proposals`.

### POST /api/proposals/:id/apply

Applies exactly one queued item. `confirm` is the dry-run switch: absent or `false` validates the item and reports the writer call **without touching the graph or the queue** (the row stays `pending`); `true` executes **exactly one** existing writer inside the same transaction as the queue-state update. The stored target/type is used as-is — a proposal cannot be redirected. A triage item (`triage_activate`/`triage_archive`) additionally requires `run_id`, and when `triage.requireDryRunFirst` is set (default true) it must be previewed with `confirm: false` before a confirm is accepted. The per-run caps apply here exactly as they do to a batch, and only against a caller-supplied `run_id`: they are cumulative over that run's already-accepted rows, so confirming items one at a time under one id cannot exceed them. An un-enveloped non-triage apply is given its own synthesized single-row `auto-` envelope, which the cap arithmetic never sees, so such a row is counted against no run budget. 404 for an unknown id.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| confirm | body | bool | false | `true` executes the write; absent/`false` is a non-mutating dry-run |
| run_id | body | string | optional | Run envelope; required for `triage_activate`/`triage_archive` items. An un-enveloped `edge`/`placement`/`lifecycle` item is given a synthesized `auto-…` envelope instead (see **Run envelope** below) |

curl `-d '{"confirm": true}' http://127.0.0.1:3005/api/proposals/<id>/apply`

Response is a typed result, not a throw (only an unknown id errors):

| `status` | Meaning | Row after |
|---|---|---|
| `dry_run` | Non-mutating: `{"proposal_id", "item_kind", "status": "dry_run", "calls": [{"writer", "args"}]}` — the existing-writer call `confirm:true` would run | stays `pending` |
| `accepted` | Writer ran; `idempotent: true` when the requested state already held (no writer ran). Carries `calls[]`, `result` and the row's `run_id` envelope | `accepted` |
| `stale` | Refused: the item is no longer a live decision (TTL passed — re-enqueue it), or the snapshot no longer matches (fingerprint change, archived/deleted endpoint, conflicting edge, project split, or a cluster already at `placement.maxClusterSize`) | `stale` (terminal; must be re-proposed, never auto-repaired) |
| `failed` | Refused on a retryable precondition (e.g. profile merge, invalid edge type, cluster shape, a `triage_archive` row with no duplicate target) | stays `pending` (fix and retry) |
| `refused` | Typed `{"refusal": {"code", "reason"}}` guard refusal (e.g. `run_id_required`, `dry_run_required`, `max_items_exceeded`); nothing ran | stays `pending` |

Every apply re-checks the staleness fingerprint and the state-dependent gates (`placement.maxClusterSize`, project isolation) against the live graph. The TTL is checked first and applies to dry-runs too, so an overdue row can never be confirmed — nor recorded as an idempotent accept, which would put a phantom entry in a run's rollback manifest. A dry-run of an already `stale`/`failed` row returns that same status and still leaves the row unchanged. Telemetry: `action: write`, tool `apply_placement_proposal`.

**Run envelope (`run_id`).** Every row an apply accepts carries a run envelope, so a committed graph mutation is always reachable by `POST /api/proposals/rollback` with that id: the `accepted` result echoes it in `run_id` (`string | null`) and no second query is needed. The envelope is the caller's `run_id` verbatim, or — for an `edge`/`placement`/`lifecycle` item the caller left un-enveloped — one synthesized as `auto-` plus a UUIDv7. The `auto-` prefix is advisory, not a namespace: a caller-supplied id that happens to look like one works, and a synthesized id is accepted by `rollback` like any other. One id lands in four places — the row's `run_id` column (the rollback key), the stored `result` JSON, the `insertLog` context of the apply, and the response. Re-applying an already `accepted` row echoes the envelope the row was accepted under (`null` only when re-reading a row accepted before envelopes were recorded). Triage kinds are never synthesized: an un-enveloped `triage_activate`/`triage_archive` still comes back `refused` with `run_id_required`, because a triage run is a run the caller defines. A dry-run synthesizes nothing either, since a preview decides nothing. `apply_batch` mints **one** envelope for the whole batch — the batch *is* the run, so a single `rollback` reverts all of it — and returns it as the top-level `run_id`; that field is present only when at least one row actually joined the run and is absent when the batch accepted nothing that needs one (e.g. every item went `stale`). The operator's consequence: an apply made without a `run_id` is now rollback-addressable, but only inside the retention window below.

### POST /api/proposals/rollback

Rolls back every reversible mutation of one explicit run (ADR 2026-09-29 §2.8). `confirm` is the dry-run switch: absent or `false` reports what would be reverted (`items[]`, `summary`) **without mutating anything**; `true` inverts each `accepted` row of the run in reverse **application** order (`applied_at` descending, not enqueue order) through existing writers only (re-draft the triage source, delete the edge the run created) and marks it `rolled_back`. A `lifecycle` merge is refused (not auto-rollbackable) and a row whose fingerprint drifted since apply is skipped with a warning. No thought is ever deleted.

**Rollback window.** A row is only revertible while it is still retained. `rollback` refuses, per row, any accepted row whose `decided_at` is older than the window `now - placement.proposalTtlDays` days (default 30) — the same setting the retention job prunes the queue with, so the guard is the read-time backstop for a retention job that has not run yet. The bound is inclusive at the boundary: a row decided exactly at the cutoff still reverts, one millisecond earlier is refused. The window is checked **first**, so it outranks the other verdicts — a row that is both out of window and drifted (or a merge) is refused *for the window*, and that reason names the window width and the concrete cutoff. The guard fails closed: a row with no or unparseable `decided_at` is refused rather than reverted. The window is measured against the **server's** clock — the route reads only `run_id` and `confirm` from the body and the MCP action forwards only `confirm` plus the audit label, so no public surface accepts a `now`; the service option exists purely as an internal/test seam, and an unparseable value reaching it would be reported as a refusal instead of throwing. A negative `placement.proposalTtlDays` disables retention and therefore this guard, so nothing is ever out of window. A refused row is never deleted: it stays `accepted` with its graph state intact. Every non-revert verdict is announced once per row as a `placement` warning, but only on `confirm: true` — the default dry-run report logs nothing. Past the window the retention job prunes the row itself, so an out-of-window apply eventually stops appearing in `items[]` altogether; the refusal is what a caller sees while the row is still retained.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| run_id | body | string | required | Run envelope to reverse (400 when missing) |
| confirm | body | bool | false | `true` executes the inverse writes; absent/`false` is a non-mutating report |

curl `-d '{"run_id": "<run>", "confirm": true}' http://127.0.0.1:3005/api/proposals/rollback`

Telemetry: `action: write`, tool `rollback_placement_proposals`.

### POST /api/proposals/:id/reject

Rejects one live `pending` item (no graph write). Returns the updated row with `state: "rejected"`, `decided_at`, and `decided_by`. 404 for an unknown id; 400 if the row is not `pending` (terminal rows cannot be re-decided). Telemetry: `action: write`, tool `reject_placement_proposal`.

curl -X POST http://127.0.0.1:3005/api/proposals/<id>/reject

### memory_review (MCP)

MCP parity for the routes above, plus `apply_batch` (no HTTP equivalent).

| Action | Kind | Inputs | Result |
|---|---|---|---|
| `enqueue` | queue write | `thought_id` | Rows queued/refreshed for the thought |
| `list` | read | `state` (default `pending`), `item_kind`, `project_id`, `limit` | Queued rows |
| `apply` | graph write | `proposal_id`, `confirm` (default false), `run_id` (required for triage kinds) | One `ApplyResult` (`dry_run`/`accepted`/`stale`/`failed`/`refused`); an `accepted` result carries the row's `run_id` envelope (the caller's, or a synthesized `auto-…` for an un-enveloped non-triage item) |
| `apply_batch` | graph write | `proposal_ids[]` (non-empty), `confirm`, `run_id`, `limit` | `{"results": [ApplyResult], "errors": [{"proposal_id", "error"}]}`; each item applied independently, a partial batch is a valid outcome. When a run cap/`limit`/`run_id` guard trips, `{"results": [], "errors": [], "refused": {"code", "reason"}}` — the whole batch is refused, nothing applied. When at least one row joined the run, the outcome also carries the one shared `run_id` envelope — the caller's, or a synthesized `auto-…` for the whole batch (see **Run envelope** below) |
| `rollback` | graph write | `run_id`, `confirm` (default false) | `RollbackReport` (`run_id`, `confirm`, `items[]`, `summary`) |
| `reject` | queue write | `proposal_id` | Updated row (`state: "rejected"`) |

`enqueue` requires a persisted, `active` `thought_id`. `apply`/`apply_batch`/`rollback` default to a non-mutating dry-run and execute only on `confirm: true`. Triage applies require `run_id`, obey `triage.maxItemsPerRun`/`triage.maxArchivesPerRun` on the single-item `apply` path as well as on `apply_batch` (the caps are cumulative per **caller-supplied** `run_id`, so one-at-a-time confirms under one id cannot exceed them; an un-enveloped non-triage `apply`/`apply_batch` is handed a synthesized one-row `auto-` envelope instead and counts against no budget — the cap guards are evaluated for a declared run only), and — when `triage.requireDryRunFirst` (default true) — must be previewed before a confirm. `enqueue` and `reject` touch only the queue, never the graph; only `apply`/`apply_batch`/`rollback` call a writer. Apply is deliberately absent from every read tool — `memory_status` `propose`/`edge_suggestions` stay read-only, and `list` cannot reach `apply` (enforced by a static test in `src/mcp/tools/memory-review.contract.test.ts`). Both write surfaces share the same envelope and window rules as the HTTP routes above: an un-enveloped non-triage `apply`/`apply_batch` gets a synthesized `auto-…` `run_id` back so `rollback` can reach it without a second query, and that envelope reaches only the rows the call actually decided — a row that came back `stale`/`failed` joins no run, and a row that was already `accepted` keeps the envelope it was accepted under — while `rollback` refuses any row decided outside the `placement.proposalTtlDays` window.

## Projects

### GET /api/projects/

Lists all projects.

curl `http://127.0.0.1:3005/api/projects/`

Response: `[{"id": "...", "name": "synaptomind", "description": "...", "local_path": "/path", ...}]`

### GET /api/projects/resolve

Resolves a filesystem path to the matching project. 400 without `path`, 404 if none matches.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| path | query | string | required | Filesystem path |

curl `'http://127.0.0.1:3005/api/projects/resolve?path=/work/foo'`

Response: `{"id": "...", "name": "foo", "local_path": "/work/foo"}`

### POST /api/projects/

Creates a project. Returns 201; 400 on validation error.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| name | body | string | required | Project name |
| description | body | string | optional | Description |
| local_path | body | string | optional/null | Associated filesystem path |

curl `-d '{"name": "foo", "local_path": "/work/foo"}' http://127.0.0.1:3005/api/projects/`

### PATCH /api/projects/:id

Updates a project. All fields optional. 404 if missing. Returns `{"success": true}`.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| name | body | string | optional | New name |
| description | body | string | optional/null | New description |
| local_path | body | string | optional/null | New path |

curl `-d '{"description": "main repo"}' http://127.0.0.1:3005/api/projects/<id>`

### GET /api/projects/:id

Fetches a project. 404 if missing.

curl `http://127.0.0.1:3005/api/projects/<id>`

### DELETE /api/projects/:id

Deletes a project. 404 if missing. Returns `{"success": true}`.

curl `-X DELETE http://127.0.0.1:3005/api/projects/<id>`

## Primers

Primers are thoughts auto-injected at the top of search results (high-frequency hits).

### GET /api/primers/

Lists all primers.

curl `http://127.0.0.1:3005/api/primers/`

### DELETE /api/primers/:id

Deletes a primer. 404 if missing. Returns `{"success": true}`.

curl `-X DELETE http://127.0.0.1:3005/api/primers/<id>`

## Thought Verify

### POST /api/thought-verify/run

Runs the verify job (integrity checks over stored thoughts). 500 with `{"error": "Verify job failed", "ok": false}` on failure.

curl `-X POST http://127.0.0.1:3005/api/thought-verify/run`

Response: `{"ok": true, ...stats}`

## Settings

Also see docs/CONFIG.md for file/environment configuration.

### GET /api/thought-settings

Returns current thought content limits. `hardLimit` is derived from `softLimit` and `hardLimitBufferPercent` and is read-only.

curl `http://127.0.0.1:3005/api/thought-settings`

Response: `{"softLimit": 600, "hardLimit": 720, "hardLimitBufferPercent": 20}`

### PATCH /api/thought-settings

Sets thought content limits. At least one field is required. Returns the updated limits.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| softLimit | body | int | optional | Recommended content budget per thought, integer >= 1. At least one of `softLimit` or `hardLimitBufferPercent` is required |
| hardLimitBufferPercent | body | int | optional | Percent buffer added to the soft limit to derive the enforced hard ceiling, integer >= 1 |

The enforced hard ceiling is derived and read-only: `hardLimit = round(softLimit * (1 + hardLimitBufferPercent / 100))`. It is returned by GET and PATCH but cannot be set directly.

curl `-d '{"softLimit": 600, "hardLimitBufferPercent": 20}' http://127.0.0.1:3005/api/thought-settings`

### GET /api/embedder-settings

Returns local embedding model settings.

curl `http://127.0.0.1:3005/api/embedder-settings`

Response: `{"precache": true, "idleTimeoutMs": 300000}`

### PATCH /api/embedder-settings

Updates embedder settings; restarts the embedder if a value changed. At least one field required; 500 if the restart fails after saving.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| precache | body | bool | optional | Preload the model at startup |
| idleTimeoutMs | body | int | optional | Idle unload timeout, integer >= 1000 |

curl `-d '{"precache": true}' http://127.0.0.1:3005/api/embedder-settings`

## Stats

### GET /api/stats

Returns database statistics plus the DB file size on disk.

curl `http://127.0.0.1:3005/api/stats`

Response: `{"thoughts": 120, "edges": 45, ..., "db_size_bytes": 1048576}`

## Telemetry

All telemetry endpoints require `LOG_DB_PATH` to be configured; otherwise they return 503 `{"error": "LOG_DB_PATH not set"}`.

### GET /api/telemetry/patterns

Tool-usage sequences (tool transitions) observed in the telemetry log.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| window | query | int | 86400 (min 60) | Window in seconds |
| limit | query | int | 10 (clamped 1-50) | Max patterns |

curl `'http://127.0.0.1:3005/api/telemetry/patterns?window=3600&limit=5'`

Response: `{"window_secs": 3600, "limit": 5, "patterns": [{"sequence": "tool_a → tool_b", "prev_tool": "tool_a", "tool_name": "tool_b", "count": 7}]}`

### GET /api/telemetry/frequency

Aggregate call frequency by action.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| window | query | int | 86400 (min 3600) | Window in seconds |
| limit | query | int | 50 (clamped 1-100) | Max action rows |

curl `http://127.0.0.1:3005/api/telemetry/frequency`

Response: `{"window_secs": 86400, "total_calls": 320, "per_hour": 13.3, "by_action": {"read": 200, "write": 120}}`

### GET /api/telemetry/orphan_writes

Detailed list of orphaned thought writes (writes with no follow-up linkage).

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| window | query | int | 86400 (min 3600) | Window in seconds |
| limit | query | int | 100 (clamped 1-500) | Max rows |

curl `http://127.0.0.1:3005/api/telemetry/orphan_writes`

Response: `{"window_secs": 86400, "count": 1, "writes": [{"id": "...", "tool_name": "...", "prev_tool": "...", "thought_id": "...", "created_at": "..."}]}`

### GET /api/telemetry/draft_lifecycle

Draft thought lifecycle aggregates.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| window | query | int | 2592000 (min 86400) | Window in seconds |

curl `http://127.0.0.1:3005/api/telemetry/draft_lifecycle`

Response: `{"window_secs": 2592000, ...lifecycle}`

## Profile

### GET /api/profile/thoughts

Returns thoughts marked as profile (`is_profile`).

curl `http://127.0.0.1:3005/api/profile/thoughts`

### GET /api/profile/stats

Returns profile statistics.

curl `http://127.0.0.1:3005/api/profile/stats`

### POST /api/profile/summarize

Generates a profile summary from profile thoughts.

curl `-X POST http://127.0.0.1:3005/api/profile/summarize`

## Slots

Named context slots (persona, pending items, decisions, etc.).

### GET /api/slots/

Returns context slots.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | query | string | optional | Scope to a project |
| names | query | string | optional | Comma-separated slot names filter |

curl `'http://127.0.0.1:3005/api/slots/?names=persona,pending_items'`

Response: `{"slots": [{"name": "persona", "content": "...", ...}]}`

`pending_items` is virtual: it is built from the same due `pending` candidates the frontier surfaces.

### PUT /api/slots/:name

Creates or updates a slot. All body fields optional; `content` defaults to empty string. 400/404 on validation/not-found errors.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| name | path | string | required | Slot name |
| content | body | string | optional | Slot content |
| max_chars | body | int | optional | Content cap (server default applies when omitted) |
| scope | body | string | optional | `project` or `global` |
| project_id | body | string | optional | Project scope |

curl `-d '{"content": "Prefers concise answers", "scope": "global"}' http://127.0.0.1:3005/api/slots/persona`

### POST /api/slots/reflect

Records a session outcome: appends a summary, adjusts goals, creates decision and pending thoughts.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | body | string | optional/null | Project scope |
| summary | body | string | optional | Session summary |
| goals_delta | body | string[] | optional | Goals to add; prefix `closed:` to remove |
| decisions | body | string[] | optional | Decisions made — each created as an active thought tagged `decision` |
| pending | body | string[] | optional | Pending tasks — each created as a draft thought tagged `pending` |
| wake_days | body | int | optional | Days before the newly created `pending` thoughts join the frontier (default 7, 1-365) |

curl `-d '{"summary": "Added API docs", "decisions": ["Use manual API reference"]}' http://127.0.0.1:3005/api/slots/reflect`

Response: `{"ok": true, "applied": {"summary_appended": true, "goals_added": 0, "goals_removed": 0, "decisions_created": 1, "pending_created": 0}}`

`pending` items are stored with `surface_after = now + wake_days`; they enter the frontier (reason `pending`) and the `pending_items` slot once due, and stay drafts until the agent activates or archives them.

## Crystals

### POST /api/crystals/

Compresses selected thoughts (or a cluster) into a single markdown "crystal" thought. 400 on validation error.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| thought_ids | body | string[] | optional | Thoughts to crystallize |
| cluster_id | body | string | optional | Crystallize a whole cluster |
| style | body | string | optional | `runbook`, `decision-log`, or `overview` |
| project_id | body | string | optional | Project scope |

curl `-d '{"thought_ids": ["<id1>", "<id2>"], "style": "overview"}' http://127.0.0.1:3005/api/crystals/`

Response: `{"crystal_id": "...", "content": "## Context\n...", "style": "overview", "members_used": 2}`

## Frontier

### GET /api/frontier/

Ranks candidate thoughts by "what to work on next". Candidates are `directive`/`todo`/`pending`-tagged thoughts in status active or draft (non-cluster); replaced thoughts are dropped and `depends_on` upstreams block their dependents.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | query | string | optional | Scope to a project |
| k | query | int | 10 (clamped 1-50) | Max items |

curl `'http://127.0.0.1:3005/api/frontier/?k=3'`

Response: `{"items": [{"thought_id": "...", "content_short": "...", "reason": "directive", "priority": 0.65, "blocked_by": []}]}`

`reason` is `directive` for `directive`/`todo` thoughts and `pending` for `pending` thoughts. `priority` is `min(1, 0.5·importance + 0.15·unblocked + age bonus)`, where the unblocked bonus is dropped when `blocked_by` is non-empty and the age bonus is `+0.1` (age ≤ 7d), `+0.05` (≤ 30d), else `0`. `blocked_by` lists the `depends_on` upstream thought ids.

## Auto-cluster

### POST /api/auto-cluster/trigger

Runs the auto-clustering job over active thoughts. 500 on job failure.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| min_age_days | body | number | optional | Only cluster thoughts older than this |
| min_similarity | body | number | optional | Similarity threshold |
| min_members | body | number | optional | Minimum cluster size |
| dry_run | body | bool | optional | Compute without writing |

curl `-d '{"dry_run": true, "min_similarity": 0.8}' http://127.0.0.1:3005/api/auto-cluster/trigger`

### GET /api/auto-cluster/status

Returns the result of the last auto-cluster run, or `{"last_run": null, "result": null}` if none.

curl `http://127.0.0.1:3005/api/auto-cluster/status`

## Health

### GET /api/health-check

Graph health audit: broken links, orphans, duplicates, structural issues. Requires auth (it lives under `/api/*`).

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| severity | query | string | optional | Minimum severity: `critical`, `warning`, or `info` |
| fix | query | bool | false | `true` auto-fixes safe issues |

curl `'http://127.0.0.1:3005/api/health-check?severity=warning'`

#### Accepted graph-health trade-offs

Two checks fire by design on a dense, hub-centric graph and are accepted as trade-offs rather than defects (ADR: `ai-workdir/synaptomind/plans/2026-09-28-928-health-overlinked-clusterless-adr.md`; tasks #934/#935):

- `overlinked_thoughts` (connectivity, warning) — active non-cluster thoughts above the finder's `maxEdges`. The flagged set is curated cross-domain hubs, not link decay: on the reference dataset active non-cluster thoughts average 4.66 edges, while the 31 flagged hubs sit at 11–24. Raising the threshold cannot change `health_score` and would only hide signal.
- `clusterless_dense_thoughts` (cluster health, warning) — transient. The finder is age-gated to the same `autoCluster.minAgeDays` window auto-cluster uses (task #935), so it reports only thoughts old enough for the clusterer to act on (see `src/db/health-check/clusters.ts`).
- `health_score` penalises the presence of a flagged *category*, not occurrence counts: `100 − criticalCategories×40 − warningCategories×15 − infoOccurrences×0.25`, clamped to `[0,100]`. Because the `info` term is per-occurrence, a large `island_thoughts` count dominates the score, while clearing a single `overlinked_thoughts` hub does not move it (`src/services/health-check.service.ts`).

### GET /health

Public liveness/readiness probe (no auth). Returns 200 when healthy, 503 when degraded. Degradation is DB-only by design: embedder readiness is reported but not counted, so long model downloads during startup do not fail the Docker healthcheck.

curl `http://127.0.0.1:3005/health`

Response: `{"status": "ok", "version": "0.8.0-beta.2", "checks": {"database": "ok", "embedder": "ok"}}`

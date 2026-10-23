# HTTP API Reference

REST API served by the SynaptoMind HTTP server. Default base URL: `http://127.0.0.1:3005` (configurable, see docs/CONFIG.md). Package version at time of writing: **0.15.0**.

This page documents the mounted surface only; removals between releases are recorded in
[CHANGELOG.md](../CHANGELOG.md).

- **Auth:** all `/api/*` endpoints require `Authorization: Bearer <token>` (401 otherwise). The token is set via the `SYNAPTOMIND_SECRET` or `SYNAPTOMIND_SERVICE_TOKEN` environment variable. `GET /health` is the only public endpoint.
- **Body limit:** request bodies over 5 MB are rejected with `413`.
- **Errors:** handlers return `{"error": "..."}` with an appropriate HTTP status (400 validation, 401 auth, 404 not found, 409 conflict, 413 too large, 500 job failure).
- **Thought object:** `id, content, status (draft|active|archived), tags: [{id, name}], source, project_id, project_name?, is_cluster, is_protected, is_global, created_at, updated_at, archived_at`.
- Curls are abbreviated: GET examples omit `-H "Authorization: Bearer $TOKEN"`; mutating examples additionally use `-X POST/PUT/PATCH/DELETE`, `-H "Content-Type: application/json"`, and `-d '<json>'`.

## Thoughts

### GET /api/thoughts/search

Hybrid (vector + FTS5) search over thoughts. Results can be grouped by cluster and are post-processed to hoist primers to the front.

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
| hybrid | query | bool | true | `0` disables hybrid search |
| recency_weight | query | float | 0 | Opt-in recency boost weight (0-1); `0` preserves relevance-only ranking, `>0` adds `recency_weight × 0.5^(ageDays/recency_half_life_days)` |
| recency_half_life_days | query | int | 30 | Recency decay half-life in days (clamped 1-3650); only meaningful when `recency_weight > 0` |
| min_relevance | query | float | 0 | Opt-in relevance gate (0-1); with `>0` only strong matches are kept (BM25, or vector with `similarity >= min_relevance`) |
| supersession_mode | query | string | suppress | Superseded thoughts: `off` (no annotation), `flag` (annotate), `suppress` (drop) |
| contradiction_mode | query | string | flag | Contradicted thoughts: `off` or `flag`; never suppressed |

curl `'http://127.0.0.1:3005/api/thoughts/search?q=auth+middleware&k=3&supersession_mode=flag'`

Unknown query parameters are ignored: `exclude_flagged` in particular is an ordinary
ignored parameter (no 400), and search never filters on it. Graph standing filters apply
independently.

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

### GET /api/thoughts/timeline

Lists thoughts with pagination and filters.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| status | query | string | optional | Status filter (draft/active/archived) |
| project_id | query | string | optional | Project filter |
| tag | query | string | optional | Comma-separated tag filter |
| limit | query | int | 50 (1-500) | Max thoughts |
| offset | query | int | 0 | Pagination offset |

curl `'http://127.0.0.1:3005/api/thoughts/timeline?limit=5&status=active'`

Response: `[{"id": "...", "content": "...", "status": "active", ...}]`

### POST /api/thoughts

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
| is_protected | body | bool | optional | Protect from auto-deletion |

curl `-d '{"content": "Deploy script uses bun", "tags": ["fact"]}' http://127.0.0.1:3005/api/thoughts`

### POST /api/thoughts/bulk

Creates up to 10000 thoughts in a single transaction; per-item failures are reported without aborting the batch. Returns 201.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| thoughts | body | array | required | Items with the same fields as POST /api/thoughts plus per-item `project_id`, `parent_id`, `relation` (max 10000) |
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
| tags | body | string[] | optional | Replacement tag set (default replace; pass tags_mode=merge to union with existing tags) |
| tags_mode | body | string | optional | `replace` (default) or `merge`: how `tags` is applied |
| status | body | string | optional | draft/active/archived |
| project_id | body | string | optional | Move to project |
| is_protected | body | bool | optional | Protection flag |

curl `-d '{"status": "archived"}' http://127.0.0.1:3005/api/thoughts/<id>`

### DELETE /api/thoughts/:id

Archives a thought (soft delete). Idempotent: archiving an already-archived thought returns it unchanged. Returns the archived thought.

Deletion of archived thoughts is handled by the retention-review process (the sole deletion path); there is no TTL-based cleanup of thoughts. This is separate from the scheduled placement-proposal retention job, which expires and prunes proposal-queue rows (see [Review](#review)).

curl `-X DELETE http://127.0.0.1:3005/api/thoughts/<id>`

## Retention review

Retention review is a manual workflow, not a scheduled deletion policy. Candidate
listing includes archived or draft, non-global thoughts that meet the age and
importance thresholds, have no recorded hits, are not protected, are due to surface,
and have no incoming edge from an active thought. Missing importance defaults to
`1.0`; missing hit count defaults to `0`. The age anchor is `archived_at`, falling
back to `created_at`. Defaults are configured by `retentionReview.*` (see
[CONFIG.md](CONFIG.md#retention-review)).

### GET /api/thoughts/retention-review

Lists candidates ordered by age anchor (oldest first), then id. Response contains
`total`, `limit`, `offset`, and `candidates`; candidate content is truncated to 200
characters.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| minAgeDays | query | number | config | Minimum age in days (positive) |
| importanceFloor | query | number | config | Candidate importance must be below this value (0–1) |
| limit | query | int | config | Page size (1–100) |
| offset | query | int | 0 | Pagination offset |

### POST /api/thoughts/:id/retention-review/protect

Protects a thought from retention-review deletion. No request body is required.

### POST /api/thoughts/:id/retention-review/delete

Preview-first hard deletion. The body is `{"confirm": true}` to execute; omitted or
false returns a preview without deleting. An ineligible or no-longer-eligible thought
is refused.

### POST /api/thoughts/retention-review/compact

Preview-first compaction of candidates into a summary thought. Supply a non-empty
`source_ids` array and `summary` object (`content` required; `tags` and `project_id`
optional). Set `confirm: true` to execute; omitted or false previews the operation.

The index migration adds `idx_thoughts_status_protected_created`,
`idx_thoughts_status_protected_archived`, and
`idx_thought_importance_importance_hit` to support candidate lookup.

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

Executed response: `{"target": {...}, "transferredEdges": 2}` — `transferredEdges` counts the
source edges the target now holds (dropped self-loops and duplicate non-symmetric edges are not
counted). The MCP `memory_supersede` `action=merge` reports the same number as `edges_transferred`.

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
- `lifecycle` — `{"action": "keep" | "link" | "merge" | "replaces+archive", "confidence", "rationale", "review_required", "blocked_by[]"}`. `blocked_by` lists the reasons a proposed move cannot be confirmed (e.g. `"source is archived"`).
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

## Tags

### GET /api/tags

Lists all tags, optionally filtered by substring.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| q | query | string | optional | Substring filter |

curl `'http://127.0.0.1:3005/api/tags?q=dec'`

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

Returns the full thought graph (nodes + edges) for visualization or traversal. 400 on invalid `status` or out-of-range `limit`.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | query | string | optional | Project filter |
| status | query | string | active | One of: `active`, `draft`, `archived`, `all` |
| limit | query | int | 500 (1-2000; 400 outside) | Max nodes |

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

The persisted placement-proposal queue. `POST /api/thoughts/propose` is read-only and persists nothing; the review queue stores its confirmable items so a reviewer can apply or reject them one at a time. The queue never re-runs the engine and never auto-applies: an apply is an explicit, per-item write gated by `confirm:true`. MCP parity uses the renamed `edge_review` tool (actions `enqueue`/`list`/`apply`/`apply_batch`/`rollback`/`reject`); only `apply`/`apply_batch`/`rollback` execute a graph write, and no read tool can reach them. Thought retention actions are exposed separately as `retention_review`.

A queued item carries an `item_kind` and a `state`: `pending` (live) → `accepted` | `rejected` | `expired` | `stale` | `rolled_back` (terminal). `edge` is the only kind the queue creates: a plan's `placement` and `lifecycle` items are not queued, and the enqueue response reports them as skipped. Rows of a retired kind (`placement`, `lifecycle`, `triage_activate`, `triage_archive`) may still exist in an upgraded install — they stay listable and filterable, but neither `apply` nor `rollback` can act on them. Enqueueing a non-active source is rejected: the thought must be persisted **and** `active`.

### GET /api/proposals

Lists queued proposals, newest first. Read-only; never applies anything. Defaults to live `pending` rows and drops `pending` rows whose `expires_at` has passed, so terminal/expired rows appear only when an explicit `state` is requested.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| state | query | string | pending | One of: `pending`, `accepted`, `rejected`, `expired`, `stale`, `rolled_back` |
| item_kind | query | string | optional | Item-kind filter: `edge`, `placement`, `lifecycle`, `triage_activate`, `triage_archive` (the last four match legacy rows only) |
| project_id | query | string | optional | Project scope |
| limit | query | int | 100 | Max rows (1-1000; 400 outside) |

curl `'http://127.0.0.1:3005/api/proposals?state=pending'`

Response: `[{"id": "...", "project_id": "...", "source_thought_id": "...", "item_kind": "edge", "target_id": "...", "edge_type": "related", "lifecycle_action": null, "direction": "symmetric", "state": "pending", "confidence": 0.8, "rationale": "...", "rule_id": "...", "run_id": null, "created_at": "...", "expires_at": "...", "decided_at": null, "decided_by": null, "applied_at": null, "result": null}]`

### POST /api/proposals

Proposes a plan for a persisted thought and queues its confirmable items (plan shape in §Propose above). Returns **201** with an object, not an array:

```json
{ "proposals": [ /* queued/refreshed rows */ ], "skipped": 2, "skipped_kinds": { "placement": 1, "lifecycle": 1 } }
```

`proposals` holds the `edge` items the queue accepted; `skipped` counts the plan items whose kind the queue no longer stores, broken down per kind in `skipped_kinds` (absent kinds are not listed), so nothing is dropped silently. Re-enqueueing the same item refreshes its live `pending` row instead of inserting a duplicate. 400 without `thought_id`, 404 for an unknown thought, 400 when the source thought is not `active`, and 400 when the queue already holds `placement.maxPendingProposals` live rows and the plan would add a new item.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| thought_id | body | string | required | Persisted **active** thought to analyse (drafts and other non-active statuses are rejected) |
| project_id | body | string | optional | Project scope |
| max_proposals | body | int | `placement.maxProposalsPerEnqueue` | Cap on the proposals generated for this thought |

curl `-d '{"thought_id": "<id>"}' http://127.0.0.1:3005/api/proposals`

### POST /api/proposals/:id/apply

Applies exactly one queued item. `confirm` is the dry-run switch: absent or `false` validates the item and reports the writer call **without touching the graph or the queue** (the row stays `pending`); `true` executes **exactly one** existing writer inside the same transaction as the queue-state update. The stored target/type is used as-is — a proposal cannot be redirected. An apply is given its own synthesized `auto-` envelope unless the caller supplies one, so it is always rollback-addressable (see **Run envelope** below). 404 for an unknown id.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| confirm | body | bool | false | `true` executes the write; absent/`false` is a non-mutating dry-run |
| run_id | body | string | optional | Run envelope to record on every row this call accepts; omitted → a synthesized `auto-…` envelope (see **Run envelope** below) |

curl `-d '{"confirm": true}' http://127.0.0.1:3005/api/proposals/<id>/apply`

Response is a typed result, not a throw (only an unknown id errors):

| `status` | Meaning | Row after |
|---|---|---|
| `dry_run` | Non-mutating: `{"proposal_id", "item_kind", "status": "dry_run", "calls": [{"writer", "args"}]}` — the existing-writer call `confirm:true` would run | stays `pending` |
| `accepted` | Writer ran; `idempotent: true` when the requested state already held (no writer ran). Carries `calls[]`, `result` and the row's `run_id` envelope | `accepted` |
| `stale` | Refused: the item is no longer a live decision (TTL passed — re-enqueue it), or the snapshot no longer matches (fingerprint change, archived/deleted endpoint, conflicting edge, project split, source/target not `active`, or a cluster already at `placement.maxClusterSize`) | `stale` (terminal; must be re-proposed, never auto-repaired) |
| `failed` | Refused on a retryable precondition (e.g. invalid edge type, source is not a cluster thought) | stays `pending` (fix and retry) |
| `refused` | Typed `{"refusal": {"code", "reason"}}` guard refusal; nothing ran. `unsupported_item_kind` is the one code on this path: the row's kind is no longer stored by the queue | stays `pending` |

Every apply re-checks the staleness fingerprint and the state-dependent gates (`placement.maxClusterSize`, project isolation) against the live graph. The TTL is checked first and applies to dry-runs too, so an overdue row can never be confirmed — nor recorded as an idempotent accept, which would put a phantom entry in a run's rollback manifest. A dry-run of an already `stale`/`failed` row returns that same status and still leaves the row unchanged.

**Run envelope (`run_id`).** Every row an apply accepts carries a run envelope, so a committed graph mutation is always reachable by `POST /api/proposals/rollback` with that id: the `accepted` result echoes it in `run_id` (`string | null`) and no second query is needed. The envelope is the caller's `run_id` verbatim, or one synthesized as `auto-` plus a UUIDv7. The `auto-` prefix is advisory, not a namespace: a caller-supplied id that happens to look like one works, and a synthesized id is accepted by `rollback` like any other. One id lands in four places — the row's `run_id` column (the rollback key), the stored `result` JSON, the `insertLog` context of the apply, and the response. Re-applying an already `accepted` row echoes the envelope the row was accepted under (`null` only when re-reading a row accepted before envelopes were recorded). A dry-run synthesizes nothing, since a preview decides nothing. `apply_batch` mints **one** envelope for the whole batch — the batch *is* the run, so a single `rollback` reverts all of it — and returns it as the top-level `run_id`; that field is present only when at least one row actually joined the run and is absent when the batch accepted nothing that needs one (e.g. every item went `stale`). The operator's consequence: an apply made without a `run_id` is rollback-addressable, but only inside the retention window below.

### POST /api/proposals/rollback

Rolls back every reversible mutation of one explicit run (ADR 2026-09-29 §2.8). `confirm` is the dry-run switch: absent or `false` reports what would be reverted (`items[]`, `summary`) **without mutating anything**; `true` inverts each `accepted` row of the run in reverse **application** order (`applied_at` descending, not enqueue order) through existing writers only (delete the edge the run created) and marks it `rolled_back`. Three verdicts are not reverted: a row of a retired kind is `refused` (no inverse writer survives), an accept that was `idempotent` is `skipped` (nothing was written), and a row whose fingerprint drifted since apply is `skipped` with a warning. No thought is ever deleted.

**Proposal expiry, pruning, and rollback window.** The scheduled placement-retention job runs daily. It marks `pending` proposal rows expired after their `expires_at` and prunes terminal queue rows whose `decided_at` is older than the `placement.proposalTtlDays` cutoff. This job only changes proposal-queue records; it does not delete thoughts. Independently, `rollback` refuses, per row, any accepted row whose `decided_at` is older than `now - placement.proposalTtlDays` days (default 30). The bound is inclusive at the boundary: a row decided exactly at the cutoff still reverts, one millisecond earlier is refused. The window is checked first; the guard fails closed for missing or unparseable `decided_at`. The window uses the server clock; no public surface accepts a caller-supplied `now`. A negative `placement.proposalTtlDays` disables the job and this guard. A refused row stays `accepted` with its graph state intact until proposal retention prunes it. Every non-revert verdict is announced once per row as a `placement` warning only on `confirm: true`; the default dry-run report logs nothing.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| run_id | body | string | required | Run envelope to reverse (400 when missing) |
| confirm | body | bool | false | `true` executes the inverse writes; absent/`false` is a non-mutating report |

curl `-d '{"run_id": "<run>", "confirm": true}' http://127.0.0.1:3005/api/proposals/rollback`

### POST /api/proposals/:id/reject

Rejects one live `pending` item (no graph write). Returns the updated row with `state: "rejected"`, `decided_at`, and `decided_by`. 404 for an unknown id; 400 if the row is not `pending` (terminal rows cannot be re-decided).

curl -X POST http://127.0.0.1:3005/api/proposals/<id>/reject

### edge_review (MCP)

MCP parity for the routes above, plus `apply_batch` (no HTTP equivalent).

| Action | Kind | Inputs | Result |
|---|---|---|---|
| `enqueue` | queue write | `thought_id`, `max_proposals` | `{proposals, skipped, skipped_kinds}` — the queued/refreshed `edge` rows plus the plan items whose kind is no longer stored; retired `max_items` and `limit` inputs return 400 with a hint to use `max_proposals` |
| `list` | read | `state` (default `pending`), `item_kind`, `project_id`, `limit`, `source_thought_id`, `created_after` | Queued rows |
| `apply` | graph write | `proposal_id`, `confirm` (default false), `run_id` | One `ApplyResult` (`dry_run`/`accepted`/`stale`/`failed`/`refused`); an `accepted` result carries the row's `run_id` envelope (the caller's, or a synthesized `auto-…`) |
| `apply_batch` | graph write | `proposal_ids[]` (non-empty), `confirm`, `run_id`, `limit` | `{"results": [ApplyResult], "errors": [{"proposal_id", "error"}]}`; each item applied independently, a partial batch is a valid outcome. When the per-call `limit` trips, `{"results": [], "errors": [], "refused": {"code": "limit_exceeded", "reason"}}` — the whole batch is refused, nothing applied. When at least one row joined the run, the outcome also carries the one shared `run_id` envelope — the caller's, or a synthesized `auto-…` for the whole batch (see **Run envelope** above) |
| `rollback` | graph write | `run_id`, `confirm` (default false) | `RollbackReport` (`run_id`, `confirm`, `items[]`, `summary`) |
| `reject` | queue write | `proposal_id` | Updated row (`state: "rejected"`) |

`enqueue` requires a persisted, `active` `thought_id`. `apply`/`apply_batch`/`rollback` default to a non-mutating dry-run and execute only on `confirm: true`. `enqueue` and `reject` touch only the queue, never the graph; only `apply`/`apply_batch`/`rollback` call a writer. Apply is deliberately absent from every read tool — `memory_status` `propose` stays read-only, and `list` cannot reach `apply` (enforced by a static test in `src/mcp/tools/edge-review.contract.test.ts`). Both write surfaces share the same envelope and window rules as the HTTP routes above: an un-enveloped `apply`/`apply_batch` gets a synthesized `auto-…` `run_id` back so `rollback` can reach it without a second query, and that envelope reaches only the rows the call actually decided — a row that came back `stale`/`failed` joins no run, and a row that was already `accepted` keeps the envelope it was accepted under — while `rollback` refuses any row decided outside the `placement.proposalTtlDays` window.

## Projects

### GET /api/projects

Lists all projects.

curl `http://127.0.0.1:3005/api/projects`

Response: `[{"id": "...", "name": "synaptomind", "description": "...", "local_path": "/path", ...}]`

### GET /api/projects/resolve

Resolves a filesystem path to the matching project. 400 without `path`, 404 if none matches.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| path | query | string | required | Filesystem path |

curl `'http://127.0.0.1:3005/api/projects/resolve?path=/work/foo'`

Response: `{"id": "...", "name": "foo", "local_path": "/work/foo"}`

### POST /api/projects

Creates a project. Returns 201; 400 on validation error.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| name | body | string | required | Project name |
| description | body | string | optional | Description |
| local_path | body | string | optional/null | Associated filesystem path |

curl `-d '{"name": "foo", "local_path": "/work/foo"}' http://127.0.0.1:3005/api/projects`

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

### GET /api/primers

Lists all primers.

curl `http://127.0.0.1:3005/api/primers`

### DELETE /api/primers/:id

Deletes a primer. 404 if missing. Returns `{"success": true}`.

curl `-X DELETE http://127.0.0.1:3005/api/primers/<id>`

## Slots

Named context slots. Four names survive: `pending_items` and `architecture_decisions` are
composed on every read (virtual, never stored), `project_context` and `active_goals` are
stored rows. Any other name is not a slot: `GET /api/slots` simply omits it, and
`PUT /api/slots/<name>` is refused with 400 — only `project_context` and `active_goals`
are writable.

### GET /api/slots

Returns context slots.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | query | string | optional | Scope to a project |
| names | query | string | optional | Comma-separated slot names filter |
| limit | query | int | optional | Max items for `pending_items` (1-1000); paginates the pending list |
| offset | query | int | 0 | Offset for `pending_items` pagination |

curl `'http://127.0.0.1:3005/api/slots?names=pending_items,active_goals'`

Response: `{"slots": [{"name": "pending_items", "content": "...", ...}]}`

`pending_items` is virtual: it is built from the same due `pending` candidates the frontier
surfaces. `architecture_decisions` is virtual too, rendered from the top `primer.topN`
primers.

Truncation: every slot's `content` is capped at `max_chars` (default `slots.defaultMaxChars`, 2000; hard limit 20000). When the stored/composed content exceeds the cap it is sliced to `max_chars` and `truncated: true` is set; the remainder is dropped from that response. Use `limit`/`offset` on `pending_items` to page through long queues without losing entries to the char cap. Explicit slots may raise their cap via `max_chars` on `PUT`.

### PUT /api/slots/:name

Creates or updates a slot. All body fields optional; `content` defaults to empty string.
400 for a name that is not one of the two writable slots (a virtual slot such as
`pending_items` is read-only, an unknown name is not a slot at all), for an invalid
`max_chars`, and for `scope: "project"` without a `project_id`; 404 for an unknown
project.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| name | path | string | required | Slot name: `project_context` or `active_goals` |
| content | body | string | optional | Slot content |
| max_chars | body | int | optional | Content cap, integer 100-8000 (server default applies when omitted) |
| scope | body | string | optional | `project` or `global` |
| project_id | body | string | optional | Project scope; required when `scope` is `project` |

curl `-d '{"content": "Prefers concise answers", "scope": "global"}' http://127.0.0.1:3005/api/slots/project_context`

### POST /api/slots/reflect

Records a session outcome: appends a summary, adjusts goals, creates decision and pending thoughts.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | body | string | optional/null | Project scope |
| summary | body | string | optional | Session summary |
| goals_add | body | string[] | optional | Goals to add to `active_goals` |
| goals_remove | body | string[] | optional | Remove stored goal lines matching each supplied string case-insensitively by substring |
| decisions | body | string[] | optional | Decisions made — each created as an active thought tagged `decision` and `reflect` |
| pending | body | string[] | optional | Pending tasks — each created as a draft thought tagged `pending` and `reflect` |
| wake_days | body | int | optional | Days before the newly created `pending` thoughts join the frontier (default 7, 1-365) |

The retired `goals_delta` body field is rejected with HTTP 400; use `goals_add` and
`goals_remove` instead.

curl `-d '{"summary": "Added API docs", "decisions": ["Use manual API reference"]}' http://127.0.0.1:3005/api/slots/reflect`

Response: `{"ok": true, "applied": {"summary_appended": true, "goals_added": 0, "goals_removed": 0, "decisions_created": 1, "pending_created": 0}}`

`pending` items are stored with `surface_after = now + wake_days`; they enter the frontier (reason `pending`) and the `pending_items` slot once due, and stay drafts until the agent activates or archives them.

Every thought this endpoint creates carries the tag `reflect` in addition to its semantic tag
(`decision` / `pending`), so reflect output can be filtered (`GET /api/thoughts/timeline?tag=reflect`,
or `memory_recall` with `tag: "reflect"`) or cleaned up without touching hand-created thoughts. The
tag is additive: dedup, statuses and the scheduled surface time are unchanged.

## Frontier

### GET /api/frontier

Ranks candidate thoughts by "what to work on next". Candidates are `directive`/`todo`/`pending`-tagged thoughts in status active or draft (non-cluster); replaced thoughts are dropped and `depends_on` upstreams block their dependents.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | query | string | optional | Scope to a project |
| k | query | int | 10 (clamped 1-50) | Max items |

curl `'http://127.0.0.1:3005/api/frontier?k=3'`

Response: `{"items": [{"thought_id": "...", "content_short": "...", "reason": "directive", "priority": 0.65, "blocked_by": []}]}`

`reason` is `directive` for `directive`/`todo` thoughts and `pending` for `pending` thoughts. `priority` is `min(1, 0.5·importance + 0.15·unblocked + age bonus)`, where the unblocked bonus is dropped when `blocked_by` is non-empty and the age bonus is `+0.1` (age ≤ 7d), `+0.05` (≤ 30d), else `0`. `blocked_by` lists the `depends_on` upstream thought ids.

## No HTTP clustering trigger

Auto-clustering is MCP-only: `memory_crystallize action=auto_cluster` (without `confirm` or with
`confirm: false` for a preview; `confirm: true` executes) is the single entry point, tuned by the
`autoCluster.*` settings in [CONFIG.md](CONFIG.md). There is no HTTP route and no
scheduled job for it.

## Health

### GET /api/health-check

Graph health audit: broken links, orphans, duplicates, structural issues. Requires auth (it lives under `/api/*`).

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| severity | query | string | optional | Minimum severity: `critical`, `warning`, or `info` |
| fix | query | bool | false | `true` auto-fixes safe issues |

curl `'http://127.0.0.1:3005/api/health-check?severity=warning'`

#### Accepted graph-health trade-offs

The following graph-health behaviours are accepted trade-offs rather than defects (ADR: `synaptomind/adr/2026-09-28-928-health-overlinked-clusterless-adr.md`; tasks #934/#935):

- `overlinked_thoughts` (connectivity, warning) — active non-cluster thoughts above the finder's `maxEdges`. The flagged set is curated cross-domain hubs, not link decay: on the reference dataset active non-cluster thoughts average 4.66 edges, while the 31 flagged hubs sit at 11–24. Raising the threshold cannot change `health_score` and would only hide signal.
- `clusterless_dense_thoughts` (cluster health, warning) — transient. The finder is age-gated to the same `autoCluster.minAgeDays` window auto-cluster uses (task #935), so it reports only thoughts old enough for the clusterer to act on (see `src/db/health-check/clusters.ts`).
- `health_score` penalises the presence of a flagged *category*, not occurrence counts: `100 − criticalCategories×40 − warningCategories×15 − scoredInfoOccurrences×0.25`, clamped to `[0,100]`. Because the `info` term is per-occurrence, clearing a single `overlinked_thoughts` hub does not move it (`src/services/health-check.service.ts`).
- `island_thoughts` is an informational *coverage* finding and is exempt from the `info` term. Publishing a thought (`status: active`) before linking it makes it an island, so charging each island would score correct publishing as a regression and discourage it (task #1967). Islands stay visible in `summary.info` and in the `connectivity` category; `score_breakdown` reports the charged count as `info_scored_occurrences` and names the exempt findings in `info_unscored_checks`. Critical and warning categories are unaffected.

Findings about *live* claims deliberately ignore `archived` endpoints. Archiving only flips the `status` column — the edges stay attached (`src/db/thoughts.ts`) — and the documented supersession flow (link `replaces`, then archive the target) does not transfer them, so a retired endpoint would otherwise be flagged forever after a correct procedure:

- `contradiction_in_cluster` reports only when both contradicting cluster members are non-archived. Both-archived pairs remain visible as the `contradicts_to_archived` info finding (a cleanup candidate).
- `duplicate_content` likewise excludes archived on both sides (merge archives its source, so the pair would stay flagged).
- `broken_parent_chains` ignores edges whose *source* is archived, and reports live-source edges pointing at an `archived`/`draft` target — its autofix deletes the archived-target ones.

### GET /health

Public liveness/readiness probe (no auth). Returns 200 when healthy, 503 when degraded. Degradation is DB-only by design: embedder readiness is reported but not counted, so long model downloads during startup do not fail the Docker healthcheck.

curl `http://127.0.0.1:3005/health`

Response: `{"status": "ok", "version": "0.9.0", "checks": {"database": "ok", "embedder": "ok"}}`

# HTTP API Reference

REST API served by the SynaptoMind HTTP server. Default base URL: `http://127.0.0.1:3005` (configurable, see docs/CONFIG.md). Server version at time of writing: **0.6.0-beta.0**.

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

### GET /api/thoughts/entities

Lists entities (code, tags, wiki links, terms) extracted from thought content.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| type | query | string | optional | One of: `code`, `tag`, `wiki`, `term` |
| limit | query | int | 100 (clamped 1-500) | Max entities |

curl `'http://127.0.0.1:3005/api/thoughts/entities?type=tag&limit=5'`

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

Runs the auto-link job that creates edges from URL overlaps between thoughts.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| dry_run | body | bool | false | Compute without writing |
| max_edges | body | int | optional | Cap edges per run |

curl `-d '{"dry_run": true}' http://127.0.0.1:3005/api/thoughts/auto-link`

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

## Smart Notes

Smart notes re-surface a thought when a surface condition is met.

### GET /api/smart-notes/

Lists all smart notes with their readiness status.

curl `http://127.0.0.1:3005/api/smart-notes/`

Response: `[{"id": "...", "thought_id": "...", "surface_condition": {"type": "older_than_days", "days": 7}, "surface_checked_at": "...", "created_at": "...", "ready": false}]`

### POST /api/smart-notes/

Creates a smart note attached to an existing thought (cluster thoughts are rejected). Returns 201.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| thought_id | body | string | required | Target thought id |
| surface_condition | body | object | required | Condition object, see below |

Condition object: `type` must be one of `older_than_days`, `has_tag`, `has_edge_type`, `project_status`, `unread_for_days`. `days` (positive integer) is required for `older_than_days`, `project_status`, `unread_for_days`; non-empty `tag` for `has_tag`; non-empty `edge_type` for `has_edge_type`.

curl `-d '{"thought_id": "<id>", "surface_condition": {"type": "older_than_days", "days": 30}}' http://127.0.0.1:3005/api/smart-notes/`

### POST /api/smart-notes/eval

Evaluates all smart notes against their conditions.

curl `-X POST http://127.0.0.1:3005/api/smart-notes/eval`

### POST /api/smart-notes/awaken

Wakes (promotes to active) all notes whose conditions are ready.

curl `-X POST http://127.0.0.1:3005/api/smart-notes/awaken`

Response: `{"awakened": [{...}], "count": 2}`

### POST /api/smart-notes/:id/promote

Manually promotes a smart note's thought.

curl `-X POST http://127.0.0.1:3005/api/smart-notes/<id>/promote`

Response: `{"ok": true, "thought": {...}}`

### DELETE /api/smart-notes/:id

Deletes a smart note. Returns `{"success": true}`.

curl `-X DELETE http://127.0.0.1:3005/api/smart-notes/<id>`

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
| decisions | body | string[] | optional | Decisions made |
| pending | body | string[] | optional | Pending tasks |
| wake_days | body | int | optional | Days before pending items resurface |

curl `-d '{"summary": "Added API docs", "decisions": ["Use manual API reference"]}' http://127.0.0.1:3005/api/slots/reflect`

Response: `{"ok": true, "applied": {"summary_appended": true, "goals_added": 0, "goals_removed": 0, "decisions_created": 1, "pending_created": 0}}`

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

Ranks candidate thoughts by "what to work on next".

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| project_id | query | string | optional | Scope to a project |
| k | query | int | 10 (clamped 1-50) | Max items |

curl `'http://127.0.0.1:3005/api/frontier/?k=3'`

Response: `{"items": [{"thought": {...}, "score": 4.2, "reasons": [...]}]}`

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

### GET /health

Public liveness/readiness probe (no auth). Returns 200 when healthy, 503 when degraded. Degradation is DB-only by design: embedder readiness is reported but not counted, so long model downloads during startup do not fail the Docker healthcheck.

curl `http://127.0.0.1:3005/health`

Response: `{"status": "ok", "version": "0.6.0-beta.0", "checks": {"database": "ok", "embedder": "ok"}}`

# MCP Tools Reference

SynaptoMind exposes its graph operations as 10 MCP tools, over both the stdio and HTTP
transports. Each tool multiplexes several actions behind an `action` argument. This page is
the detailed companion to the in-band `memory_guide` tool (`src/mcp/tools/guide.ts`), which
returns a short quick map plus a pointer here at runtime.

For the HTTP equivalents, see [docs/API.md](API.md). For end-to-end usage, see
[docs/SCENARIOS.md](SCENARIOS.md). This page documents the current surface only; removals
between releases are recorded in [CHANGELOG.md](../CHANGELOG.md).

## Tool map

| Tool | Actions | Purpose |
|---|---|---|
| `memory_recall` | search, get, context, chain, clusters, list | Find and retrieve thoughts (list = paginated inventory) |
| `memory_store` | create, update, link, link_batch, unlink, retype | Write, connect and edit thoughts |
| `memory_supersede` | archive, archive_batch, merge | Version and supersede thoughts |
| `memory_status` | slots, frontier, config, health, propose, cleanup | Query system state |
| `memory_manage` | list, create, update, delete, resolve | Project management |
| `memory_review` | enqueue, list, apply, apply_batch, rollback, reject | Review and apply queued placement proposals |
| `memory_crystallize` | graph, cluster, auto_cluster | Visualize and reorganize clusters |
| `memory_reflect` | reflect, timeline | Session management |
| `memory_primers` | list, delete | Manage the always-at-hand set (primers) |
| `memory_guide` | (no action) | In-band reference text |

## Dry-run / confirm pattern

Every mutating action added for graph maintenance — `memory_store` `unlink` and `retype`,
plus `memory_review` (`apply`/`apply_batch`/`rollback`) and `memory_manage action=delete` —
follows the same two-step pattern:

- **Preview (default).** `confirm` is absent or `false`. The tool validates the target and
  returns a non-mutating preview with `status: "preview"` and a human-readable `consequence`.
  Nothing is written.
- **Execute.** `confirm: true` performs the write and returns a status-specific result.

## Result and error envelopes

Every tool declares the same output shape, `{ result: <payload> }` (`toolOutputShape`,
`src/mcp/tools/utils.ts:12`). A successful action returns that payload in `structuredContent.result`
mirroring the JSON in `content[].text` (`jsonResult`, `src/mcp/tools/utils.ts:14-19`).

An action failure returns `isError: true` with the human-readable message in `content[].text`. When
the failure carries a domain status code, the classification is additionally mirrored into
`structuredContent.result.error`:

```json
{
  "content": [{ "type": "text", "text": "Embedder request timed out" }],
  "structuredContent": {
    "result": {
      "error": { "message": "Embedder request timed out", "statusCode": 503, "retryable": true }
    }
  },
  "isError": true
}
```

- **Nesting.** The metadata sits under `result` — the key the declared output schema expects. The
  SDK client validates `structuredContent` against that schema whenever the key is present, so
  putting it anywhere else would fail the check (`src/mcp/tools/utils.ts:37-39`).
- **Classified vs unclassified.** Only errors exposing a numeric `statusCode` are enriched. A plain
  `Error` or a non-`Error` throw keeps the plain `{ content, isError }` shape with **no**
  `structuredContent` key (`src/mcp/tools/utils.ts:49-52`, `src/mcp/tools/action-tool.ts:99-108`).
- **Retryability.** `retryable` is `statusCode === 503`. The 503 class is the transient
  availability failures — embedder not ready, overloaded, timed out, send failure
  (`src/errors.ts`) — the only class safe to repeat as-is. Every other classified code
  (`400`, `404`, `409`) is reported `retryable: false` (`src/mcp/tools/action-tool.ts:107`).

A client should re-issue the identical request only when `retryable` is `true`; otherwise the
failure is a bad request and repeating it will not help.

## `memory_recall` — finding and retrieving thoughts

### `action=list`

Paginated inventory of thoughts without a search query. Use this to enumerate by status,
project, tag, or cluster flag — the tool that makes bulk triage and cleanup possible.

| Argument | Type | Required | Description |
|---|---|---|---|
| `status` | enum | no | `draft`, `active`, or `archived` |
| `project_id` | string | no | Restrict to one project |
| `tag` | string | no | Restrict to thoughts carrying this tag |
| `is_cluster` | boolean | no | `true` = only clusters, `false` = only non-clusters |
| `limit` | integer | no | Page size (1–500, default 50) |
| `offset` | integer | no | Skip this many rows (default 0) |

Result: `{ "thoughts": [ { "id", "content", "status", "tags", "project_id", "project_name", "is_cluster", "is_profile", "is_protected", "is_global", "created_at", "updated_at", ... } ], "total": 42, "limit": 50, "offset": 0 }`

`total` is the un-paged count matching the filters, so a caller can page with
`offset += limit` until `offset >= total`.

Example:

```json
{ "action": "list", "status": "draft", "limit": 50, "offset": 0 }
```

### `action=search`

Hybrid (RRF) / vector / BM25 search. Key arguments: `query` (required), `mode` (`hybrid`/`vector`/`bm25`),
`status`, `project`, `tag`, `cluster` (only/exclude), `min_importance`, `top_k`, `min_relevance`,
`recency_weight`, `recency_half_life_days`, `supersession_mode`, `contradiction_mode`.
Returns hits with `similarity`, `distance`, `match_source`, `low_confidence`.

### `action=get`

Fetch one thought by `thought_id` (full content, tags, project, importance, edges).

### `action=context` / `action=chain` / `action=clusters`

`context` returns a thought plus its neighbours up to `max_degree`; `chain` walks a parent/develops
chain; `clusters` lists cluster thoughts and their members.

## `memory_store` — edges

### `action=link`

Create an edge between two thoughts. A pair carries **one** edge: re-linking the same pair with
the same type is idempotent for the symmetric types (`related`, `contradicts`), while a directed
duplicate or a second, different type on the pair is reported as an error — except that a
`related` placeholder edge is upgraded in place to the specific type you ask for. Constraints: no
self-loops, and only a cluster thought may carry a `cluster` edge.

| Argument | Type | Required | Description |
|---|---|---|---|
| `thought_id` | string | one of the two | The source thought (canonical name) |
| `source_id` | string | one of the two | Alias for `thought_id` — the same spelling `memory_supersede action=merge` uses |
| `target_id` | string | yes | The target thought |
| `edge_type` | enum | no | One of `related`, `parent`, `develops`, `replaces`, `cluster`, `references`, `depends_on`, `contradicts`, `supports`; default `related` |

**Naming convention.** `source_id`/`target_id` name the pair in both writers: `memory_store`
`action=link` and `memory_supersede` `action=merge`. `link` accepts either `source_id` or the
legacy `thought_id` for the source side — the two names address the same thought, so an agent
that learned the merge spelling does not have to switch vocabularies. If both are supplied,
`source_id` wins. Existing `thought_id` calls are unchanged.

Example (either form is equivalent):

```json
{ "action": "link", "source_id": "thought-a", "target_id": "thought-b", "edge_type": "develops" }
```

```json
{ "action": "link", "thought_id": "thought-a", "target_id": "thought-b", "edge_type": "develops" }
```

### `action=link_batch`

Create up to 1000 edges in one call. The batch runs in a **single transaction** and reuses the
`link` writer, so every single-link rule (type vocabulary, no self-loops, one type per pair,
cluster strictness, the `related` upgrade) applies item by item. A failing item is collected
rather than aborting the batch: the accepted items still commit and the failure is reported.

| Argument | Type | Required | Description |
|---|---|---|---|
| `links` | `{source, target, type?}`[] | yes | Edges to create (1–1000 items); `type` defaults to `related` |
| `edge_type` | enum | no | Ignored — each item carries its own `type` |

Result: `{ "linked": 2, "failed": 1, "errors": [{ "index": 2, "source": "thought-c", "target": "thought-c", "error": "Self-loop edges are not allowed" }] }`

`linked` counts the accepted items (a repeated symmetric edge is an idempotent replay and counts
too) and `failed` always equals `errors.length`. An empty or over-long `links` array is refused
with an `isError` envelope before anything runs, so a batch is never applied as a silent prefix.

Example:

```json
{ "action": "link_batch", "links": [
  { "source": "thought-a", "target": "thought-b", "type": "supports" },
  { "source": "thought-a", "target": "thought-c" }
] }
```

### `action=unlink`

Delete a single edge by id. Deletion is **idempotent**: a missing edge is reported as
`not_found`, not an error. There is **no cascade** — only the edge row is removed; thoughts,
tags and other edges are untouched. The action is not project-scoped (`edge_id` is globally
unique), so no `cwd`/`project_id` is required.

| Argument | Type | Required | Description |
|---|---|---|---|
| `edge_id` | string | yes | The edge to delete |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = delete |

**Preview** (`confirm` absent/`false`):

```json
{
  "status": "preview",
  "edge_id": "edge-123",
  "edge": { "id": "edge-123", "source_id": "thought-a", "target_id": "thought-b", "type": "contradicts", "created_at": "2026-10-01T12:00:00.000Z" },
  "consequence": "Removes the 'contradicts' edge between 'thought-a' and 'thought-b'.",
  "instruction": "Call memory_store again with action=unlink, edge_id=edge-123, confirm=true to proceed."
}
```

A missing edge in preview returns `{ "status": "not_found", "edge_id": "edge-123" }`.

**Execute** (`confirm: true`): `{ "status": "deleted", "edge_id": "edge-123" }`, or
`{ "status": "not_found", "edge_id": "edge-123" }` if it was already gone.

Example:

```json
{ "action": "unlink", "edge_id": "edge-123", "confirm": true }
```

### `action=retype`

Change an edge's type in a single transaction. The original `created_at` is preserved. The
new type must be a valid edge type and satisfy the same cluster constraints as `link` (e.g.
only a cluster thought may carry a `cluster` edge).

| Argument | Type | Required | Description |
|---|---|---|---|
| `edge_id` | string | yes | The edge to retype |
| `new_type` | enum | yes | One of: `related`, `parent`, `develops`, `replaces`, `cluster`, `references`, `depends_on`, `contradicts`, `supports` |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = retype |

**Preview**: `{ "status": "preview", "edge_id": "edge-123", "old_type": "contradicts", "new_type": "supports", "source_id": "thought-a", "target_id": "thought-b", "consequence": "Changes edge type from 'contradicts' to 'supports'." }`

**Execute**: `{ "status": "retyped", "edge_id": "edge-123", "old_type": "contradicts", "new_type": "supports" }`

Errors return an [`isError` envelope](#result-and-error-envelopes): a non-existent edge
(`Edge not found`), retyping to the current type (`is already of type`), an invalid type, or a
cluster-constraint violation.

> **Id note.** Retype is a transactional delete + insert that carries `created_at` over, so
> the edge gets a **new id**. The response echoes the `edge_id` you passed — re-fetch the
> edge if you need its new id.

Example:

```json
{ "action": "retype", "edge_id": "edge-123", "new_type": "supports", "confirm": true }
```

## `memory_supersede` — archiving and merging

`action=archive` archives one thought (`thought_id`) and is idempotent: an already-archived
thought is returned unchanged rather than re-stamped. Profile thoughts are refused
(`Profile thoughts cannot be archived`).

### `action=archive_batch`

Archive up to 1000 thoughts in one call, in a **single transaction**. Same writer and same
guards as `archive`: already-archived thoughts count as archived without being re-stamped, and
profile thoughts fail per item instead of aborting the batch.

| Argument | Type | Required | Description |
|---|---|---|---|
| `thought_ids` | string[] | yes | Thoughts to archive (1–1000 items) |

Result: `{ "archived": 2, "failed": 1, "errors": [{ "thought_id": "missing-id", "error": "Thought 'missing-id' not found" }] }`

`failed` always equals `errors.length`; an unknown id or a profile thought lands in `errors`
while the other items commit. An empty or over-long array is refused with an `isError` envelope
before anything runs.

Example:

```json
{ "action": "archive_batch", "thought_ids": ["thought-a", "thought-b"] }
```

### `action=merge`

Consolidates a source thought into a target: the source's edges are recreated on the target,
the target's content/tags are replaced when supplied, the source is archived, and a `replaces`
edge target → source records the consolidation. Merging an archived source or a profile thought
is refused.

| Argument | Type | Required | Description |
|---|---|---|---|
| `source_id` | string | yes | Thought to merge away (archived by the merge) |
| `target_id` | string | yes | Thought that survives and receives the edges |
| `merged_content` | string | no | Resulting content of the target |
| `merged_tags` | string[] | no | Resulting tag set of the target |
| `project_id` | string | no | Resulting project (defaults to the target's, then the source's) |

Result: `{ "target": { ... }, "edges_transferred": 2 }` — `edges_transferred` is the number of
source edges the target now holds, so a caller can verify the consolidation. Not every source
edge contributes: one that would collapse into a self-loop (it joined the target to the source),
a duplicate of a non-symmetric edge the target already has, and a cluster edge the cluster rule
rejects are dropped and left out of the count. An existing symmetric pair (`related`,
`contradicts`) does count — the target owns that relation after the merge. The HTTP twin
(`POST /api/thoughts/:targetId/merge`) reports the same number under its long-standing name
`transferredEdges`.

```json
{ "action": "merge", "source_id": "thought-a", "target_id": "thought-b", "merged_content": "merged claim" }
```

## `memory_crystallize` — clusters

Three actions, all read-mostly: `graph` (nodes + edges for a project, `status` and `limit`
filters), `cluster` (create a cluster thought from `thought_ids` with an optional `title`
and `tags`), and `auto_cluster` (Union-Find grouping over active thoughts, tuned by the
`autoCluster.*` settings in [CONFIG.md](CONFIG.md) and previewable with `dry_run: true`;
`project_id`/`cwd` do not apply — the run is global).

## `memory_reflect` — session reflection

`action=reflect` is **not read-only**: it writes slots and thoughts.

- `summary` is appended (with a timestamp) to the `project_context` slot.
- `goals_delta` adds goals to `active_goals`; an entry prefixed with `closed:` removes a
  matching goal instead.
- `decisions` creates one **active** thought each, tagged `decision` + `reflect`. Entries
  sufficiently similar to an existing non-archived `decision` thought are skipped
  (Jaccard ≥ 0.6 on normalised text), so re-reflecting the same decision is a no-op.
- `pending` creates one **draft** thought each, tagged `pending` + `reflect`, with
  `surface_after = now + wake_days` (default 7, range 1–365). A pending thought is invisible
  to the frontier until that time, then surfaces with reason `pending` and in the
  `pending_items` slot.

Returns the applied counts:

```json
{ "summary_appended": true, "goals_added": 1, "goals_removed": 0, "decisions_created": 2, "pending_created": 1 }
```

The `reflect` tag marks **every** thought `reflect` created (next to the semantic tag), so the
output is identifiable and can be filtered (`memory_recall` with `tag: "reflect"`) or cleaned up
without touching hand-created thoughts. It is additive: statuses, dedup and the scheduled
surface time are unchanged, and no read path keys off it.

`action=timeline` is the plain paginated thought list (`status`, `project_id`, `limit`,
`offset`).

## `memory_primers` — the always-at-hand set

### `action=list`

Lists the primers, most-hit first. A primer is a pointer to a thought that was promoted after
repeated recalls, so an agent can inject project context without a search. The list is capped
(500 rows by default).

No arguments. Returns the primer rows:

```json
[
  { "id": "primer-1", "thought_id": "thought-a", "hit_count": 12, "promoted_at": "2026-10-01T12:00:00.000Z", "created_at": "2026-10-01T12:00:00.000Z" }
]
```

### `action=delete`

Removes one primer from the always-at-hand set. The **thought itself is not deleted** — only the
primer row. Deletion is **idempotent**: a missing primer is reported as `not_found`, not an error.

| Argument | Type | Required | Description |
|---|---|---|---|
| `primer_id` | string | yes | The primer to delete |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = delete |

**Preview** (`confirm` absent/`false`):

```json
{
  "status": "preview",
  "primer_id": "primer-1",
  "primer": { "id": "primer-1", "thought_id": "thought-a", "hit_count": 12, "promoted_at": "2026-10-01T12:00:00.000Z", "created_at": "2026-10-01T12:00:00.000Z" },
  "consequence": "Removes the primer for thought 'thought-a' from the always-at-hand set.",
  "instruction": "Call memory_primers again with action=delete, primer_id=primer-1, confirm=true to proceed."
}
```

A missing primer in preview returns `{ "status": "not_found", "primer_id": "primer-1" }`.

**Execute** (`confirm: true`): `{ "status": "deleted", "primer_id": "primer-1" }`, or
`{ "status": "not_found", "primer_id": "primer-1" }` if it was already gone.

Example:

```json
{ "action": "delete", "primer_id": "primer-1", "confirm": true }
```

> **HTTP parity.** The HTTP routes `GET /api/primers` and `DELETE /api/primers/:id` keep their
> previous semantics: the HTTP delete is immediate and takes no `confirm`.

## Health-check remediation: `contradiction_in_cluster`

`memory_status action=health` reports `contradiction_in_cluster` (semantic consistency,
warning) when two non-archived members of the same cluster are joined by a `contradicts` edge
— the consolidated claim is ambiguous until the conflict is resolved. Each finding's
`details` carries `cluster_id`, `member_a`, `member_b` and `contradicts_edge_id`.

There is **no autofix** for this finding: the health check only detects, the agent decides.
Resolve it with the edge writers above, then re-run the check:

1. **Drop the contradiction** — `memory_store` action=unlink on `contradicts_edge_id`
   (preview, then `confirm: true`).
2. **Retype it** — `memory_store` action=retype, `new_type=supports` (or `related`), on
   `contradicts_edge_id` if the contradiction was a mistake.
3. **Archive the cluster thought** so the member pair is no longer co-clustered under a live
   consolidated claim — `memory_supersede` action=archive (idempotent; member thoughts are
   untouched).

Both edge writes are dry-run first: preview with `confirm` omitted, then re-issue with
`confirm: true`.

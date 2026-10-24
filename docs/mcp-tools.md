# MCP Tools Reference

SynaptoMind exposes its graph operations as 11 MCP tools, over both the stdio and HTTP
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
| `memory_store` | create, update, link, link_batch, unlink, unlink_batch, retype | Write, connect and edit thoughts |
| `memory_supersede` | archive, archive_batch, merge | Version and supersede thoughts |
| `memory_status` | slots, frontier, config, health, propose | Query system state |
| `memory_manage` | list, create, update, delete, resolve | Project management |
| `edge_review` | enqueue, list, apply, apply_batch, rollback, reject | Review and apply queued placement proposals |
| `retention_review` | list, protect, delete, compact | Review retention candidates and take explicit retention actions |
| `memory_crystallize` | graph, cluster, auto_cluster | Visualize and reorganize clusters |
| `memory_reflect` | reflect, timeline | Session management |
| `memory_primers` | list, delete | Manage the always-at-hand set (primers) |
| `memory_guide` | (no action) | In-band reference text |

## Dry-run / confirm pattern

Every destructive action — `memory_store` `unlink` and `retype`, `memory_supersede` `archive`,
`archive_batch` and `merge`, `memory_manage action=delete`, `edge_review` (`apply`/`apply_batch`/`rollback`),
`memory_primers action=delete`, and
`memory_crystallize action=auto_cluster` — follows the same two-step
pattern:

- **Preview (default).** `confirm` is absent or `false`. The tool returns its action-specific,
  non-mutating preview payload (where applicable, `status: "preview"`). Nothing is written.
- **Execute.** `confirm: true` performs the write and returns a status-specific result.

Retired inputs may remain visible in the advertised tool schema as never-valued tombstones.
Some MCP clients validate arguments against that schema before sending a call, and may reject a
tombstone at the client schema boundary; such a client-side validation error is not a server
response and does not necessarily contain the server's migration text. When a call containing a
retired input reaches the server, invocation validation returns a migration error. Tool
descriptions identify the supported replacements: recall `top_k` → `limit`, `cluster` →
`is_cluster`; status `k` → `limit`, `dry_run` → `confirm`; crystallize `dry_run` → `confirm`;
store link `thought_id` → `source_id`; reflect `goals_delta` → `goals_add` / `goals_remove`;
review enqueue `max_items` → `max_proposals`. `memory_store.is_profile` has no replacement:
remove the field from requests. Retired names are not accepted aliases.

## Result and error envelopes

Every tool declares the same output shape, `{ result: <payload> }` (`toolOutputShape`,
`src/mcp/tools/utils.ts:12`). A successful action returns that payload in `structuredContent.result`
mirroring the JSON in `content[].text` (`jsonResult`, `src/mcp/tools/utils.ts:14-22`).
Bare string payloads (config, guide) are wrapped as `{ text: string }` so no action ever
returns a bare string in `result`; arrays and objects pass through unchanged.

Two encodings coexist. Raw-text tools (`memory_status` action=config, `memory_guide`) keep the
human-readable payload in `content[].text` verbatim and report `structuredContent.result = { text }`,
so `content[].text` is **not** `JSON.stringify(result)` for those two. Every other tool goes through
`jsonResult`, where `content[].text = JSON.stringify(payload)` and `result = payload`; a string passed
to `jsonResult` is wrapped to `{ text }` and its `content[].text` becomes the JSON
`{"text":"..."}`.

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
  putting it anywhere else would fail the check (`src/mcp/tools/utils.ts:40-42`).
- **Classified vs unclassified.** Only errors exposing a numeric `statusCode` are enriched. A plain
  `Error` or a non-`Error` throw keeps the plain `{ content, isError }` shape with **no**
  `structuredContent` key (`src/mcp/tools/utils.ts:52-55`, `src/mcp/tools/action-tool.ts:99-108`).
- **Retryability.** `retryable` is `statusCode === 503`. The 503 class is the transient
  availability failures — embedder not ready, overloaded, timed out, send failure
  (`src/errors.ts`) — the only class safe to repeat as-is. Every other classified code
  (`400`, `404`, `409`) is reported `retryable: false` (`src/mcp/tools/action-tool.ts:107`).

A client should re-issue the identical request only when `retryable` is `true`; otherwise the
failure is a bad request and repeating it will not help.

## Compact output and field selection

Read tools (`memory_recall`, `memory_status`, `memory_crystallize`, `memory_manage`)
accept two opt-in output controls:

- `compact: true` — trims each thought to the minimal field set
  `{ id, content, status, tags (as strings), project }`.
- `fields: ["id", "content", ...]` — returns only the requested fields (intersected
  with the available columns). Explicit `fields` take precedence over `compact`.

Examples:

```json
{ "action": "list", "compact": true }
{ "action": "list", "fields": ["id", "content"] }
{ "action": "get", "thought_id": "thought-a", "compact": true }
{ "action": "search", "query": "marker", "compact": true }
```

Defaults are unchanged (full output) when neither flag is supplied.

## `memory_recall` — finding and retrieving thoughts

### `action=list`

Paginated inventory of thoughts without a search query. Use this to enumerate by status,
project, tag, or cluster flag — the tool that makes bulk triage and cleanup possible.

| Argument | Type | Required | Description |
|---|---|---|---|
| `status` | enum | no | `draft`, `active`, or `archived` (default: all) |
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

Hybrid (RRF) / vector search. Key arguments: `query` (required), `hybrid` (boolean, default true: RRF fusion of the vector and BM25 legs; false = vector leg only),
`status` (default active), `project`, `tag`, `is_cluster`, `min_importance`, `limit`, `min_relevance`,
`recency_weight`, `recency_half_life_days`, `supersession_mode`, `contradiction_mode`.
Returns hits with `similarity`/`distance` (embedding leg only), `match_source` (`embedding`/`bm25`/both), `low_confidence`.

### `action=get`

Fetch one thought by `thought_id` (full content, tags, project, importance, edges). Pass `include_edges: true` to return incident edges inline (upstream/downstream with type and created_at).

### `action=context` / `action=chain` / `action=clusters`

`context` returns a thought plus its neighbours up to `max_degree` (accepts a text `query` or a
`thought_id`); `chain` walks a parent/develops chain. `max_degree` bounds chain/context traversal;
it is distinct from `limit`, which caps returned results. `clusters` lists cluster thoughts and their
members.

## `memory_store` — edges

### `action=link`

Create an edge between two thoughts. Use canonical endpoint parameters `source_id` and `target_id`;
the retired `thought_id` alias is rejected with a hint to use `source_id`. A pair carries **one** edge: re-linking the same pair with
the same type is idempotent for the symmetric types (`related`, `contradicts`), while a directed
duplicate or a second, different type on the pair is reported as an error — except that a
`related` placeholder edge is upgraded in place to the specific type you ask for. Constraints: no
self-loops, and only a cluster thought may carry a `cluster` edge.

| Argument | Type | Required | Description |
|---|---|---|---|
| `source_id` | string | yes | The source thought |
| `target_id` | string | yes | The target thought |
| `edge_type` | enum | no | One of `related`, `parent`, `develops`, `replaces`, `cluster`, `references`, `depends_on`, `contradicts`, `supports`; default `related` |

**Naming convention.** `source_id`/`target_id` name the pair in both writers: `memory_store`
`action=link` and `memory_supersede` `action=merge`. The link action requires `source_id` for
the source side; its retired `thought_id` input is rejected with a hint to use `source_id`.

Example:

```json
{ "action": "link", "source_id": "thought-a", "target_id": "thought-b", "edge_type": "develops" }
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

### `action=unlink_batch`

Delete or preview up to 1000 edges in one call. The batch runs in a **single
transaction** and reuses the `unlink` writer. In `confirm` mode every `edge_id`
is validated to exist **before** any deletion happens, so a missing id aborts
the whole batch instead of leaving a partial prune behind. Preview mode
(`confirm` absent/`false`) never mutates.

| Argument | Type | Required | Description |
|---|---|---|---|
| `edge_ids` | string[] | yes | Edge IDs to delete/preview (1–1000 items) |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = delete |

Result: `{ "deleted": 2, "preview": 0, "failed": 1, "results": [{ "edge_id": "edge-1", "status": "deleted" }, { "edge_id": "edge-2", "status": "deleted" }, { "edge_id": "missing", "status": "failed", "error": "Edge not found: missing" }] }`

In preview mode each result carries `status: "preview"` plus the edge details and
`consequence` (mirroring single `unlink`). `failed` always equals the number of
entries in `errors`.

Example:

```json
{ "action": "unlink_batch", "edge_ids": ["edge-1", "edge-2"], "confirm": true }
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

All three actions preview when `confirm` is omitted or `false`; only `confirm: true` executes.
Execution re-reads/revalidates current state, so previews can become stale. Preview responses include
a `preview_token` (stored in DB, ~5 min TTL) for every destructive action (unlink, retype, archive,
archive_batch, merge, delete, auto_cluster, apply, apply_batch, rollback); `confirm: true` requires a
valid `preview_token` and fails when it is missing or stale. No transactional reservation is implied.
`archive` and `archive_batch` identify thoughts by ID and do not accept a project scope; `project_id`
and `cwd` apply only to `merge`.

### `action=archive`

Archives one thought (`thought_id`). Already-archived thoughts are idempotent: execution returns
the existing thought without re-stamping it. Profile thoughts are protected and cannot be archived.

| Argument | Type | Required | Description |
|---|---|---|---|
| `thought_id` | string | yes | Thought to archive |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = execute |

Preview returns `{ "status": "preview", "action": "archive", "thought_id": "thought-a", "current_status": "active", "outcome": "would_archive" }`. `outcome` is `not_found`, `already_archived`, `protected`, or `would_archive`. Execution returns `{ "status": "executed", "action": "archive", "result": <thought> }`; missing or protected thoughts fail with an error.

### `action=archive_batch`

Preview or archive 1–1000 thoughts per call. Preview reports each requested ID in input order,
including duplicates. Outcomes are `not_found`, `already_archived`, `protected`, or `would_archive`;
repeated non-profile IDs after their first occurrence preview as `already_archived`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `thought_ids` | string[] | yes | Thoughts to archive (1–1000 items) |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = execute |

Preview envelope: `{ "status": "preview", "action": "archive_batch", "requested_count": 2, "items": [{ "thought_id": "thought-a", "outcome": "would_archive" }] }`. The `items` array has one entry per requested occurrence, in input order (including duplicate IDs). Confirmed execution wraps the existing aggregate result: `{ "status": "executed", "action": "archive_batch", "result": { "archived": 2, "failed": 1, "errors": [{ "thought_id": "missing-id", "error": "Thought 'missing-id' not found" }] } }`. Execution does not return per-item success records.

`failed` equals `errors.length`; unknown IDs and protected profiles appear in `errors` in input
order, while successful items contribute to the aggregate `archived` count. Items are processed in
input order; duplicate IDs are idempotent.
An empty or over-long array is refused with an `isError` envelope before anything runs.

Example:

```json
{ "action": "archive_batch", "thought_ids": ["thought-a", "thought-b"] }
```

### `action=merge`

Consolidates a source thought into a target: the source's edges are recreated on the target,
the target's content/tags are replaced when supplied, the source is archived, and a `replaces`
edge target → source records the consolidation. Merging an archived source or a profile thought
is refused. Preview checks current eligibility and reports source/target status; it includes at
most 50 source-edge descriptors plus the full `source_edge_count` and a `truncated` flag. This
bounded list does not promise every edge will transfer.

| Argument | Type | Required | Description |
|---|---|---|---|
| `source_id` | string | yes | Thought to merge away (archived by the merge) |
| `target_id` | string | yes | Thought that survives and receives the edges |
| `merged_content` | string | no | Resulting content of the target |
| `merged_tags` | string[] | no | Resulting tag set of the target |
| `project_id` | string | no | Resulting project (defaults to the target's, then the source's) |

Preview returns `{ "status": "preview", "action": "merge", "outcome": "would_merge", "source": { "id", "status", "edges": [], "source_edge_count": 0, "truncated": false }, "target": { "id", "status" }, "proposed": { "merged_content", "merged_tags", "project_id" }, "effects": { "source_archived": true, "target_updated": false, "replaces_edge_created": true } }`. Missing IDs report `outcome: "not_found"`; an ineligible merge reports `outcome: "ineligible"` and `reason`. `proposed` reflects supplied values; `effects` describes the prospective updates. Execution returns `{ "status": "executed", "action": "merge", "result": { "target": { ... }, "edges_transferred": 2 } }` — `edges_transferred` is the number of
source edges the target now holds, so a caller can verify the consolidation. Not every source
edge contributes: one that would collapse into a self-loop (it joined the target to the source),
a duplicate of a non-symmetric edge the target already has, and a cluster edge the cluster rule
rejects are dropped and left out of the count. An existing symmetric pair (`related`,
`contradicts`) does count — the target owns that relation after the merge. The HTTP twin
(`POST /api/thoughts/:targetId/merge`) is unchanged: it executes immediately without preview or
confirmation and reports the count under its long-standing name `transferredEdges`. The
confirmation-first contract applies to MCP only; it does not imply an HTTP API change.

```json
{ "action": "merge", "source_id": "thought-a", "target_id": "thought-b", "merged_content": "merged claim" }
```

## `memory_crystallize` — clusters

Three actions, all read-mostly: `graph` (nodes + edges for a project, `status` and `limit`
filters), `cluster` (create a cluster thought from `thought_ids` with an optional `title`
and `tags`), and `auto_cluster` (Union-Find grouping over active thoughts, tuned by the
`autoCluster.*` settings in [CONFIG.md](CONFIG.md). It previews when `confirm` is absent or false;
`confirm: true` executes, even when the configured `autoCluster.dryRun` default is true. The retired
`dry_run` input is rejected with a hint to use `confirm`;
`project_id`/`cwd` do not apply — the run is global).

## `memory_reflect` — session reflection

`action=reflect` is **not read-only**: it writes slots and thoughts.

- `summary` is appended (with a timestamp) to the `project_context` slot.
- `goals_add` adds goals to `active_goals`; `goals_remove` removes stored goal lines when the
  supplied text matches as a case-insensitive substring. The retired `goals_delta` parameter is
  rejected with a hint to use `goals_add` / `goals_remove`.
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

## `memory_status` — system state

For this tool, retired `k` is replaced by `limit` (the frontier page/result limit). Depending on the MCP client,
never-valued retired arguments may be rejected by local schema validation before a request reaches
the server; if the request is sent, invocation validation returns the migration error.

### `action=slots` (read-only)

Slots are **read-only** through this tool: it never writes. `pending_items` is derived from
thoughts tagged `pending` (the same set the frontier surfaces); `architecture_decisions` from
primers (most-hit first); `project_context` and `active_goals` are stored rows. To change slot
content, update or archive the underlying thoughts (virtual slots) or use `memory_reflect`
(`summary` appends to `project_context`; `goals_add` and `goals_remove` edit `active_goals`). Paging applies to
`pending_items` via `limit`/`offset`.

### `action=propose`

Read-only placement plan (placement, edges, lifecycle); never writes.

## `memory_manage` — projects

CRUD over projects plus resolution from a path.

- `list`, `create`, `update`, `delete (preview→confirm)`, `resolve` (resolve project from `cwd`).
- `delete` is preview-first: returns `action: "preview"` unless `confirm: true`.

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

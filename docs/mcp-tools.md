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
| `memory_store` | create, update, link, unlink, retype | Write, connect and edit thoughts |
| `memory_supersede` | archive, merge | Version and supersede thoughts |
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

## `memory_store` — edges

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

## `memory_crystallize` — clusters

Three actions, all read-mostly: `graph` (nodes + edges for a project, `status` and `limit`
filters), `cluster` (create a cluster thought from `thought_ids` with an optional `title`
and `tags`), and `auto_cluster` (Union-Find grouping over active thoughts, tuned by the
`autoCluster.*` settings in [CONFIG.md](CONFIG.md) and previewable with `dry_run: true`;
`project_id`/`cwd` do not apply — the run is global).

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

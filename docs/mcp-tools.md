# MCP Tools Reference

SynaptoMind exposes its graph operations as 10 MCP tools, over both the stdio and HTTP
transports. Each tool multiplexes several actions behind an `action` argument. This page is
the detailed companion to the in-band `memory_guide` tool (`src/mcp/tools/guide.ts`), which
returns a condensed reference at runtime; `memory_guide` stays the authoritative quick map.

For the HTTP equivalents, see [docs/API.md](API.md). For end-to-end usage, see
[docs/SCENARIOS.md](SCENARIOS.md).

## Tool map

| Tool | Actions | Purpose |
|---|---|---|
| `memory_recall` | search, get, context, chain, clusters | Find and retrieve thoughts |
| `memory_store` | create, update, link, unlink, retype | Write, connect and edit thoughts |
| `memory_supersede` | archive, merge | Version and supersede thoughts |
| `memory_status` | slots, frontier, profile, config, health, edge_suggestions, propose, cleanup | Query system state |
| `memory_manage` | list, create, update, delete, resolve | Project management |
| `memory_review` | enqueue, list, apply, apply_batch, rollback, reject | Review and apply queued placement proposals |
| `memory_crystallize` | crystallize, graph, cluster, auto_cluster, cluster_remove, cluster_dissolve | Consolidate, visualize and reorganize clusters |
| `memory_reflect` | reflect, timeline | Session management |
| `memory_telemetry` | query, analyze, primers | Analytics and self-improvement |
| `memory_guide` | (no action) | In-band reference text |

## Dry-run / confirm pattern

Every mutating action added for graph maintenance — `memory_store` `unlink` and `retype`,
`memory_crystallize` `cluster_remove` and `cluster_dissolve` — follows the same two-step
pattern, consistent with `memory_review` (`apply`/`apply_batch`/`rollback`) and
`memory_manage action=delete`:

- **Preview (default).** `confirm` is absent or `false`. The tool validates the target and
  returns a non-mutating preview with `status: "preview"` and a human-readable `consequence`.
  Nothing is written.
- **Execute.** `confirm: true` performs the write and returns a status-specific result.

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

Errors return an `isError` envelope: a non-existent edge (`Edge not found`), retyping to the
current type (`is already of type`), an invalid type, or a cluster-constraint violation.

> **Id note.** Retype is a transactional delete + insert that carries `created_at` over, so
> the edge gets a **new id**. The response echoes the `edge_id` you passed — re-fetch the
> edge if you need its new id.

Example:

```json
{ "action": "retype", "edge_id": "edge-123", "new_type": "supports", "confirm": true }
```

## `memory_crystallize` — cluster membership

### `action=cluster_remove`

Remove one member from a cluster. The `cluster` edge from the cluster to the thought is
deleted; the member thought is **not** deleted — it becomes standalone.

| Argument | Type | Required | Description |
|---|---|---|---|
| `cluster_id` | string | yes | The cluster thought |
| `thought_id` | string | yes | The member to remove |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = remove |

**Preview**: `{ "status": "preview", "cluster_id": "cluster-1", "thought_id": "thought-1", "edge_id": "edge-9", "consequence": "Removes 'thought-1' from cluster 'cluster-1'. The thought becomes standalone." }`

**Execute**: `{ "status": "removed", "cluster_id": "cluster-1", "thought_id": "thought-1", "edge_id": "edge-9" }`

Errors: a non-existent cluster (`Cluster not found`) or a thought that is not a member
(`is not a member of cluster`) return an error envelope.

Example:

```json
{ "action": "cluster_remove", "cluster_id": "cluster-1", "thought_id": "thought-1", "confirm": true }
```

### `action=cluster_dissolve`

Delete the cluster thought and all of its member edges. Member thoughts are **not** deleted —
they become standalone. A protected cluster is refused.

| Argument | Type | Required | Description |
|---|---|---|---|
| `cluster_id` | string | yes | The cluster to dissolve |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = dissolve |

**Preview**: `{ "status": "preview", "cluster_id": "cluster-1", "member_count": 3, "member_ids": ["thought-1", "thought-2", "thought-3"], "consequence": "Deletes the cluster thought and 3 member edges. Member thoughts become standalone." }`

**Execute**: `{ "status": "dissolved", "cluster_id": "cluster-1", "deleted_edge_count": 3, "deleted_member_count": 0 }`

Errors: a non-existent or non-cluster id (`Cluster not found`) and a protected cluster
(`is protected and cannot be dissolved`) return an error envelope.

> **Protected clusters.** Clusters are created unprotected (`is_protected = false`), so
> `cluster_dissolve` is reachable directly. A cluster protected explicitly (via
> `memory_store action=update is_protected=true`) is still refused.
>
> The preview lists live (non-archived) members; the confirm's `deleted_edge_count` counts
> every member edge, including edges to archived members.

Example:

```json
{ "action": "cluster_dissolve", "cluster_id": "cluster-1", "confirm": true }
```

## Health-check remediation: `contradiction_in_cluster`

`memory_status action=health` reports `contradiction_in_cluster` (semantic consistency,
warning) when two non-archived members of the same cluster are joined by a `contradicts` edge
— the consolidated claim is ambiguous until the conflict is resolved. Each finding's
`details` carries `cluster_id`, `member_a`, `member_b` and `contradicts_edge_id`.

There is **no autofix** for this finding: the health check only detects, the agent decides.
Resolve it with the edge/cluster writers above, then re-run the check:

1. **Drop the contradiction** — `memory_store` action=unlink on `contradicts_edge_id`
   (preview, then `confirm: true`).
2. **Retype it** — `memory_store` action=retype, `new_type=supports` (or `related`), on
   `contradicts_edge_id` if the contradiction was a mistake.
3. **Extract a member** — `memory_crystallize` action=cluster_remove on `cluster_id` +
   `member_a` (or `member_b`); the pair is no longer co-clustered and the extracted thought
   stays standalone.

All three are dry-run first: preview with `confirm` omitted, then re-issue with `confirm: true`.

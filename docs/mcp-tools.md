> **Migration note (next release):** every MCP action now answers in one response envelope —
> `{ items, meta }` for collections, `{ item, meta }` for single objects — `cwd` is optional on
> the project-scoped actions (it narrows an answer to one project; without it a read answers
> across every project and says so in `meta`, except `memory_status action=propose`, whose plan
> stays project-pinned), and an id-shaped `query` resolves that thought directly.
> See the **Migration notes (response envelope, cwd scope, id lookup)** section at the end of this
> document for the full list of breaking changes.
>
> **Migration note (v0.19):** Project scoping on MCP tools uses `cwd` (working directory) instead of `project_id`. The exception is `memory_manage` actions `update` and `delete`, which require `project_id` to identify the project. See the **Migration notes (v0.19 MCP UX cleanup)** section at the end of this document for the full list (compact defaults, preview tokens, `edge_review` canonical keys, retired inputs).

# MCP Tools Reference

SynaptoMind exposes its graph operations as 11 MCP tools, over both the stdio and HTTP
transports. Each tool multiplexes several actions behind an `action` argument. This page is
the detailed companion to the in-band `memory_guide` tool (`src/mcp/tools/guide.ts`), which
returns a short quick map plus a pointer here at runtime.

Every thought operation below is MCP-only: the HTTP listener is an ops plane
(`/health` plus the two `/api/health-check` routes) and has no graph endpoints — see
[docs/API.md](API.md). For end-to-end usage, see
[docs/SCENARIOS.md](SCENARIOS.md). This page documents the current surface only; removals
between releases are recorded in [CHANGELOG.md](../CHANGELOG.md).

## Tool map

| Tool | Actions | Purpose |
|---|---|---|
| `memory_recall` | search, get, context, chain, clusters, list | Find and retrieve thoughts (list = paginated inventory) |
| `memory_store` | create, update, link, link_batch, unlink, unlink_batch, retype, bulk_create | Write, connect and edit thoughts |
| `memory_supersede` | archive, archive_batch, merge | Version and supersede thoughts |
| `memory_status` | slots, frontier, config, health, propose | Query system state |
| `memory_manage` | list, create, update, delete, resolve | Project management |
| `edge_review` | enqueue, list, apply, apply_batch, rollback, reject | Review and apply queued placement proposals |
| `retention_review` | list, protect, delete, compact | Review retention candidates and take explicit retention actions |
| `memory_crystallize` | graph, cluster, auto_cluster | Visualize and reorganize clusters |
| `memory_reflect` | reflect, timeline | Session management |
| `memory_primers` | list, delete | Manage the always-at-hand set (primers) |
| `memory_guide` | (no action) | In-band reference text |

## Response envelope

Every action answers in one envelope (`src/mcp/tools/envelope.ts`):

- a **collection** action returns `{ "items": [...], "meta": {...} }`;
- a **single-object** action returns `{ "item": ..., "meta": {...} }` (`item` is `null` when the
  action legitimately found nothing);
- `meta` always carries the same keys, whatever the action.

The envelope is the payload of the wire envelope described in
[Wire envelope](#wire-envelope): a client reads it from `structuredContent.result` (or from
`content[].text` for the two raw-text actions).

### `meta`

| Key | Type | Description |
|---|---|---|
| `action` | string | The action that produced the answer (`search`, `slots`, `link_batch`, ...) |
| `scope` | object \| null | Resolved project scope; `null` when the call carried no `cwd` or the action is not project-scoped |
| `counts` | object | Row accounting (see below) |
| `degraded` | boolean | `true` when the answer is degraded (semantic leg down, missing best match) |
| `warnings` | string[] | Non-fatal notes; empty when there are none |
| `reason` | string | Optional: why the answer is empty — `no_match`, `id_not_found`, `ambiguous_id` |
| `preview` | object | Optional: present only when the answer previews a destructive write |

`scope` reports the project `cwd` resolved to:

```json
{ "project": "01a172b4-d49b-76f4-ada8-7ba408661064", "project_name": "Doc Probe", "global": false }
```

- `project` is the project id and `project_name` its display name;
- `null` means the answer was not scoped to a project: the call omitted `cwd` (then `warnings`
  carries a `no cwd` note — `no cwd — the answer spans every project` for the readers that widen,
  the project-pinned note of [propose](#actionpropose) for that one) or the action is not
  project-scoped;
- `global: true` with `project: null` means the answer spans every project although a `cwd` was
  given — it names a path that is not registered (then `warnings` carries a
  `cwd "..." matches no known project` note). The call still succeeds; it just is not narrowed.
  `memory_status action=propose` is the exception: its plan never widens, so the same path yields one
  composed note that pairs the unknown-path fact with the pinning clause and never claims a
  cross-project answer ([Working directory](#working-directory-cwd)).

`counts` always carries three shared keys plus whatever the action can report:

| Key | Description |
|---|---|
| `total` | Rows the action considered: the candidate pool of a query (`search`, `clusters`, an id lookup), the un-paged count of a paged inventory, or the requested item count of a batch |
| `returned` | Rows in `items`, or `1`/`0` for a single `item` |
| `filtered_out` | Rows the action accounts for as dropped — not necessarily every row it dropped |

What the three keys count is per action:

| Action | `total` | `filtered_out` |
|---|---|---|
| `memory_recall` `search`, `clusters` | candidates surviving the scope (status, project), tag and standing filters | the rows the relevance gate dropped |
| `memory_recall` id lookup | the rows the id resolved, after the `limit` cap | `0` |
| `memory_recall` `list`, `memory_reflect` `timeline`, `memory_crystallize` `graph` | the un-paged count matching the filters | the rows the page left out (`offset`/`limit`) |
| `retention_review` `list` | the candidate count matching the filters, un-paged | `0` — the page remainder is unaccounted |
| `edge_review` `list` | the rows matching the filters, ignoring the page (internally capped at 1000) | the retired kinds hidden unless `include_retired` — not the page remainder |
| `memory_crystallize` `auto_cluster` | the candidate count | `0` |
| the batch writers (`link_batch`, `unlink_batch`, `bulk_create`, `archive_batch`, `apply_batch`) and the un-paged collections (`slots`, `frontier`, `memory_manage` `list`, `memory_primers` `list`, `rollback`) | the requested item count, or the rows in `items` | `0` |
| a single-object action | `1` when an `item` came back, `0` when it did not — except `propose`, where it is the planned edge count | `0` |

So `total = returned + filtered_out` holds where the action accounts for every row it dropped —
the un-paged collections (vacuously: nothing is dropped), `memory_recall` `list`, `memory_reflect`
`timeline` and `memory_crystallize` `graph` — and it fails for the rest: `search`/`clusters` leave
the `limit` slice unaccounted, `retention_review` `list` reports `filtered_out: 0` while the page is
bounded, `edge_review` `list` counts the retired kinds instead of the page remainder, and
`auto_cluster` counts candidates against grouped items. **Known gap on the default search path**
(audit #2521, Medium 1, not fixed here): the rows the `limit` slice cut are in neither `returned`
nor `filtered_out`, so a truncated answer reports `total > returned + filtered_out`. Read `returned`
for the page and `total` for the pool instead of reconstructing one from the other; a tag-filtered
search adds nothing to either key for a thought that matched the query but not the tag, because such
a row is never a candidate.

Action-specific counters sit beside them (`link_batch` → `linked`/`failed`; `archive_batch` →
`archived`/`failed`; `retention_review` list, `memory_recall` list and `memory_reflect` timeline →
`limit`/`offset`; `edge_review` list → `retired_count`; `graph` → `edges`; `cluster` →
`members`/`edges`), so a caller never has to count `items` itself.

`reason` is present only when "nothing" is not the ordinary case:

| Value | Meaning |
|---|---|
| `no_match` | The action considered nothing — a search that matched no candidate, a context lookup without a best match |
| `id_not_found` | An id-shaped search query addressed no thought **and** the fallback word search matched nothing either (the same miss also appears in `warnings`) |
| `ambiguous_id` | An id prefix addressed several thoughts; `items` carries all of them (up to `limit`) |

A result set emptied by the relevance gate keeps **no** `reason`: it shows up as
`counts.filtered_out > 0` instead, so a caller can tell "nothing matched" from "everything was
gated out".

### The `memory_crystallize action=graph` exception

A graph is two collections, not one, so this is the single documented exception to
`item`/`items`: the nodes are `items` and the edges ride beside them in a named `edges` field
(`src/mcp/tools/crystallize/graph.ts`):

```json
{
  "items": [
    { "id": "01a172b6-5dfc-73e5-b28e-91236675b273", "label": "MCP_DOC_MARKER: the envelope example thought", "title": "MCP_DOC_MARKER: the envelope example thought", "group": "test", "tags": [], "category": "concept", "status": "active", "is_cluster": false, "project_name": "Doc Probe" }
  ],
  "edges": [
    { "id": "01a172b6-5dfd-7207-98e9-e76a296474fd", "source": "01a172b6-5dfc-73e5-b28e-91236675b273", "target": "01a172b6-5dfc-73e6-b63a-ded850ebfd9b", "type": "supports" }
  ],
  "meta": {
    "action": "graph",
    "scope": { "project": "01a172b6-5dfa-754c-b67e-a0a2f5915d96", "project_name": "Doc Probe", "global": false },
    "counts": { "edges": 1, "total": 4, "returned": 4, "filtered_out": 0 },
    "degraded": false,
    "warnings": []
  }
}
```

`counts` keeps the shared three keys for the **nodes**: `total` is the node count matching the
filters, `returned` the nodes of this page and `filtered_out` the nodes the page left out
(`offset`/`limit`), so `total = returned + filtered_out` holds here — one of the few actions where
it does (the `counts` section above lists the others). `edges` holds the active edges whose two
endpoints are both in `items`, and `counts.edges` is how many of them there are — not a total.

### Preview metadata

A non-mutating preview answer is marked in `meta.preview`; an executed answer carries no
`preview` key at all:

| Key | Description |
|---|---|
| `token` | Token the confirm call must send back; `null` for the tokenless previews (`unlink_batch`, `retention_review` `compact`) |
| `destructive` | Always `true` — confirming this answer writes to the graph |
| `consequence` | What confirming would do, in one sentence (where the action has one) |
| `instruction` | The exact call that confirms this preview (where the action phrases one) |

A single-object preview also keeps `status: "preview"`, `preview_token`, `consequence` and
`instruction` **inside `item`**; a collection preview keeps them only in `meta.preview`, because
the batch rows in `items` already carry their own per-row status.

## Wire envelope

Every tool declares the same output shape, `{ result: <payload> }` (`toolOutputShape`,
`src/mcp/tools/utils.ts:12`). A successful action returns that payload in `structuredContent.result`
mirroring the JSON in `content[].text` (`jsonResult`, `src/mcp/tools/utils.ts:14-22`).
Bare string payloads are wrapped as `{ text: string }` so no action ever returns a bare string in
`result`; arrays and objects pass through unchanged.

Two encodings coexist. `memory_guide` is the one raw-text tool: it keeps the human-readable
payload in `content[].text` verbatim and reports `structuredContent.result = { text }`, so
`content[].text` is **not** `JSON.stringify(result)` there. `memory_status action=config` keeps its
display text verbatim in `content[].text` too, but wraps it in the standard envelope as
`result = { item: { text }, meta }`. Every other tool goes through `jsonResult`, where
`content[].text = JSON.stringify(payload)` and `result = payload`; a string passed to `jsonResult`
is wrapped to `{ text }` and its `content[].text` becomes the JSON `{"text":"..."}`.

`memory_status action=config` therefore carries the configuration display as raw text in
`content[].text` and the same string as `structuredContent.result.item.text`, with the standard
envelope `meta` beside it (`src/mcp/tools/status/config.ts`).

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

## Working directory (`cwd`)

`cwd` is the **optional** scope argument of every project-scoped MCP action: it limits an answer to
one project, and omitting it — or passing an empty string — is never an error: a reader answers
across every project and declares that in `meta`, while a writer falls back to the default project.
The one reader that never widens is `memory_status action=propose`, whose plan stays pinned to the
project of the thought it addresses (see below).

| Tool | Actions taking `cwd` |
|---|---|
| `memory_recall` | `search`, `context`, `clusters`, `list` |
| `memory_status` | `slots`, `frontier`, `propose` (pinned, never widened — see below) |
| `memory_reflect` | `reflect`, `timeline` |
| `memory_crystallize` | `graph`, `cluster` |
| `edge_review` | `list` |
| `memory_manage` | `resolve` — the one action that requires it |

The actions outside the table either address their rows by id (`get`, `chain`, `unlink`, `archive`,
...) or are global by design (`health`, `config`, `primers`, `crystallize auto_cluster`), so they
take no `cwd`. A write that creates a row takes it too and lands in the project the path names
(`memory_store` `create`, `bulk_create` — per item when the item carries its own `project_id` —
and `edge_review enqueue`). The id-addressed writes `memory_store action=update` and
`memory_supersede action=merge` accept it as well, but only as the scope the answer reports: they
never move the row they address.

Except `propose` (below), a read that omits `cwd` succeeds and declares the widened answer in
`meta`: `scope` is `null` and `warnings` carries `no cwd — the answer spans every project`
(`resolveEnvelopeScope`, `src/mcp/tools/envelope.ts:167-191`):

```json
{
  "items": [
    { "id": "01a172b6-5dfc-73e5-b28e-91236675b273", "content": "MCP_DOC_MARKER: the envelope example thought", "status": "active", "tags": [], "project": "Doc Probe" }
  ],
  "meta": {
    "action": "list",
    "scope": null,
    "counts": { "limit": 1, "offset": 0, "total": 4, "returned": 1, "filtered_out": 3 },
    "degraded": false,
    "warnings": ["no cwd — the answer spans every project"]
  }
}
```

`memory_manage action=resolve` is the exception: there the path is the input rather than a scope, so
a call without `cwd` fails with an `isError` envelope naming the argument
(`src/mcp/tools/manage.ts:109`).

`memory_status action=slots` adds a second warning whenever no project resolved — `cwd` omitted,
blank or naming no project — because only the global slot rows are read and the project-scoped
overrides stay unapplied (`src/mcp/tools/status/slots.ts:11-12`, `:35-38`).

`memory_status action=propose` is the one read that never widens: `cwd` scopes its candidate pool to
one project, and without it — or with a path that resolves to no project — the plan stays pinned to
the project the addressed thought belongs to, or to the default project for draft `content`
(`src/services/placement/engine.ts:84-112`, `:151-156`; `src/services/placement/placement.ts:92-93`;
`src/mcp/tools/status/propose.ts:6-36`).
A cwd-less call replaces the broadening note with one of two pinning notes:

`no cwd — propose is not cross-project: the plan is restricted to the project the addressed thought (thought_id) belongs to`

with draft content it is
`no cwd — propose is not cross-project: the plan is restricted to the default project (draft content)`.

A path that resolves to no project gets **one** composed warning instead of the generic broadening
one (`src/mcp/tools/status/propose.ts:33-35`): the unknown-path fact with its resolve hint, then the
same pinning clause, and no `the answer spans every project` claim anywhere in it:

`cwd "<path>" matches no known project (check it with memory_manage action=resolve) — propose is not cross-project: the plan is restricted to the project the addressed thought (thought_id) belongs to`

with draft content it is
`cwd "<path>" matches no known project (check it with memory_manage action=resolve) — propose is not cross-project: the plan is restricted to the default project (draft content)`.

So the plan is still pinned, never widened, while `scope` stays the unresolved
`{ project: null, project_name: null, global: true }`: the warning, not the scope, states the project
the plan really used.

A write action resolves `cwd` the same way but never widens, so it raises no scope warning in any
shape. A write that creates a row lands in the project the path names, or in the default project when
`cwd` is absent, blank or names no project; an id-addressed write (`memory_store update`,
`memory_supersede`) leaves its row's project untouched. An unregistered path therefore keeps only the
unresolved `{ project: null, project_name: null, global: true }` scope as the trace that it scoped
nothing (`writeEnvelopeScope`, `src/mcp/tools/envelope.ts:222-228`). `memory_reflect action=reflect`
is a write in this sense; its own section below spells out where each of its outputs lands. Likewise,
a read given a path that is not registered is never an error: it reports `scope.global: true` plus a
warning and answers across every project — `propose` excepted: its plan is always pinned, so the same
path yields the single composed note above, which pairs the unknown-path fact with the pinning clause
instead of claiming a cross-project answer.

There is no HTTP counterpart to that rule: the HTTP listener serves only `/health` and the
`/api/health-check` pair, so a REST client cannot reach a thought at all
([API.md](API.md)).

## Compact output and field selection

Read tools (`memory_recall`, `memory_status`, `memory_crystallize`,
`retention_review`) accept two output controls, applied to the thought objects inside `item`/`items`:

- `compact: true` — trims each thought to the minimal field set
  `{ id, content, status, tags (as strings), project }`.
- `fields: ["id", "content", ...]` — returns only the requested fields (intersected
  with the available columns). Explicit `fields` take precedence over `compact`.

Examples:

```json
{ "action": "list", "compact": true, "cwd": "/path/to/project" }
{ "action": "list", "fields": ["id", "content"], "cwd": "/path/to/project" }
{ "action": "get", "thought_id": "01a172b4-d486-700c-a16e-5ae3d2d77a90", "compact": true }
{ "action": "search", "query": "marker", "compact": true, "cwd": "/path/to/project" }
```

Output hygiene applies to every shaped thought, compact or not: `tags` are plain strings (never
`{ id, name }`), and the storage 0/1 columns `is_protected`, `is_global` and `is_cluster` are
booleans (`src/mcp/tools/utils.ts`, `shapeThought`).

Compact defaults (v0.19 MCP UX cleanup):

- `memory_recall` — every action defaults to compact output; pass `compact: false`
  for the full thought, or `fields` for an explicit subset.
- `memory_status` `propose` — defaults to the slim plan (top 3 edges, no signals);
  pass `compact: false` or `include_signals: true` (or `max_edges`) for full output.
- `memory_crystallize` `graph`, `retention_review` `list` — compact is opt-in
  (`compact: true`); full output is the default unless `fields` is supplied.
  (`retention_review` applies `compact`/`fields` to its candidate list.)

Explicit `fields` always take precedence over `compact` on every tool.

### Opt-in url links

A thought's url links ride on the thought output behind one boolean argument,
`include_url_links` (default `false`). It is accepted by `memory_recall` `search`,
`clusters`, `list`, `get`, `context` and `chain`, and by `memory_reflect action=timeline`.

- **Shape.** `url_links: [{ text, url, label }]`, ordered by `sort_order` then creation
  time. `text` is the link's key — the `text` it was written with — so an item read from memory
  can be fed back into `memory_store` (`create`, or `update` with the whole set) unchanged;
  `label` defaults to `text`. Internal columns (`id`, `thought_id`, `created_at`) are never
  emitted.
- **Every thought in the response.** Not just the primary one: `get` attaches it to the
  thought *and* to its `upstream`/`downstream` neighbours, `chain`/`context` to the head and
  both neighbourhoods, and a `group_by_cluster` answer to the cluster members. "Primary only"
  is a rule a caller cannot remember.
- **One query per response.** The links of the whole answer are read in a single batch
  query, never one per thought (`getThoughtUrlLinksBatchService`,
  `src/services/url_links.service.ts`).
- **Not hidden by `compact`, not trimmed by `fields`.** The value is attached after the
  thought shaping (`src/mcp/tools/utils.ts`, `shapeThought`), so
  `include_url_links: true` with `fields: ["id"]` answers `{ id, url_links }`. The flag
  itself is a read control, not a thought column.
- **Absence is distinguishable from emptiness.** Omitted or `false`: the key is **absent**
  from the payload (existing clients see byte-identical output). `true` with no links: the
  key is `[]`.

```json
{
  "action": "get",
  "thought_id": "01a172b4-d486-700c-a16e-5ae3d2d77a90",
  "include_url_links": true
}
```

```json
{
  "item": {
    "id": "01a172b4-d486-700c-a16e-5ae3d2d77a90",
    "content": "Read the ADR before the rewrite",
    "status": "active",
    "tags": [],
    "project": "Doc Probe",
    "url_links": [
      { "text": "adr", "url": "https://forgejo.home.lan/authelia/artifacts/src/branch/main/synaptomind/adr/2026-10-26-shrink-http-api-to-ops-endpoints.md", "label": "adr" }
    ]
  },
  "meta": { "action": "get", "scope": null, "counts": { "total": 1, "returned": 1, "filtered_out": 0 }, "degraded": false, "warnings": [] }
}
```

Url links are **thought-owned** (`memory_store action=create`, `url_links` as
`[{ text, url }]`). Two actions write them, and neither is a separate link editor:

- `memory_store action=create` sets the initial list, in array order.
- `memory_store action=update` replaces the whole set, in array order: an omitted `url_links`
  leaves the set untouched and `[]` clears it, so a link is added or removed by sending the set
  you want. A content write never adds, rewrites or deletes a link.
- `memory_supersede action=merge` transfers the source's links to the target, appended after the
  target's own; a source link whose `text` the target already carries is dropped (the target's url
  wins) and the collision is logged.

The former `POST`/`DELETE /api/thoughts/:id/links` routes went with the rest of the HTTP API in
0.20; both are now expressed through `update`'s replace-set write
([API.md](API.md#removed-routes-020)).

## Dry-run / confirm pattern

Every destructive action — `memory_store` `unlink` and `retype`, `memory_supersede` `archive`,
`archive_batch` and `merge`, `memory_manage action=delete`, `edge_review` (`apply`/`apply_batch`/`rollback`),
`memory_primers action=delete`, `memory_crystallize action=auto_cluster`, and
`retention_review action=delete` — follows the same two-step pattern:

- **Preview (default).** `confirm` is absent or `false`. Nothing is written: the answer carries
  `meta.preview` (token, `destructive: true`, consequence, instruction) and, for a single-object
  action, `status: "preview"` inside `item`.
- **Execute.** `confirm: true` performs the write and returns an executed answer with no
  `meta.preview`.

Two destructive actions take no token — `memory_store action=unlink_batch` and
`retention_review action=compact` — their preview answers `meta.preview.token: null`.

Retired inputs may remain visible in the advertised tool schema as never-valued tombstones.
Some MCP clients validate arguments against that schema before sending a call, and may reject a
tombstone at the client schema boundary; such a client-side validation error is not a server
response and does not necessarily contain the server's migration text. When a call containing a
retired input reaches the server, invocation validation returns a migration error. Tool
descriptions identify the supported replacements: recall `top_k` → `limit`, `cluster` →
`is_cluster`, `mode` → `hybrid`; status `k` → `limit`, `dry_run` → `confirm`; crystallize `dry_run` → `confirm`;
store link `thought_id` → `source_id`; reflect `goals_delta` → `goals_add` / `goals_remove`;
review enqueue `max_items` → `max_proposals`. `memory_store.is_profile` has no replacement:
remove the field from requests. Retired names are not accepted aliases.

## `memory_recall` — finding and retrieving thoughts

### `action=search`

Hybrid (RRF) / vector search. Arguments: `query` (required), `cwd` (optional: it scopes the
search to one project; omitted, every project is searched, with a `meta.warnings` note), `hybrid`
(boolean, default true: RRF fusion of the vector and BM25 legs; false = vector leg only), `status`
(default active), `tag`, `is_cluster`, `group_by_cluster`, `min_importance`, `limit`,
`min_relevance`, `recency_weight`, `recency_half_life_days`, `supersession_mode`,
`contradiction_mode`.

Result: `{ items, meta }`. Each item is `{ thought }` — plus the safety annotations that apply and,
behind `compact: false`, the ranking metadata:

| Item key | When | Description |
|---|---|---|
| `thought` | always | The (shaped) thought |
| `standing` | always unless it is `current`; `compact: false` always | `superseded` or `contradicted` |
| `superseded_by` | when it applies | Ids of the thoughts that replace this one |
| `contradicted_by` | when it applies | Ids of the thoughts that contradict this one |
| `low_confidence` | when it applies; `compact: false` always | `true` for a weak vector-only hit: no BM25 anchor and a cosine below `search.confidence.vectorFloor`. Never for an id-addressed hit, which has no cosine — its contested state rides in `standing`/`superseded_by`/`contradicted_by` |
| `scores` | `compact: false` only | `{ similarity, distance, rrf_score, bm25_score, relevance, recency_score, final_score }` — only the keys that apply |
| `match_source` | `compact: false` only | `embedding`, `bm25`, `id` |

The safety annotations are never hidden by the default compact output: a superseded, contradicted
or low-confidence hit must not look clean because the caller used the default. `meta.counts.total`
is the number of candidates that survived scope/tag/standing filtering, `filtered_out` the rows the
relevance gate dropped, and `returned` the rows in `items` after the `limit` slice.

A compact hit is `{ "thought": { ... } }`; `meta` is the envelope meta described above:

```json
{
  "thought": {
    "id": "01a172b6-5dfc-73e5-b28e-91236675b273",
    "content": "MCP_DOC_MARKER: the envelope example thought",
    "status": "active",
    "tags": [],
    "project": "Doc Probe"
  }
}
```

#### Id lookup

A `query` that is a thought id resolves that thought directly, without touching the embedding or
BM25 legs (`src/db/search-id.ts`, `src/services/search-outcome.service.ts`):

- **Shape.** A full UUID (32 hex digits, hyphens optional and accepted in any position,
  case-insensitive) or a hex **prefix of at least 13 characters**. The floor is 13 because a UUIDv7
  spends its first 12 hex digits on the millisecond timestamp: below that, a hex-looking *word*
  (`20251025`, `deadbeef`) is indistinguishable from a prefix, so it stays an ordinary query.
  `01a172b4-ebd5-7` and `01A172B4EBD57` address the same prefix.
- **Scope.** The two id forms do not share a scope (`findThoughtsByIdQuery`,
  `src/db/search-id.ts`; the filters the search path hands it are
  `src/services/search.service.ts:79-87`). A **full UUID** is an explicit reference: the lookup
  applies only the cluster-shape constraint, so it ignores `status`, `cwd` (project), `tag` and
  `min_importance`, never widens to other rows, and is never touched by the relevance gate. A
  **prefix** is a timestamp window, not a reference — its first 12 hex digits are the UUIDv7
  millisecond — so it takes every scoping filter the call carries: `status`, `cwd` (project),
  `tag`, `min_importance`, plus the cluster shape. A prefix that addresses nothing *inside* that
  scope is an id miss and falls back to the ordinary search (see **None**). `meta.scope` reports
  what `cwd` resolved to either way.
- **Cluster shape.** `is_cluster` is a shape constraint of the requested collection, not a
  scope, so it applies to both forms (`findThoughtsByIdQuery`, `src/db/search-id.ts`): `clusters`
  never answers a non-cluster row, and `search` with `is_cluster: true` / `false` filters an id hit
  the same way even for a full UUID.
- **Hits.** Each hit carries `match_source: ["id"]` and no `relevance`, because an id has no
  cosine scale. Standing is annotated exactly as on any other hit — `standing`,
  `superseded_by`, `contradicted_by` — but an id is never suppressed: a requested
  `supersession_mode` of `suppress` degrades to `flag` here, because a caller who named the id
  must get that thought back. `low_confidence` keeps its retrieval-strength meaning and stays
  `false` on an id hit (there is no cosine to judge): the contested state is carried by
  `standing`/`superseded_by`/`contradicted_by`, never by the flag.
- **Several.** A prefix that addresses more than one thought returns them all in `items`, in id
  order, with `meta.reason: "ambiguous_id"`. It is not an error — narrow the prefix or pass the
  full id. The answer is capped at `limit` rows (hard ceiling 100, `ID_PREFIX_MATCH_HARD_CAP`),
  because one `bulk_create` batch shares the UUIDv7 timestamp window and a prefix can address the
  whole batch; a truncated answer still reports `ambiguous_id`.
- **None.** A miss never zeroes the answer: an id-shaped query that addresses no thought — a full
  UUID no row carries, or a prefix that matches nothing inside the requested scope — falls back
  to the ordinary hybrid search for the same text and adds an `id_not_found` note to
  `meta.warnings`. `meta.reason: "id_not_found"` is reported only when that fallback matched
  nothing either, so a hex-looking word stays searchable and its rows keep ordinary `search`
  semantics.

```json
{
  "items": [
    { "thought": { "id": "cafebabe-0000-7000-8000-000000000001", "content": "first ambiguous id thought", "status": "active", "tags": [], "project": "Doc Probe" } },
    { "thought": { "id": "cafebabe-0000-7000-8000-000000000002", "content": "second ambiguous id thought", "status": "active", "tags": [], "project": "Doc Probe" } }
  ],
  "meta": {
    "action": "search",
    "scope": { "project": "01a172b6-5dfa-754c-b67e-a0a2f5915d96", "project_name": "Doc Probe", "global": false },
    "counts": { "total": 2, "returned": 2, "filtered_out": 0 },
    "degraded": false,
    "warnings": [],
    "reason": "ambiguous_id"
  }
}
```

```json
{
  "items": [],
  "meta": {
    "action": "search",
    "scope": { "project": "01a172b6-5dfa-754c-b67e-a0a2f5915d96", "project_name": "Doc Probe", "global": false },
    "counts": { "total": 0, "returned": 0, "filtered_out": 0 },
    "degraded": false,
    "warnings": ["id_not_found: \"cafebabe-0000-7000-8000-0000000000ff\" is id-shaped but no thought carries it — the answer is a normal search for that text"],
    "reason": "id_not_found"
  }
}
```

The second answer is the fallback emptying out. When the same fallback *does* return rows, the
answer is a normal search result set — no `reason`, the `id_not_found` warning still in
`meta.warnings`, so the caller knows the query was read as an id first.

Anything else — a word, a hex run shorter than 13 characters — is an ordinary query and flows
through the semantic and lexical legs.

#### Calibrated `relevance` and the default gate

The raw e5-small cosine scale is compressed, so a raw similarity is not a usable threshold. Each
vector-leg hit therefore also carries a calibrated `relevance` in `[0, 1]`
(`calibrateRelevance`, `src/services/text-similarity.service.ts`):

```
relevance = clamp01((similarity - unrelatedFloor) / (vectorFloor - unrelatedFloor))
```

with `search.confidence.unrelatedFloor = 0.8` (measured zero point) and
`search.confidence.vectorFloor = 0.9` (a strong match) as defaults
([CONFIG.md](CONFIG.md#search)). On the defaults:

| Raw similarity | Calibrated `relevance` |
|---|---|
| 0.80 | 0.0 |
| 0.82 | 0.2 |
| 0.84 | 0.4 |
| 0.86 | 0.6 |
| 0.88 | 0.8 |
| 0.90 and above | 1.0 |

The measurement behind those two floors (task #2178, 200 sampled thoughts, 20 unrelated queries,
real e5-small embedder): unrelated query/thought pairs reach p50 0.7627, p95 0.8002, max 0.8355,
and the per-query maximum of unrelated hits reaches 0.8319 (p95) / 0.8355 (max); the p99 of
self-relevant similarity is 0.8435.

The default noise gate is **0.4 on that calibrated scale** (a raw similarity of 0.84,
`DEFAULT_MIN_RELEVANCE` in `src/services/search-normalize.service.ts`): it clears every unrelated pair
observed in the measurement while dropping 2 of 200 self-relevant top-1 hits.

- A row with a lexical (BM25) anchor or an id is **never** gated; only cosine-only rows must clear
  the bar.
- `min_relevance: 0` turns the gate off and restores the pre-#2178 fail-open result set.
- `min_relevance: <0–1>` overrides the threshold on the calibrated scale.
- `memory_recall action=context` is exempt: its query path runs with the gate off and keeps its
  best match (see `action=context` below).
- The gate runs after standing annotation and before the `limit` slice; the candidate pool is
  over-fetched so gated rows are backfilled. Drops appear as `counts.filtered_out`, not as a
  `reason`.

`degraded: true` means the answer was produced under a known loss and must not be read as complete
truth; it is still the best available answer. A search reports it for three distinct reasons:

- **A leg was unavailable** — the embedder failed or timed out, so the query ran without a vector
  leg (and on the hybrid path fell back to BM25), or the vector/BM25 query raised
  (`src/services/search.service.ts:25-46`, `src/db/search.ts:85-91`,
  `src/db/search.ts:134-142`).
- **A filtered vector leg was cut short by the candidate pool** — status, cluster and importance
  are post-KNN filters, so the leg can deliver fewer rows than the width it requested while the
  scoped filters match more embedded thoughts than it delivered (`countFilteredVectors`,
  `src/db/search-vector.ts:18`; the comparison is `src/db/search.ts:96-102`).
- **The addressed project was shut out of a full answer** — no delivered row belongs to that
  project, yet the project has embedded rows matching the same residual filters, because nearer
  `__global__` rows consumed the whole partition walk (`addressedProjectShutOut`,
  `src/db/search-vector.ts:78`; `src/db/search.ts:107-113`).

The third case belongs to the vector leg rather than to the fused answer. It fires when that leg
delivers no row of the addressed project while the project has embedded rows matching the same
residual filters: the semantic side is then known to have lost the project, not to have found the
project empty. Two consequences follow. A hybrid answer can still contain a project row surfaced by
the BM25 leg while `degraded` is true — the flag reports the lost semantic reach, not the absence of
every project row. And a project row the vector leg did deliver, dropped afterwards by the relevance
gate, is reported as `counts.filtered_out` rather than as this flag, so a caller reading only
`degraded` can still see a project-less answer; read both fields. A project with no matching
embedded row is a genuine short or empty answer, as long as no leg failed.

### `action=get`

Fetch one thought by `thought_id`. Result: `{ item, meta }` where `item` is the shaped thought.
Pass `include_edges: true` to return incident edges inline (`upstream`/`downstream`, each with the
edge and its thought); edges are not thought columns, so `compact`/`fields` shape the thoughts
inside them but never remove the edge lists. A missing id fails with a `404` error envelope.

### `action=context` / `action=chain` / `action=clusters`

`context` returns one thought plus its neighbourhood: `{ item: { thought, chain }, meta }`, where
`chain` carries `upstream`/`downstream`. It accepts a text `query` (best match + its chain; `cwd`
scopes the query path when given) or a `thought_id` (that thought + its chain, no project scope).
A degraded query with no best match answers `item: null` with `meta.reason: "no_match"` instead of
throwing. The query path is **not** gated: `context` asks for the single best match, so the
default `min_relevance` gate of `search` would turn a weak-but-real neighbourhood into
`no_match`. `getContextService` therefore runs with `minRelevance: 0` unless a caller opts in
(`src/services/graph.service.ts:161`), and the `min_relevance` argument applies to
`search`/`clusters` only.

`chain` walks a parent/develops chain: `{ item: { thought, upstream, downstream }, meta }`;
`max_degree` bounds chain/context traversal and is distinct from `limit`, which caps returned
results. `clusters` is a cluster-only search: `{ items, meta }` of search items, with `cwd`
optional like `search` (omitted, it searches every project and says so in `meta.warnings`);
an explicit `is_cluster: false` is rejected, because it contradicts what the action is. An
id-shaped query goes through the same id lookup as `search`
([Id lookup](#id-lookup)), with the cluster constraint applied to both forms — a prefix is
scoped by `status`/`cwd`/`tag`/`min_importance` and the cluster shape, while a full UUID ignores
those filters but still only answers a cluster thought: a non-cluster id answers nothing (the
ordinary search fallback runs, and `meta.reason` explains the empty answer) instead of leaking a
row the action exists to exclude (`src/mcp/tools/recall-id-lookup.test.ts:140-172`).

### `action=list`

Paginated inventory of thoughts without a search query. `cwd` is optional: it scopes the page to
one project, and omitted, the page spans every project with a `meta.warnings` note.

| Argument | Type | Required | Description |
|---|---|---|---|
| `status` | enum | no | `draft`, `active`, `archived`, or `all` (default: all) |
| `cwd` | string | no | Restrict the page to one project (omitted = every project) |
| `tag` | string | no | Restrict to thoughts carrying this tag |
| `is_cluster` | boolean | no | `true` = only clusters, `false` = only non-clusters |
| `limit` | integer | no | Page size (1–500, default 50) |
| `offset` | integer | no | Skip this many rows (default 0) |

Result: `{ items, meta }`; `meta.counts` carries the page that actually ran — `limit` and
`offset`, defaults applied — and `total` is the un-paged count matching the filters, `filtered_out`
the rows the page did not include, so a caller pages with `offset += limit` until
`offset >= total`.

```json
{
  "items": [
    { "id": "01a172b6-5dfc-73e5-b28e-91236675b273", "content": "MCP_DOC_MARKER: the envelope example thought", "status": "active", "tags": [], "project": "Doc Probe" }
  ],
  "meta": {
    "action": "list",
    "scope": { "project": "01a172b6-5dfa-754c-b67e-a0a2f5915d96", "project_name": "Doc Probe", "global": false },
    "counts": { "total": 4, "returned": 1, "filtered_out": 3 },
    "degraded": false,
    "warnings": []
  }
}
```

## `memory_store` — writing thoughts and edges

### `action=create` / `action=update`

`create` takes `content` (required), `tags`, `status`, `cwd`, `is_protected`, `is_global`,
`parent_id`, `url_links`; `update` takes `thought_id` (required) plus the fields to change
(`content`, `tags`, `tags_mode`, `status`, `url_links`, `is_protected`, `is_global`,
`surface_after`) — `cwd` is not one of them: it scopes the answer's `meta.scope` and never moves
the thought to another project. Both answer `{ item: <shaped thought>, meta }`; `update` on a
missing id fails with a `404` error envelope.

`update` is **not** an archive path: `status: "archived"` is rejected with an error envelope naming
`memory_supersede action=archive` (preview it, then `confirm: true` with the returned
`preview_token`), while `draft`/`active` transitions are unchanged. Archiving is destructive, so it
keeps its single, token-gated write path.

### `action=link`

Create an edge between two thoughts. Use canonical endpoint parameters `source_id` and `target_id`;
the retired `thought_id` alias is rejected with a hint to use `source_id`. A pair carries **one**
edge: re-linking the same pair with the same type is idempotent for the symmetric types
(`related`, `contradicts`), while a directed duplicate or a second, different type on the pair is
reported as an error — except that a `related` placeholder edge is upgraded in place to the
specific type you ask for. Constraints: no self-loops, and only a cluster thought may carry a
`cluster` edge.

| Argument | Type | Required | Description |
|---|---|---|---|
| `source_id` | string | yes | The source thought |
| `target_id` | string | yes | The target thought |
| `edge_type` | enum | no | One of `related`, `parent`, `develops`, `replaces`, `cluster`, `references`, `depends_on`, `contradicts`, `supports`; default `related` |

Result: `{ item: { id, source_id, target_id, type, created_at }, meta }`.

**Naming convention.** `source_id`/`target_id` name the pair in both writers: `memory_store`
`action=link` and `memory_supersede` `action=merge`.

```json
{
  "item": { "id": "01a172b4-d4a4-77c6-8a1e-a4d19920ef2b", "source_id": "01a172b4-d486-700c-a16e-5ae3d2d77a90", "target_id": "01a172b4-d486-700d-b4f9-02962e9d2f1c", "type": "supports", "created_at": "2026-10-25T10:56:55.972Z" },
  "meta": { "action": "link", "scope": null, "counts": { "total": 1, "returned": 1, "filtered_out": 0 }, "degraded": false, "warnings": [] }
}
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

Result: `{ items, meta }` with one row per requested link, in input order
(`{ index, status, source, target, type?, error? }`) and the aggregate in
`meta.counts.linked` / `meta.counts.failed`:

```json
{
  "items": [
    { "index": 0, "status": "linked", "source": "01a172b3-ebd5-75ba-8a66-c98fef3e3196", "target": "01a172b3-ebf3-7706-93fc-3f4af59deb28", "type": "supports" },
    { "index": 1, "status": "failed", "source": "01a172b3-ebd5-75ba-8a66-c98fef3e3196", "target": "01a172b3-ebd5-75ba-8a66-c98fef3e3196", "error": "Edge cannot link a thought to itself (source_id and target_id are the same)" }
  ],
  "meta": {
    "action": "link_batch",
    "scope": null,
    "counts": { "linked": 1, "failed": 1, "total": 2, "returned": 2, "filtered_out": 0 },
    "degraded": false,
    "warnings": []
  }
}
```

`linked` counts the accepted items (a repeated symmetric edge is an idempotent replay and counts
too) and `failed` always equals the number of rows with an `error`. An empty or over-long `links`
array is refused with an `isError` envelope before anything runs, so a batch is never applied as a
silent prefix.

### `action=unlink`

Delete a single edge by id. Deletion is **idempotent**: a missing edge is reported as
`not_found`, not an error. There is **no cascade** — only the edge row is removed; thoughts,
tags and other edges are untouched. The action is not project-scoped (`edge_id` is globally
unique), so no `cwd` is required.

| Argument | Type | Required | Description |
|---|---|---|---|
| `edge_id` | string | yes | The edge to delete |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = delete |

**Preview** (`confirm` absent/`false`) — `item` carries the preview, `meta.preview` the gate:

```json
{
  "item": {
    "status": "preview",
    "edge_id": "01a172b4-d4a4-77c6-8a1e-a4d19920ef2b",
    "edge": { "id": "01a172b4-d4a4-77c6-8a1e-a4d19920ef2b", "source_id": "01a172b4-d486-700c-a16e-5ae3d2d77a90", "target_id": "01a172b4-d486-700d-b4f9-02962e9d2f1c", "type": "supports", "created_at": "2026-10-25T10:56:55.972Z" },
    "consequence": "Removes the 'supports' edge between '01a172b4-d486-700c-a16e-5ae3d2d77a90' and '01a172b4-d486-700d-b4f9-02962e9d2f1c'.",
    "preview_token": "01a172b4-d4a5-7635-9f7a-4263e42f55d6",
    "instruction": "Call memory_store again with action=unlink, edge_id=01a172b4-d4a4-77c6-8a1e-a4d19920ef2b, confirm=true to proceed."
  },
  "meta": {
    "action": "unlink",
    "scope": null,
    "counts": { "total": 1, "returned": 1, "filtered_out": 0 },
    "degraded": false,
    "warnings": [],
    "preview": { "token": "01a172b4-d4a5-7635-9f7a-4263e42f55d6", "destructive": true }
  }
}
```

A missing edge in preview returns `item: { "status": "not_found", "edge_id": "..." }` with no
`meta.preview`.

**Execute** (`confirm: true`): `item: { "status": "deleted", "edge_id": "..." }`, or
`{ "status": "not_found", "edge_id": "..." }` if it was already gone, and no `meta.preview`.

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

Result: `{ items, meta }`, one row per edge. `meta.counts` carries
`deleted`/`preview`/`failed`. In preview mode each row carries `status: "preview"` plus the edge
details and `consequence`, and `meta.preview` reports `token: null` with the confirm instruction
(this batch issues no token):

```json
{
  "items": [
    { "edge_id": "01a172b4-d4a4-77c6-8a1e-a4d19920ef2b", "status": "preview", "edge": { "id": "01a172b4-d4a4-77c6-8a1e-a4d19920ef2b", "source_id": "01a172b4-d486-700c-a16e-5ae3d2d77a90", "target_id": "01a172b4-d486-700d-b4f9-02962e9d2f1c", "type": "supports", "created_at": "2026-10-25T10:56:55.972Z" }, "consequence": "Removes the 'supports' edge between '01a172b4-d486-700c-a16e-5ae3d2d77a90' and '01a172b4-d486-700d-b4f9-02962e9d2f1c'." }
  ],
  "meta": {
    "action": "unlink_batch",
    "scope": null,
    "counts": { "deleted": 0, "preview": 1, "failed": 0, "total": 1, "returned": 1, "filtered_out": 0 },
    "degraded": false,
    "warnings": [],
    "preview": { "token": null, "destructive": true, "instruction": "Call memory_store again with action=unlink_batch, edge_ids=[...], confirm=true to proceed." }
  }
}
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

**Preview**: `item: { status: "preview", edge_id, old_edge_id, old_type, new_type, source_id, target_id, consequence, preview_token }`
plus the same token in `meta.preview`.

**Execute**: `item: { status: "retyped", edge_id, old_edge_id, new_edge_id, old_type, new_type }`.

Errors return an [`isError` envelope](#wire-envelope): a non-existent edge
(`Edge not found`), retyping to the current type (`is already of type`), an invalid type, or a
cluster-constraint violation.

> **Id note.** Retype is a transactional delete + insert that carries `created_at` over, so
> the edge gets a **new id**. The executed answer reports both — `old_edge_id` is the id you
> passed, `edge_id`/`new_edge_id` the fresh one.

### `action=bulk_create`

Create several thoughts in one call (`thoughts[]`, 1–10000 items, in one transaction, `cwd`
optional). Result: `{ items, meta }`, one row per requested thought in input order
(`{ index, status: "created", thought }` or `{ index, status: "failed", error }`), with
`meta.counts.created` / `meta.counts.failed`.

Each item is a strict object: `content` (required), `tags`, `status`, `parent_id`, `is_protected`,
`is_global` and `url_links` — the create item shape — plus `project_id`, `source` and `relation`
(the edge type of the `parent_id` link, default `parent`, ignored without `parent_id`).
`project_id` is **per item** here: it pins that item to its own project and overrides the
`cwd`-resolved one; the top-level `project_id` stays a tombstone that rejects the whole call.

Failure splits two ways. A **schema-level** refusal — an unknown item key, a wrong type, the
retired `is_profile` — is rejected before the action runs, and writes nothing at all. A
**per-item** failure at execution (for example a `parent_id` that does not exist) yields that
item's `status: "failed"` row at its index while the rest of the batch commits, because each item
runs in its own nested transaction inside the batch's.

## `memory_supersede` — archiving and merging

All three actions preview when `confirm` is omitted or `false`; only `confirm: true` executes.
Execution re-reads/revalidates current state, so previews can become stale. Preview responses include
a `preview_token` (stored in DB, ~5 min TTL) for every destructive action (unlink, retype, archive,
archive_batch, merge, delete, auto_cluster, apply, apply_batch, rollback); `confirm: true` requires a
valid `preview_token` and fails when it is missing or stale. No transactional reservation is implied.
`archive` and `archive_batch` identify thoughts by ID and do not accept a project scope; `cwd`
applies only to `merge`.

### `action=archive`

Archives one thought (`thought_id`). Already-archived thoughts are idempotent: execution returns
the existing thought without re-stamping it.

| Argument | Type | Required | Description |
|---|---|---|---|
| `thought_id` | string | yes | Thought to archive |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = execute |

Preview: `item: { "status": "preview", "action": "archive", "thought_id": "...", "current_status": "active", "outcome": "would_archive", "preview_token": "<token>" }`
with the token mirrored in `meta.preview`. `outcome` is `not_found`, `already_archived` or
`would_archive`. Execution answers
`item: { "status": "executed", "action": "archive", "result": <shaped thought> }`; missing
thoughts fail with an error.

### `action=archive_batch`

Preview or archive 1–1000 thoughts per call. Preview reports each requested ID in input order,
including duplicates. Outcomes are `not_found`, `already_archived` or `would_archive`;
repeated IDs after their first occurrence preview as `already_archived`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `thought_ids` | string[] | yes | Thoughts to archive (1–1000 items) |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = execute |

Preview: `items` holds one row per requested occurrence (`{ "thought_id": "...", "outcome": "would_archive" }`),
`meta.counts` holds one counter per outcome (plus the shared three), and `meta.preview.token` is the
confirm token.

```json
{
  "items": [
    { "thought_id": "01a172b4-d486-700c-a16e-5ae3d2d77a90", "outcome": "would_archive" }
  ],
  "meta": {
    "action": "archive_batch",
    "scope": null,
    "counts": { "would_archive": 1, "total": 1, "returned": 1, "filtered_out": 0 },
    "degraded": false,
    "warnings": [],
    "preview": { "token": "01a172b4-d4a7-75e3-a3cb-c92314b80e3e", "destructive": true }
  }
}
```

Confirmed execution answers the same `{ items, meta }` shape with one row per requested occurrence
(`{ "thought_id": "...", "status": "archived" }` or `{ "thought_id": "...", "status": "failed", "error": "..." }`)
and `meta.counts.archived` / `meta.counts.failed`. Items are processed in input order; duplicate
IDs are idempotent. An empty or over-long array is refused with an `isError` envelope before
anything runs.

### `action=merge`

Consolidates a source thought into a target: the source's edges are recreated on the target,
the target's content/tags are replaced when supplied, the source is archived, and a `replaces`
edge target → source records the consolidation. Merging an archived source is
refused. Preview checks current eligibility and reports source/target status; it includes at
most 50 source-edge descriptors plus the full `source_edge_count` and a `truncated` flag. This
bounded list does not promise every edge will transfer.

| Argument | Type | Required | Description |
|---|---|---|---|
| `source_id` | string | yes | Thought to merge away (archived by the merge) |
| `target_id` | string | yes | Thought that survives and receives the edges |
| `merged_content` | string | no | Resulting content of the target |
| `merged_tags` | string[] | no | Resulting tag set of the target |
| `cwd` | string | no | Resolve resulting project from working directory (defaults to the target's, then the source's) |

Preview: `item` carries `status: "preview"`, `action: "merge"`, `outcome`, `source`
(`{ id, status, edges, source_edge_count, truncated }`), `target` (`{ id, status }`),
`proposed`, `effects` (`{ source_archived, target_updated, replaces_edge_created }`) and
`preview_token`; `meta.preview` mirrors the token. Missing IDs report `outcome: "not_found"`; an
ineligible merge reports `outcome: "ineligible"` and `reason`. `proposed` reflects supplied
values; `effects` describes the prospective updates. Execution answers
`item: { "status": "executed", "action": "merge", "result": { "target": <shaped thought>, "edges_transferred": 2 } }`
— `edges_transferred` is the number of source edges the target now holds, so a caller can verify
the consolidation. Not every source edge contributes: one that would collapse into a self-loop
(it joined the target to the source), a duplicate of a non-symmetric edge the target already has,
and a cluster edge the cluster rule rejects are dropped and left out of the count. An existing
symmetric pair (`related`, `contradicts`) does count — the target owns that relation after the
merge. The former HTTP twin (`POST /api/thoughts/:targetId/merge`, which executed immediately
without a preview) is gone in 0.20: `memory_supersede action=merge` is the only merge path, so
the preview→`confirm: true` contract is the whole contract ([API.md](API.md#removed-routes-020)).

## `memory_crystallize` — clusters

Three actions. `graph` (nodes + edges for a project, `status` and `limit` filters) is the one
[envelope exception](#the-memory_crystallize-actiongraph-exception): `items` are nodes and `edges`
rides beside them, with `meta.counts.total` the node count for the filters, `returned` the nodes
of the page and `filtered_out` the nodes outside it (`offset`/`limit`) — so `total = returned +
filtered_out` as for any other collection. `cluster` (create a cluster thought from `thought_ids`
with an optional `title` and `tags`) answers `item: { cluster, edges, members }`, where `cluster` and every entry of
`members` is a shaped thought, `edges` lists the `cluster` edges to the members
(`{ source_id, target_id, type }`), and `meta.counts.members`/`meta.counts.edges` repeat the two
sizes. `cwd` selects the project of the new cluster.

`auto_cluster` (Union-Find grouping over eligible active and draft thoughts, tuned by the `autoCluster.*` settings in
[CONFIG.md](CONFIG.md)) answers `{ items: <groups>, meta }` with `meta.counts.candidates` and
`meta.counts.clusters`. It previews when `confirm` is absent or false — `meta.preview` carries the
token, the consequence and the confirm instruction — and `confirm: true` executes. The retired
`dry_run` input is rejected with a hint to use `confirm`. `cwd` does not apply to `auto_cluster` —
the run is global.

Despite the name, `min_similarity` is a maximum cosine **distance**, not a minimum similarity:
neighbours qualify when their distance is strictly below the threshold. Lower values are tighter.

## `edge_review` — placement proposals

The placement review queue, owned end to end by MCP (`edge_review`). Actions: `enqueue`, `list`,
`apply`, `apply_batch`, `rollback`, `reject`. `enqueue` requires a persisted, `active`
`thought_id`; `apply`/`apply_batch`/`rollback` are preview-first and require a `preview_token`
on `confirm: true`.

- `enqueue` → `{ item: <enqueue outcome>, meta }`, with `meta.counts.proposals` and
  `meta.counts.skipped`.
- `list` → `{ items, meta }`: `items` are the queued rows for the page (retired kinds hidden unless
  `include_retired`), `meta.counts.total` the rows matching the filters ignoring the page limit,
  `meta.counts.retired_count` the retired (legacy) kinds hidden by default, and `filtered_out` the
  rows the page or the retired filter left out. The retired aliases (`proposals`, `results`, `rows`,
  `count`, `visible_count`, `returned_count`, `retired`, `retiredCount`, `hidden_retired`,
  `breakdown`) are gone; read the canonical keys above.
- `apply` → `{ item: <apply report>, meta }`; the report's `status` is `dry_run` (preview),
  `accepted`, `stale`, `failed` or `refused`, and a preview sets `meta.preview`.
- `apply_batch` → `{ items, meta }`: one row per proposal (`status` per row, failures folded in as
  `{ proposal_id, status: "failed", reason }`), with one counter per status plus `failed` in
  `meta.counts`. A run-level refusal is reported in `meta.warnings`.
- `rollback` → `{ items, meta }`: the per-row report is `items` and its summary
  (`reverted`/`skipped`/`refused`) is `meta.counts`; a preview sets `meta.preview`.
- `reject` → `{ item: <reject report>, meta }`.

## `retention_review` — retention candidates

Retention review is a manual workflow, not a scheduled deletion policy: nothing is archived or
deleted until a caller runs `delete` or `compact`. A thought is a candidate only when every signal
holds at once — status `archived` or `draft`, an age anchor (`archived_at`, falling back to
`created_at`) older than the minimum age, importance below the floor (a missing importance row
counts as `1.0`), no recorded hits (a missing count is `0`), no incoming edge from an `active`
thought, not protected, `surface_after` absent or already due, and not global
(`src/db/retention-review.ts`).

`action=list` filters are the call's eligibility control; each one falls back to the server setting,
so a single call can narrow eligibility or page without reconfiguring anything
([CONFIG.md](CONFIG.md#retention-review)):

| Argument | Type | Default | Description |
|---|---|---|---|
| `min_age_days` | number | `retentionReview.minAgeDays` (30) | Minimum age in days, measured from the age anchor; must be positive |
| `importance_floor` | number | `retentionReview.importanceFloor` (0.3) | Candidate importance must stay below this value (0–1) |
| `limit` | int | `retentionReview.pageSize` (20) | Page size (1–100) |
| `offset` | int | `0` | Pagination offset |

```json
{ "action": "list", "min_age_days": 90, "importance_floor": 0.1, "limit": 50, "offset": 0 }
```

- `list` → `{ items: <candidates>, meta }`; `meta.counts` carries the page (`limit`, `offset`) plus
  the shared three, where `total` is the candidate count for the filters ignoring the page
  (`src/mcp/tools/retention-review.ts`). Candidates come back oldest first (age anchor ascending),
  then by id, with `content` truncated to 200 characters; `compact` and `fields` apply as on every
  other read tool. The query spans every project — a candidate carries its `project_id`/
  `project_name`, and no `cwd` narrows the list.
- `protect` → `{ item: <protect report>, meta }`.
- `delete` → `{ item: <delete report>, meta }`; the preview `item` carries
  `status: "preview"`, `action: "preview"`, `deleted: false`, `preview: true`, `confirm: false`,
  `thought_id`, `dependents`, `instruction` and `preview_token`, and `meta.preview` mirrors the
  token (with the instruction as its `consequence`). Confirming requires the token.
- `compact` → `{ item, meta }`; input is a non-empty `source_ids` array (1–1000 ids) plus a
  `summary` object (`content` required, `tags` and `project_id` optional). The preview `item`
  carries `status: "preview"`, `preview: true`, `confirm: false`, `source_ids` and `instruction`,
  and `meta.preview` reports `token: null` (this action confirms on `confirm: true` alone). The
  executed item carries `status: "compacted"`, `preview: false`, `confirm: true`, `source_ids` and
  the shaped `summary` thought; `meta.counts.sources` is the number of compacted sources. The
  summary is created `active` and protected, and every source is merged into it — archived with its
  edges transferred, not hard-deleted (`src/services/retention-review-actions.service.ts`).

## `memory_reflect` — session reflection

`cwd` is optional for both actions, though the two use it differently. `action=reflect` is **not
read-only**: it writes slots and thoughts, and answers `{ item: <counts>, meta }`.

- `summary` is appended (with a timestamp) to the `project_context` slot.
- `goals_add` adds goals to `active_goals`; `goals_remove` removes stored goal lines when the
  supplied text matches as a case-insensitive substring. The retired `goals_delta` parameter is
  rejected with a hint to use `goals_add` / `goals_remove`.
- `decisions` creates **active** thoughts tagged `decision` + `reflect`. Entries
  sufficiently similar to an existing non-archived `decision` in the same project are skipped
  (Jaccard ≥ 0.6 on normalised text), as are exact live-content duplicates of any tag.
- `pending` creates **draft** thoughts tagged `pending` + `reflect`, with
  `surface_after = now + wake_days` (default 7, range 1–365). A pending thought is invisible
  to the frontier until that time, then surfaces with reason `pending` and in the
  `pending_items` slot. An existing live thought with the same content in the project is
  left unchanged and is not counted as newly created.

```json
{
  "item": { "summary_appended": true, "goals_added": 0, "goals_removed": 0, "decisions_created": 0, "pending_created": 0 },
  "meta": {
    "action": "reflect",
    "scope": { "project": "01a172b4-d49b-76f4-ada8-7ba408661064", "project_name": "Doc Probe", "global": false },
    "counts": { "total": 1, "returned": 1, "filtered_out": 0 },
    "degraded": false,
    "warnings": []
  }
}
```

The `reflect` tag marks **every** thought `reflect` created (next to the semantic tag), so the
output is identifiable and can be filtered (`memory_recall` with `tag: "reflect"`) or cleaned up
without touching hand-created thoughts. It is additive: statuses, dedup and the scheduled
surface time are unchanged, and no read path keys off it.

A `cwd`-less `reflect` is a write without a project scope, and its outputs split: `summary`
and `goals_add`/`goals_remove` land in the **global** `project_context`/`active_goals` rows (a slot
is project-scoped only when a project resolved,
`src/services/session-reflection.service.ts:106`), while `decisions` and `pending` thoughts are
created in the default project (`src/services/session-reflection.service.ts:171-186`,
`:198-207`). The answer reports `meta.scope: null` and raises no warning, like every other write
(`writeEnvelopeScope`, `src/mcp/tools/envelope.ts:222-228`). With a registered `cwd`, all of them
land in that project instead; a path no project owns behaves like an absent one (rows for the default
project, slot edits global) and still raises no warning.

`action=timeline` is the plain paginated thought list (`status`, `cwd`, `limit`, `offset`) as
`{ items, meta }`; `cwd` scopes it to one project, and omitted, it lists every project with the
standard `no cwd` warning. `meta.counts` carries the `limit` and `offset` that actually ran
(defaults applied) beside the shared `total`/`returned`/`filtered_out`.

## `memory_primers` — the always-at-hand set

### `action=list`

Lists the primers, most-hit first. A primer is a pointer to a thought that was promoted after
repeated recalls, so an agent can inject project context without a search. The list is capped
(500 rows by default).

No arguments. Answers `{ items, meta }`, where each item is
`{ id, thought_id, hit_count, promoted_at, created_at }` (`Primer`, `src/db/primers.ts`).

### `action=delete`

Removes one primer from the always-at-hand set. The **thought itself is not deleted** — only the
primer row. Deletion is **idempotent**: a missing primer is reported as `not_found`, not an error.

| Argument | Type | Required | Description |
|---|---|---|---|
| `primer_id` | string | yes | The primer to delete |
| `confirm` | boolean | no | Absent/`false` = preview; `true` = delete |

**Preview** (`confirm` absent/`false`): `item` carries `status: "preview"`, `primer_id`, `primer`,
`consequence`, `preview_token` and `instruction`; `meta.preview` mirrors the token. A missing
primer in preview returns `item: { "status": "not_found", "primer_id": "..." }` with no
`meta.preview`.

**Execute** (`confirm: true`): `item: { "status": "deleted", "primer_id": "..." }`, or
`{ "status": "not_found", "primer_id": "..." }` if it was already gone.

## `memory_status` — system state

For this tool, retired `k` is replaced by `limit` (the frontier page/result limit). Depending on the MCP client,
never-valued retired arguments may be rejected by local schema validation before a request reaches
the server; if the request is sent, invocation validation returns the migration error.

### `action=slots` (read-only)

`cwd` is optional: with a resolved project the project-scoped slot row wins over the global fallback.
Without one only the **global** rows are read, and `meta.warnings` adds a second note:

`no project scope — the project-scoped slot overrides were not applied (pass cwd to read them)`

That warning follows the resolved project, not the argument: it fires without `cwd`, with a blank
one and with a path no project owns, but never with a registered path
(`src/mcp/tools/status/slots.ts:11-12`, `:35-38`; the read is
`src/services/slots.service.ts:94-97`). Answers `{ items, meta }` with one item per slot
(`{ name, scope, virtual, content, truncated, max_chars, updated_at }`). Slots are **read-only**
through this tool: it never writes. `pending_items` is derived from thoughts tagged `pending` (the
same set the frontier surfaces); `architecture_decisions` from primers (most-hit first);
`project_context` and `active_goals` are stored rows. To change slot content, update or archive the
underlying thoughts (virtual slots) or use `memory_reflect` (`summary` appends to
`project_context`; `goals_add` and `goals_remove` edit `active_goals`). Paging applies to
`pending_items` via `slots_limit`/`offset`.

### `action=frontier`

`cwd` is optional: with it the answer is the frontier of one project, and omitted, it spans every
project with `meta.scope: null` and the `no cwd — the answer spans every project` warning. Answers
`{ items, meta }` with the frontier entries, `limit` (1–50) bounding the page.

### `action=config` / `action=health`

Both are read-only and take no `cwd`. `config` answers the raw-text display described in
[Wire envelope](#wire-envelope) — `content[].text` verbatim, `structuredContent.result.item.text`
the same string. `health` answers `{ item: <report>, meta }`; pass `include_details: true` for the
per-check detail arrays (omitted, and content fields shortened, by default).

### `action=propose`

Read-only placement plan (placement, edges, lifecycle); never writes. `cwd` is optional, but this
reader never widens: with it the plan is restricted to that project, and without it — or with a path
that resolves to no project — the plan stays pinned to the project of the thought it addresses
(`thought_id`), or to the default project for draft `content`.

A cwd-less call says so in `meta.warnings`, in place of the `no cwd — the answer spans every project`
note:

`no cwd — propose is not cross-project: the plan is restricted to the project the addressed thought (thought_id) belongs to`

and, for draft content,
`no cwd — propose is not cross-project: the plan is restricted to the default project (draft content)`.

A path that resolves to no project gets **one** composed warning instead of the generic note, so
`meta.warnings` holds a single string — the unknown-path fact with its resolve hint, then the pinning
clause, and no `the answer spans every project` claim:

`cwd "<path>" matches no known project (check it with memory_manage action=resolve) — propose is not cross-project: the plan is restricted to the project the addressed thought (thought_id) belongs to`

and, for draft content,
`cwd "<path>" matches no known project (check it with memory_manage action=resolve) — propose is not cross-project: the plan is restricted to the default project (draft content)`.

`meta.scope` stays the unresolved `{ project: null, project_name: null, global: true }` in that case:
the warning, not the scope, records that the plan stayed inside one project
(`src/mcp/tools/status/propose.ts:24-36`).

Answers `{ item: <plan>, meta }`; default output is slim (top 3 edges, no signals) — pass
`include_signals=true` or `compact=false` for full output. `meta.counts.total` is the number of
planned edges and `meta.degraded` mirrors the plan's degraded flag.

## `memory_manage` — projects

CRUD over projects plus resolution from a path.

- `list` → `{ items: <projects>, meta }` (`fields` narrows each project row).
- `create` → `{ item: <project>, meta }`.
- `update` requires `project_id` → `{ item: { success: true, project_id }, meta }`.
- `delete` requires `project_id` and is preview-first: the preview `item` carries
  `action: "preview"`, `project`, `thought_count`, `consequence`, `instruction` and `preview_token`
  (`meta.preview` mirrors the token), and its `consequence` states that a moved thought colliding
  on content with a live row in the destination may be archived instead of kept live — the oldest
  live row per content survives, whichever side it came from; the executed `item` carries
  `action: "deleted"`, `project`, `thoughts_moved`, `moved_to`, `thoughts_archived` and
  `archived_thought_ids`.
- `resolve` → `{ item: { id, name, local_path }, meta }`.

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

## Migration notes (response envelope, cwd scope, id lookup)

Breaking changes for MCP clients (the HTTP surface has no thought endpoints to be affected —
see [API.md](API.md)):

1. **One response envelope.** Collections answer `{ items, meta }`, single objects
   `{ item, meta }`; `meta` carries `action`, `scope`, `counts`, `degraded`, `warnings` and,
   where applicable, `reason` and `preview`. Per-action payload keys are gone: the read array
   used to arrive under `thoughts`, `proposals` or as a bare array, and write answers used to
   carry their own top-level keys (`linked`/`failed`, `archived`, `status` at the root, ...).
   Read `items`/`item` and `meta.counts` instead. Write-side answers that used to be a bare
   object now nest it under `item`. The one exception is
   `memory_crystallize action=graph` (nodes in `items`, edges beside them).
2. **`cwd` is optional.** No action rejects a call without `cwd` except `memory_manage
   action=resolve`, where the path is the input rather than a scope. `memory_recall`
   `search`/`clusters`/`list`, `memory_status` `slots`/`frontier` and `memory_reflect`
   `reflect`/`timeline` (plus the older optional readers `memory_recall context`,
   `memory_crystallize graph`/`cluster` and `edge_review list`) answer across every project when
   `cwd` is absent, with `meta.scope: null` and a `no cwd — the answer spans every project`
   warning; `memory_status action=slots` adds that only the global slot rows were read. An
   unknown-but-present `cwd` keeps answering globally, with its own warning.
   `memory_status action=propose` is the exception among the readers: it takes `cwd` but never
   widens, and a cwd-less call keeps the plan pinned to the addressed thought's project (or to the
   default project for a draft) with a `no cwd — propose is not cross-project: ...` warning instead
   of the broadening note. An unknown-but-present `cwd` gets a single composed warning instead — one
   string that carries the unknown-path fact and then the pinning clause,
   `cwd "..." matches no known project (check it with memory_manage action=resolve) — propose is
   not cross-project: ...` — so nothing claims the answer spans every project.
   `memory_reflect action=reflect` is a write: without `cwd` its `decisions`/`pending` thoughts go
   to the default project and its `summary`/`goals` to the global slots, with no warning.
3. **Preview gate moved.** A preview answer always sets
   `meta.preview = { token, destructive: true, consequence?, instruction? }` (token `null` for
   `unlink_batch` and `retention_review` `compact`). Single-object previews keep the same fields
   inside `item` as before; collection previews no longer carry `preview_token` at the top level.
4. **Id-shaped search queries resolve by id.** A full UUID or a hex prefix of at least 13
   characters no longer goes through semantic search: it returns that thought, annotated with its
   standing but never suppressed. A full UUID ignores status and project scope; a prefix honours
   both and falls back to the word search when it matches nothing inside that scope. A prefix
   that addresses several thoughts answers every match (at most `limit` rows) with `reason:
   "ambiguous_id"`; when nothing carries the id, the answer is the ordinary search for the same
   text plus an `id_not_found` note in `warnings` (`reason: "id_not_found"` only when that
   fallback is empty too). `low_confidence` keeps its retrieval-strength meaning and is never set
   on an id hit (it means "no BM25 anchor and a cosine below the floor", and an id hit has no
   cosine at all), so a client that drops low-confidence rows cannot lose the exact thought it
   asked for; the contested state of an id hit rides in `standing`/`superseded_by`/
   `contradicted_by` instead.
5. **Calibrated `relevance` and a default noise gate.** Vector hits carry `relevance` on the
   measured 0–1 scale (`unrelatedFloor` 0.8 → 0, `vectorFloor` 0.9 → 1), and the default gate
   drops cosine-only rows below 0.4. `min_relevance: 0` restores the old fail-open set.
   `search.confidence.unrelatedFloor` is the new zero-point setting.
6. **Output hygiene.** Tags are plain strings and the flag columns are booleans everywhere;
   scoring metadata (`scores`, `match_source`) lives behind `compact: false`, while safety
   annotations stay visible in compact output.

## Migration notes (v0.19 MCP UX cleanup)

Breaking changes for MCP clients:

1. **Project scoping uses `cwd`.** Tools that removed their `project_id` scope
   argument reject it with `project_id was removed; use cwd`; pass `cwd` instead.
   `memory_manage` is an exception: its `update` and `delete` actions require
   `project_id` to identify the project.
2. **Compact defaults.** `memory_recall` now defaults to compact output; pass
   `compact: false` for full thoughts. `memory_status` `propose` defaults to the
   slim plan (top 3 edges, no signals); pass `compact: false` or
   `include_signals: true`. Other read tools stay full by default; opt in with
   `compact: true`. Explicit `fields` always win.
3. **Preview tokens required.** Every destructive action (`memory_store`
   `unlink`/`retype`, `memory_supersede` `archive`/`archive_batch`/`merge`,
   `memory_manage` `delete`, `edge_review` `apply`/`apply_batch`/`rollback`,
   `memory_primers` `delete`, `memory_crystallize` `auto_cluster`,
   `retention_review` `delete`) now returns a `preview_token` on preview and
   requires it (valid, unexpired) on `confirm: true`. Tokens live ~5 minutes.
4. **`edge_review` list trimmed.** Response uses canonical keys only:
   `items`, `total`, `returned`, `retired_count`, `all_total`. Retired aliases were
   removed.
5. **Retired inputs.** `top_k`→`limit`, `cluster`→`is_cluster`, `k`→`limit`,
   `dry_run`→`confirm`, `thought_id` (link)→`source_id`, `goals_delta`→
   `goals_add`/`goals_remove`, `max_items`→`max_proposals`, `mode`→`hybrid`.
   `is_profile` has no replacement — remove the field. Retired names are not
   accepted aliases.

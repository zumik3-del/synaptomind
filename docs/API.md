# HTTP API Reference

The SynaptoMind HTTP listener is an **ops plane**, not a general REST API. Default base
URL: `http://127.0.0.1:3005` (configurable through `server.port` / `SYNAPTOMIND_PORT`,
see [CONFIG.md](CONFIG.md)). Exactly three routes are mounted:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness/readiness probe (public) |
| `GET` | `/api/health-check` | Graph health report |
| `POST` | `/api/health-check/repair` | Preview/confirm graph repair |

**Everything else is MCP.** Thoughts, edges, search, clusters, projects, tags, primers,
slots, proposals and reflection are served by the MCP tools over stdio
(`synaptomind --stdio`) or HTTP (`POST /mcp` on port 3006). The route-by-route map of the
endpoints removed in 0.20 is in [Removed routes](#removed-routes-020), and the tool
reference is [docs/mcp-tools.md](mcp-tools.md). The two surfaces are sibling adapters over
one service layer, so no HTTP operation is missing from MCP except the four capabilities
listed in [Migration notes](#migration-notes-v020-http-shrink).

A removed route fails loudly with Hono's default `404` — there is no deprecation shim and
no `410 Gone` window.

- **Auth:** the two `/api/*` endpoints require `Authorization: Bearer <token>` (`401
  {"error":"Unauthorized"}` otherwise). The token is `SYNAPTOMIND_SECRET` (or the optional
  `SYNAPTOMIND_SERVICE_TOKEN`). Without either token the server fails closed;
  `SYNAPTOMIND_ALLOW_INSECURE=true` disables auth for local development only. `GET /health`
  is public.
- **Rate limit:** `/api/*` is rate limited per client address (`rateLimit.max` per
  `rateLimit.windowMs`; `429 {"error":"Rate limit exceeded"}`). The API keeps its own
  counter store, separate from the MCP transport's. `/health` is not rate limited — it must
  stay cheap enough to poll from a container healthcheck.
- **Body limit:** request bodies over 5 MB are rejected with `413
  {"error":"Request body too large (max 5MB)"}`.
- **Errors:** handlers return `{"error": "..."}` with an appropriate HTTP status — `400`
  validation, `401` auth, `404` not found, `409` conflict, `413` too large, `429` rate
  limited, `500` internal, `503` a dependency is not ready (the embedder still loading) or a
  degraded `/health`.
- Curls omit the `Authorization` header here; add
  `-H "Authorization: Bearer $SYNAPTOMIND_SECRET"` to every `/api/*` call.

## Health

### GET /health

Public liveness/readiness probe (no auth, no rate limit, no graph queries). Returns `200`
when healthy and `503` when degraded.

```bash
curl http://127.0.0.1:3005/health
```

```json
{"status": "ok", "version": "0.19.1", "checks": {"database": "ok", "embedder": "ok"}}
```

`version` is the running package version (`src/version.ts`, inlined from `package.json` at
build time). Degradation is **DB-only by design**: `checks.database` failing turns
`status` into `"degraded"` and the response into a `503`, while `checks.embedder`
(`ok` / `not ready` / `failed`) is reported but never counted. The embedder needs a long
first load (model download), and the deploy/update gate fetches `/health` with `curl -f` —
a `503` there would discard the very payload that explains the failure
(`src/services/health.service.ts`).

### GET /api/health-check

Graph health audit: broken links, orphans, duplicates, structural issues. Requires auth
(it lives under `/api/*`). The response is `{summary, categories}`. `categories` is an
array of `{name, checks}`; each check reports `name`, `severity`, `count`, and `details`,
and checks with a safe repair hook also report `auto_fixable: true`.

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| severity | query | string | optional | Minimum severity: `critical`, `warning`, or `info` |

```bash
curl 'http://127.0.0.1:3005/api/health-check?severity=warning' \
  -H "Authorization: Bearer $SYNAPTOMIND_SECRET"
```

`summary` includes graph counts (`total_thoughts`, `total_edges`, `total_clusters`,
`active`, `draft`, `archived`), `health_score`, and raw issue counts by severity. The
severity counts are currently emitted under duplicate aliases: `critical`/`warning`/`info`,
`critical_count`/`warning_count`/`info_count`, `critical_issues`/`warning_issues`/
`info_issues`, and the grouped `issues: {critical, warning, info}`. Score details are
likewise duplicated as `score_breakdown`, `score_composition`, `score_explanation`,
`score_components`, and `score_details` (the same object), plus `score_formula` and
`formula` (the same formula string). These compatibility aliases are part of the current
response and must remain until a separately reviewed deprecation/removal plan.

`score_breakdown` fields are `critical_categories`, `warning_categories`,
`info_occurrences`, `info_scored_occurrences`, `info_unscored_checks`,
`penalty_critical`, `penalty_warning`, `penalty_info`, and `formula`. Critical and warning
penalties count categories with findings (40 and 15 points); info penalty counts scored
occurrences (0.25 each), clamped to a score from 0 to 100. `island_thoughts` occurrences
are reported but not scored. The `severity` filter also filters which findings and summary
counts contribute to that response.

The same report is available to an agent as `memory_status action=health`; the route is
kept because an ops surface must be reachable without an MCP client (monitoring, a shell
on the box, a CI job, a pre-agent bootstrap check).

### POST /api/health-check/repair

Preview or execute the safe repairs of the report. Archives thoughts instead of deleting
them; edges are removed. Body: `{ confirm?: boolean, preview_token?: string, severity?:
string }`. Omit `confirm` (or send `false`) to preview — the answer carries `status:
"preview"`, `action: "repair"`, a `preview_token` and the `repairable` list (`{category,
name, count}`); re-issue with `confirm: true` and that token to execute. A missing,
unknown or stale token is a `400`.

```bash
curl -X POST http://127.0.0.1:3005/api/health-check/repair \
  -H "Authorization: Bearer $SYNAPTOMIND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The token is bound to a fingerprint of the report it previewed, so a repair must be
confirmed against the state it was previewed on.

#### Accepted graph-health trade-offs

The following graph-health behaviours are accepted trade-offs rather than defects (ADR:
`synaptomind/adr/2026-09-28-928-health-overlinked-clusterless-adr.md`; tasks #934/#935):

- `overlinked_thoughts` (connectivity, warning) — active non-cluster thoughts above the finder's `maxEdges`. The flagged set is curated cross-domain hubs, not link decay: on the reference dataset active non-cluster thoughts average 4.66 edges, while the 31 flagged hubs sit at 11–24. Raising the threshold cannot change `health_score` and would only hide signal.
- `clusterless_dense_thoughts` (cluster health, warning) — transient. The finder is age-gated to the same `autoCluster.minAgeDays` window auto-cluster uses (task #935), so it reports only thoughts old enough for the clusterer to act on (see `src/db/health-check/clusters.ts`).
- `health_score` penalises the presence of a flagged *category*, not occurrence counts: `100 − criticalCategories×40 − warningCategories×15 − scoredInfoOccurrences×0.25`, clamped to `[0,100]`. Because the `info` term is per-occurrence, clearing a single `overlinked_thoughts` hub does not move it (`src/services/health-check.service.ts`).
- `island_thoughts` is an informational *coverage* finding and is exempt from the `info` term. Publishing a thought (`status: active`) before linking it makes it an island, so charging each island would score correct publishing as a regression and discourage it (task #1967). Islands stay visible in `summary.info` and in the `connectivity` category; `score_breakdown` reports the charged count as `info_scored_occurrences` and names the exempt findings in `info_unscored_checks`. Critical and warning categories are unaffected.

Findings about *live* claims deliberately ignore `archived` endpoints. Archiving only flips the `status` column — the edges stay attached (`src/db/thoughts.ts`) — and the documented supersession flow (link `replaces`, then archive the target) does not transfer them, so a retired endpoint would otherwise be flagged forever after a correct procedure:

- `contradiction_in_cluster` reports only when both contradicting cluster members are non-archived. Both-archived pairs remain visible as the `contradicts_to_archived` info finding (a cleanup candidate).
- `duplicate_content` likewise excludes archived on both sides (merge archives its source, so the pair would stay flagged).
- `broken_parent_chains` ignores edges whose *source* is archived, and reports live-source edges pointing at an `archived`/`draft` target — its autofix deletes the archived-target ones.

## Removed routes (0.20)

The 43 `/api/*` routes that 0.20 removed, and the MCP action that answers the same
question. `—` means the capability was **dropped**, not moved: see
[Dropped capabilities](#dropped-capabilities). Arguments, response shapes and examples for
every replacement live in [docs/mcp-tools.md](mcp-tools.md).

### Thoughts

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/thoughts/search` | `memory_recall action=search` (or `clusters`) |
| `GET` | `/api/thoughts/timeline` | `memory_reflect action=timeline` |
| `POST` | `/api/thoughts` | `memory_store action=create` |
| `POST` | `/api/thoughts/bulk` | `memory_store action=bulk_create` |
| `GET` | `/api/thoughts/:id` | `memory_recall action=get` |
| `PUT` | `/api/thoughts/:id` | `memory_store action=update` |
| `DELETE` | `/api/thoughts/:id` | `memory_supersede action=archive` |
| `GET` | `/api/thoughts/:id/edges` | `memory_recall action=chain` |
| `GET` | `/api/thoughts/members/:id` | — (dropped) |
| `POST` | `/api/thoughts/propose` | `memory_status action=propose` |
| `POST` | `/api/thoughts/:targetId/merge` | `memory_supersede action=merge` (preview, then `confirm: true`) |

### Retention review

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/thoughts/retention-review` | `retention_review action=list` |
| `POST` | `/api/thoughts/retention-review/compact` | `retention_review action=compact` |
| `POST` | `/api/thoughts/:id/retention-review/protect` | `retention_review action=protect` |
| `POST` | `/api/thoughts/:id/retention-review/delete` | `retention_review action=delete` (preview, then `confirm: true`) |

### URL links

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/thoughts/:id/links` | `memory_recall` with `include_url_links: true` |
| `GET` | `/api/thoughts/links/batch` | `memory_recall` with `include_url_links: true` (any page: `search`/`clusters`/`list`) |
| `POST` | `/api/thoughts/:id/links` | `memory_store action=create` with `url_links` (create time only) |
| `DELETE` | `/api/thoughts/:id/links/:key` | — (dropped) |

### Tags

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/tags` | — (dropped) |
| `PUT` | `/api/tags/:id` | — (dropped) |
| `DELETE` | `/api/tags/:id` | — (dropped) |

### Links

| Method | Path | Use instead |
|---|---|---|
| `POST` | `/api/thoughts/:id/link` | `memory_store action=link` |
| `DELETE` | `/api/edges/:id` | `memory_store action=unlink` (preview, then `confirm: true`) |

### Graph and cluster

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/graph` | `memory_crystallize action=graph` |
| `POST` | `/api/cluster` | `memory_crystallize action=cluster` |

### Review

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/proposals` | `edge_review action=list` |
| `POST` | `/api/proposals` | `edge_review action=enqueue` |
| `POST` | `/api/proposals/:id/apply` | `edge_review action=apply` (preview, then `confirm: true`) |
| `POST` | `/api/proposals/rollback` | `edge_review action=rollback` (preview, then `confirm: true`) |
| `POST` | `/api/proposals/:id/reject` | `edge_review action=reject` |

### Projects

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/projects` | `memory_manage action=list` |
| `GET` | `/api/projects/resolve` | `memory_manage action=resolve` |
| `POST` | `/api/projects` | `memory_manage action=create` |
| `PATCH` | `/api/projects/:id` | `memory_manage action=update` |
| `GET` | `/api/projects/:id` | `memory_manage action=list` (there is no id-scoped read) |
| `DELETE` | `/api/projects/:id` | `memory_manage action=delete` (preview, then `confirm: true`) |

### Primers and slots

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/primers` | `memory_primers action=list` |
| `DELETE` | `/api/primers/:id` | `memory_primers action=delete` (preview, then `confirm: true`) |
| `GET` | `/api/slots` | `memory_status action=slots` |
| `PUT` | `/api/slots/:name` | — (dropped; slots are written by `memory_reflect action=reflect`) |
| `POST` | `/api/slots/reflect` | `memory_reflect action=reflect` |

### Frontier

| Method | Path | Use instead |
|---|---|---|
| `GET` | `/api/frontier` | `memory_status action=frontier` |

## Dropped capabilities

Four capabilities had no MCP twin, so removing the route removed the feature. None of them
had a consumer outside the route itself (no `deploy/`, `eval/`, `scripts/` or
documentation example called them):

- **Tag list / rename / delete.** Tags are set through `memory_store create`/`update`;
  there is no global tag management anymore. A tag name is corrected by rewriting the
  thoughts that carry it, and orphan tag rows are pruned on thought writes
  (`pruneOrphanTags`).
- **Explicit slot write** (`PUT /api/slots/:name`). Slot content is agent-authored through
  `memory_reflect action=reflect`; a hand-edit API contradicts "reflect, don't hand-edit
  memory".
- **Cluster member listing** (`GET /api/thoughts/members/:id`). Membership is visible from
  the member side: `memory_recall action=chain` on a member shows its `cluster` edge from
  the cluster thought (`src/services/cluster.service.ts`), and `memory_crystallize
  action=graph` returns the cluster edges of a project.
- **URL-link delete and URL-link upsert on an existing thought.** `memory_store
  action=create` is the only URL-link writer, so a link can be attached at create time only
  and cannot be removed or added afterwards; it can be corrected by recreating the thought.
  This is the known capability gap of the 0.20 shrink; the intended future home is
  `memory_store action=update` with `url_links` (replace-set semantics), not a new tool.

## Migration notes (v0.20 HTTP shrink)

1. **`/api/*` is now an ops plane.** `GET /api/health-check` and `POST
   /api/health-check/repair` are the only `/api` endpoints; `/health` is unchanged and
   still public. Every other former route answers `404`.
2. **Agents move to MCP.** The same operations exist as MCP tools over stdio
   (`synaptomind --stdio`) or HTTP (`POST /mcp` on port 3006). The
   [route table](#removed-routes-020) above is the full map.
3. **Auth and rate limiting are unchanged** for the two `/api` survivors; `/health` stays
   unauthenticated and unrated. The 5 MB body guard still protects the repair route.
4. **URL links** are read through `memory_recall` with `include_url_links: true` (any of
   `search`/`clusters`/`list`/`get`/`context`/`chain`) and `memory_reflect
   action=timeline`; they are written only at create time (`memory_store action=create`,
   `url_links`). See [docs/mcp-tools.md](mcp-tools.md#opt-in-url-links).
5. **Dropped without replacement:** tag list/rename/delete, explicit slot write
   (`PUT /api/slots/:name`), cluster-member listing, URL-link delete/upsert — see
   [Dropped capabilities](#dropped-capabilities).
6. **This page** is the ops-endpoint reference; all route-level operation documentation now
   lives in [docs/mcp-tools.md](mcp-tools.md).

There is no deprecation cycle: 0.20 removes all 43 routes at once, because a 0.x minor is
the breaking slot and a shim would keep the two wire contracts — and their drift — alive
for one more release. A client that still calls a removed route gets a `404`, never a
plausible-but-different answer (ADR
`synaptomind/adr/2026-10-26-shrink-http-api-to-ops-endpoints.md`).

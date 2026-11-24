# Architecture

The map to read before changing `src/`: the layers and the rules that bind them, the processes that
run, one read and one write traced end to end, the dependency-injection convention, the per-user
database model, and where the code-tier map lives. Every claim below names the symbol or file that
carries it at `c668c321`. Wire-level detail — arguments, envelopes, error shapes — lives in
[docs/mcp-tools.md](mcp-tools.md) and [docs/API.md](API.md) and is not repeated here.

## Layers

```
src/api/  src/mcp/     ← transports: parse arguments, serialise the envelope
        ↓
src/services/          ← validation, orchestration, transactions, policy
        ↓
src/db/                ← SQL, rows, DDL (db/schema/), migrations (db/migrations/)
```

| Layer | Owns | Must never |
| --- | --- | --- |
| `src/api/`, `src/mcp/` | Parsing, auth surface, response envelopes | Issue SQL, open transactions, hold policy |
| `src/services/` | Validation, transactions, orchestration, policy | Issue SQL (one exception below) |
| `src/db/` | SQL, row shapes, schema, migrations | Derive config, decide whether to log, import any layer above it |

`src/api/` and `src/mcp/` are sibling adapters over the same service layer, not a chain: an HTTP
handler and an MCP tool call the same service function ([docs/API.md](API.md)).

### The rules are machine-enforced

Two scan tests read the tree and fail on a violation, so a layering slip is a red test rather than a
review question.

`src/db/db-boundary.scan.test.ts` — its `the db layer boundary` describe block holds seven tests:

1. `db/ imports no layer above it` — no import from `context/`, `services/`, `api/`, `mcp/` or
   `errors` (`UPPER_LAYER`).
2. `db/errors.ts imports nothing from src/`.
3. `db/index.ts is the only way to the handle surface` — `getDb`, `setDb`, `register`, `als` and
   friends are reachable only through the barrel (`DOOR`); `db/init.ts` is the one exception
   (`HANDLE_EXCEPTION`), because the barrel re-exports `init`.
4. `context/ imports db/, and db/ never imports context/`.
5. `db/ imports logging only where the caller cannot observe the outcome` — three audited sites:
   `db/pending-embeddings.ts`, `db/search-bm25.ts`, `db/search-vector.ts` (`LOGGING_EXCEPTIONS`).
6. `no module reaches a forbidden one through import() or require()`.
7. `every specifier is normalised to its extensionless module path`.

`src/mcp/tools/thin-tools.test.ts` — `tool-layer layering guard`: no production tool module
imports `src/db`, `src/logging` or `bun:sqlite` (`FORBIDDEN_SPECIFIER`); tools reach storage
through services only.

Two deliberate seams that look like violations and are not:

- `src/errors.ts` re-exports eight classes from `db/errors.ts` (the six edge/content conflicts plus
  `NotFoundError` and `ValidationError`). It stays cycle-free and neutral against `services`/`api`/
  `mcp`, but it depends on the db layer by design.
- `src/services/health.service.ts` `probeDatabase` is the only service function that issues SQL:
  `db.prepare('SELECT 1')` in `src/services/health.service.ts:81`. Its whole job is to observe
  database unavailability instead of throwing, so the probe cannot be delegated to the db layer
  without the caller having to distinguish a failure from a report.

The connection handle itself lives in `src/db/handle.ts` (default handle, per-user registry,
`AsyncLocalStorage`) and is exported only through `src/db/index.ts`.

## Runtime modes

One Bun process per mode; the embedder is the only child.

| Mode | Entry | What runs |
| --- | --- | --- |
| HTTP ops plane | `src/index.ts` → `serve({ fetch: app.fetch })` → `src/app.ts` → `createApp` in `src/api/router.ts:9` | `GET /health` (public, `getHealthService`), `GET /api/health-check` and `POST /api/health-check/repair` behind `createGuardedPipeline` + `createBodyCap`; every other former `/api/*` route answers `404` (`src/api/removed-routes.test.ts` asserts the ledger is 43 routes) |
| MCP stdio | `synaptomind --stdio` (`src/index.ts:39`) | `StdioServerTransport`; stdout is the JSON-RPC channel, so `console.log`/`info`/`debug` are redirected to stderr. With `users[]` configured it binds the legacy database through `als.enterWith({ userId: 'stdio-legacy' })` — and refuses to start at all when it also owns the background jobs |
| MCP HTTP | `startMcpHttpServer` in `src/mcp/http-transport.ts:31` | `app.all('/mcp', …)` on `config.mcp.httpPort` (3006) → `createMcpRouteHandler` in `src/mcp/mcp-route.ts:135`; sessions, CORS and lifecycle are the transport's own concern |
| Embedder child | `synaptomind --embedder` (`src/index.ts:17`, imported before any server bootstrap) | `src/embedder/embedder-process.ts`: the `embedder-poll` interval job (`config.embedder.pollIntervalMs`, default 7000) and the `embedder-sweep` interval job (`SWEEP_INTERVAL_MS`, one hour). Spawned and supervised by `startEmbedderProcess` (`src/embedder/client-core.ts:15`) through `EmbedderSupervisor` (`src/embedder/embedder-supervisor.ts`) |
| Parent background jobs | `createLifecycle(...)` in `src/index.ts:97` | `src/lifecycle.ts` `startBackgroundJobs` → `startDecayJob` (`src/services/decay.service.ts`) and `startPreviewTokenRetentionJob` (`src/services/preview-token-retention.service.ts`); only when `processOwnsBackgroundJobs()` (`src/embedder/spawn-scope.ts:15`) says this process owns them |

## A read, traced: `memory_recall` with `action=search`

1. `registerActionTool` (`src/mcp/tools/action-tool.ts:93`) parses the arguments against the tool's
   schema, refuses irrelevant keys, dispatches to `config.handlers[action]` and converts a throw into
   the error envelope.
2. The `search` handler in `src/mcp/tools/recall.ts` resolves the project scope from `cwd` and calls
   `searchThoughtsOutcome` (`src/mcp/tools/recall.ts:132`) with no `d` — the service default resolves
   the handle from the request's async context.
3. `searchThoughtsOutcome` (`src/services/search.service.ts:187`) runs `runSearch`: the query is
   embedded through `generateEmbeddingWithFallback`, which gives up after
   `EMBEDDING_TIMEOUT_MS = 5_000` (`src/services/search.service.ts:22`) and returns an empty vector
   with `degraded: true` instead of failing.
4. `dbSearchThoughts` (`src/db/search.ts`) runs the vector leg (`vecSearchIds` in
   `src/db/search-vector.ts`) and the BM25 leg (`bm25ScoredIds` in `src/db/search-bm25.ts`), fuses
   them with `rrfMerge` (`src/db/search-rrf.ts`, `RRF_K`; call site `src/db/search.ts:121`) and
   hydrates rows with `fetchThoughtsByIds` (`src/db/search-hydrate.ts`). Each leg catches its own
   failure and sets `degraded`, so a dead semantic leg narrows the answer instead of erroring.
5. `applyGraphStanding` (`src/services/search-standing.service.ts:12`) annotates supersession and
   contradiction; the relevance gate and the `topK` slice follow, and `degraded` is stamped on every
   item.
6. `finalizeSearchAction` (`src/mcp/tools/recall.ts:72`) shapes the rows and wraps them in
   `collectionEnvelope` (`src/mcp/tools/envelope.ts:81`): `{ items, meta }`, with `meta.counts`
   (`total`, `returned`, `filtered_out`), `meta.degraded` and `meta.scope`. Envelope shape and `cwd`
   optionality are specified in [docs/mcp-tools.md](mcp-tools.md#response-envelope).

## A write, traced: `memory_store` with `action=create`

1. `createHandler` in `src/mcp/tools/store/create.ts` requires `content`, resolves the project from
   `cwd` with `resolveProjectId` (`src/mcp/tools/utils.ts:49`) and calls the service.
2. `createThoughtWithUrlLinksService` (`src/services/url_links.service.ts:33`) opens a
   `d.transaction` so the thought, its `url_links` and its parent edge commit or roll back together.
3. `createThoughtWithParentService` (`src/services/thoughts.service.ts:35`) is the validation door:
   `validateStatus`, `validateContentLength` against the configured limits, its own `d.transaction`,
   then `dbCreateThought` and `createEdge` for the parent — an `EdgeAlreadyExistsError` is logged and
   tolerated rather than failing the write.
4. `createThought` (`src/db/thoughts.ts:126`) computes `content_hash` and inserts with
   `ON CONFLICT (content_hash, project_id) WHERE status IN ('draft', 'active') DO NOTHING`
   (`src/db/thoughts.ts:142`): a duplicate under the same project in a live status returns the
   existing id instead of creating a second row.
5. The enqueue for embedding is **data-layer**: the `trg_thoughts_insert_pending` and
   `trg_thoughts_update_pending` triggers (rebuilt in `src/db/migrations/v035-pending-embeddings-hash.ts`)
   write a `pending_embeddings` row on insert and on `UPDATE OF content`. No service code enqueues.
6. The embedder child drains that queue on its poll job. `processSweep`
   (`src/embedder/embedder-process.ts:257`, hourly) is the backstop: `sweepOrphanedThoughts` finds
   thoughts with neither a vector nor a queue row and `requeueEmbeddings`
   (`src/db/pending-embeddings.ts:28`/`:44`) puts them back, `INSERT OR IGNORE` so a dead letter is
   not reset.
7. `itemEnvelope('create', …)` (`src/mcp/tools/envelope.ts:89`) answers `{ item, meta }`.

A new thought is therefore visible to the BM25 leg and to id lookups immediately, and to the vector
leg only after the next poll or sweep.

## Dependency injection

- **Service functions** take `d: Database = getDb()` as the trailing parameter and `cfg: Config =
  config` where they need configuration. `getDb()` (`src/db/handle.ts:59`) resolves the request's
  `AsyncLocalStorage` binding first, throws in multi-user mode when unbound, and otherwise returns
  the default handle. `getDb()` is called nowhere else in `services/` outside the deviations below.
- **db-layer functions** take `db: Database` as a required first parameter: `db/` issues SQL against
  the handle it is given and never resolves one.
- Inside `d.transaction(...)`, pass `d` to every call — the callee must write on the same handle.
- Tests: `beforeEach(createTestDb)` and pass `db` only for a specific instance (a file-backed
  database when `vec0` is needed). `Database` is never mocked.

Three service functions resolve the handle lazily, and each for a stated reason:

| Function | Signature | Why it cannot default |
| --- | --- | --- |
| `getHealthService` (`src/services/health.service.ts:112`) | `(d?: Database, cfg?: Config)` | The probe must report database unavailability instead of throwing |
| `runDecayJob` (`src/services/decay.service.ts:7`) | `(d?: Database)` | It runs before the handle is guaranteed; without an argument it fans out over `jobDatabases()` |
| `jobDatabases` (`src/services/jobs.service.ts:11`) | `()` | The resolver both interval jobs go through: registered user databases, else the default one, else an empty list when it has neither |

Non-default shapes that are deliberate, not forgotten:

- **`options` before `d`** — `updateThoughtByIdService(id, data, options, d, cfg)`
  (`src/services/thoughts.service.ts:86`), because `UpdateThoughtInput` whitelists columns and
  `url_links` is not one; riding in `data`, it would be dropped silently.
- **Required positional `d`** where the call must receive the caller's transaction handle or the
  function is a pure helper: `batch-run.service.ts`, `health-check-drafts.service.ts`,
  `health.service.ts`, `search-outcome.service.ts`, `search-standing.service.ts`, and
  `retention-review-eligibility.service.ts` (`evaluateEligibility(id, d, opts, now)`).
- **Required trailing `db: Database`** — `resolveCandidateEmbeddings(candidates, embed, db)` in
  `src/services/candidate-embeddings.service.ts:9`.

## The per-user model

The process serves one default database or one database per configured user, never a mix.

- `config.users[]` holds `UserConfig { id, dbPath, tokenSha256 }` (`src/config.ts:26`). A plaintext
  token in the file is rejected; `SYNAPTOMIND_USER_TOKEN_<ID>` is hashed at load, and duplicate
  hashes are refused. Full config reference: [docs/CONFIG.md](CONFIG.md#users-multi-user).
- `bootFanOut` (`src/context/registry.ts:31`) opens each user's database with migrations and
  registers it, or records it through `markUnavailable` and keeps booting. With no `users[]`, it
  opens the default database with `setDb`.
- Per request, `bindUserContext` (`src/middleware/user-context.ts:24`) matches the bearer token with
  `resolveUser` (`src/auth.ts:53`), answers `401` when nothing matches and `503` when a configured
  user's database is not available, then runs the handler inside `als.run({ userId, db })`.
- Anything that reaches storage without a request context — the interval jobs — goes through
  `jobDatabases()` and names the user it is working on in its log lines.
- `src/lifecycle.ts` `closeDatabases` closes every registered database on shutdown.

## Code tiers: Core, Pillar, Scaffolding

The tier map is not restated here. It is an ADR with fourteen disjoint rows, four placement tests and
a per-tier verification floor:

- [`synaptomind/adr/2026-11-12-code-tiers-core-pillars-scaffolding.md`](https://forgejo.home.lan/authelia/artifacts/src/commit/6371e9cf501628236e84aea7be68eefa85df3fe2/synaptomind/adr/2026-11-12-code-tiers-core-pillars-scaffolding.md)
- machine reference:
  `authelia/artifacts@6371e9cf501628236e84aea7be68eefa85df3fe2:synaptomind/adr/2026-11-12-code-tiers-core-pillars-scaffolding.md`

| Row | Tier | Block |
| --- | --- | --- |
| 1 | Core | Schema & migrations |
| 2 | Core | Write model & data semantics |
| 3 | Core | Retrieval |
| 4 | Core | Agent contract |
| 5 | Pillar | Embedding pipeline |
| 6 | Pillar | Curation & placement |
| 7 | Pillar | Graph, supersession & session |
| 8 | Pillar | Product tools |
| 9 | Scaffolding | MCP transport |
| 10 | Scaffolding | HTTP ops plane, auth, middleware |
| 11 | Scaffolding | Health-check & diagnostics |
| 12 | Scaffolding | Retention-review ledger |
| 13 | Scaffolding | Background hygiene |
| 14 | Scaffolding | Platform plumbing |

Reading this page through the map: the traced read path is rows 3 (`search.service.ts`,
`db/search*.ts`) and 4 (`recall.ts`, `envelope.ts`); the traced write path is row 2
(`thoughts.service.ts`, `url_links.service.ts`, `db/thoughts.ts`); the embedder is row 5; the
per-user middleware is row 10, the per-user fan-out (`src/context/registry.ts`) is row 14, and the
multi-user handle registry it registers into (`src/db/handle.ts`) is row 1.

Two things the tiers do not mean:

- **A tier is not a layer.** The layering rule governs feature dependencies; Scaffolding
  (`config.ts`, `errors.ts`, `logging/`) is imported by every tier, which is what makes it
  scaffolding.
- **A tier may raise a task's risk class, never lower it.** A one-line Pillar change is still a T3
  task by risk surface.

Row membership is defined by the ADR's globs, and at `c668c321` the map covers the corpus: the
measurement prints `unmatched` and `claimed more than once` both empty, so no product file escapes a
row and none is counted twice. The seven modules an earlier revision left unclassified —
`src/db/handle.ts`, `src/db/schema/{baseline-schema,vec-schema}.ts`, `src/text/stopwords.ts`,
`src/mcp/tools/list-page.ts`, `src/interval-job.ts`, `src/lifecycle.ts` — are placed by the current
globs (rows 1, 3, 4, 13 and 14 respectively). Classify from the ADR's criteria, and treat a file
matching no row as a review finding rather than as Scaffolding by default.

## Where to read next

| Question | Document |
| --- | --- |
| MCP tool arguments, envelopes, per-action examples | [docs/mcp-tools.md](mcp-tools.md) |
| The three HTTP routes and the removed-route ledger | [docs/API.md](API.md) |
| Config keys, users, environment variables | [docs/CONFIG.md](CONFIG.md) |
| Install, update, rollback | [docs/DEPLOY.md](DEPLOY.md), [docs/DEPLOY-LAYOUT.md](DEPLOY-LAYOUT.md) |
| Test lanes and helpers | [AGENTS.md](../AGENTS.md) §3, §5 |

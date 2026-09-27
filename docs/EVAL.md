# Memory evaluation harness

Independent, reproducible evaluation of SynaptoMind retrieval quality. It scores
labeled scenarios (recall@k, precision@k, MRR, hit rate) and records a baseline so
memory changes — embeddings, search, supersession — become measurable.

Implements item 1 of [issue #124](https://github.com/zumik3-del/synaptomind/issues/124).
The harness is read-only against services and builds its own file-backed temp DB
per scenario (vec0 requires a real file, not `:memory:`).

## Running

```bash
bun run eval                 # deterministic mode (default, CI-safe)
bun run eval --real          # real embedder + production search service
bun run eval --top-k 10      # override default top-k
bun run eval --out /tmp/eval.json
bun run eval --update-baseline   # recompute eval/thresholds.json from this run
bun run eval --real --update-baseline  # record/refresh the real-mode baseline
```

Exit code is non-zero **only** on a threshold regression (or a failed assertion in
a non-xfail scenario). Scenarios marked `xfail` are reported but never fail the run.
Metric gating applies per mode: the `deterministic` baseline gates `bun run eval`,
and the recorded `real` baseline gates `bun run eval --real`.

The JSON report is written to `eval/report.json` (gitignored) and contains every
scenario, query, retrieved id, metric and the regression list.

### Modes

- **deterministic (default)** — a signed feature-hashing embedding
  (`eval/embedding.ts`) over the 384-dim space. No model download, no embedder
  child process, fully reproducible. It is lexical by design; semantic coverage
  comes from `--real`.
- **`--real`** — seeds embeddings with the production embedder (`passage:` prefix)
  and queries through `searchThoughts` (`query:` prefix). Requires the model to be
  available locally.

## Metrics

Computed per query and averaged per scenario / category / overall (non-xfail only):

| Metric | Definition |
|--------|------------|
| recall@k | relevant retrieved / relevant |
| precision@k | relevant retrieved / retrieved |
| MRR | 1 / rank of the first relevant thought (0 if none) |
| hit rate | fraction of queries with at least one relevant thought |

## Categories

All eight categories from #124 are covered in `eval/datasets.ts`:

| Category | Scenario | Status |
|----------|----------|--------|
| explicit fact recall | `explicit-fact-recall` | pass |
| multi-hop / compositional | `compositional-multi-hop` | pass |
| temporal (current vs old) | `temporal-current-vs-old` | pass |
| supersession | `supersession-old-not-current` | pass |
| contradiction | `contradiction-resolution` | **xfail** |
| consolidation | `consolidated-knowledge` | pass |
| project scope isolation | `project-scope-isolation` | pass |
| retrieval quality | `retrieval-quality` | pass |

`xfail` scenarios exercise known gaps for observability. Supersession (issue #124
item 3) is implemented: `supersession-old-not-current` is now a gated pass — the
superseded thought is dropped and the replacement is returned. Contradiction
remains the only `xfail`: the `contradiction-resolution` fixture asserts that one
of two conflicting facts is excluded, but contradiction is symmetric (neither
endpoint is authoritative) and contradicted thoughts are never suppressed, so
retrieval alone cannot pick a winner. If an `xfail` scenario unexpectedly passes
it is reported as `xpass` and is still not a failure.

### Negative (no-match) scenarios

The `negative-no-match` probe is `measureOnly: true` (reported and
assertion-gated, but its zero metrics stay out of the aggregates and baseline),
so it can never destabilise the recorded floors. It carries two hard contracts:

- `noRelevant: true` — none of the scenario's own (non-`distractor`) thoughts may
  be retrieved. Shared `DISTRACTORS` are not part of that set and may fill top-k;
  the assertion is scoped to the scenario's topical thoughts, not "empty result".
- `expectNoStrongMatch: true` — **no** retrieved hit may be a strong match
  (`low_confidence === false`). The per-hit `low_confidence` / `similarity` /
  `match_source` signals from `SearchResult` are captured into the eval-local
  `RetrievedHit` view (`eval/types.ts`, threaded through `QueryRun`), so an
  off-topic query that the real embedder nonetheless returns with confident
  relevance fails loudly even when the confident hit is only a distractor. The
  assertion reports a missing-confidence error rather than passing vacuously.

A query with `relevant: []` alone is indistinguishable from a normal query that
simply missed (`computeQueryMetrics` returns zeros either way), which is why
these explicit negative contracts exist. The `negative-no-match` query shares no
token with any thought or distractor, so nothing receives a BM25 anchor; a real
embedder similarity at or above `search.confidence.vectorFloor` (`0.9`) is the
regression this probe is designed to catch.

### Scope of the categories

The harness measures **retrieval of a knowledge state**, not the pipelines that
produce it. Two categories are deliberate v1 proxies:

- `multi-hop` is multi-fact lexical recall (a query sharing tokens with several
  supporting thoughts), not graph traversal or semantic chaining.
- `consolidation` checks that an already-formed cluster thought is retrievable
  from its content; it does not exercise auto-cluster consolidation.

True multi-hop reasoning and the consolidation pipeline are therefore not yet
covered — extend the datasets or add pipeline-level scenarios when that matters.

The supersession scenario runs through the production search service with the
agent-facing `suppress` / `flag` modes (see `eval/search.ts`), so it exercises the
standing/suppression path rather than the raw DB search. Deeper relevance
re-scoring beyond deterministic standing ordering is out of scope and left as
follow-up.

## Dataset schema

Datasets are plain TypeScript (`eval/types.ts`):

```ts
interface EvalScenario {
  name: string
  category: EvalCategory
  description: string
  outcome?: 'pass' | 'xfail'   // default: pass
  measureOnly?: boolean        // reported + assertion-gated, excluded from aggregates
  thoughts: EvalThought[]      // id, content, projectId?, status?, createdAt?, isCluster?, importance?
  edges?: EvalEdge[]           // source, target, type?
  queries: EvalQuery[]
}

interface EvalQuery {
  query: string
  relevant: string[]           // ids that should be retrieved
  topK?: number
  projectFilter?: string
  forbid?: string[]            // ids that must NOT appear (hard assertion)
  rankBefore?: { before: string; after: string }  // ordering assertion
  noRelevant?: true            // negative query: no own thought may be retrieved
  expectNoStrongMatch?: true   // negative query: no hit may be a strong match
}
```

### Adding a scenario

1. Append an `EvalScenario` to `EVAL_SCENARIOS` in `eval/datasets.ts`.
   Include the shared `DISTRACTORS` so precision@k stays meaningful.
2. Use distinctive tokens in both the thought content and the query — the
   deterministic embedder matches on shared tokens.
3. Run `bun run eval` to see the metrics, then
   `bun run eval --update-baseline` to record the new baseline + thresholds.
   For a scenario that should also hold under the real embedder, verify with
   `bun run eval --real` and refresh that baseline with
   `bun run eval --real --update-baseline`.
4. Document any known gap with `outcome: 'xfail'`; mark a feature probe that must
   not disturb the aggregates with `measureOnly: true`.

## Thresholds

`eval/thresholds.json` is keyed by mode (`deterministic`, `real`). Each entry
stores the recorded `baseline` (overall + per category) and the `thresholds` used
for gating. `--update-baseline` upserts the entry for the current mode and sets
each threshold to the measured value minus a 0.02 margin, so a recorded run
always passes while real regressions are caught. A missing category is also a
regression.

Both modes are recorded: `deterministic` (the CI gate) and `real` (the production
embedder). `bun run eval --real` is metric-gated against the `real` entry, so a
real-embedder relevance regression now fails the run instead of passing silently.
Refresh the real baseline after an intentional change to the embedder, search
ranking or datasets:

```bash
bun run eval --real --update-baseline   # re-record the real entry
bun run eval --real                     # verify it is green and gated
bun run eval                            # deterministic stays green
```

The model is cached locally (`data/huggingface/Xenova/multilingual-e5-small`), so
refreshing needs no network. Do **not** regenerate the `deterministic` baseline
unless the deterministic datasets or embedder intentionally changed.

Hard assertions (`forbid`, `rankBefore`, `noRelevant`, `expectNoStrongMatch` in a
non-xfail scenario) gate the run regardless of whether a baseline exists for the
mode. Metric regressions only gate when a baseline entry is present: `--real` is
metric-gated only after `bun run eval --real --update-baseline`; without a `real`
entry the run stays green on metrics but still fails on a broken assertion.

## CI scheduling decision

A separate workflow (`.github/workflows/eval-real.yml`) runs `bun run eval --real`
on a **weekly cron schedule** (Monday 06:00 UTC) and via **`workflow_dispatch`**.
It does **not** fire on `pull_request` or `push` — that keeps PR gating in the
existing `ci.yml` intact and avoids paying the ~465M model download on every PR.

Rationale (task #891): the deterministic gate in `ci.yml` covers lexical/scenario
regressions fast. The real embedder gate catches semantic-relevance drift (model
updates, embedding-space shifts) on a cadence that matters for production without
slowing PRs down. A cached HuggingFace model path (`data/huggingface/Xenova/multilingual-e5-small`)
keeps reruns from re-downloading.

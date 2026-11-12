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
bun run eval --no-gated      # skip the report-only second pass (one pass, half the work)
```

Exit code is non-zero **only** on a threshold regression (or a failed assertion in
a non-xfail scenario). Scenarios marked `xfail` are reported but never fail the run.
Metric gating applies per mode: the `deterministic` baseline gates `bun run eval`,
and the recorded `real` baseline gates `bun run eval --real`. The report-only
gated pass (see below) never affects the exit code.

The JSON report is written to `eval/report.json` (gitignored) and contains every
scenario, query, retrieved id, metric and the regression list.

### Report-only gated pass

Every run executes the scenarios twice. The first pass is the measurement above
(ungated, `minRelevance: 0`, comparable to the recorded baselines). The second
pass replays the same scenarios with the relevance gate the production search
service applies when a caller omits `min_relevance` — nothing is pinned, the
service resolves its own default (`DEFAULT_MIN_RELEVANCE`, `0.4` today; the
harness reports the value it actually resolved).

The gated pass is printed after the main table as a side-by-side comparison
(recall / precision / MRR per scenario, then overall) with a header line naming
the gate value and the number of rows it dropped:

```
Relevance gate pass (report-only — never gates the exit code, thresholds or regressions)
  gate: minRelevance=0.400 (production default) — dropped 117 of 152 candidate rows across 16/16 queries
```

`gated` rows are the survivors the gate kept; the dropped count is the service's
own `filtered_out` bookkeeping, so a recall loss under the gate is attributable
to a specific scenario instead of appearing as an unexplained dip. Both passes
land in the JSON report: the top level stays the ungated pass (plus
`relevanceGate`: `{ minRelevance, candidates, droppedRows, queriesWithDrops }`),
and the gated pass is the nested `gated` object with the same shape.

**The gated pass never gates.** It feeds neither `regressions` nor the exit
code, and `--update-baseline` still records the ungated numbers only. This is
deliberate visibility-first sequencing: gating on the gate would need its own
baseline (a separate `gated`/`relevanceGate` threshold entry keyed by mode, so
the recorded value carries the `minRelevance` it was measured at) and a decision
on the tolerated recall delta per category before any floor is recorded.

`--no-gated` skips that second pass (`bun run eval --no-gated`, one pass instead
of two). It changes nothing about the gating: the ungated measurement, the
thresholds, the exit code and `--update-baseline` are identical, the report just
carries no `gated` object and the table says the pass was skipped. It is the
switch for a run that has no reader for the gate comparison — the `--real` mode
otherwise pays the model cost twice.

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

Two measure-only probe categories sit outside the #124 set and carry no
threshold floor: `no-match` (negative probes) and `pool-dilution` (the F2
candidate-pool probe described below).

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

## Candidate-pool dilution probe (F2)

`multi-project-pool-dilution` (category `pool-dilution`, `measureOnly`) measures
whether the filtered vec0 leg loses recall on a multi-project database. The DB
layer derives **one global** candidate pool for both legs (`topK × 10`, capped at
1000 — `src/db/search.ts:15-16,29`) and applies the project/status/cluster filter
to that pool inside the same query (`src/db/search-vector.ts:28-39`), so rows of
the queried project that rank below the cutoff never reach the filter — silently,
with no `degraded` flag on the outcome.

The scenario seeds three deliberately unequal projects (700 / 200 / 5 rows) in
which every row of the two larger projects ranks nearer the query than any row of
the smallest one, and asks the query inside the smallest project. Three of its
five rows are the labelled answers, two belong to a control topic. The arms differ
only in the leg and the overfetch width, so the comparison isolates the pool from
RRF and from the filter:

| arm | legs | `poolTopK` | derived pool | recall@5 | precision@5 |
|-----|------|-----------|--------------|----------|-------------|
| `hybrid-k5` | hybrid | – | 200 | 0.000 | 0.000 |
| `vector-k5` | vector only | – | 200 | 0.000 | 0.000 |
| `vector-k10` | vector only | – | 400 | 0.000 | 0.000 |
| `vector-k5-pool520` | vector only | 13 | 520 | 0.000 | 0.000 |
| `vector-k5-pool1000` | vector only | 50 | 1000 | 1.000 | 0.600 |
| `hybrid-k5-pool1000` | hybrid | 50 | 1000 | 1.000 | 0.600 |
| `vector-k5-control` | vector only | – | 200 | 1.000 | 1.000 |
| `hybrid-k5-control` | hybrid | – | 200 | 1.000 | 1.000 |

Recorded 2026-11-12 with the pre-fix pool (`CANDIDATE_POOL_MULTIPLIER = 10`);
deterministic and `--real` produce the same table. The derived pool is
`min(1000, candidateK × 10)` where `candidateK = topK × 4` under
`supersessionMode: 'suppress'` (`src/services/search-normalize.service.ts:126-129`).

What the numbers say:

- **The loss is real and pool-sized.** The filtered vec0 leg returns nothing until
  the pool passes the count of rows that rank nearer than the ground truth
  (900 here): pool 900 → 0 rows, 901 → 1, 1000 → 5
  (`multiproject-dilution.test.ts`). The loss is silent: an empty result with
  `degraded === false`, indistinguishable from "no match in this project".
- **It reaches the user-facing path.** `hybrid-k5` loses recall too, so this is
  not an RRF artifact; both legs miss. Below the BM25 leg's own overfetch
  (`limit × 3`, capped at 1000 — `src/db/search-bm25.ts:84-105`) the hybrid path
  is masked, which is why the default corpus is sized above it.
- **Widening the pool recovers it, up to the cap.** With 900 nearer rows the
  vector leg comes back exactly at k=23 (pool 920) and stays empty at k=22 (pool
  880), so a deeper search is itself a workaround; the 1000 cap bounds it — a
  corpus with 1 200 nearer rows stays at recall 0 for every k, and only a
  project-scoped vector leg can fix that.
- The two control arms keep full recall at the same narrow pool, so the zeros are
  not the filter, the pool plumbing or the harness.

The probe is a measurement, not a floor: it stays `measureOnly`, contributes no
queries to the aggregates and has no threshold entry. When F2 is fixed (wider
pool for filtered searches, or a project-scoped vector leg), the narrow arms
recover — update the snapshot assertions in `multiproject-dilution.test.ts`
together with this table.

Cost: 905 seeded rows, ~0.9 s in deterministic mode and ~2.7 s in `--real`
(single pass; the harness seeds a scenario once per pass).

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
  hybrid?: boolean             // false = vector leg only (no BM25, no RRF)
  poolTopK?: number            // overfetch width; hits are truncated back to topK
  label?: string               // arm name, shown in the per-arm report table
  noRelevant?: true            // negative query: no own thought may be retrieved
  expectNoStrongMatch?: true   // negative query: no hit may be a strong match
}
```

`hybrid: false` and `poolTopK` exist for arm-style probes that must hold the
query, the filter and the scored k constant while moving one ranking knob; a
labelled query also gets a row in the `Probe arms (per-query)` table printed
below the scenario table.

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

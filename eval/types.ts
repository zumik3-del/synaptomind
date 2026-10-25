// Shared types for the memory-evaluation harness.
// The harness is independent from runtime services: datasets are pure data and
// the search path is injected (see eval/search.ts).

export type EvalCategory =
  | 'explicit-fact'
  | 'multi-hop'
  | 'temporal'
  | 'supersession'
  | 'contradiction'
  | 'consolidation'
  | 'project-scope'
  | 'retrieval-quality'
  | 'no-match'

/** `xfail` scenarios are reported but never fail the run (known gaps). */
type ScenarioOutcome = 'pass' | 'xfail'

export interface EvalThought {
  id: string
  content: string
  /** Defaults to `default`; used for project-scope isolation. */
  projectId?: string
  /** Defaults to `active`. */
  status?: string
  /** ISO timestamp; defaults to now. Set to model temporal scenarios. */
  createdAt?: string
  isCluster?: boolean
  importance?: number
  /**
   * Marks a shared background thought (the `DISTRACTORS` spread into every
   * scenario). Excluded from a scenario's "own" thought set, which the
   * negative `noRelevant` contract asserts must not be retrieved.
   */
  distractor?: boolean
}

interface EvalEdge {
  source: string
  target: string
  /** Defaults to `related`. */
  type?: string
}

interface RankExpectation {
  before: string
  after: string
}

/**
 * Eval-local view of one retrieved hit's #155 confidence signals, captured from
 * the production `SearchResult` at the search boundary so `evaluateChecks` can
 * assert on confidence without the harness depending on the raw result shape.
 */
export interface RetrievedHit {
  id: string
  /**
   * Mirrors `SearchResult.low_confidence`: `false` means there is strong
   * evidence the hit is relevant (a BM25 anchor, or a vector hit at/above the
   * confidence floor).
   */
  lowConfidence: boolean
  /** Vector-leg cosine similarity; `0` when the vector leg did not match. */
  similarity: number
  /** Search legs that matched, in the fixed `vector`, `bm25` order. */
  matchSource: string[]
}

export interface EvalQuery {
  query: string
  /** Thought ids the query should retrieve. */
  relevant: string[]
  /** Defaults to the runner top-k. */
  topK?: number
  projectFilter?: string
  /** Ids that must not be returned (hard assertion). */
  forbid?: string[]
  /** Ordering assertion, e.g. a current fact above a stale one. */
  rankBefore?: RankExpectation
  /**
   * Opt-in recency boost passed through to `SearchServiceOptions` for this
   * query only (`0`/unset preserves relevance-only ranking). Enables measuring
   * the recency path end-to-end without slowing the other scenarios.
   */
  recencyWeight?: number
  /** Recency decay half-life in days; only meaningful with a weight > 0. */
  recencyHalfLifeDays?: number
  /**
   * Negative-query contract. When `true` the query is off-topic: `relevant`
   * MUST be `[]` and `evaluateChecks` hard-asserts that NONE of the scenario's
   * own (non-`distractor`) thoughts appear in the retrieved list. Shared
   * `DISTRACTORS` are not part of that set and may legitimately fill top-k, so
   * the assertion is scoped to the scenario's topical thoughts, not "empty
   * result". Without it a query with `relevant: []` is indistinguishable from
   * a normal query that simply missed (`computeQueryMetrics` returns zeros
   * either way).
   */
  noRelevant?: true
  /**
   * Confidence contract for an off-topic query: hard-asserts that NO retrieved
   * result is a strong match (`lowConfidence === false`), i.e. every hit carries
   * the #155 `low_confidence` verdict. `noRelevant` only guards the scenario's
   * own thoughts, so a distractor returned with real-embedder confidence would
   * slip through; this contract catches that. Requires the retrieved confidence
   * signals (`SearchResult` → `RetrievedHit`), so `evaluateChecks` reports a
   * missing-data error rather than passing vacuously.
   */
  expectNoStrongMatch?: true
}

export interface EvalScenario {
  name: string
  category: EvalCategory
  description: string
  /** Defaults to `pass`. */
  outcome?: ScenarioOutcome
  /**
   * Feature-probe scenarios: reported in the run, and their hard assertions
   * (`forbid`, `rankBefore`, `noRelevant`) still gate it, but their query
   * metrics are excluded from the overall/category aggregates and thus from the
   * recorded baseline. Adding one therefore never destabilises existing
   * `eval/thresholds.json` floors and never requires `--update-baseline`.
   */
  measureOnly?: boolean
  thoughts: EvalThought[]
  edges?: EvalEdge[]
  queries: EvalQuery[]
}

export interface QueryMetrics {
  /** recall@k over the retrieved list. */
  recall: number
  /** precision@k = relevant retrieved / retrieved. */
  precision: number
  /** reciprocal rank of the first relevant thought (0 when none). */
  mrr: number
  /** 1 when at least one relevant thought was retrieved. */
  hit: number
  retrieved: string[]
  checkErrors: string[]
}

export interface AggregateMetrics {
  recall: number
  precision: number
  mrr: number
  hitRate: number
  queries: number
}

export type EvalMode = 'deterministic' | 'real'

/**
 * Relevance gate applied to one harness pass.
 *
 * - `off` pins `minRelevance: 0` (the pre-#2178 fail-open result set the
 *   recorded `eval/thresholds.json` baselines were produced with).
 * - `default` leaves `minRelevance` unset so the search service resolves it the
 *   way production does (`DEFAULT_MIN_RELEVANCE`, `0.4` today).
 */
export type RelevanceGate = 'off' | 'default'

/**
 * Gate bookkeeping for a pass, so a recall loss under the production gate is
 * attributable instead of appearing as an unexplained dip (task #2191).
 */
export interface GateStats {
  /** Resolved gate threshold on the calibrated relevance scale; `0` = gate off. */
  minRelevance: number
  /** Rows handed to the gate (retained + dropped) across the pass. Retained rows
   * are counted after the `topK` slice, so this is a lower bound on what the gate
   * actually saw when the candidate pool overfetches. */
  candidates: number
  /** Rows the gate dropped across the pass (`SearchOutcome.filtered_out`). */
  droppedRows: number
  /** Queries where the gate dropped at least one row. */
  queriesWithDrops: number
}

export interface QueryRun {
  query: string
  relevant: string[]
  hits: RetrievedHit[]
  metrics: QueryMetrics
}

export interface ScenarioRun {
  name: string
  category: string
  outcome: 'pass' | 'xfail'
  status: 'pass' | 'fail' | 'xfail' | 'xpass'
  measureOnly?: boolean
  metrics: AggregateMetrics
  queries: QueryRun[]
  checkErrors: string[]
}

export interface Regression {
  scope: string
  metric: string
  actual: number
  threshold: number
  detail?: string
}

export interface RunResult {
  mode: EvalMode
  generatedAt: string
  topK: number
  scenarios: ScenarioRun[]
  overall: AggregateMetrics
  categories: Record<string, AggregateMetrics>
  /**
   * Relevance-gate bookkeeping for this pass: the resolved threshold and how
   * many rows it dropped. Always set by `runEval`; absent on hand-built results.
   */
  relevanceGate?: GateStats
}

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
export type ScenarioOutcome = 'pass' | 'xfail'

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

export interface EvalEdge {
  source: string
  target: string
  /** Defaults to `related`. */
  type?: string
}

export interface RankExpectation {
  before: string
  after: string
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

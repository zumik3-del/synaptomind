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
}

export interface EvalScenario {
  name: string
  category: EvalCategory
  description: string
  /** Defaults to `pass`. */
  outcome?: ScenarioOutcome
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

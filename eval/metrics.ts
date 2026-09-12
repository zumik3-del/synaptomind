// Retrieval metrics. All functions are pure so they can be unit-tested by the
// tester without touching a database.

import type { AggregateMetrics, QueryMetrics } from './types'

/**
 * recall@k   = relevant retrieved / relevant
 * precision@k = relevant retrieved / retrieved
 * mrr        = 1 / rank of first relevant (0 when none)
 * hit        = 1 when at least one relevant thought was retrieved
 */
export function computeQueryMetrics(
  retrieved: string[],
  relevant: string[],
  checkErrors: string[] = []
): QueryMetrics {
  const relevantSet = new Set(relevant)
  const uniqueRetrieved = [...new Set(retrieved)]
  const hits = uniqueRetrieved.filter(id => relevantSet.has(id))
  const recall = relevant.length === 0 ? 0 : hits.length / relevant.length
  const precision = uniqueRetrieved.length === 0 ? 0 : hits.length / uniqueRetrieved.length
  const rank = uniqueRetrieved.findIndex(id => relevantSet.has(id))
  const mrr = rank === -1 ? 0 : 1 / (rank + 1)
  const hit = rank === -1 ? 0 : 1

  return { recall, precision, mrr, hit, retrieved: uniqueRetrieved, checkErrors }
}

export function averageMetrics(metrics: QueryMetrics[]): AggregateMetrics {
  if (metrics.length === 0) {
    return { recall: 0, precision: 0, mrr: 0, hitRate: 0, queries: 0 }
  }
  let recall = 0
  let precision = 0
  let mrr = 0
  let hit = 0
  for (const metric of metrics) {
    recall += metric.recall
    precision += metric.precision
    mrr += metric.mrr
    hit += metric.hit
  }
  const n = metrics.length
  return {
    recall: recall / n,
    precision: precision / n,
    mrr: mrr / n,
    hitRate: hit / n,
    queries: n
  }
}

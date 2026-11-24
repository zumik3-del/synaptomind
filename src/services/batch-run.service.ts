import type { Database } from 'bun:sqlite'

interface TolerantBatchFailure<T> {
  item: T
  index: number
  message: string
}

interface TolerantBatchOutcome<R, E> {
  results: R[]
  errors: E[]
}

export function runTolerantBatch<T, R, E>(
  d: Database,
  items: readonly T[],
  runItem: (item: T, index: number, d: Database) => R,
  toErrorRow: (failure: TolerantBatchFailure<T>) => E
): TolerantBatchOutcome<R, E> {
  const results: R[] = []
  const errors: E[] = []
  const runItemInSavepoint = d.transaction((item: T, index: number) => runItem(item, index, d))
  const runAll = d.transaction(() => {
    for (let index = 0; index < items.length; index++) {
      try {
        results.push(runItemInSavepoint(items[index], index))
      } catch (err) {
        // A trigger can RAISE(ROLLBACK) the whole run; continuing would autocommit the rest.
        if (!d.inTransaction) throw err
        errors.push(toErrorRow({ item: items[index], index, message: messageOf(err) }))
      }
    }
  })
  runAll()

  return { results, errors }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

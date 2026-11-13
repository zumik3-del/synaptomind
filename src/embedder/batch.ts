export interface EmbeddingRow {
  id: string
  content: string
  contentHash: string
}

export type RowOutcome = 'stored' | 'skipped'

export interface FailedRow {
  id: string
  error: string
}

export interface BatchOutcome {
  succeeded: string[]
  failed: FailedRow[]
  contentChanged: string[]
}

export function classifyBatch(
  rows: EmbeddingRow[],
  store: (row: EmbeddingRow, index: number) => RowOutcome | FailedRow
): BatchOutcome {
  const outcome: BatchOutcome = { succeeded: [], failed: [], contentChanged: [] }
  rows.forEach((row, index) => {
    const result = store(row, index)
    if (result === 'stored') {
      outcome.succeeded.push(row.id)
    } else if (result === 'skipped') {
      outcome.contentChanged.push(row.id)
    } else {
      outcome.failed.push({ id: row.id, error: result.error })
    }
  })
  return outcome
}

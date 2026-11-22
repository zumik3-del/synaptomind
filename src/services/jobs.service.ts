import type { Database } from 'bun:sqlite'
import { getDb, listUserDatabases } from '../db'

export { createIntervalJob } from '../interval-job'
export type { IntervalJob, IntervalJobOptions } from '../interval-job'

export interface JobDatabase {
  userId: string
  db: Database
}

export function jobDatabases(): JobDatabase[] {
  const registered = listUserDatabases()
  if (registered.length > 0) return registered
  try {
    return [{ userId: 'default', db: getDb() }]
  } catch {
    return []
  }
}

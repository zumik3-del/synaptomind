import { getDb } from '../db'
import { getPrimers, deletePrimer, type Primer } from '../db/primers'
import type { Database } from 'bun:sqlite'

export function listPrimersService(d: Database = getDb()): Primer[] {
  return getPrimers(d)
}

export function deletePrimerService(primerId: string, d: Database = getDb()): boolean {
  return deletePrimer(d, primerId)
}

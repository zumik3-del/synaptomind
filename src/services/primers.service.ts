import { getDb } from '../db'
import { getPrimers, getPrimerById, deletePrimer, type Primer } from '../db/primers'
import type { Database } from 'bun:sqlite'

export function listPrimersService(d: Database = getDb()): Primer[] {
  return getPrimers(d)
}

export function getPrimerService(primerId: string, d: Database = getDb()): Primer | undefined {
  return getPrimerById(d, primerId)
}

export function deletePrimerService(primerId: string, d: Database = getDb()): boolean {
  return deletePrimer(d, primerId)
}

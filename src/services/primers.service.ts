import { getDb } from '../db'
import { getPrimers, deletePrimer, type Primer } from '../db/primers'

export function listPrimersService(): Primer[] {
  return getPrimers(getDb())
}

export function deletePrimerService(primerId: string): boolean {
  return deletePrimer(getDb(), primerId)
}

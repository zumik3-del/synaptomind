// Registry facade for multi-user SynaptoMind.
//
// Wraps the container registry (userId -> Database map + ALS) with per-user
// unavailability tracking and the boot fan-out that opens/migrates/registers
// every configured user DB before listeners open.
//
// Re-exports the container surface so `context/registry` is the canonical entry
// to the connection context.

export * from './container'

import { config } from '../config'
import { openDatabase } from '../db/init'
import { clearRegistry, register, setDb } from './container'

// ---------------------------------------------------------------------------
// Per-user unavailability state
// ---------------------------------------------------------------------------

const unavailable = new Map<string, string>()

export function markUnavailable(userId: string, error?: unknown): void {
  unavailable.set(userId, error instanceof Error ? error.message : String(error ?? ''))
}

export function isUnavailable(userId: string): boolean {
  return unavailable.has(userId)
}

export function clearUnavailable(): void {
  unavailable.clear()
}

export function unavailableUsers(): string[] {
  return [...unavailable.keys()]
}

export function getUnavailableUsers(): Array<{ userId: string; error: string }> {
  return [...unavailable.entries()].map(([userId, error]) => ({ userId, error }))
}

// ---------------------------------------------------------------------------
// Boot fan-out
// ---------------------------------------------------------------------------

export interface BootFanOutResult {
  registered: string[]
  unavailable: Array<{ userId: string; error: string }>
}

export function bootFanOut(): BootFanOutResult {
  clearRegistry()
  clearUnavailable()

  const users = Array.isArray(config.users) ? config.users : []
  const multi = users.length > 0

  const registered: string[] = []
  const unavail: Array<{ userId: string; error: string }> = []

  if (!multi) {
    // Legacy single-user mode: open + migrate the configured DB and publish
    // the singleton handle (single-user / tests only).
    const db = openDatabase({ runMigrations: true })
    setDb(db)
    return { registered, unavailable: unavail }
  }

  for (const u of users) {
    try {
      const db = openDatabase({ dbPath: u.dbPath, runMigrations: true })
      register(u.id, db)
      registered.push(u.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      markUnavailable(u.id, msg)
      unavail.push({ userId: u.id, error: msg })
      console.error(`[synaptomind] user ${u.id} database unavailable: ${msg}`)
    }
  }

  return { registered, unavailable: unavail }
}

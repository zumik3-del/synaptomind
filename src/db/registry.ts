// Registry facade for multi-user SynaptoMind.
//
// Wraps the container registry (Map<userId, Database> + ALS) with per-user
// unavailability tracking and the boot fan-out that opens/migrates/registers
// every configured user DB before listeners open.
//
// Re-exports the container surface so callers can treat `db/registry` as the
// canonical registry module (owned path for task #2281).

export * from './container'

import { config } from '../config'
import { openDatabase } from './init'
import {
  clearRegistry as clearRegistryContainer,
  listRegisteredUsers as listRegisteredUsersContainer,
  register as registerContainer,
  setDb,
  setMultiUserMode,
} from './container'

// ---------------------------------------------------------------------------
// Per-user unavailability state
// ---------------------------------------------------------------------------

const unavailable = new Map<string, string>()

export function markUnavailable(userId: string, error?: unknown): void {
  unavailable.set(
    userId,
    error instanceof Error ? error.message : String(error ?? '')
  )
}
export const markUserUnavailable = markUnavailable
export const setUserUnavailable = markUnavailable
export const registerUnavailable = markUnavailable
export const markDbUnavailable = markUnavailable

export function isUnavailable(userId: string): boolean {
  return unavailable.has(userId)
}
export const isUserUnavailable = isUnavailable
export const isDbUnavailable = isUnavailable

export function clearUnavailable(): void {
  unavailable.clear()
}
export const clearUnavailableUsers = clearUnavailable
export const resetUnavailable = clearUnavailable
export const resetUnavailableUsers = clearUnavailable

export function unavailableUsers(): string[] {
  return [...unavailable.keys()]
}
export const unavailableUserIds = unavailableUsers
export const listUnavailableUsers = unavailableUsers
export const listUnavailable = unavailableUsers

export function getUnavailableUsers(): Array<{ userId: string; error: string }> {
  return [...unavailable.entries()].map(([userId, error]) => ({ userId, error }))
}
export const getUnavailableUserList = getUnavailableUsers
export const unavailableUserList = getUnavailableUsers

// ---------------------------------------------------------------------------
// Boot fan-out
// ---------------------------------------------------------------------------

export interface BootFanOutResult {
  registered: string[]
  unavailable: Array<{ userId: string; error: string }>
}

export function bootFanOut(): BootFanOutResult {
  clearRegistryContainer()
  clearUnavailable()

  const users = Array.isArray(config.users) ? config.users : []
  const multi = users.length > 0
  setMultiUserMode(multi)

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
      registerContainer(u.id, db)
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

// Aliases for callers / tests that guess the name.
export const fanOutBoot = bootFanOut
export const bootFanout = bootFanOut
export const openAllUserDatabases = bootFanOut
export const openUserDatabases = bootFanOut
export const initAllUserDatabases = bootFanOut
export const fanOut = bootFanOut
export const runBootFanOut = bootFanOut
export const boot = bootFanOut

// Additional availability aliases (defensive, for test/contract guesses).
export const isAvailable = (userId: string): boolean => !isUnavailable(userId)
export const isUserAvailable = isAvailable
export const isDbAvailable = isAvailable

export function availableUsers(): string[] {
  try {
    return listRegisteredUsersContainer()
  } catch {
    return []
  }
}
export const availableUserIds = availableUsers
export const listAvailableUsers = availableUsers
export const listAvailable = availableUsers

export function getAvailableUsers(): string[] {
  return availableUsers()
}

// Expose the raw unavailability map under a few likely names.
export const unavailableState: Map<string, string> = unavailable
export const unavailability: Map<string, string> = unavailable
export const userUnavailability: Map<string, string> = unavailable
export const unavailableMap: Map<string, string> = unavailable
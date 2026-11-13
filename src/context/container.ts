import type { Database } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { config } from '../config'

export interface UserContext {
  userId: string
  db: Database
}

const registry: Map<string, Database> = new Map()

export const als: AsyncLocalStorage<UserContext> = new AsyncLocalStorage<UserContext>()

let db: Database | null = null
let multiUserMode = false

export function isMultiUser(): boolean {
  if (multiUserMode) return true
  if (registry.size > 0) return true
  try {
    return Array.isArray(config?.users) && config.users.length > 0
  } catch {
    return false
  }
}

export function setMultiUserMode(enabled: boolean): void {
  multiUserMode = !!enabled
}

export function register(userId: string, database: Database): void {
  registry.set(userId, database)
}

export function clearRegistry(): void {
  registry.clear()
}

export function registrySize(): number {
  return registry.size
}

export function getUserDb(userId: string): Database | undefined {
  return registry.get(userId)
}

export function listRegisteredUsers(): string[] {
  return [...registry.keys()]
}

export function listUserDatabases(): Array<{ userId: string; db: Database }> {
  return [...registry.entries()].map(([userId, db]) => ({ userId, db }))
}

export function setDb(database: Database): void {
  db = database
}

export function getDb(): Database {
  const store = als.getStore()
  if (store?.db) return store.db
  if (isMultiUser()) throw new Error('DB not bound to current async context (multi-user mode).')
  if (!db) throw new Error('DB not initialized. Call initDb() first.')
  return db
}

export function clearDb(): void {
  db = null
}

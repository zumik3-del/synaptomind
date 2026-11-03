import type { Database } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { config } from '../config'

export const registry: Map<string, Database> = new Map()
export const userRegistry: Map<string, Database> = registry
export const dbs: Map<string, Database> = registry
export const userDbs: Map<string, Database> = registry

export interface UserContext {
  userId: string
  db: Database
}

export const als: AsyncLocalStorage<UserContext> = new AsyncLocalStorage<UserContext>()
export const asyncLocalStorage: AsyncLocalStorage<UserContext> = als
export const dbAls: AsyncLocalStorage<UserContext> = als
export const userAls: AsyncLocalStorage<UserContext> = als
export const contextAls: AsyncLocalStorage<UserContext> = als
export const ALS: AsyncLocalStorage<UserContext> = als
export const userContextAls: AsyncLocalStorage<UserContext> = als

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
export const isMultiUserMode = isMultiUser
export function isMultiuser(): boolean { return isMultiUser() }

export function setMultiUserMode(enabled: boolean): void { multiUserMode = !!enabled }
export function enableMultiUserMode(): void { multiUserMode = true }
export function disableMultiUserMode(): void { multiUserMode = false }
export function setMultiUser(enabled: boolean): void { multiUserMode = !!enabled }
export function enableMultiUser(): void { multiUserMode = true }
export function markMultiUser(): void { multiUserMode = true }

export function register(userId: string, database: Database): void { registry.set(userId, database) }
export function registerDb(userId: string, database: Database): void { register(userId, database) }
export function registerUser(userId: string, database: Database): void { register(userId, database) }
export function registerUserDb(userId: string, database: Database): void { register(userId, database) }
export function addDb(userId: string, database: Database): void { register(userId, database) }
export function setRegistryEntry(userId: string, database: Database): void { register(userId, database) }

export function unregister(userId: string): void { registry.delete(userId) }
export function unregisterDb(userId: string): void { unregister(userId) }
export function removeDb(userId: string): void { unregister(userId) }
export function deleteDb(userId: string): void { unregister(userId) }

export function clearRegistry(): void { registry.clear() }
export function clearUserRegistry(): void { registry.clear() }
export function resetRegistry(): void { registry.clear() }

export function getUserDb(userId: string): Database | undefined { return registry.get(userId) }
export function getRegisteredDb(userId: string): Database | undefined { return registry.get(userId) }
export function getDbForUser(userId: string): Database | undefined { return registry.get(userId) }

export function listRegisteredUsers(): string[] { return [...registry.keys()] }
export function registeredUserIds(): string[] { return [...registry.keys()] }

export function setDb(database: Database): void { db = database }
export function getDb(): Database {
  const store = als.getStore()
  if (store?.db) return store.db
  if (isMultiUser()) throw new Error('DB not bound to current async context (multi-user mode).')
  if (!db) throw new Error('DB not initialized. Call initDb() first.')
  return db
}
export function clearDb(): void { db = null }

export default { registry, als, register, getDb, setDb, clearDb, isMultiUser }

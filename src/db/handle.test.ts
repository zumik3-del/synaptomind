import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  als,
  clearDb,
  clearRegistry,
  getDb,
  getUserDb,
  isMultiUser,
  listRegisteredUsers,
  listUserDatabases,
  register,
  registrySize,
  setDb,
  setMultiUserMode
} from './handle'

// Multi-user mode is the container's own switch (`setMultiUserMode`), the same one boot fan-out
// flips; the loaded config is frozen, so no case writes users into the global.
describe('container fail-closed', () => {
  beforeEach(() => {
    clearRegistry()
    clearDb()
    setMultiUserMode(false)
  })

  afterEach(() => {
    clearRegistry()
    clearDb()
    setMultiUserMode(false)
  })

  test('unbound getDb throws in multi-user mode', () => {
    setMultiUserMode(true)
    expect(isMultiUser()).toBe(true)
    expect(() => getDb()).toThrow()
  })

  test('ALS binding works', () => {
    setMultiUserMode(true)
    const db = new Database(':memory:')
    register('u', db)
    als.run({ userId: 'u', db }, () => {
      expect(getDb()).toBe(db)
    })
    expect(() => getDb()).toThrow()
  })

  test('single-user fallback works', () => {
    clearRegistry()
    const db = new Database(':memory:')
    setDb(db)
    expect(isMultiUser()).toBe(false)
    expect(getDb()).toBe(db)
  })

  test('test-state reset between suites', () => {
    expect(isMultiUser()).toBe(false)
    expect(clearRegistry).not.toThrow()
    expect(() => getDb()).toThrow()
  })
})

describe('container registry accessors', () => {
  beforeEach(() => {
    clearRegistry()
    clearDb()
    setMultiUserMode(false)
  })

  afterEach(() => {
    clearRegistry()
    clearDb()
    setMultiUserMode(false)
  })

  test('registrySize tracks register and clearRegistry', () => {
    expect(registrySize()).toBe(0)
    register('u1', new Database(':memory:'))
    register('u2', new Database(':memory:'))
    expect(registrySize()).toBe(2)
    clearRegistry()
    expect(registrySize()).toBe(0)
  })

  test('clearRegistry drops every user handle', () => {
    register('u1', new Database(':memory:'))
    register('u2', new Database(':memory:'))
    expect(listRegisteredUsers()).toEqual(['u1', 'u2'])

    clearRegistry()

    expect(getUserDb('u1')).toBeUndefined()
    expect(getUserDb('u2')).toBeUndefined()
    expect(listRegisteredUsers()).toEqual([])
    expect(listUserDatabases()).toEqual([])
  })

  test('listUserDatabases returns a snapshot that a later register does not mutate', () => {
    const db1 = new Database(':memory:')
    register('u1', db1)

    const snapshot = listUserDatabases()
    expect(snapshot).toEqual([{ userId: 'u1', db: db1 }])

    register('u2', new Database(':memory:'))

    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toEqual({ userId: 'u1', db: db1 })
    expect(listUserDatabases()).toHaveLength(2)
  })

  test('listUserDatabases returns a fresh array each call', () => {
    register('u1', new Database(':memory:'))

    const first = listUserDatabases()
    first.length = 0

    expect(listUserDatabases()).toHaveLength(1)
  })
})

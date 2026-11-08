import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { als, clearDb, clearRegistry, getDb, isMultiUser, register, setDb } from '../db/container'
import { config } from '../config'

const DUMMY_USER = { id: 'u', dbPath: '/tmp/opencode/dummy.db', tokenSha256: 'a'.repeat(64) }

describe('container fail-closed', () => {
  beforeEach(() => {
    clearRegistry()
    clearDb()
    config.users = []
  })

  afterEach(() => {
    clearRegistry()
    clearDb()
    config.users = []
  })

  test('unbound getDb throws in multi-user mode', () => {
    config.users = [DUMMY_USER as any]
    expect(isMultiUser()).toBe(true)
    expect(() => getDb()).toThrow()
  })

  test('ALS binding works', () => {
    config.users = [DUMMY_USER as any]
    const db = new Database(':memory:')
    register('u', db)
    als.run({ userId: 'u', db }, () => {
      expect(getDb()).toBe(db)
    })
    expect(() => getDb()).toThrow()
  })

  test('single-user fallback works', () => {
    config.users = []
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

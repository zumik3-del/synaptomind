import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { als, clearDb, clearRegistry, getDb, isMultiUser, register, setDb, setMultiUserMode } from '../db/container'
import { config } from '../config'

describe('container fail-closed', () => {
  beforeEach(() => {
    clearRegistry()
    clearDb()
    setMultiUserMode(false)
    config.users = []
  })

  afterEach(() => {
    clearRegistry()
    clearDb()
    setMultiUserMode(false)
    config.users = []
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
    setMultiUserMode(false)
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
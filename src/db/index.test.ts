import { expect, test } from 'bun:test'
import { getDb as containerGetDb } from '../context/container'
import * as barrel from './index'
import * as init from './init'

test('the db barrel re-exports the init lifecycle and the container handle unchanged', () => {
  expect(barrel.initDb).toBe(init.initDb)
  expect(barrel.openDatabase).toBe(init.openDatabase)
  expect(barrel.closeDb).toBe(init.closeDb)
  expect(barrel.getDb).toBe(containerGetDb)
})

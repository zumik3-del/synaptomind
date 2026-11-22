import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { InvalidEdgeTypeError } from '../db/errors'
import { ClusterEdgeValidationError } from '../db/edges'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { createEdge } from './edges.service'

beforeEach(createTestDb)
afterEach(closeDb)

test("createEdge reports the retired 'child' type as the deprecation message, not the vocabulary error", () => {
  const db = getDb()
  const source = seedThought({ content: 'child source' })
  const target = seedThought({ content: 'child target' })

  expect(() => createEdge(db, source, target, 'child')).toThrow(ClusterEdgeValidationError)
  expect(() => createEdge(db, source, target, 'child')).toThrow(
    "Edge type 'child' is deprecated. Use 'parent' instead — 'parent' covers both directions."
  )
})

test("the 'child' refusal is the only one: an unknown type keeps the vocabulary error", () => {
  const db = getDb()
  const source = seedThought({ content: 'unknown source' })
  const target = seedThought({ content: 'unknown target' })

  expect(() => createEdge(db, source, target, 'frobnicates')).toThrow(InvalidEdgeTypeError)
  expect(() => createEdge(db, source, target, 'frobnicates')).not.toThrow(
    ClusterEdgeValidationError
  )
})

import { expect, test } from 'bun:test'
import {
  ClusterEdgeValidationError,
  EdgeAlreadyExistsError,
  EdgeConflictError,
  InvalidEdgeTypeError,
  SelfLoopEdgeError,
  ThoughtContentConflictError
} from './errors'

test('every db error carries a name, a message and the status code its route maps to', () => {
  const cases: Array<[Error & { statusCode: number }, string, number, string]> = [
    [new EdgeAlreadyExistsError(), 'EdgeAlreadyExistsError', 409, 'Edge already exists'],
    [
      new ClusterEdgeValidationError('clusters only'),
      'ClusterEdgeValidationError',
      400,
      'clusters only'
    ],
    [new SelfLoopEdgeError(), 'SelfLoopEdgeError', 400, 'cannot link a thought to itself'],
    [
      new InvalidEdgeTypeError('frobnicates', ['related', 'parent']),
      'InvalidEdgeTypeError',
      400,
      "Invalid edge type 'frobnicates'. Valid types: related, parent"
    ]
  ]

  for (const [error, name, statusCode, message] of cases) {
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(name)
    expect(error.statusCode).toBe(statusCode)
    expect(error.message).toContain(message)
  }
})

test('EdgeConflictError names both endpoints and the one-edge-per-pair rule', () => {
  const error = new EdgeConflictError('src-1', 'tgt-2')

  expect(error.name).toBe('EdgeConflictError')
  expect(error.statusCode).toBe(409)
  expect(error.message).toContain('between src-1 and tgt-2')
  expect(error.message).toContain('Only one edge per pair of thoughts is allowed')
})

test('ThoughtContentConflictError names the holder only when it is known', () => {
  const named = new ThoughtContentConflictError('thought-1')
  const anonymous = new ThoughtContentConflictError()

  expect(named.statusCode).toBe(409)
  expect(named.name).toBe('ThoughtContentConflictError')
  expect(named.message).toContain('already has this content (thought-1)')
  expect(anonymous.message).toContain(
    'Another live thought in this project already has this content'
  )
  expect(anonymous.message).not.toContain('(')
})

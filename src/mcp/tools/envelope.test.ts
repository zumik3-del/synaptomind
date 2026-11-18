import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../../context/container'
import { closeDb } from '../../db/init'
import { createProject } from '../../db/projects'
import { createTestDb } from '../../test/helpers'
import {
  collectionEnvelope,
  itemEnvelope,
  readEnvelopeScope,
  resolveEnvelopeScope,
  scopeProjectId,
  writeEnvelopeScope
} from './envelope'

beforeEach(createTestDb)
afterEach(closeDb)

test('a collection envelope counts what it returned and defaults the totals', () => {
  const envelope = collectionEnvelope('search', [{ id: 'a' }, { id: 'b' }])

  expect(envelope.items).toHaveLength(2)
  expect(envelope.meta).toEqual({
    action: 'search',
    scope: null,
    counts: { total: 2, returned: 2, filtered_out: 0 },
    degraded: false,
    warnings: []
  })
})

test('an item envelope reports one returned item and none for a miss', () => {
  expect(itemEnvelope('get', { id: 'a' }).meta.counts).toEqual({
    total: 1,
    returned: 1,
    filtered_out: 0
  })
  expect(itemEnvelope('get', null).meta.counts).toEqual({ total: 0, returned: 0, filtered_out: 0 })
})

test('the envelope passes the caller counts, reason and warnings through, without aliasing them', () => {
  const warnings = ['w1']
  const envelope = collectionEnvelope('recall', [], {
    total: 9,
    filtered_out: 4,
    degraded: true,
    warnings,
    reason: 'no_match',
    counts: { edges: 3 }
  })

  expect(envelope.meta.counts).toEqual({
    edges: 3,
    total: 9,
    returned: 0,
    filtered_out: 4
  })
  expect(envelope.meta.degraded).toBe(true)
  expect(envelope.meta.reason).toBe('no_match')
  expect(envelope.meta.warnings).toEqual(['w1'])
  expect(envelope.meta.warnings).not.toBe(warnings)
})

test('a preview is marked destructive and carries a null token when none was issued', () => {
  const envelope = itemEnvelope('delete', null, {
    preview: { consequence: 'removes the project', instruction: 'call again with confirm=true' }
  })

  expect(envelope.meta.preview).toEqual({
    token: null,
    destructive: true,
    consequence: 'removes the project',
    instruction: 'call again with confirm=true'
  })
})

test('a preview token is carried verbatim and omits the optional texts it was not given', () => {
  const envelope = collectionEnvelope('unlink', [], { preview: { token: 'tok-1' } })

  expect(envelope.meta.preview).toEqual({ token: 'tok-1', destructive: true })
  expect(Object.hasOwn(envelope.meta, 'reason')).toBe(false)
})

test('a read without a cwd spans every project and says so', () => {
  const { scope, warnings } = resolveEnvelopeScope(undefined)

  expect(scope).toBeNull()
  expect(warnings).toEqual(['no cwd — the answer spans every project'])
})

test('a cwd that matches no project resolves to a global scope with a warning', () => {
  const { scope, warnings } = resolveEnvelopeScope('/somewhere/unknown')

  expect(scope).toEqual({ project: null, project_name: null, global: true })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('matches no known project')
  expect(warnings[0]).toContain('memory_manage action=resolve')
})

test('a known cwd scopes the answer to its project without a warning', () => {
  const project = createProject(getDb(), {
    name: 'Scoped',
    local_path: '/work/scoped'
  })

  const { scope, warnings } = resolveEnvelopeScope('/work/scoped/')

  expect(scope).toEqual({ project: project.id, project_name: 'Scoped', global: false })
  expect(warnings).toEqual([])
})

test('readEnvelopeScope ignores a blank cwd and passes the project id only for a real project', () => {
  const absent = readEnvelopeScope('   ')
  expect(absent.scope).toBeNull()
  expect(absent.projectId).toBeUndefined()

  const unknown = readEnvelopeScope(42)
  expect(unknown.scope).toBeNull()
  expect(unknown.projectId).toBeUndefined()
})

test('scopeProjectId is undefined for a global or absent scope', () => {
  expect(scopeProjectId(null)).toBeUndefined()
  expect(scopeProjectId({ project: 'p1', project_name: 'P', global: true })).toBeUndefined()
  expect(scopeProjectId({ project: 'p1', project_name: 'P', global: false })).toBe('p1')
})

test('a write keeps its scope even when the cwd matches no project, and has no warning', () => {
  expect(writeEnvelopeScope(undefined)).toEqual({ scope: null, warnings: [] })
  expect(writeEnvelopeScope('  ')).toEqual({ scope: null, warnings: [] })
  expect(writeEnvelopeScope('/somewhere/unknown')).toEqual({
    scope: { project: null, project_name: null, global: true },
    warnings: []
  })
})

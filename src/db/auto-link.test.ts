import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import { findLinkCandidates } from './auto-link'

beforeEach(createTestDb)
afterEach(closeDb)

test('findLinkCandidates returns active non-cluster thoughts with < 3 related edges', () => {
  const a = seedThought({ content: 'a' })
  const b = seedThought({ content: 'b' })
  seedThought({ content: 'cluster', is_cluster: 1 })
  seedThought({ status: 'archived' })
  seedEdge(a, b, 'related')
  const candidates = findLinkCandidates(getDb())
  expect(candidates.length).toBeGreaterThanOrEqual(2)
  expect(candidates.every(c => c.edge_count < 3)).toBeTrue()
})

test('findLinkCandidates excludes cluster members', () => {
  const cluster = seedThought({ is_cluster: 1 })
  const member = seedThought()
  seedEdge(cluster, member, 'cluster')
  const candidates = findLinkCandidates(getDb())
  expect(candidates.find(c => c.id === member)).toBeUndefined()
})

test('findLinkCandidates excludes cluster thoughts themselves', () => {
  const cluster = seedThought({ is_cluster: 1 })
  const candidates = findLinkCandidates(getDb())
  expect(candidates.find(c => c.id === cluster)).toBeUndefined()
})

test('findLinkCandidates orders by edge_count ASC then created_at DESC', () => {
  const isolated = seedThought({ content: 'isolated' })
  const connected = seedThought({ content: 'connected' })
  seedEdge(connected, seedThought({ content: 'neighbor' }), 'related')
  const candidates = findLinkCandidates(getDb())
  const ids = candidates.map(c => c.id)
  expect(ids.indexOf(isolated)).toBeLessThan(ids.indexOf(connected))
})

test('findLinkCandidates excludes draft thoughts', () => {
  const draft = seedThought({ content: 'draft', status: 'draft' })
  const candidates = findLinkCandidates(getDb())
  expect(candidates.find(c => c.id === draft)).toBeUndefined()
})

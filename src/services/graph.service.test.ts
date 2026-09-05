import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { getChainService, getGraphDataService } from './graph.service'

beforeEach(createTestDb)
afterEach(() => {
  const { closeDb: close } = require('../db/init')
  close()
})

test('getGraphDataService returns nodes and edges', () => {
  const a = seedThought({ content: 'node a' })
  const b = seedThought({ content: 'node b' })
  seedEdge(a, b, 'related')
  const graph = getGraphDataService()
  expect(graph.nodes.length).toBeGreaterThanOrEqual(2)
  expect(graph.edges.length).toBeGreaterThanOrEqual(1)
})

test('getGraphDataService labels long content with ellipsis', () => {
  const long = 'x'.repeat(80)
  const id = seedThought({ content: long })
  const graph = getGraphDataService()
  const node = graph.nodes.find(n => n.id === id)
  expect(node!.label).toHaveLength(61)
  expect(node!.label).toEndWith('…')
  expect(node!.title).toBe(long)
})

test('getGraphDataService assigns category based on source', () => {
  const mcpId = seedThought({ source: 'mcp' })
  const apiId = seedThought({ source: 'api' })
  const normalId = seedThought({ source: 'test' })
  const graph = getGraphDataService()
  expect(graph.nodes.find(n => n.id === mcpId)!.category).toBe('agent')
  expect(graph.nodes.find(n => n.id === apiId)!.category).toBe('api')
  expect(graph.nodes.find(n => n.id === normalId)!.category).toBe('concept')
})

test('getGraphDataService filters by project', () => {
  const projId = 'proj-1'
  seedThought({ content: 'in project', project_id: projId })
  seedThought({ content: 'not in project' })
  const graph = getGraphDataService(projId)
  expect(graph.nodes.every(n => n.project_name !== undefined)).toBeTrue()
})

test('getChainService returns null for unknown thought', () => {
  expect(getChainService('nonexistent')).toBeNull()
})

test('getChainService returns upstream and downstream', () => {
  const a = seedThought({ content: 'a' })
  const b = seedThought({ content: 'b' })
  const c = seedThought({ content: 'c' })
  seedEdge(a, b, 'develops')
  seedEdge(b, c, 'related')
  const chain = getChainService(b)
  expect(chain).not.toBeNull()
  expect(chain!.thought.id).toBe(b)
  expect(chain!.upstream.length).toBeGreaterThanOrEqual(1)
  expect(chain!.downstream.length).toBeGreaterThanOrEqual(1)
})

test('getChainService filters by direction upstream', () => {
  const a = seedThought()
  const b = seedThought()
  seedEdge(a, b, 'related')
  const chain = getChainService(b, 'upstream')
  expect(chain).not.toBeNull()
  expect(chain!.upstream.length).toBe(1)
  expect(chain!.downstream.length).toBe(0)
})

test('getChainService filters by direction downstream', () => {
  const a = seedThought()
  const b = seedThought()
  seedEdge(a, b, 'related')
  const chain = getChainService(a, 'downstream')
  expect(chain).not.toBeNull()
  expect(chain!.upstream.length).toBe(0)
  expect(chain!.downstream.length).toBe(1)
})

test('getChainService caps edges at maxDegree', () => {
  const hub = seedThought({ content: 'hub' })
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const t = seedThought({ content: `spoke ${i}` })
    ids.push(t)
    seedEdge(hub, t, 'related')
  }
  const chain = getChainService(hub, 'both', 3)
  expect(chain).not.toBeNull()
  expect(chain!.downstream.length).toBe(3)
})

test('getChainService default maxDegree is 50', () => {
  const hub = seedThought({ content: 'hub' })
  for (let i = 0; i < 3; i++) {
    const t = seedThought({ content: `node ${i}` })
    seedEdge(hub, t, 'related')
  }
  const chain = getChainService(hub)
  expect(chain).not.toBeNull()
  expect(chain!.downstream.length).toBe(3)
})

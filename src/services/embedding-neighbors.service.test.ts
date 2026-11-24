import { expect, test } from 'bun:test'
import { buildInMemoryDistanceLookup } from './embedding-neighbors.service'

function unitAt(angle: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = Math.cos(angle)
  v[1] = Math.sin(angle)
  return v
}

test('distance lookup reports `1 - similarity` for the auto-cluster convention', () => {
  const candidates = [
    { id: 'A', content: 'A' },
    { id: 'B', content: 'B' },
    { id: 'C', content: 'C' }
  ]
  const embeddings = [unitAt(0), unitAt(Math.acos(0.75)), unitAt(Math.acos(0.25))]
  const lookup = buildInMemoryDistanceLookup(candidates, embeddings)

  const neighbors = lookup('A', 2)
  expect(neighbors.map(n => n.id)).toEqual(['B', 'C'])
  expect(neighbors[0]!.distance).toBeCloseTo(0.25, 5)
  expect(neighbors[1]!.distance).toBeCloseTo(0.75, 5)
})

test('the distance lookup guards zero-norm vectors and ranks the unknown id as no neighbours', () => {
  const zero = new Float32Array(384)
  const unit = unitAt(0)
  const candidates = [
    { id: 'zero', content: 'zero' },
    { id: 'unit', content: 'unit' }
  ]
  expect(buildInMemoryDistanceLookup(candidates, [zero, unit])('zero', 5)).toEqual([
    { id: 'unit', distance: 1 }
  ])
  expect(buildInMemoryDistanceLookup(candidates, [zero, unit])('not-a-candidate', 5)).toEqual([])
})

test('each candidate is ranked from its own row, nearest first when topK is below the pool', () => {
  const candidates = [
    { id: 'A', content: 'A' },
    { id: 'B', content: 'B' },
    { id: 'C', content: 'C' }
  ]
  const embeddings = [unitAt(0), unitAt(Math.acos(0.75)), unitAt(Math.acos(0.25))]
  const lookup = buildInMemoryDistanceLookup(candidates, embeddings)

  const nearestToA = lookup('A', 1)
  expect(nearestToA.map(neighbor => neighbor.id)).toEqual(['B'])
  expect(nearestToA[0]!.distance).toBeCloseTo(0.25, 5)

  const nearestToB = lookup('B', 1)
  expect(nearestToB.map(neighbor => neighbor.id)).toEqual(['C'])
  expect(nearestToB[0]!.distance).toBeCloseTo(0.1721, 3)
})

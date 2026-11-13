import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../../db'
import { createTestDb, seedEdge, seedThought } from '../../test/helpers'
import { proposePlacementPlan } from './engine'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const T0 = '2025-01-01T00:00:00.000Z'
const T1 = '2025-02-01T00:00:00.000Z'
const T2 = '2025-03-01T00:00:00.000Z'
const T3 = '2025-04-01T00:00:00.000Z'

function okEmbed(): (texts: string[]) => Promise<Float32Array[]> {
  return async texts => texts.map(() => new Float32Array(384))
}

function failEmbed(): (texts: string[]) => Promise<Float32Array[]> {
  return async () => {
    throw new Error('embedder exploded')
  }
}

function stubSearch(map: Record<string, Array<{ id: string; similarity: number }>>) {
  return (_id: string, _emb: Float32Array, _topK: number) => map[_id] ?? []
}

function fp(db: Database): Record<string, number> {
  const c = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    thoughts: c('SELECT COUNT(*) AS n FROM thoughts'),
    active: c("SELECT COUNT(*) AS n FROM thoughts WHERE status='active'"),
    archived: c("SELECT COUNT(*) AS n FROM thoughts WHERE status='archived'"),
    clusterEdges: c("SELECT COUNT(*) AS n FROM edges WHERE type='cluster'"),
    edges: c('SELECT COUNT(*) AS n FROM edges'),
    clusterThoughts: c('SELECT COUNT(*) AS n FROM thoughts WHERE is_cluster=1')
  }
}

function importedIdentifiers(src: string): string[] {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const bodies: string[] = []
  for (const m of stripped.matchAll(/\bimport\s+[\s\S]*?from\s*['"][^'"]*['"]/g)) bodies.push(m[0])
  const KW = new Set(['import', 'export', 'from', 'as', 'type', 'default'])
  const out = new Set<string>()
  for (const b of bodies) {
    for (const tok of b.split(/\s+|[,{}*]+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(tok) && !KW.has(tok)) out.add(tok)
    }
  }
  return [...out]
}

const WRITER_IMPORTS = [
  'createEdge',
  'deleteEdge',
  'createEdgeService',
  'deleteEdgeService',
  'createEdgesService',
  'createThought',
  'updateThought',
  'deleteThought',
  'archiveThought',
  'createThoughtWithParentService',
  'createThoughtWithUrlLinksService',
  'updateThoughtByIdService',
  'archiveThoughtByIdService',
  'mergeThoughtsService',
  'createClusterService',
  'crystallize',
  'deleteEdges',
  'insertEmbedding',
  'boostImportance'
]

describe('no-write guarantee', () => {
  test('static import scan: placement non-test files import no graph writer', () => {
    const placementDir = join(import.meta.dir)
    const sourceFiles = readdirSync(placementDir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.suite.ts'))
      .sort()
    expect(sourceFiles.length).toBeGreaterThan(0)
    for (const f of sourceFiles) {
      const src = readFileSync(join(placementDir, f), 'utf8')
      const ids = importedIdentifiers(src)
      const violations = ids.filter(i => WRITER_IMPORTS.includes(i))
      expect(violations, `${f} imports writer symbol(s): ${violations.join(', ')}`).toEqual([])
    }
  })

  test('runtime fingerprint unchanged across branches', async () => {
    const db = getDb()
    seedThought({ id: 'fw-c', content: 'cluster agg', is_cluster: 1, created_at: T0 })
    seedThought({ id: 'fw-m', content: 'cluster member', created_at: T1 })
    seedThought({ id: 'fw-keep', content: 'plain idea', created_at: T2 })
    seedThought({ id: 'fw-merge-src', content: 'dup fox', created_at: T3 })
    seedThought({ id: 'fw-merge-tgt', content: 'dup fox jumped', created_at: T0 })
    seedThought({ id: 'fw-re-old', content: 'postgres for storage persists data', created_at: T0 })
    seedThought({
      id: 'fw-re-new',
      content: 'postgres now for storage persists data',
      created_at: T1
    })
    seedEdge('fw-c', 'fw-m', 'cluster')

    const before = fp(db)
    await proposePlacementPlan(
      { thoughtId: 'fw-keep' },
      { now: NOW },
      { embed: okEmbed(), searchNeighbors: stubSearch({}) },
      db
    )
    await proposePlacementPlan({ thoughtId: 'fw-keep' }, { now: NOW }, { embed: failEmbed() }, db)
    await proposePlacementPlan(
      { thoughtId: 'fw-merge-src' },
      { now: NOW },
      {
        embed: okEmbed(),
        searchNeighbors: stubSearch({ 'fw-merge-src': [{ id: 'fw-merge-tgt', similarity: 0.9 }] })
      },
      db
    )
    await proposePlacementPlan(
      { thoughtId: 'fw-re-new' },
      { now: NOW },
      {
        embed: okEmbed(),
        searchNeighbors: stubSearch({ 'fw-re-new': [{ id: 'fw-re-old', similarity: 0.9 }] })
      },
      db
    )
    await proposePlacementPlan(
      { content: 'some draft content', projectId: 'default' },
      { now: NOW },
      { embed: okEmbed(), searchNeighbors: stubSearch({}) },
      db
    )
    await proposePlacementPlan(
      { thoughtId: 'fw-m' },
      { now: NOW },
      {
        embed: okEmbed(),
        searchNeighbors: stubSearch({ 'fw-m': [{ id: 'fw-keep', similarity: 0.9 }] })
      },
      db
    )
    const after = fp(db)
    expect(after).toEqual(before)
  })
})

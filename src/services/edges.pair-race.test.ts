import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../db'
import { getEdgePairBetween, insertEdgeRow } from '../db/edges'
import { getThoughtImportance } from '../db/importance'
import { closeDb, initDb } from '../db/init'
import { seedThought } from '../test/helpers'
import { createEdge } from './edges.service'

let dir: string | null = null
const peers: Database[] = []

afterEach(() => {
  for (const peer of peers.splice(0)) {
    try {
      peer.close(true)
    } catch {}
  }
  closeDb()
  if (dir !== null) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
})

test('a pair a second connection commits first is reused, not duplicated or boosted again', () => {
  // Two connections on one file: one handle is synchronous, so only a peer can commit a pair
  // between the lookup a caller resolved and the insert that follows it.
  dir = mkdtempSync(join(tmpdir(), 'synaptomind-edge-pair-'))
  const dbPath = join(dir, 'test.db')
  initDb({ dbPath, runMigrations: true })
  const a = getDb()
  const b = new Database(dbPath)
  b.run('PRAGMA busy_timeout = 5000')
  peers.push(b)

  const src = seedThought()
  const tgt = seedThought()
  a.prepare('UPDATE thought_importance SET importance = 0.5 WHERE thought_id = ?').run(src)

  expect(getEdgePairBetween(a, src, tgt)).toBeNull()

  const winner = insertEdgeRow(b, src, tgt, 'related')
  expect(winner.inserted).toBeTrue()

  const raced = insertEdgeRow(a, src, tgt, 'related')
  expect(raced.inserted).toBeFalse()
  expect(raced.id).not.toBe(winner.id)

  const pair = a
    .prepare(
      `SELECT id FROM edges
       WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`
    )
    .all(src, tgt, tgt, src)
  expect(pair).toEqual([{ id: winner.id }])

  const edge = createEdge(a, src, tgt, 'related')
  expect(edge.id).toBe(winner.id)
  expect(getThoughtImportance(a, src)?.importance).toBeCloseTo(0.5, 5)
})

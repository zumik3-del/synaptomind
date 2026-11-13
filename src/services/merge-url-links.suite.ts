import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'

// Real log sink: point the default Logger's FileSink at a scratch JSONL file
// BEFORE `../config` is evaluated (it is read at module load), then read the
// emitted lines back. Same recipe as `embedder-batch-loop.suite.ts`; no
// `insertLog` mock, so the redaction inside `Logger.insertLog` is exercised.
const scratch = mkdtempSync(join(tmpdir(), 'synaptomind-merge-url-links-'))
const logFile = join(scratch, 'logs.jsonl')
process.env.SYNAPTOMIND_LOG_FILE = logFile
process.env.SYNAPTOMIND_LOG_FORMAT = 'json'
process.env.SYNAPTOMIND_LOG_LEVEL = 'info'

const { closeDb } = await import('../db/init')
const { getDb } = await import('../context/container')
const { insertLog } = await import('../logging/log')
const { getThoughtUrlLinksForThoughts } = await import('../db/thought_url_links')
const { createTestDb, seedThought } = await import('../test/helpers')
const { createThoughtWithUrlLinksService } = await import('./url_links.service')
const { mergeThoughtsService } = await import('./merge.service')

beforeEach(() => {
  createTestDb()
  rmSync(logFile, { force: true })
})

afterEach(closeDb)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

interface LinkRow {
  text: string
  url: string
  sortOrder: number
}

interface LogRow {
  level: string
  type: string
  message: string
  metadata: Record<string, unknown> | null
  raw: string
}

function linksOf(thoughtId: string): LinkRow[] {
  return getThoughtUrlLinksForThoughts(getDb(), [thoughtId]).map(link => ({
    text: link.key,
    url: link.url,
    sortOrder: link.sort_order
  }))
}

function createLinked(content: string, urlLinks: Array<{ text: string; url: string }>): string {
  return createThoughtWithUrlLinksService({ content }, { urlLinks }).id
}

function logRows(): LogRow[] {
  if (!existsSync(logFile)) return []
  const rows: LogRow[] = []
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as {
        level?: string
        type?: string
        msg?: string
        meta?: Record<string, unknown>
      }
      rows.push({
        level: obj.level ?? '',
        type: obj.type ?? '',
        message: obj.msg ?? '',
        metadata: obj.meta === undefined ? null : obj.meta,
        raw: trimmed
      })
    } catch {}
  }
  return rows
}

const collisionRows = (): LogRow[] =>
  logRows().filter(row => row.type === 'thought' && row.message.includes('already on target'))

test('matrix case 7: merging with mergedContent moves the source links to the target', () => {
  const target = seedThought({ content: 'target thought without links' })
  const source = createLinked('source thought with two links', [
    { text: 'a', url: 'https://example.com/a' },
    { text: 'b', url: 'https://example.com/b' }
  ])

  mergeThoughtsService({
    targetId: target,
    sourceId: source,
    mergedContent: 'merged body, no markers'
  })

  expect(linksOf(target)).toEqual([
    { text: 'a', url: 'https://example.com/a', sortOrder: 0 },
    { text: 'b', url: 'https://example.com/b', sortOrder: 1 }
  ])
  expect(linksOf(source)).toEqual([])
  expect(collisionRows()).toHaveLength(0)
})

test('matrix case 8: merging without mergedContent appends the source links after the target max sort_order', () => {
  const target = createLinked('target thought with two links', [
    { text: 't0', url: 'https://example.com/t0' },
    { text: 't1', url: 'https://example.com/t1' }
  ])
  const source = createLinked('source thought with two links', [
    { text: 's0', url: 'https://example.com/s0' },
    { text: 's1', url: 'https://example.com/s1' }
  ])

  mergeThoughtsService({ targetId: target, sourceId: source })

  expect(linksOf(target)).toEqual([
    { text: 't0', url: 'https://example.com/t0', sortOrder: 0 },
    { text: 't1', url: 'https://example.com/t1', sortOrder: 1 },
    { text: 's0', url: 'https://example.com/s0', sortOrder: 2 },
    { text: 's1', url: 'https://example.com/s1', sortOrder: 3 }
  ])
  expect(linksOf(source)).toEqual([])
  expect(collisionRows()).toHaveLength(0)
})

test('matrix case 11: the sink writes the collision line with a readable link key, kept and dropped url', () => {
  const target = createLinked('target with the colliding key', [
    { text: 'docs', url: 'https://example.com/target/docs' }
  ])
  const source = createLinked('source with the colliding key', [
    { text: 'docs', url: 'https://example.com/source/docs' },
    { text: 'extra', url: 'https://example.com/source/extra' }
  ])

  mergeThoughtsService({ targetId: target, sourceId: source })

  expect(linksOf(target)).toEqual([
    { text: 'docs', url: 'https://example.com/target/docs', sortOrder: 0 },
    { text: 'extra', url: 'https://example.com/source/extra', sortOrder: 1 }
  ])
  expect(linksOf(source)).toEqual([])

  const rows = collisionRows()
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(row.level).toBe('warning')
  expect(row.metadata).toEqual({
    target_id: target,
    source_id: source,
    link_name: 'docs',
    kept_url: 'https://example.com/target/docs',
    dropped_url: 'https://example.com/source/docs'
  })
  expect('link_key' in (row.metadata ?? {})).toBe(false)
  expect(row.raw).toContain('"link_name":"docs"')
  expect(row.raw).toContain('"kept_url":"https://example.com/target/docs"')
  expect(row.raw).toContain('"dropped_url":"https://example.com/source/docs"')
  expect(row.raw).not.toContain('***')
})

test('a collision is logged once per collided key, never for a transferred key', () => {
  const target = createLinked('target with two colliding keys', [
    { text: 'docs', url: 'https://example.com/target/docs' },
    { text: 'spec', url: 'https://example.com/target/spec' }
  ])
  const source = createLinked('source with two colliding keys and one fresh key', [
    { text: 'docs', url: 'https://example.com/source/docs' },
    { text: 'spec', url: 'https://example.com/source/spec' },
    { text: 'fresh', url: 'https://example.com/source/fresh' }
  ])

  mergeThoughtsService({ targetId: target, sourceId: source })

  expect(linksOf(target).map(link => [link.text, link.url])).toEqual([
    ['docs', 'https://example.com/target/docs'],
    ['spec', 'https://example.com/target/spec'],
    ['fresh', 'https://example.com/source/fresh']
  ])
  const rows = collisionRows()
  expect(rows.map(row => row.metadata?.link_name)).toEqual(['docs', 'spec'])
  for (const row of rows) expect(row.raw).not.toContain('***')
})

test('the sink still redacts a genuinely sensitive metadata field name', () => {
  insertLog('warning', 'probe', 'redaction control', {
    api_key: 'sk-live-control-value',
    link_name: 'docs'
  })

  const rows = logRows()
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(row.metadata).toEqual({ api_key: '***', link_name: 'docs' })
  expect(row.raw).toContain('"api_key":"***"')
  expect(row.raw).not.toContain('sk-live-control-value')
})

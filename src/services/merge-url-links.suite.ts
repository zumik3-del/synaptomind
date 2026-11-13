import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'

interface LogCall {
  level: string
  type: string
  message: string
  metadata?: Record<string, unknown>
}

const entries: LogCall[] = []
const realLog = await import('../logging/log')

mock.module('../logging/log', () => ({
  ...realLog,
  insertLog: (level: string, type: string, message: string, metadata?: Record<string, unknown>) => {
    entries.push({ level, type, message, metadata })
  }
}))

const { getDb } = await import('../context/container')
const { getThoughtUrlLinksForThoughts } = await import('../db/thought_url_links')
const { createThoughtWithUrlLinksService } = await import('./url_links.service')
const { mergeThoughtsService } = await import('./merge.service')

beforeEach(() => {
  createTestDb()
  entries.length = 0
})

afterEach(closeDb)

interface LinkRow {
  text: string
  url: string
  sortOrder: number
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

function linkWarnings(): LogCall[] {
  return entries.filter(
    entry => entry.level === 'warning' && entry.metadata?.link_key !== undefined
  )
}

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
})

test('matrix case 11: a merge key collision keeps the target URL, drops both rows and logs one warning', () => {
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

  const warnings = linkWarnings()
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.level).toBe('warning')
  expect(warnings[0]?.metadata).toMatchObject({
    link_key: 'docs',
    kept_url: 'https://example.com/target/docs',
    dropped_url: 'https://example.com/source/docs'
  })
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
  expect(linkWarnings().map(entry => entry.metadata?.link_key)).toEqual(['docs', 'spec'])
})

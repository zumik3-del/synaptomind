import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { getThoughtUrlLinksForThoughts } from '../db/thought_url_links'
import { createTestDb } from '../test/helpers'
import { updateThoughtByIdService } from './thoughts.service'
import { createThoughtWithUrlLinksService } from './url_links.service'

beforeEach(createTestDb)
afterEach(closeDb)

interface LinkRow {
  text: string
  url: string
  label: string
  sortOrder: number
}

function linksOf(thoughtId: string): LinkRow[] {
  return getThoughtUrlLinksForThoughts(getDb(), [thoughtId]).map(link => ({
    text: link.key,
    url: link.url,
    label: link.label,
    sortOrder: link.sort_order
  }))
}

function createLinked(content: string, urlLinks: Array<{ text: string; url: string }>): string {
  return createThoughtWithUrlLinksService({ content }, { urlLinks }).id
}

test('create writes sort_order as the array index, so the array order is the link order', () => {
  const id = createLinked('three links in a known order', [
    { text: 'first', url: 'https://example.com/1' },
    { text: 'second', url: 'https://example.com/2' },
    { text: 'third', url: 'https://example.com/3' }
  ])

  expect(linksOf(id)).toEqual([
    { text: 'first', url: 'https://example.com/1', label: 'first', sortOrder: 0 },
    { text: 'second', url: 'https://example.com/2', label: 'second', sortOrder: 1 },
    { text: 'third', url: 'https://example.com/3', label: 'third', sortOrder: 2 }
  ])
})

test('matrix case 1: a content edit keeps a create-time link whose text carries no marker', () => {
  const id = createLinked('a thought with one out-of-band link', [
    { text: 'spec', url: 'https://example.com/spec' }
  ])

  updateThoughtByIdService(id, { content: 'the thought was rewritten and still has no marker' })

  expect(linksOf(id)).toEqual([
    { text: 'spec', url: 'https://example.com/spec', label: 'spec', sortOrder: 0 }
  ])
})

test('matrix case 2: re-sending byte-identical content keeps the link', () => {
  const content = 'identical content re-sent unchanged'
  const id = createLinked(content, [{ text: 'spec', url: 'https://example.com/spec' }])

  updateThoughtByIdService(id, { content })

  expect(linksOf(id)).toEqual([
    { text: 'spec', url: 'https://example.com/spec', label: 'spec', sortOrder: 0 }
  ])
})

test('matrix case 3a: a tags-only edit leaves the link set alone', () => {
  const id = createLinked('tagged thought', [{ text: 'spec', url: 'https://example.com/spec' }])

  updateThoughtByIdService(id, { tags: ['tag-one', 'tag-two'] })

  expect(linksOf(id)).toHaveLength(1)
  expect(linksOf(id)[0]?.text).toBe('spec')
})

test('matrix case 3b: a status-only edit leaves the link set alone', () => {
  const id = createLinked('status probe', [{ text: 'spec', url: 'https://example.com/spec' }])

  updateThoughtByIdService(id, { status: 'draft' })

  expect(linksOf(id)).toHaveLength(1)
  expect(linksOf(id)[0]?.text).toBe('spec')
})

test('matrix case 4: removing a [[key|label]] marker no longer deletes the row', () => {
  const id = createLinked('see [[spec/the spec]] for the details', [
    { text: 'spec', url: 'https://example.com/spec' }
  ])

  updateThoughtByIdService(id, { content: 'see the details, the marker is gone' })

  expect(linksOf(id).map(link => link.text)).toEqual(['spec'])
})

test('matrix case 5: renaming the marker keeps the row under its original key', () => {
  const id = createLinked('see [[spec/the spec]]', [
    { text: 'spec', url: 'https://example.com/spec' }
  ])

  updateThoughtByIdService(id, { content: 'see [[spec-2026/the spec]]' })

  const links = linksOf(id)
  expect(links.map(link => link.text)).toEqual(['spec'])
  expect(links[0]?.url).toBe('https://example.com/spec')
})

test('matrix case 6: [[nb]] plus an out-of-band {nb, spec} pair survives a benign edit', () => {
  const id = createLinked('notebook [[nb]] and the design spec', [
    { text: 'nb', url: 'https://example.com/nb' },
    { text: 'spec', url: 'https://example.com/spec' }
  ])

  updateThoughtByIdService(id, { content: 'notebook [[nb]] and the design spec, reviewed' })

  expect(linksOf(id).map(link => link.text)).toEqual(['nb', 'spec'])
})

test('matrix case 9: update url_links replaces the set in array order', () => {
  const id = createLinked('replace-set probe', [
    { text: 'a', url: 'https://example.com/a' },
    { text: 'b', url: 'https://example.com/b' }
  ])

  const updated = updateThoughtByIdService(
    id,
    {},
    {
      urlLinks: [
        { text: 'c', url: 'https://example.com/c' },
        { text: 'a', url: 'https://example.com/a-moved' },
        { text: 'd', url: 'https://example.com/d' }
      ]
    }
  )

  expect(linksOf(id)).toEqual([
    { text: 'c', url: 'https://example.com/c', label: 'c', sortOrder: 0 },
    { text: 'a', url: 'https://example.com/a-moved', label: 'a', sortOrder: 1 },
    { text: 'd', url: 'https://example.com/d', label: 'd', sortOrder: 2 }
  ])
  expect(Object.hasOwn(updated!, 'url_links')).toBe(false)
})

test('matrix case 10: update url_links: [] is the only explicit clear', () => {
  const id = createLinked('clear probe', [
    { text: 'a', url: 'https://example.com/a' },
    { text: 'b', url: 'https://example.com/b' }
  ])

  updateThoughtByIdService(id, {}, { urlLinks: [] })

  expect(linksOf(id)).toEqual([])
})

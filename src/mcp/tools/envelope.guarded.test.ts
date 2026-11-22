import { describe, expect, test } from 'bun:test'
import type { GuardedOutcome } from '../../services/confirm-gate.service'
import {
  collectionEnvelope,
  guardedCollectionEnvelope,
  guardedEnvelope,
  itemEnvelope
} from './envelope'

type Outcome<P, R> = GuardedOutcome<P, R>

function executed<R>(value: R): Outcome<never, R> {
  return { status: 'executed', value }
}

function preview<P>(value: P, token: string | null): Outcome<P, never> {
  return { status: 'preview', token, value }
}

describe('guardedEnvelope — the three preview states the docs promise', () => {
  test('an executed outcome carries no preview key at all', () => {
    const envelope = guardedEnvelope('archive', executed({ status: 'executed', result: 'done' }))

    expect(envelope.item).toEqual({ status: 'executed', result: 'done' })
    expect(Object.hasOwn(envelope.meta, 'preview')).toBe(false)
    expect(envelope.meta.counts).toEqual({ total: 1, returned: 1, filtered_out: 0 })
  })

  test('a preview carries the issued token verbatim', () => {
    const envelope = guardedEnvelope('archive', preview({ status: 'preview' }, 'tok-1'))

    expect(envelope.meta.preview).toEqual({ token: 'tok-1', destructive: true })
  })

  test('a tokenless preview declares token: null rather than omitting the block', () => {
    const envelope = guardedEnvelope('archive', preview({ status: 'preview' }, null))

    expect(Object.hasOwn(envelope.meta, 'preview')).toBe(true)
    expect(envelope.meta.preview?.token).toBeNull()
    expect(envelope.meta.preview).toEqual({ token: null, destructive: true })
  })

  test('the caller preview texts survive the token injection', () => {
    const envelope = guardedEnvelope('archive', preview({ status: 'preview' }, null), {
      preview: { consequence: 'archives the thought', instruction: 'call again with confirm=true' }
    })

    expect(envelope.meta.preview).toEqual({
      token: null,
      destructive: true,
      consequence: 'archives the thought',
      instruction: 'call again with confirm=true'
    })
  })

  test('the caller envelope options pass through unchanged', () => {
    const envelope = guardedEnvelope('merge', executed({ status: 'executed' }), {
      total: 3,
      warnings: ['w1'],
      scope: { project: 'p1', project_name: 'P', global: false }
    })

    expect(envelope.meta.counts).toEqual({ total: 3, returned: 1, filtered_out: 0 })
    expect(envelope.meta.warnings).toEqual(['w1'])
    expect(envelope.meta.scope).toEqual({ project: 'p1', project_name: 'P', global: false })
  })
})

describe('guardedCollectionEnvelope — the same three states, identical to collectionEnvelope', () => {
  const items = [{ thought_id: 'a', outcome: 'would_archive' }]
  const opts = { total: 4, counts: { would_archive: 1 } }

  test('an executed outcome matches collectionEnvelope with no preview', () => {
    const outcome = executed({ items, counts: { archived: 1 } })
    const guarded = guardedCollectionEnvelope('archive_batch', outcome, {
      ...opts,
      counts: outcome.value.counts
    })

    expect(guarded).toEqual(
      collectionEnvelope('archive_batch', items, { ...opts, counts: { archived: 1 } })
    )
    expect(Object.hasOwn(guarded.meta, 'preview')).toBe(false)
    expect(guarded.meta.counts).toEqual({
      archived: 1,
      total: 4,
      returned: 1,
      filtered_out: 0
    })
  })

  test('a preview with a token matches collectionEnvelope carrying that token', () => {
    const outcome = preview({ items, counts: { would_archive: 1 } }, 'tok-2')
    const guarded = guardedCollectionEnvelope('archive_batch', outcome, opts)

    expect(guarded).toEqual(
      collectionEnvelope('archive_batch', items, { ...opts, preview: { token: 'tok-2' } })
    )
    expect(guarded.meta.preview).toEqual({ token: 'tok-2', destructive: true })
  })

  test('a tokenless preview matches collectionEnvelope carrying token: null', () => {
    const outcome = preview({ items, counts: { would_archive: 1 } }, null)
    const guarded = guardedCollectionEnvelope('archive_batch', outcome, opts)

    expect(guarded).toEqual(
      collectionEnvelope('archive_batch', items, { ...opts, preview: { token: null } })
    )
    expect(guarded.meta.preview).toEqual({ token: null, destructive: true })
  })

  test('the item rows and the totals come from the outcome, never from the options', () => {
    const outcome = preview({ items, counts: { would_archive: 1 } }, 'tok-3')
    const guarded = guardedCollectionEnvelope('archive_batch', outcome, opts)

    expect(guarded.items).toBe(items)
    expect(guarded.meta.counts.total).toBe(opts.total)
    expect(guarded.meta.counts.returned).toBe(items.length)
    expect(guarded.meta.counts.would_archive).toBe(1)
  })
})

describe('itemEnvelope stays the primitive the guarded seam builds on', () => {
  test('a null item reports zero returned and keeps the preview text', () => {
    const envelope = itemEnvelope('delete', null, { preview: { token: 'tok-9' } })

    expect(envelope.meta.counts).toEqual({ total: 0, returned: 0, filtered_out: 0 })
    expect(envelope.meta.preview).toEqual({ token: 'tok-9', destructive: true })
  })
})

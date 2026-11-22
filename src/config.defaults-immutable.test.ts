import { describe, expect, test } from 'bun:test'
import { loadFreshConfig, type FreshConfigLoad } from './test/fresh-config'

/**
 * `DEFAULTS` is the fallback every rejected value falls back TO, and the config object shares its
 * untouched sections (the load is a shallow merge over it). Writing an env override in place used to
 * corrupt the defaults, so the next load — or any reader of `DEFAULTS` — saw the override where the
 * default belonged. These tests compare a snapshot of the defaults taken before a load with the
 * defaults the loaded module reports afterwards.
 */

async function load(env: Record<string, string> = {}): Promise<FreshConfigLoad> {
  return loadFreshConfig({ env, isolated: true })
}

function readPath(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function resolved(probe: FreshConfigLoad, path: string): unknown {
  return readPath(probe.config, path)
}

function defaultAt(probe: FreshConfigLoad, path: string): unknown {
  return readPath(probe.defaults, path)
}

describe('DEFAULTS — an env override must not write through the shared sections', () => {
  test('the defaults object is identical before and after an env override is applied', async () => {
    const baseline = await load()
    const before = structuredClone(baseline.defaults)

    const probe = await load({
      SYNAPTOMIND_PORT: '3010',
      SYNAPTOMIND_PRIMER_TOP_N: '7',
      SYNAPTOMIND_SEARCH_CONFIDENCE_VECTOR_FLOOR: '0.5',
      SYNAPTOMIND_RETENTION_REVIEW_PAGE_SIZE: '50'
    })

    expect(probe.error).toBeUndefined()
    expect(resolved(probe, 'server.port')).toBe(3010)
    expect(resolved(probe, 'primer.topN')).toBe(7)
    expect(resolved(probe, 'search.confidence.vectorFloor')).toBe(0.5)
    expect(resolved(probe, 'retentionReview.pageSize')).toBe(50)

    expect(probe.defaults).toEqual(before)
    expect(defaultAt(probe, 'server.port')).toBe(3005)
    expect(defaultAt(probe, 'primer.topN')).toBe(3)
    expect(defaultAt(probe, 'search.confidence.vectorFloor')).toBe(0.9)
    expect(defaultAt(probe, 'retentionReview.pageSize')).toBe(20)
  })

  test('an invalid env override leaves the defaults untouched too', async () => {
    const baseline = await load()
    const before = structuredClone(baseline.defaults)

    const probe = await load({ SYNAPTOMIND_SEARCH_CONFIDENCE_UNRELATED_FLOOR: 'nope' })

    expect(resolved(probe, 'search.confidence.unrelatedFloor')).toBe(0.8)
    expect(probe.defaults).toEqual(before)
  })

  test('a config.json override leaves the defaults untouched', async () => {
    const baseline = await load()
    const before = structuredClone(baseline.defaults)

    const probe = await loadFreshConfig({
      isolated: true,
      configFile: { server: { port: 3011 }, primer: { promoteThreshold: 9 } }
    })

    expect(resolved(probe, 'server.port')).toBe(3011)
    expect(resolved(probe, 'primer.promoteThreshold')).toBe(9)
    expect(probe.defaults).toEqual(before)
  })
})

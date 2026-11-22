import { describe, expect, test } from 'bun:test'
import { config, DEFAULTS, ENV_MAPPINGS } from './config'
import { describeValue, getNested, isPlainObject } from './config.schema'
import { normalizeSearchOptions } from './services/search-normalize.service'
import { loadFreshConfig, type FreshConfigLoad, type FreshConfigOptions } from './test/fresh-config'

async function load(options: FreshConfigOptions = {}): Promise<FreshConfigLoad> {
  return loadFreshConfig({ ...options, isolated: true })
}

function resolved(probe: FreshConfigLoad, path: string): unknown {
  return getNested(probe.config, path)
}

function defaultAt(probe: FreshConfigLoad, path: string): unknown {
  return getNested(probe.defaults, path)
}

function warnings(stderr: string): string[] {
  return stderr.split('\n').filter(line => line.includes('[config] invalid value'))
}

function expectOneWarning(probe: FreshConfigLoad, path: string): string {
  const found = warnings(probe.stderr).filter(line => line.includes(`invalid value for ${path}`))
  expect(found.length).toBe(1)
  expect(warnings(probe.stderr).length).toBe(1)
  return found[0] as string
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!isPlainObject(value)) return [prefix]
  return Object.keys(value).flatMap(key =>
    leafPaths(value[key], prefix === '' ? key : `${prefix}.${key}`)
  )
}

describe('fallback matrix — an invalid config.json value', () => {
  test('a wrong-typed value becomes the default with one warning naming key, value and default', async () => {
    const probe = await load({ configFile: { primer: { topN: '3' } } })

    expect(resolved(probe, 'primer.topN')).toBe(3)
    const warning = expectOneWarning(probe, 'primer.topN')
    expect(warning).toContain('invalid value for primer.topN: "3"')
    expect(warning).toContain('(expected an integer >= 1)')
    expect(warning).toContain('using default 3')
  })

  test('a non-finite value (1e999 parses to Infinity) becomes the default and is named', async () => {
    const probe = await load({ configText: '{"decay":{"rate":1e999}}' })

    expect(resolved(probe, 'decay.rate')).toBe(0.95)
    const warning = expectOneWarning(probe, 'decay.rate')
    expect(warning).toContain('invalid value for decay.rate: "Infinity"')
    expect(warning).toContain('(expected a finite number)')
    expect(warning).toContain('using default 0.95')
  })

  test('an out-of-bound value becomes the default, it is not clamped', async () => {
    const probe = await load({ configFile: { thoughts: { softLimit: 0 } } })

    expect(resolved(probe, 'thoughts.softLimit')).toBe(600)
    const warning = expectOneWarning(probe, 'thoughts.softLimit')
    expect(warning).toContain('invalid value for thoughts.softLimit: 0')
    expect(warning).toContain('using default 600')
  })

  test('a value inside its bound passes unchanged and warns nothing', async () => {
    const probe = await load({
      configFile: { thoughts: { softLimit: 1, hardLimitBufferPercent: 7 } }
    })

    expect(resolved(probe, 'thoughts.softLimit')).toBe(1)
    expect(resolved(probe, 'thoughts.hardLimitBufferPercent')).toBe(7)
    expect(warnings(probe.stderr)).toEqual([])
  })
})

describe('fallback matrix — an invalid environment value', () => {
  test('a non-numeric env value becomes the default, reported against the env var', async () => {
    const probe = await load({ env: { SYNAPTOMIND_PRIMER_TOP_N: 'abc' } })

    expect(resolved(probe, 'primer.topN')).toBe(3)
    const warning = expectOneWarning(probe, 'primer.topN')
    expect(warning).toContain('(from SYNAPTOMIND_PRIMER_TOP_N)')
    expect(warning).toContain('"abc"')
    expect(warning).toContain('using default 3')
  })

  test('a non-finite env value becomes the default and is named', async () => {
    const probe = await load({ env: { SYNAPTOMIND_DECAY_RATE: 'Infinity' } })

    expect(resolved(probe, 'decay.rate')).toBe(0.95)
    const warning = expectOneWarning(probe, 'decay.rate')
    expect(warning).toContain('(from SYNAPTOMIND_DECAY_RATE)')
    expect(warning).toContain('"Infinity"')
    expect(warning).toContain('using default 0.95')
  })

  test('an out-of-bound env value becomes the default, it is not clamped', async () => {
    const probe = await load({ env: { SYNAPTOMIND_THOUGHT_SOFT_LIMIT: '0' } })

    expect(resolved(probe, 'thoughts.softLimit')).toBe(600)
    const warning = expectOneWarning(probe, 'thoughts.softLimit')
    expect(warning).toContain('(from SYNAPTOMIND_THOUGHT_SOFT_LIMIT)')
    expect(warning).toContain('using default 600')
  })

  test('an env value inside its bound passes unchanged and warns nothing', async () => {
    const probe = await load({ env: { SYNAPTOMIND_THOUGHT_SOFT_LIMIT: '1' } })

    expect(resolved(probe, 'thoughts.softLimit')).toBe(1)
    expect(warnings(probe.stderr)).toEqual([])
  })

  test('the env layer wins over config.json and the winner is what gets validated', async () => {
    const probe = await load({
      configFile: { thoughts: { softLimit: 7 } },
      env: { SYNAPTOMIND_THOUGHT_SOFT_LIMIT: '0' }
    })

    expect(resolved(probe, 'thoughts.softLimit')).toBe(600)
    expect(warnings(probe.stderr).length).toBe(1)
  })
})

describe('fallback matrix — warning discipline', () => {
  test('one rejected value is one warning even when the load carries several bad keys', async () => {
    const probe = await load({
      configFile: { server: { port: 'nope' }, primer: { topN: 0 } }
    })

    expect(warnings(probe.stderr).length).toBe(2)
    expect(warnings(probe.stderr)).toEqual([
      expect.stringContaining('invalid value for server.port'),
      expect.stringContaining('invalid value for primer.topN')
    ])
  })

  test('a fully valid file and environment warn nothing', async () => {
    const probe = await load({
      configFile: { server: { port: 3010 }, primer: { topN: 4 } },
      env: { SYNAPTOMIND_THOUGHT_SOFT_LIMIT: '900' }
    })

    expect(resolved(probe, 'server.port')).toBe(3010)
    expect(resolved(probe, 'primer.topN')).toBe(4)
    expect(warnings(probe.stderr)).toEqual([])
  })
})

describe('section repair — a section replaced by a non-object', () => {
  test('a string primer section is one warning and both defaults', async () => {
    const probe = await load({ configFile: { primer: 'abc' } })

    expect(resolved(probe, 'primer.topN')).toBe(defaultAt(probe, 'primer.topN'))
    expect(resolved(probe, 'primer.promoteThreshold')).toBe(
      defaultAt(probe, 'primer.promoteThreshold')
    )
    const warning = expectOneWarning(probe, 'primer')
    expect(warning).toContain('invalid value for primer: "abc"')
    expect(warning).toContain('(expected an object)')
    expect(warning).toContain(`using default ${describeValue(defaultAt(probe, 'primer'))}`)
  })

  test('a nested section replaced by a number is repaired at its own path', async () => {
    const probe = await load({ configFile: { search: { confidence: 5 } } })

    expect(resolved(probe, 'search.confidence.vectorFloor')).toBe(
      defaultAt(probe, 'search.confidence.vectorFloor')
    )
    expect(resolved(probe, 'search.confidence.unrelatedFloor')).toBe(
      defaultAt(probe, 'search.confidence.unrelatedFloor')
    )
    const warning = expectOneWarning(probe, 'search.confidence')
    expect(warning).toContain('invalid value for search.confidence: 5')
    expect(warning).toContain('(expected an object)')
  })

  test('a shaped section is not "repaired" and warns nothing', async () => {
    const probe = await load({ configFile: { primer: { topN: 2 }, search: { confidence: {} } } })

    expect(resolved(probe, 'primer.topN')).toBe(2)
    expect(warnings(probe.stderr)).toEqual([])
  })
})

describe('ENV_MAPPINGS and DEFAULTS — shape equality', () => {
  test('every DEFAULTS leaf is env-mapped, with users the one declared exception', () => {
    const leaves = leafPaths(DEFAULTS as unknown as Record<string, unknown>)
    expect(leaves).toContain('users')

    const mapped = [...ENV_MAPPINGS.map(mapping => mapping.path)].sort()
    expect(leaves.filter(path => path !== 'users').sort()).toEqual(mapped)
    expect(mapped).not.toContain('users')
  })

  test('every mapped path is a leaf, never a whole section', () => {
    const leaves = new Set(leafPaths(DEFAULTS as unknown as Record<string, unknown>))
    const sections = ENV_MAPPINGS.map(mapping => mapping.path).filter(path => !leaves.has(path))

    expect(sections).toEqual([])
  })

  test('the DEFAULTS type and the env registry declare the same shape', () => {
    const defaultsShape = leafPaths(DEFAULTS as unknown as Record<string, unknown>).map(path => {
      const value = getNested(DEFAULTS, path)
      return `${path}:${Array.isArray(value) ? 'list' : typeof value}`
    })
    const declaredShape = ENV_MAPPINGS.map(mapping => {
      const value = getNested(DEFAULTS, mapping.path)
      return `${mapping.path}:${Array.isArray(value) ? 'list' : typeof value}`
    })

    expect(declaredShape.sort()).toEqual(
      defaultsShape.filter(shape => !shape.startsWith('users:')).sort()
    )
  })
})

describe('search.confidence — no downstream clamp survives the removed guard', () => {
  test('an out-of-bound floor falls back at load instead of being clamped to 1', async () => {
    const probe = await load({ configFile: { search: { confidence: { vectorFloor: 5 } } } })

    expect(resolved(probe, 'search.confidence.vectorFloor')).toBe(0.9)
    const warning = expectOneWarning(probe, 'search.confidence.vectorFloor')
    expect(warning).toContain('(expected a finite number in [0,1])')
  })

  test('a caller-supplied floor reaches normalization unclamped', () => {
    expect(normalizeSearchOptions({ query: 'x', confidenceFloor: 5 }).confidenceFloor).toBe(5)
    expect(normalizeSearchOptions({ query: 'x', confidenceFloor: -0.5 }).confidenceFloor).toBe(-0.5)
  })

  test('normalization takes both configured floors verbatim', () => {
    const normalized = normalizeSearchOptions({ query: 'x' })

    expect(normalized.confidenceFloor).toBe(config.search.confidence.vectorFloor)
    expect(normalized.unrelatedFloor).toBe(config.search.confidence.unrelatedFloor)
  })
})

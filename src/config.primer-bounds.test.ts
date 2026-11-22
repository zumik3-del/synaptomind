import { describe, expect, test } from 'bun:test'
import { DEFAULTS } from './config'
import { loadFreshConfig, type FreshConfigLoad } from './test/fresh-config'

/**
 * Every primer-knob assertion the deleted `config.primer-bounds.test.ts` carried, re-expressed
 * against the one schema: the ad-hoc sanitizer clamped a bad count to 1 and floored a fraction, the
 * schema replaces a value that is not an integer >= 1 with the default and reports it.
 */

function readPath(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const TOP_N = 'SYNAPTOMIND_PRIMER_TOP_N'
const PROMOTE = 'SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD'

async function load(
  configFile?: unknown,
  env: Record<string, string> = {}
): Promise<FreshConfigLoad> {
  return loadFreshConfig({ configFile, env, isolated: true })
}

function topN(probe: FreshConfigLoad): unknown {
  return readPath(probe.config, 'primer.topN')
}

function promote(probe: FreshConfigLoad): unknown {
  return readPath(probe.config, 'primer.promoteThreshold')
}

function warnings(probe: FreshConfigLoad): string[] {
  return probe.stderr.split('\n').filter(line => line.includes('[config] invalid value'))
}

describe('primer knobs — the built-in defaults', () => {
  test('topN defaults to 3 and promoteThreshold to 5', () => {
    expect(DEFAULTS.primer.topN).toBe(3)
    expect(DEFAULTS.primer.promoteThreshold).toBe(5)
  })

  test('a config without a primer section resolves to the defaults', async () => {
    const probe = await load()

    expect(probe.error).toBeUndefined()
    expect(topN(probe)).toBe(3)
    expect(promote(probe)).toBe(5)
    expect(warnings(probe)).toEqual([])
  })
})

describe('primer knobs — config.json (the file path)', () => {
  test('a negative topN becomes the default 3, never "unlimited" and never 1', async () => {
    const probe = await load({ primer: { topN: -5 } })

    expect(topN(probe)).toBe(3)
    expect(promote(probe)).toBe(5)
  })

  test('a zero topN becomes the default 3', async () => {
    const probe = await load({ primer: { topN: 0 } })

    expect(topN(probe)).toBe(3)
  })

  test('a non-numeric topN falls back to the built-in default (3)', async () => {
    const probe = await load({ primer: { topN: 'abc' } })

    expect(topN(probe)).toBe(3)
  })

  test('a negative promoteThreshold becomes the default 5, never 1', async () => {
    const probe = await load({ primer: { promoteThreshold: -5 } })

    expect(promote(probe)).toBe(5)
    expect(topN(probe)).toBe(3)
  })

  test('a non-numeric promoteThreshold falls back to the built-in default (5)', async () => {
    const probe = await load({ primer: { promoteThreshold: 'abc' } })

    expect(promote(probe)).toBe(5)
  })

  test('a fractional knob falls back to the default instead of being floored', async () => {
    const probe = await load({ primer: { topN: 2.7 } })

    expect(topN(probe)).toBe(3)
    expect(warnings(probe).length).toBe(1)
  })

  test('a primer section that is not an object is one warning and both defaults', async () => {
    const probe = await load({ primer: 'abc' })

    expect(topN(probe)).toBe(3)
    expect(promote(probe)).toBe(5)
    expect(warnings(probe)).toEqual([expect.stringContaining('invalid value for primer: "abc"')])
  })

  test('valid values are untouched', async () => {
    const probe = await load({ primer: { topN: 3, promoteThreshold: 5 } })

    expect(topN(probe)).toBe(3)
    expect(promote(probe)).toBe(5)
    expect(warnings(probe)).toEqual([])
  })
})

describe('primer knobs — the env path', () => {
  test(`${TOP_N}=-5 becomes the default 3`, async () => {
    const probe = await load(undefined, { [TOP_N]: '-5' })

    expect(topN(probe)).toBe(3)
  })

  test(`${TOP_N}=0 becomes the default 3`, async () => {
    const probe = await load(undefined, { [TOP_N]: '0' })

    expect(topN(probe)).toBe(3)
  })

  test(`${TOP_N}=abc becomes the default 3`, async () => {
    const probe = await load(undefined, { [TOP_N]: 'abc' })

    expect(topN(probe)).toBe(3)
  })

  test('the env override wins over a valid file value AND is validated', async () => {
    const probe = await load({ primer: { topN: 4 } }, { [TOP_N]: '-2' })

    expect(topN(probe)).toBe(3)
    expect(warnings(probe).length).toBe(1)
  })

  test('a valid env override is applied untouched', async () => {
    const probe = await load(undefined, { [TOP_N]: '7' })

    expect(topN(probe)).toBe(7)
    expect(warnings(probe)).toEqual([])
  })

  test(`${PROMOTE}=-5 becomes the default 5`, async () => {
    const probe = await load(undefined, { [PROMOTE]: '-5' })

    expect(promote(probe)).toBe(5)
  })

  test(`${PROMOTE}=abc becomes the default 5`, async () => {
    const probe = await load(undefined, { [PROMOTE]: 'abc' })

    expect(promote(probe)).toBe(5)
  })

  test('no override anywhere resolves to 3 / 5', async () => {
    const probe = await load()

    expect(topN(probe)).toBe(3)
    expect(promote(probe)).toBe(5)
  })
})

describe('primer knobs — the stderr report', () => {
  test('a negative topN names the key, the offending value and the default actually used', async () => {
    const probe = await load({ primer: { topN: -5 } })

    expect(warnings(probe)).toEqual([
      '[config] invalid value for primer.topN: -5 (expected an integer >= 1), using default 3'
    ])
  })

  test('a non-numeric topN names the offending value and the default used', async () => {
    const probe = await load({ primer: { topN: 'abc' } })

    expect(warnings(probe)).toEqual([
      '[config] invalid value for primer.topN: "abc" (expected an integer >= 1), using default 3'
    ])
  })

  test('a negative promoteThreshold names the offending value and the default used', async () => {
    const probe = await load({ primer: { promoteThreshold: -5 } })

    expect(warnings(probe)).toEqual([
      '[config] invalid value for primer.promoteThreshold: -5 (expected an integer >= 1), using default 5'
    ])
  })

  test('a negative env override names both the key and the env var', async () => {
    const probe = await load(undefined, { [TOP_N]: '-5' })

    expect(warnings(probe)).toEqual([
      `[config] invalid value for primer.topN (from ${TOP_N}): -5 (expected an integer >= 1), using default 3`
    ])
  })

  test('a non-numeric env value names the env var and the value', async () => {
    const probe = await load(undefined, { [TOP_N]: 'abc' })

    expect(warnings(probe)).toEqual([
      `[config] invalid value for primer.topN (from ${TOP_N}): "abc" (expected an integer >= 1), using default 3`
    ])
  })

  test('valid values print nothing', async () => {
    const probe = await load({ primer: { topN: 3, promoteThreshold: 5 } })

    expect(probe.stderr).not.toContain('invalid value for primer')
  })

  test('a valid env override prints nothing', async () => {
    const probe = await load(undefined, { [TOP_N]: '3' })

    expect(probe.stderr).not.toContain('invalid value for primer')
  })
})

import { describe, expect, test } from 'bun:test'
import { DEFAULTS } from './config'
import { loadFreshConfig, type FreshConfigLoad } from './test/fresh-config'

/**
 * The deleted `config.retention-review-bounds.test.ts` assertions, re-expressed against the one
 * schema. The sanitizer clamped `pageSize: 101.8` to 100 and `importanceFloor: -1` to 0; the schema
 * rejects both — a fraction is not an integer and a bound is not a clamp — and keeps `0`, which is
 * a legitimate floor, as a value.
 */

function readPath(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const DEFAULTS_SECTION = { pageSize: 20, importanceFloor: 0.3, minAgeDays: 30 }

async function load(configFile?: unknown): Promise<FreshConfigLoad> {
  return loadFreshConfig({ configFile, isolated: true })
}

function section(probe: FreshConfigLoad): unknown {
  return readPath(probe.config, 'retentionReview')
}

function warnings(probe: FreshConfigLoad): string[] {
  return probe.stderr.split('\n').filter(line => line.includes('[config] invalid value'))
}

describe('retentionReview — the declared defaults', () => {
  test('the section resolves to pageSize 20, importanceFloor 0.3, minAgeDays 30', () => {
    expect(DEFAULTS.retentionReview).toEqual(DEFAULTS_SECTION)
  })
})

describe('retentionReview — invalid values fall back, they are not clamped', () => {
  test('the old clamp case: a fractional pageSize, a negative floor and a zero age all fall back', async () => {
    const probe = await load({
      retentionReview: { pageSize: 101.8, importanceFloor: -1, minAgeDays: 0 }
    })

    expect(section(probe)).toEqual(DEFAULTS_SECTION)
    const lines = warnings(probe)
    expect(lines.length).toBe(3)
    for (const needle of [
      'invalid value for retentionReview.pageSize: 101.8',
      'invalid value for retentionReview.importanceFloor: -1',
      'invalid value for retentionReview.minAgeDays: 0'
    ])
      expect(lines.join('\n')).toContain(needle)
  })

  test('a wrong-typed pageSize and a non-finite floor fall back, an absent age defaults', async () => {
    const probe = await loadFreshConfig({
      isolated: true,
      configText: '{"retentionReview":{"pageSize":"bad","importanceFloor":1e999}}'
    })

    expect(section(probe)).toEqual(DEFAULTS_SECTION)
    const lines = warnings(probe)
    expect(lines.length).toBe(2)
    expect(lines.join('\n')).toContain('invalid value for retentionReview.pageSize: "bad"')
    expect(lines.join('\n')).toContain(
      'invalid value for retentionReview.importanceFloor: "Infinity"'
    )
  })

  test('an out-of-bound pageSize above 100 falls back to 20', async () => {
    const probe = await load({ retentionReview: { pageSize: 101 } })

    expect(readPath(probe.config, 'retentionReview.pageSize')).toBe(20)
    expect(warnings(probe).length).toBe(1)
  })

  test('a policy outside 1–100 page size falls back; both boundaries pass', async () => {
    for (const value of [0, 1, 100]) {
      const probe = await load({ retentionReview: { pageSize: value } })
      const expected = value === 0 ? 20 : value

      expect(readPath(probe.config, 'retentionReview.pageSize'), `pageSize ${value}`).toBe(expected)
    }
    const zero = await load({ retentionReview: { pageSize: 0 } })
    expect(warnings(zero).length).toBe(1)
  })

  test('a negative age falls back; 1 is the smallest accepted age', async () => {
    const rejected = await load({ retentionReview: { minAgeDays: -1 } })
    const accepted = await load({ retentionReview: { minAgeDays: 1 } })

    expect(readPath(rejected.config, 'retentionReview.minAgeDays')).toBe(30)
    expect(readPath(accepted.config, 'retentionReview.minAgeDays')).toBe(1)
    expect(warnings(accepted)).toEqual([])
  })

  test('a floor of 0 is legitimate and survives both layers', async () => {
    const fromFile = await load({ retentionReview: { importanceFloor: 0 } })
    expect(readPath(fromFile.config, 'retentionReview.importanceFloor')).toBe(0)
    expect(warnings(fromFile)).toEqual([])

    const fromEnv = await loadFreshConfig({
      isolated: true,
      env: { SYNAPTOMIND_RETENTION_REVIEW_IMPORTANCE_FLOOR: '0' }
    })
    expect(readPath(fromEnv.config, 'retentionReview.importanceFloor')).toBe(0)
    expect(warnings(fromEnv)).toEqual([])
  })

  test('a floor above 1 falls back to 0.3', async () => {
    const probe = await load({ retentionReview: { importanceFloor: 1.5 } })

    expect(readPath(probe.config, 'retentionReview.importanceFloor')).toBe(0.3)
    expect(warnings(probe)).toEqual([
      expect.stringContaining('(expected a finite number in [0,1])')
    ])
  })
})

describe('retentionReview — valid values do not warn', () => {
  test('pageSize 15, importanceFloor 0.4, minAgeDays 45 are untouched', async () => {
    const probe = await load({
      retentionReview: { pageSize: 15, importanceFloor: 0.4, minAgeDays: 45 }
    })

    expect(section(probe)).toEqual({ pageSize: 15, importanceFloor: 0.4, minAgeDays: 45 })
    expect(warnings(probe)).toEqual([])
  })
})

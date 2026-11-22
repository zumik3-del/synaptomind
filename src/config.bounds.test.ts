import { describe, expect, test } from 'bun:test'
import { ENV_MAPPINGS } from './config'
import { describeValue, getNested } from './config.schema'
import { loadFreshConfig, type FreshConfigLoad } from './test/fresh-config'

interface BoundCase {
  path: string
  env: string
  min: number
  max?: number
  below: number
  above?: number
}

/**
 * The ten bounded keys the schema declares. `below`/`above` are one step outside the bound; a key
 * that stops rejecting either one is no longer a bound and the matrix fails.
 */
const BOUNDED: BoundCase[] = [
  { path: 'db.busyTimeout', env: 'SYNAPTOMIND_DB_BUSY_TIMEOUT', min: 0, below: -1 },
  { path: 'thoughts.softLimit', env: 'SYNAPTOMIND_THOUGHT_SOFT_LIMIT', min: 1, below: 0 },
  {
    path: 'thoughts.hardLimitBufferPercent',
    env: 'SYNAPTOMIND_THOUGHT_HARD_LIMIT_BUFFER_PERCENT',
    min: 1,
    below: 0
  },
  {
    path: 'primer.promoteThreshold',
    env: 'SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD',
    min: 1,
    below: 0
  },
  { path: 'primer.topN', env: 'SYNAPTOMIND_PRIMER_TOP_N', min: 1, below: 0 },
  {
    path: 'search.confidence.vectorFloor',
    env: 'SYNAPTOMIND_SEARCH_CONFIDENCE_VECTOR_FLOOR',
    min: 0,
    max: 1,
    below: -0.1,
    above: 1.1
  },
  {
    path: 'search.confidence.unrelatedFloor',
    env: 'SYNAPTOMIND_SEARCH_CONFIDENCE_UNRELATED_FLOOR',
    min: 0,
    max: 1,
    below: -0.1,
    above: 1.1
  },
  {
    path: 'retentionReview.minAgeDays',
    env: 'SYNAPTOMIND_RETENTION_REVIEW_MIN_AGE_DAYS',
    min: 1,
    below: 0
  },
  {
    path: 'retentionReview.importanceFloor',
    env: 'SYNAPTOMIND_RETENTION_REVIEW_IMPORTANCE_FLOOR',
    min: 0,
    max: 1,
    below: -0.1,
    above: 1.1
  },
  {
    path: 'retentionReview.pageSize',
    env: 'SYNAPTOMIND_RETENTION_REVIEW_PAGE_SIZE',
    min: 1,
    max: 100,
    below: 0,
    above: 101
  }
]

async function load(
  configFile: unknown,
  env: Record<string, string> = {}
): Promise<FreshConfigLoad> {
  return loadFreshConfig({ configFile, env, isolated: true })
}

function resolved(probe: FreshConfigLoad, path: string): unknown {
  return getNested(probe.config, path)
}

function warnings(probe: FreshConfigLoad): string[] {
  return probe.stderr.split('\n').filter(line => line.includes('[config] invalid value'))
}

function oneRejection(probe: FreshConfigLoad, path: string): string {
  const lines = warnings(probe).filter(line => line.includes(`invalid value for ${path}`))
  expect(lines.length).toBe(1)
  expect(warnings(probe).length).toBe(1)
  return lines[0] as string
}

describe('bounded keys — the declared set', () => {
  test('exactly the ten keys below declare a bound, and the matrix matches each one', () => {
    const declared = ENV_MAPPINGS.filter(
      entry => entry.min !== undefined || entry.max !== undefined
    )
      .map(entry => ({ path: entry.path, min: entry.min, max: entry.max }))
      .sort((a, b) => a.path.localeCompare(b.path))
    const expected = BOUNDED.map(entry => ({
      path: entry.path,
      min: entry.min,
      max: entry.max
    })).sort((a, b) => a.path.localeCompare(b.path))

    expect(declared).toEqual(expected)
    expect(declared.length).toBe(10)
  })
})

describe.each(BOUNDED.map(entry => [entry.path, entry] as const))(
  'bounded key %s',
  (path, entry) => {
    test(`a config.json value of ${entry.below} is rejected and becomes the default`, async () => {
      const probe = await load(setAt(path, entry.below))

      expect(resolved(probe, path)).toBe(getNested(probe.defaults, path))
      const warning = oneRejection(probe, path)
      expect(warning).toContain(`invalid value for ${path}: ${describeValue(entry.below)}`)
      expect(warning).toContain(`using default ${describeValue(getNested(probe.defaults, path))}`)
      expect(warning).not.toContain('(from ')
    })

    test(`an env value of ${entry.below} is rejected and becomes the default`, async () => {
      const probe = await load(undefined, { [entry.env]: String(entry.below) })

      expect(resolved(probe, path)).toBe(getNested(probe.defaults, path))
      const warning = oneRejection(probe, path)
      expect(warning).toContain(`invalid value for ${path} (from ${entry.env})`)
      expect(warning).toContain(`using default ${describeValue(getNested(probe.defaults, path))}`)
    })

    test(`the lower boundary ${entry.min} is inside the bound and passes unchanged`, async () => {
      const fromFile = await load(setAt(path, entry.min))
      expect(resolved(fromFile, path)).toBe(entry.min)
      expect(warnings(fromFile)).toEqual([])

      const fromEnv = await load(undefined, { [entry.env]: String(entry.min) })
      expect(resolved(fromEnv, path)).toBe(entry.min)
      expect(warnings(fromEnv)).toEqual([])
    })

    if (entry.above !== undefined && entry.max !== undefined) {
      const above = entry.above
      const max = entry.max

      test(`a config.json value of ${above} is rejected and becomes the default`, async () => {
        const probe = await load(setAt(path, above))

        expect(resolved(probe, path)).toBe(getNested(probe.defaults, path))
        const warning = oneRejection(probe, path)
        expect(warning).toContain(`invalid value for ${path}: ${describeValue(above)}`)
      })

      test(`an env value of ${above} is rejected and becomes the default`, async () => {
        const probe = await load(undefined, { [entry.env]: String(above) })

        expect(resolved(probe, path)).toBe(getNested(probe.defaults, path))
        const warning = oneRejection(probe, path)
        expect(warning).toContain(`(from ${entry.env})`)
      })

      test(`the upper boundary ${max} is inside the bound and passes unchanged`, async () => {
        const probe = await load(setAt(path, max))

        expect(resolved(probe, path)).toBe(max)
        expect(warnings(probe)).toEqual([])
      })
    }
  }
)

describe('bounded keys — 0 is a value, not a missing key', () => {
  test('every key whose bound admits 0 resolves 0 through both layers', async () => {
    const zeroLegitimate = BOUNDED.filter(entry => entry.min === 0)
    expect(zeroLegitimate.map(entry => entry.path)).toEqual([
      'db.busyTimeout',
      'search.confidence.vectorFloor',
      'search.confidence.unrelatedFloor',
      'retentionReview.importanceFloor'
    ])

    for (const entry of zeroLegitimate) {
      const fromFile = await load(setAt(entry.path, 0))
      expect(resolved(fromFile, entry.path), `${entry.path} via config.json`).toBe(0)
      expect(warnings(fromFile), `${entry.path} via config.json`).toEqual([])

      const fromEnv = await load(undefined, { [entry.env]: '0' })
      expect(resolved(fromEnv, entry.path), `${entry.path} via ${entry.env}`).toBe(0)
      expect(warnings(fromEnv), `${entry.path} via ${entry.env}`).toEqual([])
    }
  })
})

function setAt(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.')
  let node: Record<string, unknown> = {}
  const root = node
  for (const key of keys.slice(0, -1)) {
    const child: Record<string, unknown> = {}
    node[key] = child
    node = child
  }
  node[keys[keys.length - 1]] = value
  return root
}

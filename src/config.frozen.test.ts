import { describe, expect, test } from 'bun:test'
import { config, DEFAULTS } from './config'
import { loadFreshConfig } from './test/fresh-config'

/**
 * The load is the only writer of the config object, so the object is frozen: a section the file does
 * not override is the very object `DEFAULTS` exposes, and an in-place write would corrupt the
 * defaults every later load and every reader falls back to. Callers that need other values build
 * their own fixture and pass it to the consumer.
 */

function objectsIn(value: unknown, seen: Set<object> = new Set()): object[] {
  if (value === null || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  return [value, ...Object.values(value).flatMap(nested => objectsIn(nested, seen))]
}

describe('the loaded config is frozen', () => {
  test('the export and every object reachable from it are frozen', () => {
    const objects = objectsIn(config)
    expect(objects.length).toBeGreaterThan(1)
    for (const object of objects) expect(Object.isFrozen(object)).toBe(true)
  })

  test('assigning a top-level, nested or array value throws', () => {
    expect(() => {
      ;(config as unknown as Record<string, unknown>).contentLanguage = 'ru'
    }).toThrow(TypeError)
    expect(() => {
      config.thoughts.softLimit = 10
    }).toThrow(TypeError)
    expect(() => {
      config.db.path = '/tmp/elsewhere.db'
    }).toThrow(TypeError)
    expect(() => {
      config.search.confidence.unrelatedFloor = 0.5
    }).toThrow(TypeError)
    expect(() => {
      config.users.push({ id: 'alice', dbPath: '/tmp/alice.db', tokenSha256: 'a'.repeat(64) })
    }).toThrow(TypeError)

    expect(config.db.path).toBe(DEFAULTS.db.path)
    expect(config.users).toEqual([])
  })
})

describe('an isolated load equals the documented defaults', () => {
  test('the resolved object deep-equals DEFAULTS and is frozen at every level', async () => {
    const probe = await loadFreshConfig({ isolated: true })

    expect(probe.error).toBeUndefined()
    expect(probe.config).toEqual(probe.defaults)
    expect(probe.config).toEqual(DEFAULTS as unknown as Record<string, unknown>)
    for (const object of objectsIn(probe.config)) expect(Object.isFrozen(object)).toBe(true)
  })

  test('assigning into a freshly loaded config throws as well', async () => {
    const probe = await loadFreshConfig({ isolated: true })
    const loaded = probe.config as { thoughts: { softLimit: number } }

    expect(() => {
      loaded.thoughts.softLimit = 1
    }).toThrow(TypeError)
    expect(loaded.thoughts.softLimit).toBe(DEFAULTS.thoughts.softLimit)
  })
})

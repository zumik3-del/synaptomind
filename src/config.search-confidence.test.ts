import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULTS, ENV_MAPPINGS } from './config'

/**
 * Task #2178: `search.confidence.unrelatedFloor` — the zero point of the
 * calibrated relevance scale, and the env override
 * `SYNAPTOMIND_SEARCH_CONFIDENCE_UNRELATED_FLOOR`.
 *
 * The key is resolved on the FINAL merged config (config.json, then env), so the
 * load-time cases run the real module in a child process with a scratch cwd —
 * the same pattern as `src/config.primer-bounds.test.ts`. No model, no DB.
 */

const CONFIG_TS = resolve(import.meta.dir, 'config.ts')

const PROBE = `const m = await import(${JSON.stringify(CONFIG_TS)});
console.log('FLOOR=' + m.config.search.confidence.unrelatedFloor);
console.log('VECTORFLOOR=' + m.config.search.confidence.vectorFloor);`

const FLOOR_ENV = 'SYNAPTOMIND_SEARCH_CONFIDENCE_UNRELATED_FLOOR'
const VECTOR_ENV = 'SYNAPTOMIND_SEARCH_CONFIDENCE_VECTOR_FLOOR'

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

function scratchDir(): string {
  SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-config-search-'))
  return SCRATCH
}

/** Ambient env minus the two search-confidence overrides. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env[FLOOR_ENV]
  delete env[VECTOR_ENV]
  return env
}

interface LoadResult {
  code: number
  /** stdout: the probe lines (the resolved knob values). */
  out: string
  /** stderr: the config layer's report ("invalid value for ..."). */
  err: string
}

async function loadConfig(cwd: string, env: Record<string, string> = {}): Promise<LoadResult> {
  const proc = Bun.spawn([process.execPath, '-e', PROBE], {
    cwd,
    env: { ...baseEnv(), ...env },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { code, out: stdout, err: stderr }
}

function resolved(out: string, key: string): string {
  const line = out.split('\n').find(l => l.startsWith(`${key}=`))
  return line === undefined ? '' : line.slice(key.length + 1)
}

async function loadWithFile(fileConfig: unknown, env: Record<string, string> = {}): Promise<LoadResult> {
  const cwd = scratchDir()
  writeFileSync(join(cwd, 'config.json'), JSON.stringify(fileConfig))
  return loadConfig(cwd, env)
}

describe('search.confidence.unrelatedFloor — the built-in default', () => {
  test('the default floor is the measured unrelated similarity (0.8)', () => {
    // The calibrated relevance is `(similarity - unrelatedFloor) /
    // (vectorFloor - unrelatedFloor)`; the pair 0.8/0.9 is the measured e5-small
    // band from task #2178.
    expect(DEFAULTS.search.confidence.unrelatedFloor).toBe(0.8)
    expect(DEFAULTS.search.confidence.vectorFloor).toBe(0.9)
  })

  test('a config without a search section resolves to the defaults', async () => {
    const res = await loadConfig(scratchDir())

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'FLOOR')).toBe('0.8')
    expect(resolved(res.out, 'VECTORFLOOR')).toBe('0.9')
  })

  test('the env mapping exists next to the vector floor', () => {
    const floor = ENV_MAPPINGS.find(m => m.path === 'search.confidence.unrelatedFloor')
    const vector = ENV_MAPPINGS.find(m => m.path === 'search.confidence.vectorFloor')

    expect(floor?.env).toBe(FLOOR_ENV)
    expect(floor?.type).toBe('float')
    expect(vector?.env).toBe(VECTOR_ENV)
  })
})

describe('search.confidence.unrelatedFloor — config.json', () => {
  test('a file value overrides the floor and leaves the vector floor alone', async () => {
    const res = await loadWithFile({ search: { confidence: { unrelatedFloor: 0.75 } } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'FLOOR')).toBe('0.75')
    expect(resolved(res.out, 'VECTORFLOOR')).toBe('0.9')
  })

  test('an explicit 0 is a real value, not "missing"', async () => {
    const res = await loadWithFile({ search: { confidence: { unrelatedFloor: 0 } } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'FLOOR')).toBe('0')
  })
})

describe('search.confidence.unrelatedFloor — the env override', () => {
  test(`${FLOOR_ENV} overrides the default`, async () => {
    const res = await loadConfig(scratchDir(), { [FLOOR_ENV]: '0.7' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'FLOOR')).toBe('0.7')
  })

  test('the env override wins over config.json', async () => {
    const res = await loadWithFile({ search: { confidence: { unrelatedFloor: 0.75 } } }, { [FLOOR_ENV]: '0.72' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'FLOOR')).toBe('0.72')
  })

  test('an invalid env value falls back to the default and is reported', async () => {
    const res = await loadConfig(scratchDir(), { [FLOOR_ENV]: 'not-a-number' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'FLOOR')).toBe('0.8')
    expect(res.err).toContain(`invalid value for ${FLOOR_ENV}`)
  })
})

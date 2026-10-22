import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULTS, ENV_MAPPINGS } from '../config'

/**
 * The archived-thought TTL is opt-in: `ttl.archivedTtlDays` ships as -1
 * (disabled) and only an explicit positive value — in config.json or via
 * SYNAPTOMIND_ARCHIVED_TTL_DAYS — turns the irreversible deletion on.
 *
 * The DEFAULT is pinned here: a future flip back to an implicit TTL has to
 * break this test instead of deleting archived memory on a default install.
 * The "as resolved at load" cases run the real module in a child process with
 * a scratch cwd (config.json is read from cwd), so they describe a fresh
 * install instead of whatever the developer's checkout happens to carry.
 */

const CONFIG_TS = resolve(import.meta.dir, '..', 'config.ts')

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

function scratchDir(): string {
  SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-config-ttl-'))
  return SCRATCH
}

/**
 * Ambient env minus the TTL override, so a case never inherits the setting it
 * is supposed to control.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.SYNAPTOMIND_ARCHIVED_TTL_DAYS
  return env
}

interface LoadResult {
  code: number
  stdout: string
}

/** Load `src/config.ts` as a fresh process in `cwd` and report the resolved TTL. */
async function loadTtl(cwd: string, env: Record<string, string> = {}): Promise<LoadResult> {
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `const m = await import(${JSON.stringify(CONFIG_TS)}); console.log('TTL=' + m.config.ttl.archivedTtlDays)`
    ],
    { cwd, env: { ...baseEnv(), ...env }, stdout: 'pipe', stderr: 'pipe' }
  )
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited
  ])
  return { code, stdout }
}

// ── declared default ─────────────────────────────────────────────────────────

describe('config defaults — ttl', () => {
  test('archivedTtlDays defaults to -1 (archived deletion disabled)', () => {
    expect(DEFAULTS.ttl.archivedTtlDays).toBe(-1)
  })

  test('cleanupIntervalMs keeps its 24h default', () => {
    expect(DEFAULTS.ttl.cleanupIntervalMs).toBe(86400000)
  })
})

// ── as resolved at config load ───────────────────────────────────────────────

describe('config as resolved at load — ttl', () => {
  test('a fresh install (no config.json, no env) resolves to -1', async () => {
    const res = await loadTtl(scratchDir())

    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('TTL=-1')
  })

  test('SYNAPTOMIND_ARCHIVED_TTL_DAYS=90 opts the deletion in', async () => {
    const res = await loadTtl(scratchDir(), { SYNAPTOMIND_ARCHIVED_TTL_DAYS: '90' })

    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('TTL=90')
  })

  test('config.json opts the deletion in', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ ttl: { archivedTtlDays: 90 } }))

    const res = await loadTtl(cwd)

    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('TTL=90')
  })

  test('a config.json without a ttl section stays disabled', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ contentLanguage: 'en' }))

    const res = await loadTtl(cwd)

    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('TTL=-1')
  })
})

// ── ENV_MAPPINGS correctness ─────────────────────────────────────────────────

describe('ENV_MAPPINGS — ttl', () => {
  test('SYNAPTOMIND_ARCHIVED_TTL_DAYS targets ttl.archivedTtlDays as an int', () => {
    const mapping = ENV_MAPPINGS.find(m => m.path === 'ttl.archivedTtlDays')

    expect(mapping).toEqual({
      env: 'SYNAPTOMIND_ARCHIVED_TTL_DAYS',
      path: 'ttl.archivedTtlDays',
      type: 'int'
    })
  })
})

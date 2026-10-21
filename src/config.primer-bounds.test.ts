import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULTS } from './config'

/**
 * The `primer.topN` / `primer.promoteThreshold` bounds.
 *
 * Both knobs are counts, so both must be integers >= 1:
 * - a negative `topN` reaches SQLite as `LIMIT -1`, which means "no limit" —
 *   the architecture_decisions slot then renders EVERY primer instead of the
 *   top N;
 * - a negative `promoteThreshold` makes `hit_count >= threshold` true for
 *   every thought, so every search promotes everything into the always-at-hand
 *   set (the 1257-primer flood this project already suffered).
 *
 * The knobs are sanitized on the FINAL merged config — after the config.json
 * merge AND after the env overrides, because the env override wins. That
 * ordering is the whole point of these cases: an earlier sanitizer would be
 * bypassed by `SYNAPTOMIND_PRIMER_TOP_N`.
 *
 * The load-time cases run the real module in a child process with a scratch
 * cwd (config.json is read from cwd) and read back the resolved knobs — the
 * same pattern as `src/config.dtype.test.ts`. No model, no network, no DB.
 */

const CONFIG_TS = resolve(import.meta.dir, 'config.ts')

const PROBE = `const m = await import(${JSON.stringify(CONFIG_TS)});
console.log('TOPN=' + m.config.primer.topN);
console.log('PROMOTE=' + m.config.primer.promoteThreshold);`

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

function scratchDir(): string {
  SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-config-knobs-'))
  return SCRATCH
}

/**
 * Ambient env minus the two primer overrides, so a case never inherits the
 * setting it is supposed to control.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.SYNAPTOMIND_PRIMER_TOP_N
  delete env.SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD
  return env
}

interface LoadResult {
  code: number
  /** stdout: the probe lines (the resolved knob values). */
  out: string
  /** stderr: the config layer's report (the "invalid value for ..." lines). */
  err: string
}

/**
 * Load `src/config.ts` as a fresh process in `cwd` and report what it resolved.
 */
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

/** The value the child printed for `key` ('TOPN' / 'PROMOTE'). */
function resolved(out: string, key: string): string {
  const line = out.split('\n').find(l => l.startsWith(`${key}=`))
  return line === undefined ? '' : line.slice(key.length + 1)
}

/** Write a config.json into the scratch cwd and load the config from there. */
async function loadWithFile(fileConfig: unknown, env: Record<string, string> = {}): Promise<LoadResult> {
  const cwd = scratchDir()
  writeFileSync(join(cwd, 'config.json'), JSON.stringify(fileConfig))
  return loadConfig(cwd, env)
}

// ── the built-in defaults ─────────────────────────────────────────────────────

describe('primer knobs — the built-in defaults', () => {
  test('topN defaults to 3 and promoteThreshold to 5', () => {
    expect(DEFAULTS.primer.topN).toBe(3)
    expect(DEFAULTS.primer.promoteThreshold).toBe(5)
  })

  test('a config without a primer section resolves to the defaults', async () => {
    const res = await loadConfig(scratchDir())

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('3')
    expect(resolved(res.out, 'PROMOTE')).toBe('5')
  })
})

// ── the file path (config.json) ──────────────────────────────────────────────

describe('primer knobs — config.json (the file path)', () => {
  test('a negative topN becomes 1, never "unlimited"', async () => {
    const res = await loadWithFile({ primer: { topN: -5 } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('1')
    // The untouched knob keeps its default.
    expect(resolved(res.out, 'PROMOTE')).toBe('5')
  })

  test('a zero topN becomes 1', async () => {
    const res = await loadWithFile({ primer: { topN: 0 } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('1')
  })

  test('a non-numeric topN falls back to the built-in default (3)', async () => {
    const res = await loadWithFile({ primer: { topN: 'abc' } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('3')
  })

  test('a negative promoteThreshold becomes 1, never "promote everything"', async () => {
    const res = await loadWithFile({ primer: { promoteThreshold: -5 } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'PROMOTE')).toBe('1')
    expect(resolved(res.out, 'TOPN')).toBe('3')
  })

  test('a non-numeric promoteThreshold falls back to the built-in default (5)', async () => {
    const res = await loadWithFile({ primer: { promoteThreshold: 'abc' } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'PROMOTE')).toBe('5')
  })

  test('a fractional knob is floored, not rounded', async () => {
    const res = await loadWithFile({ primer: { topN: 2.7 } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('2')
  })

  test('a primer section that is not an object falls back to both defaults', async () => {
    const res = await loadWithFile({ primer: 'abc' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('3')
    expect(resolved(res.out, 'PROMOTE')).toBe('5')
  })

  test('valid values are untouched', async () => {
    const res = await loadWithFile({ primer: { topN: 3, promoteThreshold: 5 } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('3')
    expect(resolved(res.out, 'PROMOTE')).toBe('5')
  })
})

// ── the env path ──────────────────────────────────────────────────────────────

describe('primer knobs — the env path', () => {
  test('SYNAPTOMIND_PRIMER_TOP_N=-5 becomes 1', async () => {
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_TOP_N: '-5' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('1')
  })

  test('SYNAPTOMIND_PRIMER_TOP_N=0 becomes 1', async () => {
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_TOP_N: '0' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('1')
  })

  test('SYNAPTOMIND_PRIMER_TOP_N=abc falls back to the built-in default (3)', async () => {
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_TOP_N: 'abc' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('3')
  })

  test('the env override wins over a valid file value AND is sanitized', async () => {
    const res = await loadWithFile({ primer: { topN: 4 } }, { SYNAPTOMIND_PRIMER_TOP_N: '-2' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('1')
  })

  test('a valid env override is applied untouched', async () => {
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_TOP_N: '7' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('7')
  })

  test('SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD=-5 becomes 1', async () => {
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD: '-5' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'PROMOTE')).toBe('1')
  })

  test('SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD=abc falls back to the built-in default (5)', async () => {
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_PROMOTE_THRESHOLD: 'abc' })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'PROMOTE')).toBe('5')
  })

  test('no override anywhere resolves to 3 / 5', async () => {
    const res = await loadConfig(scratchDir())

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('3')
    expect(resolved(res.out, 'PROMOTE')).toBe('5')
  })
})

// ── the stderr report ─────────────────────────────────────────────────────────

describe('primer knobs — the stderr report', () => {
  test('a negative topN names the offending value and the value actually used', async () => {
    const res = await loadWithFile({ primer: { topN: -5 } })

    expect(res.err).toContain('[config] invalid value for primer.topN: "-5"')
    expect(res.err).toContain('(expected an integer >= 1)')
    expect(res.err).toContain('using 1')
  })

  test('a non-numeric topN names the offending value and the default used', async () => {
    const res = await loadWithFile({ primer: { topN: 'abc' } })

    expect(res.err).toContain('[config] invalid value for primer.topN: "abc"')
    expect(res.err).toContain('using 3')
  })

  test('a negative promoteThreshold names the offending value and the value used', async () => {
    const res = await loadWithFile({ primer: { promoteThreshold: -5 } })

    expect(res.err).toContain('[config] invalid value for primer.promoteThreshold: "-5"')
    expect(res.err).toContain('using 1')
  })

  test('a negative env override is reported too', async () => {
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_TOP_N: '-5' })

    expect(res.err).toContain('[config] invalid value for primer.topN: "-5"')
    expect(res.err).toContain('using 1')
  })

  test('a non-numeric env value is reported by the env layer, naming the value', async () => {
    // The env parser rejects a non-numeric int before the sanitizer sees it, so
    // the report comes from the env layer ("invalid value for <ENV_VAR>") and
    // the knob keeps its built-in default — pinned by the resolved value.
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_TOP_N: 'abc' })

    expect(res.err).toContain('[config] invalid value for SYNAPTOMIND_PRIMER_TOP_N: "abc"')
    expect(resolved(res.out, 'TOPN')).toBe('3')
  })

  test('valid values print nothing', async () => {
    const res = await loadWithFile({ primer: { topN: 3, promoteThreshold: 5 } })

    expect(res.err).not.toContain('invalid value for primer')
  })

  test('a valid env override prints nothing', async () => {
    const res = await loadConfig(scratchDir(), { SYNAPTOMIND_PRIMER_TOP_N: '3' })

    expect(res.err).not.toContain('invalid value for primer')
  })
})

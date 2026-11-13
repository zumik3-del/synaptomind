import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS } from './config'
import { loadFreshConfig } from './test/fresh-config'

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

function scratchDir(): string {
  SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-config-knobs-'))
  return SCRATCH
}

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
  out: string
  err: string
}

async function loadConfig(cwd: string, env: Record<string, string> = {}): Promise<LoadResult> {
  const file = join(cwd, 'config.json')
  const probe = await loadFreshConfig({
    env: { ...baseEnv(), ...env },
    configFile: existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined
  })
  if (probe.error !== undefined) {
    return { code: 1, out: '', err: `${probe.stderr}\n${probe.error}` }
  }
  const resolved = probe.config as { primer: { topN: number; promoteThreshold: number } }
  return {
    code: 0,
    out: `TOPN=${resolved.primer.topN}\nPROMOTE=${resolved.primer.promoteThreshold}`,
    err: probe.stderr
  }
}

function resolved(out: string, key: string): string {
  const line = out.split('\n').find(l => l.startsWith(`${key}=`))
  return line === undefined ? '' : line.slice(key.length + 1)
}

async function loadWithFile(
  fileConfig: unknown,
  env: Record<string, string> = {}
): Promise<LoadResult> {
  const cwd = scratchDir()
  writeFileSync(join(cwd, 'config.json'), JSON.stringify(fileConfig))
  return loadConfig(cwd, env)
}

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

describe('primer knobs — config.json (the file path)', () => {
  test('a negative topN becomes 1, never "unlimited"', async () => {
    const res = await loadWithFile({ primer: { topN: -5 } })

    expect(res.code).toBe(0)
    expect(resolved(res.out, 'TOPN')).toBe('1')
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

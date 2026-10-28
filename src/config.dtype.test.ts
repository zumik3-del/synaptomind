import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertEmbedderDtype, DEFAULTS, EMBEDDER_DTYPES, ENV_MAPPINGS } from './config'
import { loadFreshConfig } from './test/fresh-config'

/**
 * The `embedder.dtype` contract.
 *
 * `dtype` decides which ONNX file the embedder downloads and loads (q8 ->
 * `onnx/model_quantized.onnx` ~118 MB, fp32 -> `onnx/model.onnx` ~449 MB), so
 * the DEFAULT is a memory/disk commitment and an unknown value must never be
 * absorbed by a silent fallback: on a metered or offline host the fp32 fallback
 * would pull 449 MB nobody asked for. Both directions are pinned here.
 *
 * The env/file override is asserted through `applyEnvOverrides`, which runs at
 * module-import time — importing `./config` directly would freeze one
 * combination forever, so the load-time cases evaluate a cache-busted fresh
 * module instance with a scratch `config.json` and environment
 * (`loadFreshConfig`) and read back `config.embedder.dtype`. No model, no
 * network, no DB.
 */

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

function scratchDir(): string {
  SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-config-dtype-'))
  return SCRATCH
}

/**
 * Ambient env minus the dtype override, so a case never inherits the setting it
 * is supposed to control.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.SYNAPTOMIND_EMBEDDER_DTYPE
  return env
}

interface LoadResult {
  code: number
  out: string
}

/**
 * Load `src/config.ts` with `cwd`'s `config.json` (when it has one) and report
 * what it resolved. A `DTYPE=` line is printed only when the module loaded, so
 * its absence is the observable "no silent fallback".
 */
async function loadConfig(cwd: string, dtype: string | undefined): Promise<LoadResult> {
  const env = baseEnv()
  if (dtype !== undefined) env.SYNAPTOMIND_EMBEDDER_DTYPE = dtype

  const file = join(cwd, 'config.json')
  const probe = await loadFreshConfig({
    env,
    configFile: existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined
  })
  if (probe.error !== undefined) {
    return { code: 1, out: `${probe.stderr}\n${probe.error}` }
  }
  const resolved = probe.config as { embedder: { dtype: string } }
  return { code: 0, out: `DTYPE=${resolved.embedder.dtype}\n${probe.stderr}` }
}

describe('embedder.dtype — declared contract', () => {
  test('the default dtype is q8', () => {
    expect(DEFAULTS.embedder.dtype).toBe('q8')
  })

  test('exactly fp32 and q8 are accepted values', () => {
    expect([...EMBEDDER_DTYPES]).toEqual(['fp32', 'q8'])
  })

  test('the env override SYNAPTOMIND_EMBEDDER_DTYPE targets embedder.dtype as a string', () => {
    const mapping = ENV_MAPPINGS.find(m => m.path === 'embedder.dtype')

    expect(mapping).toEqual({ env: 'SYNAPTOMIND_EMBEDDER_DTYPE', path: 'embedder.dtype', type: 'string' })
  })
})

describe('assertEmbedderDtype — the fail-fast gate', () => {
  test('both declared dtypes pass', () => {
    expect(() => assertEmbedderDtype('fp32', 'test')).not.toThrow()
    expect(() => assertEmbedderDtype('q8', 'test')).not.toThrow()
  })

  // fp16 is a REAL transformers.js dtype; accepting it here would point the
  // validator at a file the fp32/q8 mapping does not describe, so the gate must
  // stay a closed set rather than "any dtype transformers knows".
  const REJECTED: unknown[] = ['fp16', 'int8', 'FP32', 'Q8', 'q4', '', ' fp32', undefined, null, 42, true, {}, []]

  test.each(REJECTED.map(value => [JSON.stringify(value) ?? String(value), value]))(
    'rejects %s, naming the value and the allowed set',
    (_label, value) => {
      expect(() => assertEmbedderDtype(value, 'test')).toThrow(/invalid embedder\.dtype/)
      expect(() => assertEmbedderDtype(value, 'test')).toThrow(/allowed values: fp32, q8/)
    }
  )

  test('the error names the source that carried the bad value', () => {
    expect(() => assertEmbedderDtype('int8', 'config.json or SYNAPTOMIND_EMBEDDER_DTYPE')).toThrow(
      /from config\.json or SYNAPTOMIND_EMBEDDER_DTYPE/
    )
  })
})

describe('embedder.dtype — as resolved at config load', () => {
  test('no override anywhere → q8', async () => {
    const res = await loadConfig(scratchDir(), undefined)

    expect(res.out).toContain('DTYPE=q8')
    expect(res.code).toBe(0)
  })

  test('SYNAPTOMIND_EMBEDDER_DTYPE=fp32 → fp32; =q8 → q8', async () => {
    const fp32 = await loadConfig(scratchDir(), 'fp32')
    expect(fp32.out).toContain('DTYPE=fp32')
    expect(fp32.code).toBe(0)

    const q8 = await loadConfig(scratchDir(), 'q8')
    expect(q8.out).toContain('DTYPE=q8')
    expect(q8.code).toBe(0)
  })

  test('config.json carries the value when the env var is absent', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ embedder: { dtype: 'fp32' } }))

    const res = await loadConfig(cwd, undefined)

    expect(res.out).toContain('DTYPE=fp32')
    expect(res.code).toBe(0)
  })

  test('the env var wins over config.json', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ embedder: { dtype: 'q8' } }))

    const res = await loadConfig(cwd, 'fp32')

    expect(res.out).toContain('DTYPE=fp32')
    expect(res.code).toBe(0)
  })

  test('an unknown value in SYNAPTOMIND_EMBEDDER_DTYPE aborts the load, it does not fall back', async () => {
    const res = await loadConfig(scratchDir(), 'int8')

    expect(res.code).not.toBe(0)
    expect(res.out).toContain('invalid embedder.dtype')
    expect(res.out).toContain('"int8"')
    expect(res.out).toContain('allowed values: fp32, q8')
    // The fallback would have logged a dtype; nothing resolved.
    expect(res.out).not.toContain('DTYPE=')
  })

  test('an unknown value in config.json aborts the load too', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ embedder: { dtype: 'fp16' } }))

    const res = await loadConfig(cwd, undefined)

    expect(res.code).not.toBe(0)
    expect(res.out).toContain('invalid embedder.dtype')
    expect(res.out).toContain('"fp16"')
    expect(res.out).not.toContain('DTYPE=')
  })

  test('a non-string dtype in config.json aborts the load', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ embedder: { dtype: 8 } }))

    const res = await loadConfig(cwd, undefined)

    expect(res.code).not.toBe(0)
    expect(res.out).toContain('invalid embedder.dtype')
    expect(res.out).not.toContain('DTYPE=')
  })
})

// The label is part of the error's value: the env override is applied after the
// file merge, so it wins, and blaming config.json for a bad env value (or the
// reverse) sends the operator to the wrong place. `assertEmbedderDtype`'s own
// `source` argument is covered above — these cases exercise the CALL SITE that
// picks the label, at module load, through the same child process (config.json
// is read from cwd).

describe('embedder.dtype — the error names the layer that actually carried the value', () => {
  test('a bad value from the environment is blamed on the env var, not config.json', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ embedder: { dtype: 'q8' } }))

    const res = await loadConfig(cwd, 'int8')

    expect(res.code).not.toBe(0)
    expect(res.out).toContain('from SYNAPTOMIND_EMBEDDER_DTYPE: "int8"')
    expect(res.out).not.toContain('from config.json')
  })

  test('a bad value from config.json is blamed on config.json, not the env var', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ embedder: { dtype: 'fp16' } }))

    const res = await loadConfig(cwd, undefined)

    expect(res.code).not.toBe(0)
    expect(res.out).toContain('from config.json: "fp16"')
    // The env var is unset here: naming it would be a lie about the source.
    expect(res.out).not.toContain('SYNAPTOMIND_EMBEDDER_DTYPE')
  })

  test('both layers carry a bad value → the label names the layer that won', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ embedder: { dtype: 'fp16' } }))

    const res = await loadConfig(cwd, 'int8')

    expect(res.code).not.toBe(0)
    expect(res.out).toContain('from SYNAPTOMIND_EMBEDDER_DTYPE: "int8"')
    // The overridden file value is not what aborted the load.
    expect(res.out).not.toContain('fp16')
  })
})

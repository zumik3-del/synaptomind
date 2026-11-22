import { afterEach, describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ENV_MAPPINGS } from './config'
import { RAW_ENV, rawEnvEffective, rawEnvEntry, rawEnvFallbackNumber } from './config.raw-env'
import { configHandler } from './mcp/tools/status/config'

const SRC = resolve(import.meta.dir)

/**
 * Env variables a production module reads through `process.env` but deliberately does not surface in
 * `RAW_ENV`: the embedder-script switch exists so a test can swap the child process for a stub, and
 * a real deployment has no reason to set it. Naming it here keeps the scan strict — a knob that is
 * neither mapped, registered nor listed fails the suite.
 */
const TEST_SEAMS = ['SYNAPTOMIND_EMBEDDER_SCRIPT']

const EXCLUDED_DIRS = ['test/', '__fixtures__/']

function productionSources(): Array<{ file: string; source: string }> {
  return [...new Glob('**/*.ts').scanSync({ cwd: SRC })]
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.endsWith('.test.ts') && !file.endsWith('.suite.ts'))
    .filter(file => !EXCLUDED_DIRS.some(dir => file.startsWith(dir) || file.includes(`/${dir}`)))
    .sort()
    .map(file => ({ file: `src/${file}`, source: readFileSync(resolve(SRC, file), 'utf8') }))
}

function literalReads(sources: Array<{ file: string; source: string }>): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const { file, source } of sources) {
    const names = [
      ...[...source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]),
      ...[...source.matchAll(/process\.env\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g)].map(
        match => match[2]
      )
    ]
    for (const name of names) {
      if (name === undefined) continue
      found.set(name, [...(found.get(name) ?? []), file])
    }
  }
  return found
}

function dynamicReaders(sources: Array<{ file: string; source: string }>): string[] {
  return sources
    .filter(({ source }) => /process\.env\[\s*[^'"\s\]]/.test(source))
    .map(({ file }) => file)
}

let saved = new Map<string, string | undefined>()

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved = new Map()
})

async function configDisplay(): Promise<string> {
  const result = (await configHandler.run({ action: 'config' })) as {
    content: Array<{ text: string }>
  }
  return result.content[0]?.text ?? ''
}

function rawSection(text: string): string {
  const marker = '--- Raw environment ---'
  const start = text.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  return text.slice(start)
}

describe('RAW_ENV — the declared table', () => {
  test('every variable is declared once', () => {
    const names = RAW_ENV.map(entry => entry.env)

    expect(new Set(names).size).toBe(names.length)
  })

  test('every entry names the module that reads it', () => {
    for (const entry of RAW_ENV) expect(entry.description).toContain('src/')
  })

  test('SYNAPTOMIND_USER_TOKEN_<ID> is the one pattern entry, and it carries no numeric fallback', () => {
    const patterns = RAW_ENV.filter(entry => entry.env.includes('<'))

    expect(patterns.map(entry => entry.env)).toEqual(['SYNAPTOMIND_USER_TOKEN_<ID>'])
    expect(patterns[0]?.kind).toBe('secret-list')
    expect(() => rawEnvFallbackNumber('SYNAPTOMIND_USER_TOKEN_<ID>')).toThrow(/no numeric fallback/)
  })

  test('a numeric kind declares the fallback its reader uses', () => {
    expect(rawEnvFallbackNumber('EMBEDDER_START_TIMEOUT_MS')).toBe(300_000)
    expect(rawEnvFallbackNumber('EMBEDDER_BACKOFF_BASE_MS')).toBe(1_000)
    expect(() => rawEnvFallbackNumber('SYNAPTOMIND_SECRET')).toThrow(/no numeric fallback/)
  })

  test('an entry lookup names the undeclared variable instead of returning undefined', () => {
    expect(rawEnvEntry('SYNAPTOMIND_DEBUG').kind).toBe('flag')
    expect(() => rawEnvEntry('SYNAPTOMIND_NOT_A_KNOB')).toThrow(
      /SYNAPTOMIND_NOT_A_KNOB is not declared in RAW_ENV/
    )
  })
})

describe('rawEnvEffective — the value the reader would use', () => {
  test('a flag reports yes only for the exact string "true"', () => {
    const entry = rawEnvEntry('SYNAPTOMIND_DEBUG')

    expect(rawEnvEffective(entry, { SYNAPTOMIND_DEBUG: 'true' })).toBe('yes')
    expect(rawEnvEffective(entry, { SYNAPTOMIND_DEBUG: 'false' })).toBe('no')
    expect(rawEnvEffective(entry, { SYNAPTOMIND_DEBUG: '1' })).toBe('no')
    expect(rawEnvEffective(entry, {})).toBe('no')
  })

  test('a positive integer reports the effective value, else the declared default', () => {
    const entry = rawEnvEntry('EMBEDDER_START_TIMEOUT_MS')

    expect(rawEnvEffective(entry, { EMBEDDER_START_TIMEOUT_MS: ' 5000 ' })).toBe('5000')
    expect(rawEnvEffective(entry, { EMBEDDER_START_TIMEOUT_MS: 'abc' })).toBe('300000 (default)')
    expect(rawEnvEffective(entry, { EMBEDDER_START_TIMEOUT_MS: '0' })).toBe('300000 (default)')
    expect(rawEnvEffective(entry, { EMBEDDER_START_TIMEOUT_MS: '-5' })).toBe('300000 (default)')
    expect(rawEnvEffective(entry, {})).toBe('300000 (default)')
  })

  test('a path, a file and a secret are reduced to presence', () => {
    for (const name of ['SYNAPTOMIND_VEC0_PATH', 'SYNAPTOMIND_CONFIG', 'SYNAPTOMIND_SECRET']) {
      const entry = rawEnvEntry(name)

      expect(rawEnvEffective(entry, { [name]: '/some/where' })).toBe('[set]')
      expect(rawEnvEffective(entry, { [name]: '   ' })).toBe('-')
      expect(rawEnvEffective(entry, {})).toBe('-')
    }
  })

  test('a secret list reports the env-name ids, sorted, never a token', () => {
    const entry = rawEnvEntry('SYNAPTOMIND_USER_TOKEN_<ID>')

    expect(
      rawEnvEffective(entry, {
        SYNAPTOMIND_USER_TOKEN_ZOE: 'zoe-token',
        SYNAPTOMIND_USER_TOKEN_ALICE: 'alice-token',
        SYNAPTOMIND_USER_TOKEN_EMPTY: '',
        SYNAPTOMIND_SECRET: 'not-a-user-token'
      })
    ).toBe('ALICE, ZOE')
    expect(rawEnvEffective(entry, {})).toBe('-')
  })
})

describe('RAW_ENV completeness — a mechanical scan of src/', () => {
  test('every process.env read is mapped, registered or a named test seam', () => {
    const reads = literalReads(productionSources())
    const declared = new Set([
      ...ENV_MAPPINGS.map(mapping => mapping.env),
      ...RAW_ENV.map(entry => entry.env),
      ...TEST_SEAMS
    ])

    const uncovered = [...reads.keys()].filter(name => !declared.has(name)).sort()
    expect(uncovered).toEqual([])
  })

  test('every literal RAW_ENV entry is actually read somewhere in src/', () => {
    const reads = literalReads(productionSources())
    const registered = RAW_ENV.map(entry => entry.env).filter(env => !env.includes('<'))
    const unused = registered.filter(name => !reads.has(name))

    expect(unused).toEqual([])
  })

  test('only the registry loaders and the logger read through a dynamic subscript', () => {
    expect(dynamicReaders(productionSources())).toEqual([
      'src/config.schema.ts',
      'src/config.ts',
      'src/logging/log.ts'
    ])
  })

  test('the logger reads only env-mapped names through its dynamic helper', () => {
    const source = readFileSync(resolve(SRC, 'logging/log.ts'), 'utf8')
    const names = [...source.matchAll(/\benv(?:Str|Int)\(\s*'([A-Z0-9_]+)'/g)].map(
      match => match[1] as string
    )
    const mapped = new Set(ENV_MAPPINGS.map(mapping => mapping.env))

    expect(names.length).toBeGreaterThan(0)
    expect(names.filter(name => !mapped.has(name))).toEqual([])
  })

  test('the user-token env family the config loader builds is the registered one', () => {
    const registered = RAW_ENV.find(entry => entry.kind === 'secret-list')
    const prefix = (registered?.env ?? '').replace('<ID>', '')
    const source = readFileSync(resolve(SRC, 'config.ts'), 'utf8')

    expect(prefix).toBe('SYNAPTOMIND_USER_TOKEN_')
    expect(source).toContain(prefix)
  })
})

describe('memory_status action=config — the raw-env section', () => {
  test('lists every registered variable and its description', async () => {
    const section = rawSection(await configDisplay())

    for (const entry of RAW_ENV) expect(section).toContain(entry.env)
    expect(section).toContain('src/embedder/embedder-supervisor.ts')
  })

  test('shows the effective flag and integer values', async () => {
    setEnv('SYNAPTOMIND_DEBUG', 'true')
    setEnv('EMBEDDER_START_TIMEOUT_MS', '12345')
    setEnv('EMBEDDER_BACKOFF_BASE_MS', undefined)

    const section = rawSection(await configDisplay())

    expect(section).toContain('SYNAPTOMIND_DEBUG = yes:')
    expect(section).toContain('EMBEDDER_START_TIMEOUT_MS = 12345:')
    expect(section).toContain('EMBEDDER_BACKOFF_BASE_MS = 1000 (default):')
  })

  test('never echoes a secret, a file or a path value', async () => {
    const secret = 'sk-live-do-not-print-me'
    const bearer = 'single-user-bearer-secret'
    const configFile = '/srv/private/config.json'
    const vec0 = '/srv/private/vec0.so'
    const token = 'alice-plaintext-token'
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SYNAPTOMIND_USER_TOKEN_')) setEnv(key, undefined)
    }
    setEnv('SYNAPTOMIND_SECRET', secret)
    setEnv('SYNAPTOMIND_ALLOW_INSECURE', 'true')
    setEnv('SYNAPTOMIND_CONFIG', configFile)
    setEnv('SYNAPTOMIND_VEC0_PATH', vec0)
    setEnv('SYNAPTOMIND_USER_TOKEN_ALICE', token)

    const text = await configDisplay()
    const section = rawSection(text)

    for (const value of [secret, bearer, configFile, vec0, token]) expect(text).not.toContain(value)
    expect(section).toContain('SYNAPTOMIND_SECRET = [set]:')
    expect(section).toContain('SYNAPTOMIND_CONFIG = [set]:')
    expect(section).toContain('SYNAPTOMIND_VEC0_PATH = [set]:')
    expect(section).toContain('SYNAPTOMIND_USER_TOKEN_<ID> = ALICE:')
  })

  test('an unset secret and an empty path read as absent', async () => {
    setEnv('SYNAPTOMIND_SECRET', undefined)
    setEnv('SYNAPTOMIND_CONFIG', '')
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SYNAPTOMIND_USER_TOKEN_')) setEnv(key, undefined)
    }

    const section = rawSection(await configDisplay())

    expect(section).toContain('SYNAPTOMIND_SECRET = -:')
    expect(section).toContain('SYNAPTOMIND_CONFIG = -:')
    expect(section).toContain('SYNAPTOMIND_USER_TOKEN_<ID> = -:')
  })
})

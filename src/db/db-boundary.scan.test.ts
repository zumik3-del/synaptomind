import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..')
const DB_DIR = join(SRC, 'db')
const CONTEXT_DIR = join(SRC, 'context')

const DOOR = 'db/index'
const HANDLE = 'db/handle'
const HANDLE_EXCEPTION = 'db/init'
const UPPER_LAYER = /^(context|services|api|mcp)\/|^errors$/
const LOGGING = /^logging(\/|$)/
const SCRIPT_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs)$/

// The db/ files allowed to log, each with the reason its caller cannot observe the outcome it logs.
const LOGGING_EXCEPTIONS: Record<string, string> = {
  'db/pending-embeddings.ts': 'the caller sees a void/false return, not the row transition',
  'db/search-bm25.ts': 'the caller receives the fallback result, never the SQL exception',
  'db/search-vector.ts': 'the caller receives the fallback result, never the SQL exception'
}

// *.test.ts / *.suite.ts are excluded: a test beside a db module may exercise the layers above it.
function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (entry.name.endsWith('.ts') && !/\.(test|suite)\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

interface Import {
  file: string
  specifier: string
  target: string
}

const STATIC_SPECIFIER = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g]
const DYNAMIC_SPECIFIER = [/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g]

// A `.js` specifier names a `.ts` module here, so an equality rule must see the module, not the file.
function stripExtension(path: string): string {
  return path.replace(SCRIPT_EXTENSION, '')
}

function specifiersOf(file: string, patterns: RegExp[]): Import[] {
  const source = readFileSync(file, 'utf8')
  const specifiers = patterns.flatMap(pattern =>
    [...source.matchAll(pattern)].map(match => match[1])
  )
  return specifiers.map(specifier => ({
    file: relative(SRC, file),
    specifier,
    target: stripExtension(relative(SRC, resolve(dirname(file), specifier)))
  }))
}

function importsOf(file: string): Import[] {
  return specifiersOf(file, STATIC_SPECIFIER)
}

function dynamicImportsOf(file: string): Import[] {
  return specifiersOf(file, DYNAMIC_SPECIFIER)
}

function relativeImports(file: string): Import[] {
  return importsOf(file).filter(entry => entry.specifier.startsWith('.'))
}

function describeImport(entry: Import): string {
  return `${entry.file} imports '${entry.specifier}'`
}

function isAuditedLogging(file: string): boolean {
  return Object.hasOwn(LOGGING_EXCEPTIONS, file)
}

function mayReachHandle(file: string): boolean {
  const module = stripExtension(file)
  return module === DOOR || module === HANDLE_EXCEPTION
}

describe('the db layer boundary', () => {
  test('db/ imports no layer above it', () => {
    const offenders = filesUnder(DB_DIR)
      .flatMap(relativeImports)
      .filter(entry => UPPER_LAYER.test(entry.target))
      .map(describeImport)

    expect(
      offenders,
      'db/ is a SQL-only layer: an import of context/, services/, api/, mcp/ or errors belongs in services/'
    ).toEqual([])
  })

  test('db/errors.ts imports nothing from src/', () => {
    const offenders = relativeImports(join(DB_DIR, 'errors.ts')).map(describeImport)

    expect(
      offenders,
      'db/errors.ts is re-exported by src/errors.ts, so importing anything from src/ closes a cycle'
    ).toEqual([])
  })

  test('db/index.ts is the only way to the handle surface', () => {
    const offenders = filesUnder(SRC)
      .flatMap(importsOf)
      .filter(entry => entry.target === HANDLE)
      .filter(entry => !mayReachHandle(entry.file))
      .map(describeImport)

    expect(
      offenders,
      `only ${DOOR}.ts (the door) and ${HANDLE_EXCEPTION}.ts (the boot exception) may reach ${HANDLE}.ts`
    ).toEqual([])
  })

  test('context/ imports db/, and db/ never imports context/', () => {
    const offenders = [
      ...filesUnder(CONTEXT_DIR)
        .filter(file => !importsOf(file).some(entry => entry.target === 'db'))
        .map(file => `${relative(SRC, file)} does not import '../db'`),
      ...filesUnder(DB_DIR)
        .flatMap(relativeImports)
        .filter(entry => entry.target.startsWith('context/') || entry.target === 'context')
        .map(describeImport)
    ]

    expect(offenders, 'context/ depends on db/, never the reverse').toEqual([])
  })

  test('db/ imports logging only where the caller cannot observe the outcome', () => {
    const offenders = filesUnder(DB_DIR)
      .flatMap(importsOf)
      .filter(entry => LOGGING.test(entry.target))
      .filter(entry => !isAuditedLogging(entry.file))
      .map(describeImport)

    expect(
      offenders,
      `logging/ is an upper layer: log in the caller, or list the file in LOGGING_EXCEPTIONS with the reason its caller cannot observe the outcome (audited: ${Object.keys(LOGGING_EXCEPTIONS).join(', ')})`
    ).toEqual([])
  })

  test('no module reaches a forbidden one through import() or require()', () => {
    const offenders = filesUnder(SRC)
      .flatMap(dynamicImportsOf)
      .filter(entry => {
        const inDb = entry.file.startsWith('db/')
        if (!inDb) return entry.target === HANDLE && !mayReachHandle(entry.file)
        if (UPPER_LAYER.test(entry.target)) return true
        return LOGGING.test(entry.target) && !isAuditedLogging(entry.file)
      })
      .map(describeImport)

    expect(
      offenders,
      'import() and require() cross a boundary as a static import does: db/ reaches no layer above it, and only db/index.ts or db/init.ts reaches db/handle'
    ).toEqual([])
  })

  test('every specifier is normalised to its extensionless module path', () => {
    const offenders = filesUnder(SRC)
      .flatMap(relativeImports)
      .filter(entry => SCRIPT_EXTENSION.test(entry.target))
      .map(describeImport)

    expect(
      offenders,
      "a '.js' specifier names a '.ts' module: strip the script extension before matching, or an equality rule (db/handle, context) misses it"
    ).toEqual([])
  })
})

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

function stripExtension(path: string): string {
  return path.replace(/\.ts$/, '')
}

function importsOf(file: string): Import[] {
  const source = readFileSync(file, 'utf8')
  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)
  ].map(match => match[1])
  return specifiers.map(specifier => ({
    file: relative(SRC, file),
    specifier,
    target: stripExtension(relative(SRC, resolve(dirname(file), specifier)))
  }))
}

function relativeImports(file: string): Import[] {
  return importsOf(file).filter(entry => entry.specifier.startsWith('.'))
}

function describeImport(entry: Import): string {
  return `${entry.file} imports '${entry.specifier}'`
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
      .filter(entry => stripExtension(entry.file) !== DOOR)
      .filter(entry => stripExtension(entry.file) !== HANDLE_EXCEPTION)
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
})

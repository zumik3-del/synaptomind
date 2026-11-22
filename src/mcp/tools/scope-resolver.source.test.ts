import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// Same style as the thin-tools layering guard: the tools layer has exactly one cwd→scope resolver,
// so a second one cannot quietly reappear beside it.
const TOOLS_DIR = import.meta.dir
const ENVELOPE = 'envelope.ts'
// `memory_manage action=resolve` takes the path as its INPUT (docs/mcp-tools.md), not as a scope.
const INPUT_RESOLVER = 'manage.ts'

function productionToolFiles(dir: string = TOOLS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionToolFiles(path)
    if (!entry.name.endsWith('.ts')) return []
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.suite.ts')) return []
    return [relative(TOOLS_DIR, path)]
  })
}

function sourceOf(file: string): string {
  return readFileSync(join(TOOLS_DIR, file), 'utf8')
}

describe('one cwd→scope resolver in the tools layer', () => {
  test('only envelope.ts resolves a cwd for scope, plus the resolve action that takes it as input', () => {
    const callers = productionToolFiles()
      .filter(file => /resolveProjectService\s*[(,}]/.test(sourceOf(file)))
      .sort()

    expect(callers).toEqual([ENVELOPE, INPUT_RESOLVER])
  })

  test('the resolve action resolves the path it was given, not a scope', () => {
    const source = sourceOf(INPUT_RESOLVER)
    const handlerStart = source.indexOf('  resolve: {')

    expect(handlerStart).toBeGreaterThan(-1)
    for (const match of source.matchAll(/resolveProjectService\s*\(/g)) {
      expect(match.index).toBeGreaterThan(handlerStart)
    }
  })

  test('the tool seam reaches the resolver through envelope.ts, never through the service module', () => {
    const utils = sourceOf('utils.ts')

    expect(utils).not.toContain('services/projects.service')
    expect(utils).toContain("from './envelope'")
  })

  test('the retired console scope warnings are gone from the tools layer', () => {
    const offenders = productionToolFiles().filter(file => {
      const source = sourceOf(file)
      return /console\.warn\(['"`]\[scope\]/.test(source) || /\[scope\]/.test(source)
    })

    expect(offenders).toEqual([])
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

type DependencyMap = Record<string, string>

interface Manifest {
  dependencies?: DependencyMap
  devDependencies?: DependencyMap
}

interface TextLockfile {
  workspaces: Record<string, Manifest>
}

// A dependency reclassified in package.json but not in bun.lock drifts silently: the frozen install
// every CI job and the deploy path run trusts the lockfile's own classification.
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as Manifest
const lockfile = Bun.JSONC.parse(readFileSync(resolve(ROOT, 'bun.lock'), 'utf8')) as TextLockfile
const workspace = lockfile.workspaces[''] ?? {}

function keysOf(dependencies: DependencyMap | undefined): string[] {
  return Object.keys(dependencies ?? {}).sort()
}

describe('bun.lock dependency classification matches package.json', () => {
  test('runtime dependency keys match', () => {
    expect(keysOf(workspace.dependencies)).toEqual(keysOf(manifest.dependencies))
  })

  test('dev dependency keys match', () => {
    expect(keysOf(workspace.devDependencies)).toEqual(keysOf(manifest.devDependencies))
  })
})

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { GATE_CASES } from '../../test/confirm-gate-cases'

const TOOLS_DIR = import.meta.dir

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.suite.ts')) continue
    out.push(path)
  }
  return out
}

const FILES = sourceFiles(TOOLS_DIR).map(path => ({
  path,
  name: relative(TOOLS_DIR, path),
  source: readFileSync(path, 'utf8')
}))

describe('source guard: the tools layer cannot re-implement the handshake', () => {
  test('no tool module imports the preview-token store or its service', () => {
    const offenders = FILES.filter(file => /preview-tokens/.test(file.source)).map(f => f.name)
    expect(offenders).toEqual([])
  })

  test('no tool module calls the token mint/claim functions directly', () => {
    const offenders = FILES.filter(file =>
      /\b(createPreviewToken|consumePreviewToken)(Service)?\b/.test(file.source)
    ).map(f => f.name)
    expect(offenders).toEqual([])
  })

  test('every converted module imports runGuarded from the gate service', () => {
    const converted = [
      'store/unlink.ts',
      'store/retype.ts',
      'crystallize/auto-cluster.ts',
      'manage.ts',
      'supersede.ts',
      'review.ts',
      'review/apply.ts',
      'review/rollback.ts',
      'retention-review.ts',
      'primers.ts'
    ]
    for (const name of converted) {
      const file = FILES.find(f => f.name === name)
      expect({ name, found: file !== undefined }).toEqual({ name, found: true })
      expect({
        name,
        gate: /from '[^']*services\/confirm-gate\.service'/.test(file!.source)
      }).toEqual({ name, gate: true })
      expect({ name, calls: /\brunGuarded\(/.test(file!.source) }).toEqual({
        name,
        calls: true
      })
    }
  })

  test('the gate call sites match the contract-matrix inventory', () => {
    const sites = FILES.reduce(
      (total, file) => total + (file.source.match(/\brunGuarded\(/g)?.length ?? 0),
      0
    )
    expect(sites).toBe(GATE_CASES.length)
  })
})

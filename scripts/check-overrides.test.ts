import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Regression coverage for the overrides gate added by #2679: an `overrides`
// entry forcing a version outside an installed consumer's declared range must
// fail the build, and the ranges the gate cannot judge must be skipped rather
// than misread. `scripts/check-overrides.ts` self-executes at import time and
// resolves both its root and `node_modules` from its own directory, so every
// case runs it as a child process inside a throwaway repo-shaped tree — never
// imported into this test's module registry, and never against the real tree
// (so no `bun install` is required).
//
// CHECK_OVERRIDES_SCRIPT points the same cases at a deliberately broken copy of
// the script; that is the mutation hook used to prove each case can go red.

const scriptSource =
  process.env.CHECK_OVERRIDES_SCRIPT ?? join(import.meta.dir, 'check-overrides.ts')

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

interface CheckRun {
  stdout: string
  stderr: string
  exitCode: number | null
}

interface PackageSpec {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  nodeModules?: PackageSpec[]
}

async function runCheck(scriptPath: string, cwd: string): Promise<CheckRun> {
  const proc = Bun.spawn(['bun', scriptPath], {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { stdout, stderr, exitCode }
}

function writePackage(nodeModules: string, spec: PackageSpec): void {
  const dir = join(nodeModules, spec.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: spec.name,
      version: spec.version ?? '1.0.0',
      dependencies: spec.dependencies,
      devDependencies: spec.devDependencies
    })
  )
  for (const nested of spec.nodeModules ?? []) writePackage(join(dir, 'node_modules'), nested)
}

/**
 * A throwaway repo-shaped tree holding a copy of the real gate script, a root
 * manifest with the given `overrides`, and a synthetic `node_modules`. The
 * script resolves its root from its own location, so the fixture is authored
 * exactly like this repository: `<root>/package.json` + `<root>/node_modules`.
 */
function makeTree(
  overrides: Record<string, unknown>,
  packages: PackageSpec[]
): {
  script: string
  cwd: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-overrides-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', overrides })
  )
  const nodeModules = join(dir, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  for (const spec of packages) writePackage(nodeModules, spec)
  const script = join(dir, 'scripts', 'check-overrides.ts')
  writeFileSync(script, readFileSync(scriptSource, 'utf8'))
  return { script, cwd: dir }
}

describe('overrides range gate #2679', () => {
  test('fails when a forced version falls outside the consumer range', async () => {
    const { script, cwd } = makeTree({ 'forced-pkg': '2.0.0' }, [
      { name: 'consumer-a', dependencies: { 'forced-pkg': '^1.0.0' } }
    ])
    const { stdout, stderr, exitCode } = await runCheck(script, cwd)
    if (exitCode === 0)
      console.error('[check-overrides] forced range unexpectedly passed:\n' + stdout)
    expect(exitCode).toBe(1)
    expect(stderr).toContain(
      'FAIL forced-pkg 2.0.0 > consumer-a declares ^1.0.0 (dependencies) at node_modules/consumer-a'
    )
    expect(stderr).toContain('1 override(s) force a version outside')
  })

  test('passes when the forced version satisfies the consumer range', async () => {
    const { script, cwd } = makeTree({ 'forced-pkg': '1.2.3' }, [
      { name: 'consumer-a', dependencies: { 'forced-pkg': '^1.0.0' } }
    ])
    const { stdout, stderr, exitCode } = await runCheck(script, cwd)
    if (exitCode !== 0) console.error('[check-overrides] in-range run failed:\n' + stdout + stderr)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      'OK: 1 overrides vs 1 consumer declarations in 1 installed packages — 0 allowed, 0 skipped'
    )
  })

  test('allows a violation matched by an EXCEPTIONS entry', async () => {
    // The same shape as the real #275 case, so the sanctioned entry is proven to
    // match by override + consumer name and to print its reason.
    const { script, cwd } = makeTree({ 'fast-uri': '4.2.4' }, [
      { name: 'ajv', version: '8.20.0', dependencies: { 'fast-uri': '^3.0.1' } }
    ])
    const { stdout, stderr, exitCode } = await runCheck(script, cwd)
    if (exitCode !== 0) console.error('[check-overrides] exception run failed:\n' + stdout + stderr)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      'ALLOWED fast-uri 4.2.4 > ajv declares ^3.0.1 (dependencies) at node_modules/ajv — '
    )
    expect(stdout).toContain('1 allowed, 0 skipped')
    expect(stdout).not.toContain('STALE exception')
  })

  test('skips non-semver ranges instead of judging them', async () => {
    // Load-bearing: `Bun.semver.satisfies` answers true for both of these, so it
    // is the classifier — not the comparison — that keeps them out of the gate.
    const { script, cwd } = makeTree({ 'forced-pkg': '1.2.3' }, [
      { name: 'workspace-consumer', dependencies: { 'forced-pkg': 'workspace:*' } },
      { name: 'alias-consumer', dependencies: { 'forced-pkg': 'npm:other-pkg@^1.0.0' } }
    ])
    const { stdout, stderr, exitCode } = await runCheck(script, cwd)
    if (exitCode !== 0)
      console.error('[check-overrides] non-semver run failed:\n' + stdout + stderr)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      'SKIP forced-pkg 1.2.3 > workspace-consumer declares workspace:* (dependencies) at ' +
        'node_modules/workspace-consumer — range is not semver (workspace protocol)'
    )
    expect(stdout).toContain(
      'SKIP forced-pkg 1.2.3 > alias-consumer declares npm:other-pkg@^1.0.0 (dependencies) at ' +
        'node_modules/alias-consumer — range is not semver (npm alias)'
    )
    expect(stdout).toContain('0 allowed, 2 skipped')
  })

  test('object-form overrides behave like the plain string form', async () => {
    const inside = makeTree({ 'forced-pkg': { '.': '1.2.3' } }, [
      { name: 'consumer-a', dependencies: { 'forced-pkg': '^1.0.0' } }
    ])
    const insideRun = await runCheck(inside.script, inside.cwd)
    if (insideRun.exitCode !== 0)
      console.error(
        '[check-overrides] object in-range failed:\n' + insideRun.stdout + insideRun.stderr
      )
    expect(insideRun.stderr).toBe('')
    expect(insideRun.exitCode).toBe(0)
    expect(insideRun.stdout).toContain('1 overrides vs 1 consumer declarations')

    const outside = makeTree({ 'forced-pkg': { '.': '2.0.0' } }, [
      { name: 'consumer-a', dependencies: { 'forced-pkg': '^1.0.0' } }
    ])
    const outsideRun = await runCheck(outside.script, outside.cwd)
    if (outsideRun.exitCode === 0)
      console.error('[check-overrides] object out-of-range passed:\n' + outsideRun.stdout)
    expect(outsideRun.exitCode).toBe(1)
    expect(outsideRun.stderr).toContain(
      'FAIL forced-pkg 2.0.0 > consumer-a declares ^1.0.0 (dependencies) at node_modules/consumer-a'
    )
  })

  test('skips an installed package devDependencies range', async () => {
    // A package's own devDependencies are never installed, so the override never
    // lands there and a mismatch is not a violation.
    const { script, cwd } = makeTree({ 'forced-pkg': '2.0.0' }, [
      { name: 'consumer-a', devDependencies: { 'forced-pkg': '^1.0.0' } }
    ])
    const { stdout, stderr, exitCode } = await runCheck(script, cwd)
    if (exitCode !== 0)
      console.error('[check-overrides] devDependencies run failed:\n' + stdout + stderr)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      'SKIP forced-pkg 2.0.0 > consumer-a declares ^1.0.0 (devDependencies) at ' +
        'node_modules/consumer-a — devDependencies of an installed package are never installed'
    )
    expect(stdout).toContain('0 allowed, 1 skipped')
  })

  test('scoped overrides only judge declarations below their scope', async () => {
    const scoped = { 'scope-pkg': { 'forced-pkg': '2.0.0' } }
    const inScope = makeTree(scoped, [
      {
        name: 'scope-pkg',
        nodeModules: [{ name: 'inner-consumer', dependencies: { 'forced-pkg': '^1.0.0' } }]
      }
    ])
    const inScopeRun = await runCheck(inScope.script, inScope.cwd)
    if (inScopeRun.exitCode === 0)
      console.error('[check-overrides] scoped violation passed:\n' + inScopeRun.stdout)
    expect(inScopeRun.exitCode).toBe(1)
    expect(inScopeRun.stderr).toContain(
      'FAIL forced-pkg 2.0.0 > inner-consumer declares ^1.0.0 (dependencies) at ' +
        'node_modules/scope-pkg/node_modules/inner-consumer'
    )

    const outOfScope = makeTree(scoped, [
      { name: 'other-consumer', dependencies: { 'forced-pkg': '^1.0.0' } }
    ])
    const outOfScopeRun = await runCheck(outOfScope.script, outOfScope.cwd)
    if (outOfScopeRun.exitCode !== 0)
      console.error(
        '[check-overrides] out-of-scope run failed:\n' + outOfScopeRun.stdout + outOfScopeRun.stderr
      )
    expect(outOfScopeRun.stderr).toBe('')
    expect(outOfScopeRun.exitCode).toBe(0)
    expect(outOfScopeRun.stdout).toContain(
      'SKIP forced-pkg 2.0.0 — no installed package under scope-pkg declares it'
    )
  })
})

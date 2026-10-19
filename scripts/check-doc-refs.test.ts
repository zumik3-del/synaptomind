import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Regression coverage for the offline doc-reference lint added by #1757
// (audit M7, Theme F) and widened by #1780 to `deploy/` + the `docs/adr/` token.
// `scripts/check-doc-refs.ts` must fail on any surviving `ai-workdir/` or
// `docs/adr/` pointer (both absent from a checkout) and pass on the real tree.
// The script self-executes at import time
// (`process.chdir(dirname(import.meta.dir))`), so it is exercised as a child
// process — never imported into this test's module registry.

const repoRoot = join(import.meta.dir, '..')
const scriptSource = join(repoRoot, 'scripts', 'check-doc-refs.ts')

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

interface LintRun {
  stdout: string
  stderr: string
  exitCode: number | null
}

async function runLint(scriptPath: string, cwd: string): Promise<LintRun> {
  const proc = Bun.spawn(['bun', scriptPath], { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { stdout, stderr, exitCode }
}

/**
 * A throwaway repo-shaped tree holding a copy of the real lint script, so a
 * seeded `ai-workdir/` reference cannot be polluted by, or pollute, the
 * working tree. The script resolves its roots relative to its own location.
 */
function makeTree(): { script: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-docrefs-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  mkdirSync(join(dir, 'deploy'), { recursive: true })
  const script = join(dir, 'scripts', 'check-doc-refs.ts')
  writeFileSync(script, readFileSync(scriptSource, 'utf8'))
  return { script, cwd: dir }
}

describe('check-doc-refs lint #1757/#1780', () => {
  test('passes on the current tree (no ai-workdir/ references)', async () => {
    const { stdout, stderr, exitCode } = await runLint(scriptSource, repoRoot)
    if (exitCode !== 0) console.error('[check-doc-refs] current tree:\n' + stdout + stderr)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  test('fails with a non-zero exit on a seeded ai-workdir/ reference', async () => {
    const { script, cwd } = makeTree()
    writeFileSync(join(cwd, 'src', 'seed.md'), '# seeded\n\nSee ai-workdir/plan.md for details.\n')
    const { stdout, stderr, exitCode } = await runLint(script, cwd)
    if (exitCode === 0) console.error('[check-doc-refs] seeded tree unexpectedly clean:\n' + stdout)
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('ai-workdir/')
    expect(stderr).toContain('seed.md')
  })

  test('passes on a clean throwaway tree (control for the seeded case)', async () => {
    const { script, cwd } = makeTree()
    writeFileSync(join(cwd, 'docs', 'ok.md'), '# fine\n\nDesign docs live in authelia/artifacts.\n')
    const { stderr, exitCode } = await runLint(script, cwd)
    if (exitCode !== 0) console.error('[check-doc-refs] clean tree:\n' + stderr)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  test('covers deploy/ and the docs/adr/ token (app.env is scanned)', async () => {
    const { script, cwd } = makeTree()
    // Mirrors the real repair site: deploy/app.env pointed at a `docs/adr/0001-…`
    // path that never existed. Proves the deploy/ root and the .env extension.
    writeFileSync(
      join(cwd, 'deploy', 'app.env'),
      '# see docs/adr/0001-self-contained-binary-tarball-deployment.md\nDIST="binary"\n'
    )
    const { stderr, exitCode } = await runLint(script, cwd)
    if (exitCode === 0) console.error('[check-doc-refs] deploy/ seed unexpectedly clean:\n' + stderr)
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('docs/adr/')
    expect(stderr).toContain('deploy/app.env')
  })

  test('covers a seeded offence under docs/ (was never seeded before)', async () => {
    const { script, cwd } = makeTree()
    writeFileSync(join(cwd, 'docs', 'seed.md'), '# seeded\n\nDesign: docs/adr/0001-x.md\n')
    const { stderr, exitCode } = await runLint(script, cwd)
    if (exitCode === 0) console.error('[check-doc-refs] docs/ seed unexpectedly clean:\n' + stderr)
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('docs/seed.md')
  })

  test('rejects only text extensions, not binary blobs', async () => {
    const { script, cwd } = makeTree()
    // .png is outside TEXT_EXTENSIONS, so a stray byte sequence is not a hit.
    writeFileSync(join(cwd, 'src', 'logo.png'), 'ai-workdir/not-scanned')
    const { stderr, exitCode } = await runLint(script, cwd)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  test('reports the offending file and line number', async () => {
    const { script, cwd } = makeTree()
    writeFileSync(join(cwd, 'src', 'multi.ts'), 'const a = 1\n// ai-workdir/x.md\nconst b = 2\n')
    const { stderr } = await runLint(script, cwd)
    expect(stderr).toContain('multi.ts:2')
  })
})

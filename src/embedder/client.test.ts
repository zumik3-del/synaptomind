import { test, expect } from 'bun:test'

// The stub-subprocess suite (client.suite.ts) exercises the REAL embedder
// client. Other suites mock.module('../embedder/client') globally, and bun
// cannot unmock modules — its patching has been observed to leak through
// `export *` re-exports into client-core under some multi-file evaluation
// orders (CI-only split-brain: mock'd generateEmbedding, real startEmbedder).
// No in-process specifier trick is safe, so the suite runs in a child bun
// process with a clean module registry.

test('embedder client stub suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/embedder/client.suite.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])

  if (exitCode !== 0) {
    console.error('[client.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
})

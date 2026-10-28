import { expect, test } from 'bun:test'

// The chunking suite (batch-chunking.suite.ts) witnesses the IPC boundary of the
// REAL embedder client, which other test files mock.module('../embedder/client')
// globally; bun cannot unmock modules, so the suite runs in a child bun process
// with a clean module registry (same pattern as client.test.ts).
test('embedder batch chunking suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/embedder/batch-chunking.suite.ts'], {
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
    console.error('[batch-chunking.test] isolated suite failed:\n' + stdout + '\n' + stderr)
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
}, 30_000)

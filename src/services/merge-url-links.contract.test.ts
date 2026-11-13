import { expect, test } from 'bun:test'

// The merge url-links suite (merge-url-links.suite.ts) drives the REAL log sink:
// it points SYNAPTOMIND_LOG_FILE at a scratch JSONL file before the app modules
// load, so the default Logger's FileSink emits the collision line that the test
// reads back. `config.ts` and the default Logger are evaluated once per process,
// so the suite runs in a child bun process with a clean module registry
// (AGENTS.md §8; same recipe as embedder-batch-loop.test.ts).
test('merge url-links sink suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/services/merge-url-links.suite.ts'], {
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
    console.error(
      '[merge-url-links.contract.test] isolated suite failed:\n' + stdout + '\n' + stderr
    )
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
}, 30_000)

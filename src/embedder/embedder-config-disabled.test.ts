import { expect, test } from 'bun:test'

// The case needs `config.embedder.enabled === false` at load, and the config object is frozen and
// process-wide, so it runs in a child bun process whose environment decides the value.
test('config-disabled embedder suite (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/embedder/embedder-config-disabled.suite.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: { ...process.env, SYNAPTOMIND_EMBEDDER_ENABLED: 'false' },
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
      '[embedder-config-disabled.test] isolated suite failed:\n' + stdout + '\n' + stderr
    )
  }
  expect(exitCode).toBe(0)
  expect(stdout + stderr).toContain('0 fail')
}, 30_000)

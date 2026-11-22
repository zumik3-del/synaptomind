import { expect, test } from 'bun:test'

test('multi-user embedder real SQLite progress (isolated process)', async () => {
  const proc = Bun.spawn(['bun', 'test', './src/embedder/embedder-multi-db.suite.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      SYNAPTOMIND_EMBEDDER_POLL_INTERVAL: '10',
      SYNAPTOMIND_EMBEDDER_BATCH_SIZE: '10',
      SYNAPTOMIND_EMBEDDER_PRECACHE: 'true',
      SYNAPTOMIND_EMBEDDER_IDLE_TIMEOUT: '60000'
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const deadline = setTimeout(() => proc.kill(), 30_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  clearTimeout(deadline)
  const output = stdout + stderr
  if (code !== 0) console.error(output)
  expect(code).toBe(0)
  // A fully skipped suite also ends in "0 fail"; require real assertions to run.
  expect(Number(output.match(/(\d+)\s+pass/)?.[1] ?? 0)).toBeGreaterThan(0)
  expect(output).toContain('0 fail')
}, 30_000)

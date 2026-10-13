import { expect, test } from 'bun:test'

// The heavy auto-cluster perf suite (auto-cluster.perf.suite.ts) runs a
// 3000-candidate O(N^2) job (~4 s, ~36 MB) that must not sit inside the default
// `bun test` gate on a host that also runs prod (AGENTS.md §8; task #1569, O4).
// `*.suite.ts` is excluded from the test glob and this wrapper spawns it only on
// demand — same child-process recipe as `batch-chunking.test.ts`:
//   SYNAPTOMIND_PERF_SUITE=1 bun test ./src/services/auto-cluster.perf.test.ts
const PERF_SUITE_ENABLED = process.env.SYNAPTOMIND_PERF_SUITE === '1'

test.skipIf(!PERF_SUITE_ENABLED)(
  'auto-cluster perf suite (isolated process; set SYNAPTOMIND_PERF_SUITE=1)',
  async () => {
    const proc = Bun.spawn(['bun', 'test', './src/services/auto-cluster.perf.suite.ts'], {
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
      console.error('[auto-cluster.perf.test] isolated suite failed:\n' + stdout + '\n' + stderr)
    }
    expect(exitCode).toBe(0)
    expect(stdout + stderr).toContain('0 fail')
  }
)

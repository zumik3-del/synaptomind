import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The dtype reaches the loader through `config`, which is read at import time —
// so both values are driven as separate processes rather than two in-process
// cases. `model-dtype.suite.ts` mocks `@huggingface/transformers` entirely, so
// each run is offline and needs no model files.
const scratchCaches: string[] = []

afterAll(() => {
  for (const dir of scratchCaches) rmSync(dir, { recursive: true, force: true })
})

for (const dtype of ['fp32', 'q8'] as const) {
  test(`embedder loader suite, dtype=${dtype} (isolated process)`, async () => {
    // A scratch cache dir per run: even if the mock failed to apply, the loader
    // must never be pointed at a real model cache by a test.
    const cacheDir = mkdtempSync(join(tmpdir(), `synaptomind-model-dtype-${dtype}-`))
    scratchCaches.push(cacheDir)

    const proc = Bun.spawn(['bun', 'test', './src/embedder/model-dtype.suite.ts'], {
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        SYNAPTOMIND_EMBEDDER_DTYPE: dtype,
        SYNAPTOMIND_EMBEDDER_CACHE_DIR: cacheDir
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])

    if (exitCode !== 0) {
      console.error(`[model-dtype.test] dtype=${dtype} suite failed:\n` + stdout + '\n' + stderr)
    }
    expect(exitCode).toBe(0)
    expect(stdout + stderr).toContain('0 fail')
  }, 60_000)
}

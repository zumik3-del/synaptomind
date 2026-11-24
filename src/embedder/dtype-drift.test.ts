import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// dtype-drift.suite.ts is invisible to the gates: `*.suite.ts` is excluded from the
// test glob, so nothing ran it. It cannot be spawned bare the way client.test.ts
// spawns its suite either — the default mode is `embed`, which downloads a 113 MB
// (q8) or 449 MB (fp32) ONNX model through ensureModelFiles, and a test must stay
// offline. What IS offline is the suite's `compare` mode: the cosine arithmetic
// and the two calibration gates behind docs/CONFIG.md's "fp32↔q8 drift ≤0.0061"
// claim. That half runs here, against a synthetic dump pair, with a negative
// control proving the gate goes red when the two dtypes are identical.
//
// The `embed` half stays a manual tool (it is the only thing that measures REAL
// vectors), and deleting the suite would delete the only place the drift
// thresholds are asserted: the dtype→ONNX contract has its own coverage in
// model-validator.test.ts (`ensureModelFiles — a q8 fetch never asks for
// onnx/model.onnx`) and model-dtype.suite.ts, but `dtypeDistanceBound`, the
// `blocking === 0` verdict and the `vectorFloor` comparison live only here.

/** What the dumps carry; the suite asserts the dump length against its own corpus. */
const CORPUS = 16
const DIMENSIONS = 384
/** Per-component jitter of the "q8" dump: cosine distance ~2e-4, far under
 *  dtypeDistanceBound (0.25) and leaving self-similarity above vectorFloor (0.9). */
const NOISE = 0.02

const scratchDirs: string[] = []
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** Deterministic, so a failure reproduces without a frozen fixture file. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round7 = (v: number): number => Math.round(v * 1e7) / 1e7

interface Vectors {
  query: number[]
  passage: number[]
}

function dumpPair(identical: boolean): { fp32: string; q8: string } {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-dtype-drift-'))
  scratchDirs.push(dir)
  const rand = mulberry32(2664)
  const vector = () => Array.from({ length: DIMENSIONS }, () => round7(rand() * 2 - 1))
  const perturbed = (v: number[]) => v.map(x => round7(x + NOISE * (rand() * 2 - 1)))

  const samples: Array<{ text: string; fp32: Vectors; q8: Vectors }> = []
  for (let i = 0; i < CORPUS; i++) {
    const query = vector()
    const passage = vector()
    samples.push({
      text: `synthetic sample ${i}`,
      fp32: { query, passage },
      q8: identical ? { query, passage } : { query: perturbed(query), passage: perturbed(passage) }
    })
  }

  const write = (name: string, dtype: string, pick: (s: (typeof samples)[number]) => Vectors) => {
    const path = join(dir, name)
    writeFileSync(
      path,
      JSON.stringify({
        dtype,
        model: 'multilingual-e5-small',
        dimensions: DIMENSIONS,
        cacheDir: dir,
        onnxFile: dtype === 'q8' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx',
        samples: samples.map(s => ({ text: s.text, ...pick(s) }))
      })
    )
    return path
  }

  return {
    fp32: write('fp32.json', 'fp32', s => s.fp32),
    q8: write('q8.json', 'q8', s => s.q8)
  }
}

function runCompare(dumps: { fp32: string; q8: string }): { output: string; exitCode: number } {
  const proc = Bun.spawnSync(['bun', 'test', './src/embedder/dtype-drift.suite.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: { ...process.env, DRIFT_MODE: 'compare', DRIFT_FP32: dumps.fp32, DRIFT_Q8: dumps.q8 },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return {
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    exitCode: proc.exitCode ?? 1
  }
}

test('compare mode passes on a dump pair that differs only by quantization-scale noise', () => {
  const { output, exitCode } = runCompare(dumpPair(false))
  if (exitCode !== 0) console.error('[dtype-drift.test] compare mode failed:\n' + output)
  expect(exitCode).toBe(0)
  expect(output).toContain('0 fail')
  // Both cases are registered and the compare one RAN: a bare `embed` spawn would
  // have failed on its missing cache dir, and a skipped pair would read 0 pass.
  expect(output).toContain('1 pass')
  expect(output).toContain('Ran 2 tests across 1 file')
}, 30_000)

test('compare mode fails when the two dtypes produced identical vectors', () => {
  // The negative control. Without it, "the suite passes" and "the suite was never
  // reached" are the same observation — and a threshold that cannot fail is not a
  // threshold.
  const { output, exitCode } = runCompare(dumpPair(true))
  expect(exitCode).not.toBe(0)
  expect(output).toContain('identical texts must not be identical vectors across dtypes')
}, 30_000)

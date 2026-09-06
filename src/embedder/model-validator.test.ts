import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { validateModelFiles } from './model-validator'

const MODEL = 'test-model'

// Exact-size boundaries: the validator flags size < minSizeBytes, so a file
// of exactly the minimum must pass.
const CONFIG_BYTES = 50
const TOKENIZER_BYTES = 1_000
const ONNX_BYTES = 1_000_000

let cacheDir = ''

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'synaptomind-model-validator-'))
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
})

async function writeModelFile(relPath: string, sizeBytes: number, fill = 0x61): Promise<void> {
  const fp = join(cacheDir, MODEL, relPath)
  await mkdir(dirname(fp), { recursive: true })
  await writeFile(fp, Buffer.alloc(sizeBytes, fill))
}

async function writeAllModelFiles(onnxFill = 0x61): Promise<void> {
  await writeModelFile('config.json', CONFIG_BYTES)
  await writeModelFile('tokenizer.json', TOKENIZER_BYTES)
  await writeModelFile('tokenizer_config.json', CONFIG_BYTES)
  await writeModelFile('onnx/model.onnx', ONNX_BYTES, onnxFill)
}

test('all files present with sufficient sizes → everything ok', async () => {
  await writeAllModelFiles()

  const result = await validateModelFiles(cacheDir, MODEL)

  expect(result.ok).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'])
  expect(result.missing).toEqual([])
  expect(result.corrupt).toEqual([])
})

test('empty cache dir → every file missing', async () => {
  const result = await validateModelFiles(cacheDir, MODEL)

  expect(result.missing).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'])
  expect(result.corrupt).toEqual([])
  expect(result.ok).toEqual([])
})

test('a missing file lands in the missing list, the rest stay ok', async () => {
  await writeModelFile('config.json', CONFIG_BYTES)
  await writeModelFile('tokenizer_config.json', CONFIG_BYTES)
  await writeModelFile('onnx/model.onnx', ONNX_BYTES)

  const result = await validateModelFiles(cacheDir, MODEL)

  expect(result.missing).toEqual(['tokenizer.json'])
  expect(result.corrupt).toEqual([])
  expect(result.ok).toEqual(['config.json', 'tokenizer_config.json', 'onnx/model.onnx'])
})

test('a file below its minimum size lands in the corrupt list', async () => {
  await writeAllModelFiles()
  await writeModelFile('config.json', 10) // 10 < 50

  const result = await validateModelFiles(cacheDir, MODEL)

  expect(result.corrupt).toEqual(['config.json'])
  expect(result.missing).toEqual([])
  expect(result.ok).toEqual(['tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'])
})

test('an all-zero ONNX header is corrupt even at sufficient size', async () => {
  await writeAllModelFiles(0x00)

  const result = await validateModelFiles(cacheDir, MODEL)

  expect(result.corrupt).toEqual(['onnx/model.onnx'])
  expect(result.ok).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json'])
})

test('mixed: one missing, one corrupt, two ok', async () => {
  await writeModelFile('config.json', 10) // corrupt
  // tokenizer.json not written → missing
  await writeModelFile('tokenizer_config.json', CONFIG_BYTES)
  await writeModelFile('onnx/model.onnx', ONNX_BYTES)

  const result = await validateModelFiles(cacheDir, MODEL)

  expect(result.missing).toEqual(['tokenizer.json'])
  expect(result.corrupt).toEqual(['config.json'])
  expect(result.ok).toEqual(['tokenizer_config.json', 'onnx/model.onnx'])
})

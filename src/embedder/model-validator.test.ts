import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { EmbedderDtype } from '../config'
import { ensureModelFiles, validateModelFiles } from './model-validator'

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

  const result = await validateModelFiles(cacheDir, MODEL, 'fp32')

  expect(result.ok).toEqual([
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model.onnx'
  ])
  expect(result.missing).toEqual([])
  expect(result.corrupt).toEqual([])
})

test('empty cache dir → every file missing', async () => {
  const result = await validateModelFiles(cacheDir, MODEL, 'fp32')

  expect(result.missing).toEqual([
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model.onnx'
  ])
  expect(result.corrupt).toEqual([])
  expect(result.ok).toEqual([])
})

test('a missing file lands in the missing list, the rest stay ok', async () => {
  await writeModelFile('config.json', CONFIG_BYTES)
  await writeModelFile('tokenizer_config.json', CONFIG_BYTES)
  await writeModelFile('onnx/model.onnx', ONNX_BYTES)

  const result = await validateModelFiles(cacheDir, MODEL, 'fp32')

  expect(result.missing).toEqual(['tokenizer.json'])
  expect(result.corrupt).toEqual([])
  expect(result.ok).toEqual(['config.json', 'tokenizer_config.json', 'onnx/model.onnx'])
})

test('a file below its minimum size lands in the corrupt list', async () => {
  await writeAllModelFiles()
  await writeModelFile('config.json', 10) // 10 < 50

  const result = await validateModelFiles(cacheDir, MODEL, 'fp32')

  expect(result.corrupt).toEqual(['config.json'])
  expect(result.missing).toEqual([])
  expect(result.ok).toEqual(['tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'])
})

test('an all-zero ONNX header is corrupt even at sufficient size', async () => {
  await writeAllModelFiles(0x00)

  const result = await validateModelFiles(cacheDir, MODEL, 'fp32')

  expect(result.corrupt).toEqual(['onnx/model.onnx'])
  expect(result.ok).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json'])
})

test('mixed: one missing, one corrupt, two ok', async () => {
  await writeModelFile('config.json', 10) // corrupt
  await writeModelFile('tokenizer_config.json', CONFIG_BYTES)
  await writeModelFile('onnx/model.onnx', ONNX_BYTES)

  const result = await validateModelFiles(cacheDir, MODEL, 'fp32')

  expect(result.missing).toEqual(['tokenizer.json'])
  expect(result.corrupt).toEqual(['config.json'])
  expect(result.ok).toEqual(['tokenizer_config.json', 'onnx/model.onnx'])
})

// transformers.js resolves the ONNX file by dtype suffix (fp32 -> '', q8 ->
// '_quantized'), so the validator must require the file the LOADER will open.

const DTYPE_ONNX: Array<{ dtype: EmbedderDtype; onnx: string; sibling: string }> = [
  { dtype: 'fp32', onnx: 'onnx/model.onnx', sibling: 'onnx/model_quantized.onnx' },
  { dtype: 'q8', onnx: 'onnx/model_quantized.onnx', sibling: 'onnx/model.onnx' }
]

async function writeTokenizerFiles(): Promise<void> {
  await writeModelFile('config.json', CONFIG_BYTES)
  await writeModelFile('tokenizer.json', TOKENIZER_BYTES)
  await writeModelFile('tokenizer_config.json', CONFIG_BYTES)
}

const reportedPaths = (result: Awaited<ReturnType<typeof validateModelFiles>>, path: string) =>
  [...result.ok, ...result.missing, ...result.corrupt].includes(path)

describe('validateModelFiles — dtype selects the ONNX file', () => {
  for (const { dtype, onnx, sibling } of DTYPE_ONNX) {
    test(`${dtype}: the dtype's ONNX file is the one validated (ok path)`, async () => {
      await writeTokenizerFiles()
      await writeModelFile(onnx, ONNX_BYTES)

      const result = await validateModelFiles(cacheDir, MODEL, dtype)

      expect(result.ok).toContain(onnx)
      expect(result.missing).toEqual([])
      expect(result.corrupt).toEqual([])
    })

    test(`${dtype}: only the sibling dtype's ONNX file present → still missing`, async () => {
      await writeTokenizerFiles()
      await writeModelFile(sibling, ONNX_BYTES)

      const result = await validateModelFiles(cacheDir, MODEL, dtype)

      expect(result.missing).toEqual([onnx])
      expect(result.corrupt).toEqual([])
      expect(reportedPaths(result, sibling)).toBe(false)
    })

    test(`${dtype}: an all-zero header in the dtype's ONNX file is corrupt`, async () => {
      await writeTokenizerFiles()
      await writeModelFile(onnx, ONNX_BYTES, 0x00)

      const result = await validateModelFiles(cacheDir, MODEL, dtype)

      expect(result.corrupt).toEqual([onnx])
      expect(result.missing).toEqual([])
    })

    test(`${dtype}: a valid sibling file never masks a corrupt dtype file`, async () => {
      await writeTokenizerFiles()
      await writeModelFile(onnx, 10) // below the 1 MB floor
      await writeModelFile(sibling, ONNX_BYTES)

      const result = await validateModelFiles(cacheDir, MODEL, dtype)

      expect(result.corrupt).toEqual([onnx])
      expect(result.missing).toEqual([])
      expect(reportedPaths(result, sibling)).toBe(false)
    })
  }
})

describe('ensureModelFiles — a q8 fetch never asks for onnx/model.onnx', () => {
  const requestedUrls: string[] = []
  let restoreFetch: (() => void) | null = null

  function stubFetch(): void {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requestedUrls.push(url)
      return new Response(new Uint8Array(ONNX_BYTES).fill(0x61), { status: 200 })
    }) as typeof fetch
    restoreFetch = () => {
      globalThis.fetch = original
    }
  }

  beforeEach(() => {
    requestedUrls.length = 0
    stubFetch()
  })

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = null
  })

  test('q8 download targets onnx/model_quantized.onnx and leaves a stale fp32 file untouched', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model.onnx', ONNX_BYTES, 0x42)
    const staleBefore = await readFile(join(cacheDir, MODEL, 'onnx/model.onnx'))

    await ensureModelFiles(cacheDir, MODEL, 'q8')

    expect(requestedUrls).toEqual([
      `https://huggingface.co/${MODEL}/resolve/main/onnx/model_quantized.onnx`
    ])
    expect(requestedUrls.some(url => url.endsWith('onnx/model.onnx'))).toBe(false)

    const quantized = Bun.file(join(cacheDir, MODEL, 'onnx/model_quantized.onnx'))
    expect(await quantized.exists()).toBe(true)
    expect(quantized.size).toBe(ONNX_BYTES)

    const staleAfter = await readFile(join(cacheDir, MODEL, 'onnx/model.onnx'))
    expect(staleAfter.equals(staleBefore)).toBe(true)
  })

  test('fp32 download targets onnx/model.onnx (the mirror image)', async () => {
    await writeTokenizerFiles()

    await ensureModelFiles(cacheDir, MODEL, 'fp32')

    expect(requestedUrls).toEqual([`https://huggingface.co/${MODEL}/resolve/main/onnx/model.onnx`])
    expect(await Bun.file(join(cacheDir, MODEL, 'onnx/model.onnx')).exists()).toBe(true)
  })

  test('q8 with all files cached downloads nothing', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model_quantized.onnx', ONNX_BYTES)

    await ensureModelFiles(cacheDir, MODEL, 'q8')

    expect(requestedUrls).toEqual([])
  })

  test('a corrupt q8 ONNX file is re-fetched from the quantized path, not the fp32 one', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model_quantized.onnx', ONNX_BYTES, 0x00) // all-zero header

    await ensureModelFiles(cacheDir, MODEL, 'q8')

    expect(requestedUrls).toEqual([
      `https://huggingface.co/${MODEL}/resolve/main/onnx/model_quantized.onnx`
    ])
    const quantized = Bun.file(join(cacheDir, MODEL, 'onnx/model_quantized.onnx'))
    expect(quantized.size).toBe(ONNX_BYTES)
    expect(
      (await readFile(join(cacheDir, MODEL, 'onnx/model_quantized.onnx'))).subarray(0, 4)
    ).toEqual(Buffer.from([0x61, 0x61, 0x61, 0x61]))
  })
})

// The warning must go to stderr: `embedder-client` records a child's stderr as `warning`, stdout only as `info`.

const MIB = 1024 * 1024

/** The stable half of the line: the `[embedder]` tag, the sibling's path, its size. */
function staleSiblingCore(path: string, bytes: number): string {
  return `[embedder] ${path} (${(bytes / MIB).toFixed(1)} MB)`
}

const UNCONDITIONAL_DELETE_RE =
  /\b(can|may|could|might)\s+be\s+delet|\byou\s+(can|may|should)\s+delete\b|\bis\s+deletable\b|\b(safe|free)\s+to\s+(delete|remove)\b/i

/** A named price for deleting the sibling: without one, `delet…` reads as an invitation. */
const DELETION_COST_RE = /\boffline\b|re-?download|\bnetwork\b/i

/** One stale-sibling line: stable core intact, and no free-lunch deletion advice. */
function expectStaleSiblingWarning(
  line: string | undefined,
  path: string,
  bytes: number,
  dtype: EmbedderDtype
): void {
  const text = line ?? '<no warning line emitted>'
  expect(text).toContain(staleSiblingCore(path, bytes))
  expect(text).toContain(`dtype=${dtype}`)
  expect(text).not.toMatch(UNCONDITIONAL_DELETE_RE)
  // If the line mentions deleting the file at all, it owes the operator the cost.
  if (/delet/i.test(text)) expect(text).toMatch(DELETION_COST_RE)
}

describe('ensureModelFiles — stale sibling ONNX warning', () => {
  let events: string[] = []
  let serveDownloads = false
  let restoreWarn: () => void = () => {}
  let restoreFetch: () => void = () => {}

  const warnings = (): string[] =>
    events.filter(e => e.startsWith('warn:')).map(e => e.slice('warn:'.length))
  const fetches = (): string[] =>
    events.filter(e => e.startsWith('fetch:')).map(e => e.slice('fetch:'.length))

  beforeEach(() => {
    events = []
    // Offline by default: an unexpected download fails loudly here instead of
    // reaching huggingface.co. Only the repair-path case opts into a served body.
    serveDownloads = false

    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      events.push(`warn:${args.map(String).join(' ')}`)
    })
    restoreWarn = () => warnSpy.mockRestore()

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      events.push(`fetch:${url}`)
      if (!serveDownloads) throw new Error('offline: this suite must not download')
      return new Response(new Uint8Array(ONNX_BYTES).fill(0x61), { status: 200 })
    }) as typeof fetch
    restoreFetch = () => {
      globalThis.fetch = originalFetch
    }
  })

  afterEach(() => {
    restoreWarn()
    restoreFetch()
  })

  test('q8 with a stale fp32 file present → one warning naming the file and its size, file untouched', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model_quantized.onnx', ONNX_BYTES)
    const staleBytes = 2 * MIB
    await writeModelFile('onnx/model.onnx', staleBytes, 0x42)
    const stalePath = join(cacheDir, MODEL, 'onnx/model.onnx')
    const before = await readFile(stalePath)

    await ensureModelFiles(cacheDir, MODEL, 'q8')

    const lines = warnings()
    expect(lines).toHaveLength(1)
    expectStaleSiblingWarning(lines[0], 'onnx/model.onnx', staleBytes, 'q8')
    expect(lines[0]).toContain('(2.0 MB)')
    expect(fetches()).toEqual([])

    // Log-only by design: a switch back reuses the file, so it is never deleted.
    const after = await readFile(stalePath)
    expect(after.byteLength).toBe(staleBytes)
    expect(after.equals(before)).toBe(true)
  })

  test('fp32 with a stale q8 file present → one warning (mirror image), same size convention', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model.onnx', ONNX_BYTES)
    const staleBytes = 1_310_720 // 1.25 MiB → toFixed(1) → "1.3 MB"
    await writeModelFile('onnx/model_quantized.onnx', staleBytes, 0x42)

    await ensureModelFiles(cacheDir, MODEL, 'fp32')

    const lines = warnings()
    expect(lines).toHaveLength(1)
    expectStaleSiblingWarning(lines[0], 'onnx/model_quantized.onnx', staleBytes, 'fp32')
    expect(lines[0]).toContain('(1.3 MB)')
    expect(fetches()).toEqual([])
  })

  test('emitted exactly once even when a corrupt dtype file makes the repair validate twice', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model_quantized.onnx', ONNX_BYTES, 0x00) // all-zero header → repair path
    const staleBytes = 2 * MIB
    await writeModelFile('onnx/model.onnx', staleBytes, 0x42)
    serveDownloads = true // let the repair complete, so the post-download validation runs

    await ensureModelFiles(cacheDir, MODEL, 'q8')

    expect(fetches()).toHaveLength(1)
    const lines = warnings()
    expect(lines).toHaveLength(1)
    expectStaleSiblingWarning(lines[0], 'onnx/model.onnx', staleBytes, 'q8')
  })

  test('a clean cache logs nothing on the warn channel', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model_quantized.onnx', ONNX_BYTES)

    await ensureModelFiles(cacheDir, MODEL, 'q8')

    expect(warnings()).toEqual([])
    expect(fetches()).toEqual([])
  })

  test('fp32 with only the q8 file on disk → the warning precedes the download that fails', async () => {
    const staleBytes = 2 * MIB
    await writeModelFile('onnx/model_quantized.onnx', staleBytes, 0x42)

    await expect(ensureModelFiles(cacheDir, MODEL, 'fp32')).rejects.toThrow(
      'offline: this suite must not download'
    )

    // The hint must not depend on a successful download: it is emitted before
    // the fetch that fails on an offline host.
    const [first] = events
    expect(first?.startsWith('warn:')).toBe(true)
    expectStaleSiblingWarning(
      first?.slice('warn:'.length),
      'onnx/model_quantized.onnx',
      staleBytes,
      'fp32'
    )
    expect(fetches()).toHaveLength(1)
  })

  test('the line reaches the real stderr stream (recorded as `warning`), never stdout', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model_quantized.onnx', ONNX_BYTES)
    const staleBytes = 2 * MIB
    await writeModelFile('onnx/model.onnx', staleBytes, 0x42)

    const monitor = resolve(import.meta.dir, 'model-validator.ts')
    const script =
      `const m = await import(${JSON.stringify(monitor)});` +
      `await m.ensureModelFiles(${JSON.stringify(cacheDir)}, ${JSON.stringify(MODEL)}, 'q8');` +
      `console.log('DONE')`
    const proc = Bun.spawn(['bun', '-e', script], { cwd: cacheDir, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])

    expect(code).toBe(0)
    expect(stdout).toContain('DONE')
    const warned = stderr.split('\n').filter(l => l.startsWith('[embedder]'))
    expect(warned).toHaveLength(1)
    expectStaleSiblingWarning(warned[0], 'onnx/model.onnx', staleBytes, 'q8')
    expect(stdout).not.toContain(staleSiblingCore('onnx/model.onnx', staleBytes))
  })
})

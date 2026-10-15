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

  expect(result.ok).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'])
  expect(result.missing).toEqual([])
  expect(result.corrupt).toEqual([])
})

test('empty cache dir → every file missing', async () => {
  const result = await validateModelFiles(cacheDir, MODEL, 'fp32')

  expect(result.missing).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'])
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
  // tokenizer.json not written → missing
  await writeModelFile('tokenizer_config.json', CONFIG_BYTES)
  await writeModelFile('onnx/model.onnx', ONNX_BYTES)

  const result = await validateModelFiles(cacheDir, MODEL, 'fp32')

  expect(result.missing).toEqual(['tokenizer.json'])
  expect(result.corrupt).toEqual(['config.json'])
  expect(result.ok).toEqual(['tokenizer_config.json', 'onnx/model.onnx'])
})

// ── dtype awareness ──────────────────────────────────────────────────────────
// transformers.js resolves the ONNX file by dtype suffix (fp32 -> '', q8 ->
// '_quantized'), so the validator must require the file the LOADER will open.
// The cases below add only what the fp32 table above cannot say: which ONNX
// path is required, and that the sibling dtype's file is inert — present or
// not, it never satisfies the requirement and is never reported as broken.
// A q8 run must never touch `onnx/model.onnx`: that is the 449 MB download the
// dtype switch exists to avoid.

const DTYPE_ONNX: Array<{ dtype: EmbedderDtype; onnx: string; sibling: string }> = [
  { dtype: 'fp32', onnx: 'onnx/model.onnx', sibling: 'onnx/model_quantized.onnx' },
  { dtype: 'q8', onnx: 'onnx/model_quantized.onnx', sibling: 'onnx/model.onnx' }
]

/** The three small files every dtype shares, so only the ONNX path varies. */
async function writeTokenizerFiles(): Promise<void> {
  await writeModelFile('config.json', CONFIG_BYTES)
  await writeModelFile('tokenizer.json', TOKENIZER_BYTES)
  await writeModelFile('tokenizer_config.json', CONFIG_BYTES)
}

/** Every path the validator reported, whatever its verdict. */
const reportedPaths = (result: Awaited<ReturnType<typeof validateModelFiles>>, path: string) => [
  ...result.ok,
  ...result.missing,
  ...result.corrupt
].includes(path)

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

      // The sibling is a real, well-formed file — it just is not the one this
      // dtype loads, so it neither satisfies the check nor gets blamed.
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

  /**
   * Replace global fetch for the duration of one test: records every URL and
   * answers with a plausible non-zero ONNX body, so the repair path completes
   * without a network call and the requested path is observable.
   */
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
    // A leftover fp32 file from before the switch: large, valid, and NOT what
    // q8 loads. It must not be requested, counted, or deleted.
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
    // Replaced by the download, so the zero header is gone.
    expect((await readFile(join(cacheDir, MODEL, 'onnx/model_quantized.onnx'))).subarray(0, 4)).toEqual(
      Buffer.from([0x61, 0x61, 0x61, 0x61])
    )
  })
})

// ── the stale sibling ONNX warning ───────────────────────────────────────────
// A dtype switch leaves the OTHER dtype's ONNX file in the cache. transformers.js
// resolves the file from the dtype string alone and never scans `onnx/`, so the
// sibling is inert — but it can be hundreds of MB on the disk-tight hosts the
// deploy guide names, so `ensureModelFiles` reports it. Four properties of that
// report are silent by nature and therefore easy to break without noticing:
// it goes to stderr (`console.warn`; `embedder-client` records a child's stderr
// at logs.db level `warning` while stdout only reaches `info`), it is emitted
// exactly once per call, it comes BEFORE any download (on an offline host the
// fetch is what fails, and this line is the operator's only hint), and it never
// touches the file.
//
// The sibling fixtures are synthetic (>= 1 MB) rather than the real 448.5 MB fp32
// file; the expected size text is derived from the fixture through the repo's
// existing MiB + toFixed(1) convention, with two literal cases pinning that
// convention (2 MiB → "2.0 MB", 1.25 MiB → "1.3 MB") instead of a real-file size.

const MIB = 1024 * 1024

/** The stale-sibling line for `path` at `bytes`, as the warning must render it. */
function staleSiblingLine(path: string, bytes: number, dtype: EmbedderDtype): string {
  return `[embedder] ${path} (${(bytes / MIB).toFixed(1)} MB) is not used by dtype=${dtype} and can be deleted`
}

describe('ensureModelFiles — stale sibling ONNX warning', () => {
  // Both channels are recorded in one log so a test can assert their ORDER. The
  // warning is swallowed here; the real stderr stream is asserted in the
  // child-process case at the end of this block.
  let events: string[] = []
  let serveDownloads = false
  let restoreWarn: () => void = () => {}
  let restoreFetch: () => void = () => {}

  const warnings = (): string[] => events.filter(e => e.startsWith('warn:')).map(e => e.slice('warn:'.length))
  const fetches = (): string[] => events.filter(e => e.startsWith('fetch:')).map(e => e.slice('fetch:'.length))

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

    expect(warnings()).toEqual([staleSiblingLine('onnx/model.onnx', staleBytes, 'q8')])
    // The size is one-decimal MiB, the unit the download line already uses.
    expect(warnings()[0]).toContain('(2.0 MB)')
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

    expect(warnings()).toEqual([staleSiblingLine('onnx/model_quantized.onnx', staleBytes, 'fp32')])
    expect(warnings()[0]).toContain('(1.3 MB)')
    expect(fetches()).toEqual([])
  })

  test('emitted exactly once even when a corrupt dtype file makes the repair validate twice', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model_quantized.onnx', ONNX_BYTES, 0x00) // all-zero header → repair path
    const staleBytes = 2 * MIB
    await writeModelFile('onnx/model.onnx', staleBytes, 0x42)
    serveDownloads = true // let the repair complete, so the post-download validation runs

    await ensureModelFiles(cacheDir, MODEL, 'q8')

    // The repair happened, so validateModelFiles ran on both sides of the
    // download; the warning sits outside that path and must not be repeated.
    expect(fetches()).toHaveLength(1)
    expect(warnings()).toEqual([staleSiblingLine('onnx/model.onnx', staleBytes, 'q8')])
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

    await expect(ensureModelFiles(cacheDir, MODEL, 'fp32')).rejects.toThrow('offline: this suite must not download')

    // The hint must not depend on a successful download: it is emitted before
    // the fetch that fails on an offline host.
    expect(events[0]).toBe(`warn:${staleSiblingLine('onnx/model_quantized.onnx', staleBytes, 'fp32')}`)
    expect(fetches()).toHaveLength(1)
  })

  test('the line reaches the real stderr stream (the one logs.db records as `warning`), never stdout', async () => {
    await writeTokenizerFiles()
    await writeModelFile('onnx/model_quantized.onnx', ONNX_BYTES)
    const staleBytes = 2 * MIB
    await writeModelFile('onnx/model.onnx', staleBytes, 0x42)

    // `spyOn` above only proves console.warn was called; this case proves which
    // stream the line lands on, which is what makes the warning durable.
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
    expect(stderr).toContain(staleSiblingLine('onnx/model.onnx', staleBytes, 'q8'))
    // stdout is recorded at level `info`, so the warning must not travel there.
    expect(stdout).not.toContain('is not used by dtype=')
  })
})

import { mkdir, rm } from 'node:fs/promises'
import type { EmbedderDtype } from '../config'
import { insertLog } from '../logging'

interface FileSpec {
  path: string
  minSizeBytes: number
}

// transformers.js resolves the ONNX filename by appending a per-dtype suffix
// (DEFAULT_DTYPE_SUFFIX_MAPPING: fp32 -> '', q8 -> '_quantized') to `onnx/model`.
// Keep this in sync with `config.embedder.dtype` — the loader passes the same dtype.
const ONNX_FILE_BY_DTYPE: Record<EmbedderDtype, string> = {
  fp32: 'onnx/model.onnx',
  q8: 'onnx/model_quantized.onnx'
}

function expectedFiles(dtype: EmbedderDtype): FileSpec[] {
  return [
    { path: 'config.json', minSizeBytes: 50 },
    { path: 'tokenizer.json', minSizeBytes: 1_000 },
    { path: 'tokenizer_config.json', minSizeBytes: 50 },
    { path: ONNX_FILE_BY_DTYPE[dtype], minSizeBytes: 1_000_000 }
  ]
}

function modelDir(cacheDir: string, modelName: string): string {
  return `${cacheDir}/${modelName}`
}

function downloadUrl(modelName: string, relativePath: string): string {
  return `https://huggingface.co/${modelName}/resolve/main/${relativePath}`
}

interface ValidationResult {
  missing: string[]
  corrupt: string[]
  ok: string[]
}

export async function validateModelFiles(
  cacheDir: string,
  modelName: string,
  dtype: EmbedderDtype
): Promise<ValidationResult> {
  const missing: string[] = []
  const corrupt: string[] = []
  const ok: string[] = []

  const baseDir = modelDir(cacheDir, modelName)

  for (const file of expectedFiles(dtype)) {
    const fp = `${baseDir}/${file.path}`
    const f = Bun.file(fp)
    const exists = await f.exists()

    if (!exists) {
      missing.push(file.path)
      continue
    }

    const size = f.size
    if (size < file.minSizeBytes) {
      console.log(`[embedder] corrupt model file: ${file.path} (${size} bytes, expected >= ${file.minSizeBytes})`)
      corrupt.push(file.path)
      continue
    }

    if (file.path.endsWith('.onnx')) {
      const buf = await f.slice(0, 4).arrayBuffer()
      const view = new Uint8Array(buf)
      if (view[0] === 0 && view[1] === 0 && view[2] === 0 && view[3] === 0) {
        console.log(`[embedder] corrupt ONNX file: ${file.path} (all-zero header)`)
        corrupt.push(file.path)
        continue
      }
    }

    ok.push(file.path)
  }

  return { missing, corrupt, ok }
}

async function downloadFile(modelName: string, relativePath: string, destPath: string): Promise<void> {
  const url = downloadUrl(modelName, relativePath)
  console.log(`[embedder] downloading ${relativePath}...`)

  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Failed to download ${relativePath}: HTTP ${resp.status} ${resp.statusText}`)
  }

  const parentDir = destPath.substring(0, destPath.lastIndexOf('/'))
  await mkdir(parentDir, { recursive: true })

  const buffer = await resp.arrayBuffer()
  await Bun.write(destPath, new Uint8Array(buffer))

  const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1)
  console.log(`[embedder] downloaded ${relativePath} (${sizeMB} MB)`)
}

export async function ensureModelFiles(cacheDir: string, modelName: string, dtype: EmbedderDtype): Promise<void> {
  const expectedCount = expectedFiles(dtype).length
  const result = await validateModelFiles(cacheDir, modelName, dtype)

  const baseDir = modelDir(cacheDir, modelName)
  for (const path of result.corrupt) {
    const fp = `${baseDir}/${path}`
    console.log(`[embedder] removing corrupt file: ${path}`)
    await rm(fp, { force: true })
  }

  const toDownload = [...result.missing, ...result.corrupt]

  if (toDownload.length > 0) {
    for (const path of toDownload) {
      const destPath = `${baseDir}/${path}`
      await downloadFile(modelName, path, destPath)
    }

    const finalResult = await validateModelFiles(cacheDir, modelName, dtype)
    if (finalResult.missing.length > 0 || finalResult.corrupt.length > 0) {
      throw new Error(
        `Model files still missing/corrupt after download: ${`missing=[${finalResult.missing.join(',')}] corrupt=[${finalResult.corrupt.join(',')}]`}`
      )
    }

    insertLog('info', 'embedding', 'Model downloaded and validated (not loaded into memory)', {
      model: modelName,
      files: toDownload
    })
    console.log(`[embedder] model files ready (${result.ok.length + toDownload.length}/${expectedCount}, dtype=${dtype})`)
  } else {
    insertLog('info', 'embedding', 'Model files validated (cached, not loaded)', {
      model: modelName,
      filesOk: result.ok
    })
    console.log(`[embedder] model files validated (${result.ok.length}/${expectedCount}, dtype=${dtype})`)
  }
}

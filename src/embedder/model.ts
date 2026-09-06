import { pipeline } from '@huggingface/transformers'
import { config } from '../config'
import { insertLog } from '../logging'

// Idle/unload is owned by the embedder process (resetIdleTimer exits the
// process on idle) — model.ts deliberately has no timer of its own.
let extractor: Awaited<ReturnType<typeof loadExtractor>> | null = null
let loading: Promise<void> | null = null

async function loadExtractor() {
  return await pipeline('feature-extraction', config.embedder.model, {
    cache_dir: config.embedder.cacheDir,
    dtype: 'fp32',
    // Single intra-op thread: ORT's thread pool calls pthread_setaffinity_np,
    // which fails with EINVAL inside LXC cgroups ("Specify the number of
    // threads explicitly"). One thread is plenty for this 384-dim model.
    session_options: { intraOpNumThreads: 1 }
  })
}

export function resetExtractor() {
  extractor = null
  loading = null
}

export async function getExtractor() {
  if (extractor) return extractor
  if (!loading) {
    loading = loadExtractor().then(
      e => {
        extractor = e
        loading = null
        insertLog('info', 'embedding', 'Model loaded', {
          model: config.embedder.model
        })
      },
      err => {
        loading = null
        insertLog('error', 'embedding', 'Model failed to load', {
          model: config.embedder.model,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    )
  }
  await loading
  if (!extractor) throw new Error('extractor was not set after loading')
  return extractor
}

const E5_PREFIX = { query: 'query: ', passage: 'passage: ' }

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const pipe = await getExtractor()
  const result = await pipe(E5_PREFIX.query + text, { pooling: 'mean', normalize: true })
  return result.data as Float32Array
}

export async function generateEmbeddings(batch: string[]): Promise<Float32Array[]> {
  const pipe = await getExtractor()
  return Promise.all(
    batch.map(text =>
      pipe(E5_PREFIX.passage + text, { pooling: 'mean', normalize: true }).then(r => r.data as Float32Array)
    )
  )
}

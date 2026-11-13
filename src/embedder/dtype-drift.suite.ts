import { expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { config } from '../config'
import { ensureModelFiles } from './model-validator'

const SAMPLES: string[] = [
  'Decided to keep exactly one model copy resident: a single embedding model costs 300-400 MB of RSS.',
  'The q8 quantized ONNX file is roughly a quarter of the fp32 size, which matters on a 1 GB host.',
  'Search blends BM25 and vector hits with reciprocal rank fusion, then applies the confidence floor.',
  'A long thought: changing the embedding model precision may alter similarity to previously stored passage vectors, so compare both paths before deciding whether to re-embed the corpus.',
  'Tests must stay offline: no network, no model files, no live database, no production service.',
  'p95 latency for search stayed under 40 ms on the development host.',
  'Rollback is never automatic: restore the pre-update database backup, then check out the printed revision.',
  'Vector dimensions are 384 for multilingual-e5-small.',
  'Решение: по умолчанию используем квантованную модель q8, потому что fp32 занимает 449 МБ на диске.',
  'Калибровка точности сравнивает сохранённый вектор с заново посчитанным.',
  'Если сменить точность модели, старые эмбеддинги могут перестать соответствовать новым.',
  'Поиск по мыслям объединяет полнотекстовый и векторный ранжировщик.',
  'Память — узкое место: на сервере всего 1–2 ГБ, поэтому держим одну копию модели.',
  'Тесты не должны ходить в сеть и скачивать веса.',
  'TODO: перемерить дрейф после переключения dtype и записать числа в задачу.',
  'Тест: «ёж» и «ež» — юникод, пунктуация!!! цифры 123, эмодзи 🚀, длинное тире — всё это должно пережить токенизацию одинаково в обеих точностях модели.'
]

interface DriftSample {
  text: string
  query: number[]
  passage: number[]
}

interface DriftDump {
  dtype: string
  model: string
  dimensions: number
  cacheDir: string
  onnxFile: string
  samples: DriftSample[]
}

type Path = 'query' | 'passage'

const PATHS: Path[] = ['query', 'passage']

const MODE = process.env.DRIFT_MODE ?? 'embed'

const round7 = (v: Float32Array): number[] => Array.from(v, x => Math.round(x * 1e7) / 1e7)

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb))
}

interface Distribution {
  min: number
  median: number
  mean: number
  max: number
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return {
    min: sorted[0],
    median,
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    max: sorted[sorted.length - 1]
  }
}

const fmt = (n: number): string => n.toFixed(6)

async function readDump(envKey: string): Promise<DriftDump> {
  const path = process.env[envKey]
  if (!path) throw new Error(`${envKey} is required for DRIFT_MODE=compare`)
  return JSON.parse(await readFile(path, 'utf-8')) as DriftDump
}

test.skipIf(MODE !== 'embed')(
  'embed — real vectors for the configured dtype (one model resident)',
  async () => {
    const cacheDir = process.env.SYNAPTOMIND_EMBEDDER_CACHE_DIR
    const outPath = process.env.DRIFT_OUT
    if (!cacheDir || !outPath) {
      throw new Error('DRIFT_MODE=embed needs SYNAPTOMIND_EMBEDDER_CACHE_DIR and DRIFT_OUT')
    }

    const { dtype, model, dimensions } = config.embedder
    const onnxFile = dtype === 'q8' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx'
    console.log(`[drift] embed dtype=${dtype} model=${model} cacheDir=${cacheDir}`)

    await ensureModelFiles(cacheDir, model, dtype)

    const onnxPath = `${cacheDir}/${model}/${onnxFile}`
    expect(await Bun.file(onnxPath).exists()).toBe(true)

    if (dtype === 'q8') {
      expect(await Bun.file(`${cacheDir}/${model}/onnx/model.onnx`).exists()).toBe(false)
    }

    const { generateEmbedding, generateEmbeddings } = await import('./model')

    const samples: DriftSample[] = []
    for (const text of SAMPLES) {
      const query = await generateEmbedding(text)
      const [passage] = await generateEmbeddings([text])
      expect(query.length).toBe(dimensions)
      expect(passage.length).toBe(dimensions)
      samples.push({ text, query: round7(query), passage: round7(passage) })
      console.log(`[drift]   embedded (${samples.length}/${SAMPLES.length}): ${text.slice(0, 48)}`)
    }

    const dump: DriftDump = { dtype, model, dimensions, cacheDir, onnxFile, samples }
    await writeFile(outPath, JSON.stringify(dump))
    console.log(
      `[drift] wrote ${outPath} (${samples.length} samples, dtype=${dtype}, onnx=${onnxFile})`
    )
  },
  600_000
)

test.skipIf(MODE !== 'compare')(
  'compare — fp32 vs q8 cosine distance per path, against driftThreshold 0.25',
  async () => {
    const fp32 = await readDump('DRIFT_FP32')
    const q8 = await readDump('DRIFT_Q8')

    expect(fp32.dtype).toBe('fp32')
    expect(q8.dtype).toBe('q8')
    expect(fp32.samples.length).toBe(SAMPLES.length)
    expect(q8.samples.length).toBe(SAMPLES.length)

    const distances: Record<Path, number[]> = { query: [], passage: [] }

    for (let i = 0; i < SAMPLES.length; i++) {
      const a = fp32.samples[i]
      const b = q8.samples[i]
      expect(a.text).toBe(b.text)

      const perText: string[] = []
      for (const path of PATHS) {
        const d = cosineDistance(a[path], b[path])
        distances[path].push(d)
        perText.push(`${path}=${fmt(d)}`)
      }
      console.log(`[drift] ${String(i).padStart(2)} ${perText.join(' ')}  ${a.text.slice(0, 40)}`)
    }

    const dtypeDistanceBound = 0.25
    const vectorFloor = config.search.confidence.vectorFloor
    console.log(`[drift] fp32 onnx=${fp32.onnxFile} q8 onnx=${q8.onnxFile} dims=${fp32.dimensions}`)
    console.log(
      `[drift] provisional dtypeDistanceBound=${dtypeDistanceBound} vectorFloor=${vectorFloor}`
    )

    const dists: Record<Path, Distribution> = {
      query: distribution(distances.query),
      passage: distribution(distances.passage)
    }
    for (const path of PATHS) {
      const dist = dists[path]
      const over = distances[path].filter(d => d > dtypeDistanceBound).length
      const worstSimilarity = 1 - dist.max
      console.log(
        `[drift] ${path.padEnd(7)} distance: min=${fmt(dist.min)} median=${fmt(dist.median)} ` +
          `mean=${fmt(dist.mean)} max=${fmt(dist.max)} over${dtypeDistanceBound}=${over}/${SAMPLES.length} ` +
          `| worst self-similarity=${fmt(worstSimilarity)}`
      )
      expect(
        dist.min,
        `${path}: identical texts must not be identical vectors across dtypes`
      ).toBeGreaterThan(0)
      expect(worstSimilarity).toBeGreaterThan(vectorFloor)
    }

    const crossText: number[] = []
    for (let i = 0; i < fp32.samples.length; i++) {
      for (let j = i + 1; j < fp32.samples.length; j++) {
        crossText.push(cosineDistance(fp32.samples[i].passage, fp32.samples[j].passage))
      }
    }
    const cross = distribution(crossText)
    console.log(
      `[drift] reference (fp32 passage, ${crossText.length} different-text pairs): ` +
        `min=${fmt(cross.min)} median=${fmt(cross.median)} max=${fmt(cross.max)}`
    )

    const blocking = distances.passage.filter(d => d > dtypeDistanceBound).length
    const worst = Math.min(...PATHS.map(path => 1 - dists[path].max))
    console.log(
      `[drift] provisional calibration: ${blocking === 0 ? 'corpus re-embed NOT indicated' : 'corpus re-embed MAY be required'} — ` +
        `${blocking}/${SAMPLES.length} PASSAGE samples exceed test-only dtypeDistanceBound=${dtypeDistanceBound} ` +
        `(query max=${fmt(dists.query.max)}, passage max=${fmt(dists.passage.max)}); ` +
        `worst cross-dtype self-similarity=${fmt(worst)} vs vectorFloor=${vectorFloor}; ` +
        `quantization noise is ${((dists.passage.max / cross.median) * 100).toFixed(1)}% of the median distance ` +
        `between two different thoughts (${fmt(cross.median)})`
    )

    expect(blocking).toBe(0)
  },
  60_000
)

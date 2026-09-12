// Deterministic, dependency-free embedding used by the default harness mode.
//
// It is a signed feature-hashing ("hashing trick") bag-of-words vector over the
// 384-dimensional space the vec0 table uses. Texts that share tokens land close
// together, so retrieval quality is reproducible in CI without downloading a
// model or starting the embedder child process.
//
// It is intentionally lexical: it does not model semantics. Semantic coverage
// is provided by the optional `--real` mode, which uses the production embedder.

const DEFAULT_DIMENSIONS = 384

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Lowercased alphanumeric tokens longer than two characters. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2)
}

export function deterministicEmbedding(text: string, dimensions = DEFAULT_DIMENSIONS): Float32Array {
  const vector = new Float32Array(dimensions)
  const counts = new Map<string, number>()
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }

  for (const [token, count] of counts) {
    const index = fnv1a(token) % dimensions
    const sign = fnv1a(`sign:${token}`) % 2 === 0 ? 1 : -1
    vector[index] += sign * (1 + Math.log(count))
  }

  let norm = 0
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= norm
  }
  return vector
}

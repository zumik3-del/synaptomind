import { EmbedderSupervisor, type EmbedderClientDeps, DEFAULT_DEPS } from './embedder-supervisor'

export { EMBEDDER_START_TIMEOUT_MS, sleepUnref } from './embedder-supervisor'
export type { EmbedderClientDeps, EmbedderState } from './embedder-supervisor'

export const EMBEDDER_BATCH_CHUNK = 64

export class EmbedderClient extends EmbedderSupervisor {
  constructor(deps: EmbedderClientDeps = DEFAULT_DEPS) {
    super(deps)
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return this.ipc.sendRequest(method, params)
  }

  async startEmbedderProcess(): Promise<void> {
    await this.ensureReady()
    console.error('[embedder] child process started')
  }

  async stopEmbedderProcess(): Promise<void> {
    await this.teardownProcess('Embedder shutting down')
  }

  async generateEmbedding(text: string): Promise<Float32Array> {
    await this.ensureReady()
    return this.sendRequest('embed', { text }) as Promise<Float32Array>
  }

  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    await this.ensureReady()
    const embeddings: Float32Array[] = []
    for (let i = 0; i < texts.length; i += EMBEDDER_BATCH_CHUNK) {
      const chunk = texts.slice(i, i + EMBEDDER_BATCH_CHUNK)
      const batch = (await this.sendRequest('embed_batch', { texts: chunk })) as Float32Array[]
      embeddings.push(...batch)
    }
    return embeddings
  }
}
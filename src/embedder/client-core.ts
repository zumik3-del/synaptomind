import { EmbedderClient, type EmbedderState } from './embedder-client'

export type { EmbedderState }

const defaultClient = new EmbedderClient()

export function isEmbedderReady(): boolean {
  return defaultClient.isEmbedderReady()
}

export function getEmbedderState(): EmbedderState {
  return defaultClient.getEmbedderState()
}

export async function startEmbedderProcess(): Promise<void> {
  return defaultClient.startEmbedderProcess()
}

export async function stopEmbedderProcess(): Promise<void> {
  return defaultClient.stopEmbedderProcess()
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  return defaultClient.generateEmbedding(text)
}

export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  return defaultClient.generateEmbeddings(texts)
}

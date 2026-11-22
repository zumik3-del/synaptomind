import { expect, test } from 'bun:test'
import { config } from '../config'
import { EmbedderUnavailableError } from '../errors'
import { searchThoughtsOutcome } from '../services/search.service'
import { createTestDb, seedThought } from '../test/helpers'
import { isEmbedderReady } from './client-core'
import { EmbedderClient } from './embedder-client'

// `config.embedder.enabled` is read from the frozen global at call time, so a case that needs it off
// loads its own config in a child process: the wrapper passes SYNAPTOMIND_EMBEDDER_ENABLED=false.
class NoSpawnClient extends EmbedderClient {
  spawns = 0

  protected override spawnProcess(): void {
    this.spawns++
    throw new Error('unexpected spawn')
  }
}

test('a config-disabled embedder refuses explicit and on-demand starts with BM25 fallback', async () => {
  createTestDb()
  expect(config.embedder.enabled).toBe(false)

  const client = new NoSpawnClient()
  for (const call of [
    () => client.startEmbedderProcess(),
    () => client.generateEmbedding('hello'),
    () => client.generateEmbeddings(['hello', 'world'])
  ]) {
    await expect(call()).rejects.toBeInstanceOf(EmbedderUnavailableError)
  }
  expect(client.spawns).toBe(0)
  expect(client.isEmbedderReady()).toBe(false)

  const id = seedThought({ content: 'quartzbadger unique searchable phrase' })
  const outcome = await searchThoughtsOutcome({ query: 'quartzbadger', hybrid: true })
  expect(outcome.items.map(item => item.thought.id)).toContain(id)
  expect(outcome.items[0]?.degraded).toBe(true)
  expect(isEmbedderReady()).toBe(false)
})

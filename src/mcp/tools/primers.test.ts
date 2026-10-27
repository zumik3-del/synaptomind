import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from '../../db/container'
import { closeDb } from '../../db/init'
import { promoteThoughtToPrimer } from '../../db/primers'
import { createTestDb, seedThought } from '../../test/helpers'

// Coverage for the telemetry cut (ADR 2026-10-21): the primer list/delete
// capability moved out of the removed `memory_telemetry` tool into the dedicated
// `memory_primers` tool. The delete follows the project-wide destructive-action
// convention (ADR 2026-09-28 p8-review-queue-apply §"a dedicated write tool is
// the honest surface"): without `confirm=true` it only previews, with
// `confirm=true` it deletes, and an unknown id is `not_found` (idempotent).

async function setupClient(): Promise<Client> {
  // The tool module is imported lazily so a missing tool fails the individual
  // test instead of the whole file.
  const { registerMemoryPrimers } = await import('./primers')
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerMemoryPrimers(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
}

function parseResult(result: unknown): { data: any; isError: boolean } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  const text = r.content?.[0]?.text ?? '{}'
  try {
    return { data: JSON.parse(text), isError: r.isError === true }
  } catch {
    return { data: text, isError: r.isError === true }
  }
}

/** Seed one primer over a fresh thought and return both ids. */
function seedPrimer(hitCount = 12): { thoughtId: string; primerId: string } {
  const thoughtId = seedThought({ content: 'primer candidate' })
  const primer = promoteThoughtToPrimer(getDb(), thoughtId, hitCount)
  if (!primer) throw new Error('primer was not created')
  return { thoughtId, primerId: primer.id }
}

/** Whether a primer row is still in the main db (raw SQL, no cut-only symbol). */
function primerExists(id: string): boolean {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM primers WHERE id = ?`).get(id) as { c: number }
  return row.c > 0
}

beforeEach(createTestDb)
afterEach(closeDb)

describe('memory_primers list', () => {
  test('list returns the primer set', async () => {
    const client = await setupClient()
    const { thoughtId } = seedPrimer()

    const result = await client.callTool({ name: 'memory_primers', arguments: { action: 'list' } })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items.map((p: { thought_id: string }) => p.thought_id)).toContain(thoughtId)
  })

  test('list returns an empty array when there is no primer', async () => {
    const client = await setupClient()

    const result = await client.callTool({ name: 'memory_primers', arguments: { action: 'list' } })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.items).toEqual([])
  })
})

describe('memory_primers delete', () => {
  test('delete without confirm only previews and keeps the primer', async () => {
    const client = await setupClient()
    const { thoughtId, primerId } = seedPrimer()

    const result = await client.callTool({
      name: 'memory_primers',
      arguments: { action: 'delete', primer_id: primerId }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.item.status).toBe('preview')
    expect(data.item.primer_id).toBe(primerId)
    expect(data.item.primer.thought_id).toBe(thoughtId)
    expect(data.item.instruction).toContain('confirm=true')
    // The refusal is the point: nothing was deleted.
    expect(primerExists(primerId)).toBe(true)
  })

  test('delete with confirm=false is still a preview', async () => {
    const client = await setupClient()
    const { primerId } = seedPrimer()

    const result = await client.callTool({
      name: 'memory_primers',
      arguments: { action: 'delete', primer_id: primerId, confirm: false }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.item.status).toBe('preview')
    expect(primerExists(primerId)).toBe(true)
  })

  test('delete with confirm=true deletes the primer', async () => {
    const client = await setupClient()
    const { primerId } = seedPrimer()

    const preview = await client.callTool({
      name: 'memory_primers',
      arguments: { action: 'delete', primer_id: primerId }
    })
    const token = (JSON.parse((preview as any).content[0].text)).item.preview_token
    const result = await client.callTool({
      name: 'memory_primers',
      arguments: { action: 'delete', primer_id: primerId, confirm: true, preview_token: token }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.item.status).toBe('deleted')
    expect(data.item.primer_id).toBe(primerId)
    expect(primerExists(primerId)).toBe(false)
  })

  test('delete of an unknown primer id reports not_found', async () => {
    const client = await setupClient()

    const result = await client.callTool({
      name: 'memory_primers',
      arguments: { action: 'delete', primer_id: 'no-such-primer', confirm: true }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.item.status).toBe('not_found')
    expect(data.item.primer_id).toBe('no-such-primer')
  })

  test('delete of an unknown primer id without confirm also reports not_found', async () => {
    const client = await setupClient()

    const result = await client.callTool({
      name: 'memory_primers',
      arguments: { action: 'delete', primer_id: 'no-such-primer' }
    })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(false)
    expect(data.item.status).toBe('not_found')
  })

  test('delete without primer_id is refused with an error envelope', async () => {
    const client = await setupClient()

    const result = await client.callTool({ name: 'memory_primers', arguments: { action: 'delete' } })
    const { data, isError } = parseResult(result)

    expect(isError).toBe(true)
    expect(String(data)).toContain('primer_id')
  })
})

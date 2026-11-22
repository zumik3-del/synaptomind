import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { closeDb } from '../../db'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

const SNAPSHOT = JSON.parse(
  readFileSync(resolve(import.meta.dir, '__fixtures__', 'tools-list.snapshot.json'), 'utf-8')
) as unknown

interface AdvertisedTool {
  name: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  cwdContract?: string[]
}

let client: Client

beforeAll(async () => {
  const server = new McpServer({ name: 'tools-list-contract', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'tools-list-contract-client', version: '0.0.0' })
  await client.connect(clientTransport)
})
beforeEach(() => {
  createTestDb()
})
afterEach(() => {
  closeDb()
})

// The pinned shape drops prose and sorts every object's keys, so a reworded
// description or a reordered property does not read as a schema change.
function pinnedShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pinnedShape)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (key === 'description') continue
    out[key] = pinnedShape(source[key])
  }
  return out
}

// The cwd prose is pinned sentence by sentence: only the clauses that state the
// contract (ignored / optional / required for resolve) survive, whitespace normalised.
const CWD_CONTRACT_MARKERS = ['ACCEPTED AND IGNORED', 'OPTIONAL', 'REQUIRED for']

function cwdDescription(tool: AdvertisedTool): string {
  const cwd = (tool.inputSchema as { properties?: Record<string, { description?: unknown }> })
    ?.properties?.cwd
  return typeof cwd?.description === 'string' ? cwd.description : ''
}

function extractCwdContract(tool: AdvertisedTool): string[] {
  return cwdDescription(tool)
    .split(/(?<=\.)\s+/)
    .map(sentence => sentence.replace(/\s+/g, ' ').trim())
    .filter(sentence => CWD_CONTRACT_MARKERS.some(marker => sentence.includes(marker)))
}

function advertisedShape(tools: AdvertisedTool[]): unknown {
  return tools
    .map(tool => {
      // A recorded tool carries its pinned contract; a live one is extracted from the prose.
      const cwdContract = tool.cwdContract ?? extractCwdContract(tool)
      return {
        name: tool.name,
        ...(cwdContract.length > 0 ? { cwdContract } : {}),
        inputSchema: pinnedShape(tool.inputSchema),
        outputSchema: pinnedShape(tool.outputSchema)
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function snapshotDrift(actual: unknown, recorded: unknown): string | null {
  const live = JSON.stringify(advertisedShape(actual as AdvertisedTool[]), null, 2).split('\n')
  const pinned = JSON.stringify(advertisedShape(recorded as AdvertisedTool[]), null, 2).split('\n')
  let line = 0
  while (line < live.length && line < pinned.length && live[line] === pinned[line]) line++
  if (line === live.length && line === pinned.length) return null
  return [
    `tools/list drifted from the recorded contract at line ${line + 1}:`,
    `  recorded: ${pinned[line] ?? '<end of snapshot>'}`,
    `  live:     ${live[line] ?? '<end of answer>'}`,
    'A deliberate schema change updates src/mcp/tools/__fixtures__/tools-list.snapshot.json in the same commit.'
  ].join('\n')
}

async function advertisedTools(): Promise<AdvertisedTool[]> {
  const { tools } = await client.listTools()
  return tools as AdvertisedTool[]
}

describe('tools/list advertises the recorded contract', () => {
  test('every registered tool answers the schema in the snapshot', async () => {
    const drift = snapshotDrift(await advertisedTools(), SNAPSHOT)
    if (drift !== null) throw new Error(drift)
  })

  test('the snapshot names every registered tool and nothing else', async () => {
    const recorded = (SNAPSHOT as AdvertisedTool[]).map(tool => tool.name).sort()
    const live = (await advertisedTools()).map(tool => tool.name).sort()
    expect(live).toEqual(recorded)
  })

  test('every advertised argument and tool keeps a description', async () => {
    for (const tool of await advertisedTools()) {
      expect({ tool: tool.name, described: (tool.description ?? '').trim().length > 0 }).toEqual({
        tool: tool.name,
        described: true
      })
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties
      for (const [argument, schema] of Object.entries(properties ?? {})) {
        const description = (schema as { description?: unknown }).description
        expect({
          tool: tool.name,
          argument,
          described: typeof description === 'string' && description.trim().length > 0
        }).toEqual({ tool: tool.name, argument, described: true })
      }
    }
  })

  test('the snapshot check has teeth: a dropped or retyped argument is caught', () => {
    const doctored = structuredClone(SNAPSHOT) as Array<{
      name: string
      inputSchema?: { properties?: Record<string, { type?: string }> }
    }>
    const recall = doctored.find(tool => tool.name === 'memory_recall')
    if (!recall?.inputSchema?.properties) throw new Error('snapshot has no memory_recall schema')
    recall.inputSchema.properties.query.type = 'string'
    recall.inputSchema.properties.limit.type = 'string'
    delete recall.inputSchema.properties.cwd
    expect(snapshotDrift(doctored, SNAPSHOT)).not.toBeNull()
  })

  test('the normalisation ignores key order, so a reordered schema is not drift', () => {
    const reordered = (
      structuredClone(SNAPSHOT) as Array<{ name: string; inputSchema?: unknown }>
    ).map(tool => {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined
      if (!schema?.properties) return tool
      const reversed: Record<string, unknown> = {}
      for (const key of Object.keys(schema.properties).reverse()) {
        reversed[key] = schema.properties[key]
      }
      return { ...tool, inputSchema: { ...schema, properties: reversed } }
    })
    expect(snapshotDrift(reordered, SNAPSHOT)).toBeNull()
  })

  test('the cwd contract check has teeth: a reverted description is drift', () => {
    const doctored = structuredClone(SNAPSHOT) as Array<{
      name: string
      cwdContract?: string[]
      inputSchema?: { properties?: Record<string, { description?: string }> }
    }>
    const recall = doctored.find(tool => tool.name === 'memory_recall')
    if (!recall?.inputSchema?.properties?.cwd)
      throw new Error('snapshot has no recall cwd argument')
    recall.inputSchema.properties.cwd.description =
      'Working directory — resolves the project scope. OPTIONAL for search/clusters/list/context. IGNORED for get/chain.'
    delete recall.cwdContract
    expect(snapshotDrift(doctored, SNAPSHOT)).not.toBeNull()
  })

  test('every tool that states a cwd contract in the snapshot states one live', async () => {
    const live = (await advertisedTools())
      .map(tool => ({ name: tool.name, cwdContract: extractCwdContract(tool) }))
      .filter(entry => entry.cwdContract.length > 0)
      .map(entry => entry.name)
      .sort()
    const recorded = (SNAPSHOT as AdvertisedTool[])
      .filter(tool => (tool.cwdContract ?? []).length > 0)
      .map(tool => tool.name)
      .sort()
    expect(live).toEqual(recorded)
  })
})

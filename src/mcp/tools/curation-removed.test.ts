import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DEFAULTS, ENV_MAPPINGS, type Config } from '../../config'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

// Assembled on purpose: this guard scans `src/` for these stems, and the guard itself lives there.
const TOOL = 'edge' + '_' + 'review'
const PLAN = 'propose' + 'Placement' + 'Plan'
const DASHED = 'placement' + '-proposals'
const SNAKED = 'placement' + '_' + 'proposals'
const INDEX_PREFIX = 'idx' + '_pp_'
const APPLY = 'placement' + '-apply'
const NEEDLES = [TOOL, PLAN, DASHED, SNAKED, INDEX_PREFIX, APPLY]

const SECTION = 'placement'
const SRC_DIR = resolve(import.meta.dir, '..', '..')

// The migration chain keeps its history: v040 creates the table, v041 adds a column to it and v051
// drops it. Those files, plus the two pins that read the table by name to prove the drop, are the
// only places allowed to spell it.
const ALLOWED_FILES = new Set([
  'db/drop-' + DASHED + '-v051.test.ts',
  'db/init.migration-atomicity.test.ts'
])

const SURVIVING_TOOLS = [
  'memory_crystallize',
  'memory_guide',
  'memory_primers',
  'memory_projects',
  'memory_recall',
  'memory_reflect',
  'memory_retention',
  'memory_status',
  'memory_store',
  'memory_supersede'
]
const STATUS_ACTIONS = ['slots', 'frontier', 'config', 'health']

let client: Client

beforeAll(async () => {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
})
beforeEach(createTestDb)
afterEach(closeDb)

function toolText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text
}

async function advertisedStatusActions(): Promise<string[] | undefined> {
  const { tools } = await client.listTools()
  const status = tools.find(tool => tool.name === 'memory_status')
  return (status?.inputSchema as { properties?: Record<string, { enum?: string[] }> })?.properties
    ?.action?.enum
}

/** The `## Tools` table of the in-band guide, as tool name -> action cell. */
function guideToolRows(text: string): Map<string, string> {
  const start = text.indexOf('## Tools')
  const end = text.indexOf('\n## ', start + 1)
  const rows = new Map<string, string>()
  for (const line of text.slice(start, end < 0 ? undefined : end).split('\n')) {
    const match = /^\| ([a-z_]+) \| ([^|]+) \|$/.exec(line)
    if (match) rows.set(match[1] as string, match[2] as string)
  }
  return rows
}

describe('the removed review tool', () => {
  test('tools/list advertises exactly the ten surviving tools', async () => {
    const { tools } = await client.listTools()

    expect(tools.map(tool => tool.name).sort()).toEqual(SURVIVING_TOOLS)
    expect(tools.map(tool => tool.name)).not.toContain(TOOL)
  })

  test('calling it answers the SDK unknown-tool error', async () => {
    await expect(client.callTool({ name: TOOL, arguments: { action: 'list' } })).rejects.toThrow(
      new RegExp(TOOL)
    )
  })
})

describe('the removed status action', () => {
  test('memory_status advertises only the four surviving actions', async () => {
    expect(await advertisedStatusActions()).toEqual(STATUS_ACTIONS)
  })

  test('calling it is refused instead of answered', async () => {
    const result = (await client.callTool({
      name: 'memory_status',
      arguments: { action: 'propose' }
    })) as { isError?: boolean; content: Array<{ text: string }> }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Invalid option')
  })
})

describe('the removed config section', () => {
  test('DEFAULTS carries no such section', () => {
    expect(Object.keys(DEFAULTS as unknown as Record<string, unknown>)).not.toContain(SECTION)
  })

  test('no env mapping points into it', () => {
    const offending = ENV_MAPPINGS.map(mapping => mapping.path).filter(
      path => path === SECTION || path.startsWith(`${SECTION}.`)
    )

    expect(offending).toEqual([])
  })

  test('the config type declares no such member', () => {
    const source = readFileSync(join(SRC_DIR, 'config.ts'), 'utf8')
    const start = source.indexOf('interface Config {')
    if (start < 0) throw new Error('src/config.ts declares no `interface Config`')
    const end = source.indexOf('\n}', start)

    expect(new RegExp(`^\\s*${SECTION}\\??\\s*:`, 'm').test(source.slice(start, end))).toBe(false)
    type RemovedMember = Extract<typeof SECTION, keyof Config>
    const REMOVED_IS_NOT_A_MEMBER: RemovedMember extends never ? true : false = true
    expect(REMOVED_IS_NOT_A_MEMBER).toBe(true)
  })

  test('memory_status action=config does not advertise it', async () => {
    const text = toolText(
      await client.callTool({ name: 'memory_status', arguments: { action: 'config' } })
    )

    expect(text.toLowerCase()).not.toContain(SECTION)
    expect(text).toContain('edgeDetect.maxCandidates')
  })
})

describe('the in-band guide', () => {
  test('its tool table lists the surviving ten and no review tool', async () => {
    const text = toolText(await client.callTool({ name: 'memory_guide', arguments: {} }))
    const rows = guideToolRows(text)

    expect([...rows.keys()].sort()).toEqual(SURVIVING_TOOLS)
    expect(text).not.toContain(TOOL)
  })

  test('its memory_status row matches the advertised action enum', async () => {
    const text = toolText(await client.callTool({ name: 'memory_guide', arguments: {} }))
    const actions = guideToolRows(text)
      .get('memory_status')
      ?.split(',')
      .map(action => action.trim())

    expect(actions).toEqual(await advertisedStatusActions())
  })
})

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

describe('the sources carry no trace of the removed subsystem', () => {
  test('no file under src/ names it outside the migration chain and its two pins', () => {
    const hits: string[] = []
    for (const file of filesUnder(SRC_DIR)) {
      const path = relative(SRC_DIR, file)
      if (path.startsWith('db/migrations/') || ALLOWED_FILES.has(path)) continue
      const text = readFileSync(file, 'utf8')
      for (const needle of NEEDLES) {
        if (text.includes(needle)) hits.push(`${path} :: ${needle}`)
      }
    }

    expect(hits).toEqual([])
  }, 30_000)
})

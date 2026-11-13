import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { config, DEFAULTS, ENV_MAPPINGS } from '../config'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { registerAllMemoryTools } from '../mcp/tools'
import { createTestDb, seedThought } from '../test/helpers'
import { createApp } from './router'

const STEM = 'self'
const DASHED = `${STEM}-improve`
const CAMEL = `${STEM}Improve`
const SNAKED = `${STEM}_improve`
const NEEDLES = [DASHED, CAMEL, SNAKED]

const LOOSE = new RegExp(`\\b${STEM}[\\s_-]*improve\\b`, 'i')

const CFG_KEY = CAMEL
const SECTION_HEADING = `${STEM[0].toUpperCase()}${STEM.slice(1)} Improve`
const REMOVED_ENV_VARS = ['ENABLED', 'INTERVAL_MS', 'HITS_THRESHOLD', 'MAX_PRIMER_PROMOTES'].map(
  suffix => `SYNAPTOMIND_${STEM.toUpperCase()}_IMPROVE_${suffix}`
)

const SRC_DIR = resolve(import.meta.dir, '..')

mock.module('../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384),
  generateEmbeddings: () => [new Float32Array(384)],
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer test-token')
  return app.request(path, { ...init, headers })
}

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
}

function toolText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text
}

beforeEach(createTestDb)
afterEach(closeDb)

describe('the removed HTTP routes', () => {
  test(`POST /api/thoughts/${DASHED}/run answers 404`, async () => {
    const res = await request(`/api/thoughts/${DASHED}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: true })
    })
    expect(res.status).toBe(404)
  })

  test(`GET /api/thoughts/${DASHED}/status answers 404`, async () => {
    const res = await request(`/api/thoughts/${DASHED}/status`)
    expect(res.status).toBe(404)
  })
})

function configInterfaceSource(): string {
  const source = readFileSync(resolve(SRC_DIR, 'config.ts'), 'utf8')
  const start = source.indexOf('interface Config {')
  if (start < 0) throw new Error('src/config.ts declares no `interface Config`')
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error('the `Config` interface of src/config.ts is not closed')
  return source.slice(start, end)
}

type RemovedMember = Extract<typeof CFG_KEY, keyof typeof config>
const REMOVED_IS_NOT_A_MEMBER: RemovedMember extends never ? true : false = true

function flattenConfig(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenConfig(value as Record<string, unknown>, path))
    } else {
      out[path] = value
    }
  }
  return out
}

function leafValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

function differingLeaves(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const flatA = flattenConfig(a)
  const flatB = flattenConfig(b)
  const paths = new Set([...Object.keys(flatA), ...Object.keys(flatB)])
  return [...paths].filter(path => leafValue(flatA[path]) !== leafValue(flatB[path])).sort()
}

let configProbe = 0
async function freshConfig(): Promise<Record<string, unknown>> {
  configProbe += 1
  const fresh = (await import(`../config.ts?env-probe=${Date.now()}-${configProbe}`)) as {
    config: Record<string, unknown>
  }
  return fresh.config
}

describe('the removed config section', () => {
  test('the config type declares no such member', () => {
    const declared = new RegExp(`^\\s*${CFG_KEY}\\??\\s*:`, 'm')
    expect(declared.test(configInterfaceSource())).toBe(false)
    expect(REMOVED_IS_NOT_A_MEMBER).toBe(true)
  })

  test('the defaults carry no such section', () => {
    expect(Object.keys(DEFAULTS as unknown as Record<string, unknown>)).not.toContain(CFG_KEY)
  })

  test('no env mapping points into the removed section', () => {
    const offending = ENV_MAPPINGS.map(m => m.path).filter(
      p => p === CFG_KEY || p.startsWith(`${CFG_KEY}.`)
    )
    expect(offending).toEqual([])
  })

  test('the four removed env variables are inert', async () => {
    const CONTROL_VAR = 'SYNAPTOMIND_CONTENT_LANGUAGE'
    const CONTROL_VALUES = ['guard-control-a', 'guard-control-b']
    const CANDIDATES = ['1', 'true', '999999', 'x']
    const saved = [...REMOVED_ENV_VARS, CONTROL_VAR].map(name => [name, process.env[name]] as const)
    try {
      for (const candidate of CANDIDATES) {
        for (const name of REMOVED_ENV_VARS) delete process.env[name]
        process.env[CONTROL_VAR] = CONTROL_VALUES[0]
        const without = await freshConfig()

        for (const name of REMOVED_ENV_VARS) process.env[name] = candidate
        process.env[CONTROL_VAR] = CONTROL_VALUES[1]
        const withRemoved = await freshConfig()

        const differing = differingLeaves(without, withRemoved)
        expect({ candidate, differing }).toEqual({ candidate, differing: ['contentLanguage'] })
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test('memory_status action=config does not advertise the removed section', async () => {
    const client = await setupClient()
    const text = toolText(
      await client.callTool({ name: 'memory_status', arguments: { action: 'config' } })
    )

    expect(text).not.toContain(SECTION_HEADING)
    expect(text.toLowerCase()).not.toContain(CFG_KEY.toLowerCase())
    expect(text).toContain('primer.promoteThreshold')
  })
})

describe('the in-band guide', () => {
  test('the guide mentions none of the removed names', async () => {
    const client = await setupClient()
    const text = toolText(await client.callTool({ name: 'memory_guide', arguments: {} }))

    expect(text.toLowerCase()).not.toContain(DASHED.toLowerCase())
    expect(text).not.toContain(CAMEL)
    expect(text).not.toContain(SNAKED)
    expect(text).toContain('primer.promoteThreshold')
  })
})

describe('the surviving promotion on the search path', () => {
  const MARKER = 'SURVIVORPRIMERMARKER'
  const THRESHOLD = 3
  const UNSCOPED_CWD = '/tmp/guard-unscoped'
  let originalThreshold = 0
  let client: Client

  beforeAll(async () => {
    client = await setupClient()
  })

  beforeEach(() => {
    originalThreshold = config.primer.promoteThreshold
    config.primer.promoteThreshold = THRESHOLD
  })

  afterEach(() => {
    config.primer.promoteThreshold = originalThreshold
  })

  async function search(): Promise<Array<{ thought: { id: string } }>> {
    const text = toolText(
      await client.callTool({
        name: 'memory_recall',
        arguments: { action: 'search', query: MARKER, cwd: UNSCOPED_CWD, compact: false }
      })
    )
    return (JSON.parse(text) as { items: Array<{ thought: { id: string } }> }).items
  }

  function primerRow(thoughtId: string): { hit_count: number } | null {
    return getDb().prepare('SELECT hit_count FROM primers WHERE thought_id = ?').get(thoughtId) as {
      hit_count: number
    } | null
  }

  test('a thought below the threshold is not promoted', async () => {
    const id = seedThought({ content: `${MARKER} below the threshold` })

    await search()
    await search()

    expect(primerRow(id)).toBeNull()
  })

  test('a thought that reaches the threshold is promoted to a primer', async () => {
    const id = seedThought({ content: `${MARKER} reaching the threshold` })

    await search()
    await search()
    const items = await search()

    expect(items.map(r => r.thought.id)).toContain(id)
    expect(primerRow(id)?.hit_count).toBe(THRESHOLD)
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
  let sources: Array<{ path: string; text: string }> | null = null
  function sourceFiles(): Array<{ path: string; text: string }> {
    sources ??= filesUnder(SRC_DIR).map(file => ({
      path: relative(SRC_DIR, file),
      text: readFileSync(file, 'utf8')
    }))
    return sources
  }

  test('no file under src/ mentions it — this guard file included', () => {
    const hits: string[] = []
    for (const { path, text } of sourceFiles()) {
      const lower = text.toLowerCase()
      for (const needle of NEEDLES) {
        if (lower.includes(needle.toLowerCase())) hits.push(`${path} :: ${needle}`)
      }
    }
    expect(hits).toEqual([])
  }, 30_000)

  test('no file under src/ mentions it under a looser spelling either', () => {
    const hits = sourceFiles()
      .filter(({ text }) => LOOSE.test(text))
      .map(({ path }) => path)
    expect(hits).toEqual([])
  })
})

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { config, DEFAULTS, ENV_MAPPINGS } from '../config'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { registerAllMemoryTools } from '../mcp/tools'
import { createTestDb, seedThought } from '../test/helpers'
import { createApp } from './router'

// Guard test for the removal of the whole subsystem (ADR 2026-10-21,
// Q1-Q7): the two HTTP routes, the background job, the detection module and
// the entire config section are gone. Nothing may reintroduce them.
//
// The subsystem is NOT named here, exactly as in the two sibling guard files:
// a name is the one thing a grep over src/ would find, whatever separator it
// is spelled with — a dash, an underscore, a space or none at all.
//
// The capability that must survive is pinned here too: the promotion of
// frequently-hit thoughts to primers happens on the search path, and the
// removal must not have taken it with it.
//
// The needles below are assembled from parts ON PURPOSE: this guard file must
// not contain the very strings it forbids, so that a repo-wide grep over src/
// returns nothing at all — not even this file. The two tests at the end of
// this file enforce it: one for the spellings the project greps for, one for
// any separator at all.

const STEM = 'self'
const DASHED = `${STEM}-improve`
const CAMEL = `${STEM}Improve`
const SNAKED = `${STEM}_improve`
const NEEDLES = [DASHED, CAMEL, SNAKED]

/**
 * The loose needle: the stem and the word with ANY separator between them —
 * none, a dash, an underscore or a space. The three needles above are the
 * spellings the project greps for; this one also catches the spaced spelling,
 * so the tree stays clean under any reasonable grep. It is written with the
 * stem as a part, so this file does not match its own check.
 */
const LOOSE = new RegExp(`\\b${STEM}[\\s_-]*improve\\b`, 'i')

/** The removed config section key (camel-cased, so it is built, not written). */
const CFG_KEY = CAMEL
/** The removed section's heading in the rendered config view. */
const SECTION_HEADING = `${STEM[0].toUpperCase()}${STEM.slice(1)} Improve`
/** The four env variables the removed section used to answer to. */
const REMOVED_ENV_VARS = ['ENABLED', 'INTERVAL_MS', 'HITS_THRESHOLD', 'MAX_PRIMER_PROMOTES'].map(
  suffix => `SYNAPTOMIND_${STEM.toUpperCase()}_IMPROVE_${suffix}`
)

const SRC_DIR = resolve(import.meta.dir, '..')

// The search path needs an embedder; the mock keeps the suite offline. Same
// shape as the other HTTP search suites in this directory.
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

/** The text of an MCP tool answer. */
function toolText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text
}

beforeEach(createTestDb)
afterEach(closeDb)

// ── the HTTP surface is gone ────────────────────────────────────────────────

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

// ── the config surface is gone ──────────────────────────────────────────────

/**
 * The `Config` interface of src/config.ts, as source text.
 *
 * The TYPE is the contract: the removed section must be gone from it, so no
 * code can read `config.<removed>` any more. The RUNTIME object is a different
 * matter — `deepMerge` copies the operator's file keys verbatim, so on an
 * instance whose config.json still carries the block the runtime object HAS
 * the key (inert, read by nobody). An assertion about the runtime object
 * would therefore only be true on an unconfigured machine; these assertions
 * are about what the code guarantees everywhere.
 */
function configInterfaceSource(): string {
  const source = readFileSync(resolve(SRC_DIR, 'config.ts'), 'utf8')
  const start = source.indexOf('interface Config {')
  if (start < 0) throw new Error('src/config.ts declares no `interface Config`')
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error('the `Config` interface of src/config.ts is not closed')
  return source.slice(start, end)
}

/**
 * The type-level half of the same guarantee: the removed key is not a member
 * of the config type. `Extract` collapses to `never` while the member is
 * absent, so the constant below fails to COMPILE the moment the member comes
 * back — `bun run tsc --noEmit` is the gate for that half, and it holds in
 * every environment.
 */
type RemovedMember = Extract<typeof CFG_KEY, keyof typeof config>
const REMOVED_IS_NOT_A_MEMBER: RemovedMember extends never ? true : false = true

/** A config object flattened into 'a.b.c' → value entries. */
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

/** A comparable form of a leaf value (arrays included). */
function leafValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

/** The leaf paths whose values differ between two configs. */
function differingLeaves(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const flatA = flattenConfig(a)
  const flatB = flattenConfig(b)
  const paths = new Set([...Object.keys(flatA), ...Object.keys(flatB)])
  return [...paths]
    .filter(path => leafValue(flatA[path]) !== leafValue(flatB[path]))
    .sort()
}

/** A fresh instance of the config module, built from the current environment. */
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
    // The runtime half: the declaration is read out of the source, so the
    // guarantee is checked in every environment — with or without a
    // config.json, with or without the block in the operator's file.
    const declared = new RegExp(`^\\s*${CFG_KEY}\\??\\s*:`, 'm')
    expect(declared.test(configInterfaceSource())).toBe(false)
    // The compile-time half (see RemovedMember above): the removed key is no
    // member of the config type, so no code can read it.
    expect(REMOVED_IS_NOT_A_MEMBER).toBe(true)
  })

  test('the defaults carry no such section', () => {
    expect(Object.keys(DEFAULTS as unknown as Record<string, unknown>)).not.toContain(CFG_KEY)
  })

  test('no env mapping points into the removed section', () => {
    const offending = ENV_MAPPINGS.map(m => m.path).filter(p => p === CFG_KEY || p.startsWith(`${CFG_KEY}.`))
    expect(offending).toEqual([])
  })

  test('the four removed env variables are inert', async () => {
    // A control variable that still has a mapping: it proves every fresh
    // instance really re-read the environment instead of handing back a
    // cached one. It is a TOP-LEVEL knob, so any other change the removed
    // variables might cause shows up as a leaf of its own.
    const CONTROL_VAR = 'SYNAPTOMIND_CONTENT_LANGUAGE'
    const CONTROL_VALUES = ['guard-control-a', 'guard-control-b']
    // Every plausible shape of a re-introduced mapping: a boolean, an integer
    // and a string. The removed variables must change nothing for any of
    // them.
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

        // The control knob is the ONLY difference between the two configs:
        // the removed variables changed nothing, whatever the operator's
        // config.json carries.
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
    const text = toolText(await client.callTool({ name: 'memory_status', arguments: { action: 'config' } }))

    expect(text).not.toContain(SECTION_HEADING)
    expect(text.toLowerCase()).not.toContain(CFG_KEY.toLowerCase())
    // The surviving knob is still advertised — the section moved, it did not die.
    expect(text).toContain('primer.promoteThreshold')
  })
})

// ── the in-band guide no longer advertises the removed job ──────────────────

describe('the in-band guide', () => {
  test('the guide mentions none of the removed names', async () => {
    const client = await setupClient()
    const text = toolText(await client.callTool({ name: 'memory_guide', arguments: {} }))

    expect(text.toLowerCase()).not.toContain(DASHED.toLowerCase())
    expect(text).not.toContain(CAMEL)
    expect(text).not.toContain(SNAKED)
    // The guide still tells the agent where primers come from.
    expect(text).toContain('primer.promoteThreshold')
  })
})

// ── the surviving capability: promotion on the search path ──────────────────
//
// The promotion used to be pinned over `GET /api/thoughts/search`. That route
// died in the 0.20 HTTP shrink, so the guard now drives the surviving search
// path — `memory_recall action=search`, which is where
// `postProcessSearchResults` counts hits and promotes.

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
    return getDb()
      .prepare('SELECT hit_count FROM primers WHERE thought_id = ?')
      .get(thoughtId) as { hit_count: number } | null
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

    // The thought really was found by the search path — otherwise the promotion
    // below would prove nothing.
    expect(items.map(r => r.thought.id)).toContain(id)
    // The promotion happened on the hit that crossed the threshold.
    expect(primerRow(id)?.hit_count).toBe(THRESHOLD)
  })
})

// ── the removal is complete in the sources ──────────────────────────────────

/** Every file under a directory, recursively. */
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
  // Both cases below walk the same tree. Reading every file under src/ costs
  // ~2 s on a cold/slow filesystem (it was ~4.4 s per suite run when each case
  // read the tree itself), so the text is loaded once per process and reused.
  // The first read is also I/O-bound, so a parallel run on a slow mount can take
  // several seconds: the per-case budget is raised instead of racing bun's 5 s.
  let sources: Array<{ path: string; text: string }> | null = null
  function sourceFiles(): Array<{ path: string; text: string }> {
    sources ??= filesUnder(SRC_DIR).map(file => ({
      path: relative(SRC_DIR, file),
      text: readFileSync(file, 'utf8')
    }))
    return sources
  }

  test(
    'no file under src/ mentions it — this guard file included',
    () => {
      const hits: string[] = []
      for (const { path, text } of sourceFiles()) {
        const lower = text.toLowerCase()
        for (const needle of NEEDLES) {
          if (lower.includes(needle.toLowerCase())) hits.push(`${path} :: ${needle}`)
        }
      }
      expect(hits).toEqual([])
    },
    30_000
  )

  test('no file under src/ mentions it under a looser spelling either', () => {
    // The needles above are the three spellings the project greps for. A
    // looser grep — a word boundary, a space, no separator at all — must find
    // nothing either, so the tree stays clean under any reasonable grep.
    const hits = sourceFiles()
      .filter(({ text }) => LOOSE.test(text))
      .map(({ path }) => path)
    expect(hits).toEqual([])
  })
})

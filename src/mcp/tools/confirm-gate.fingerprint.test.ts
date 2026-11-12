/**
 * Per-input fingerprint matrix for the converted destructive actions (task
 * #2492).
 *
 * The sibling contract suite proves that a preview token is refused when *the*
 * state drifts; it cannot see which state, so dropping one of the inputs an
 * action folds into its fingerprint kept every case green (the drift dimension
 * task #2467 found). Here each declared input is moved on its own and the token
 * minted before that change must be refused, which is what a dropped input
 * stops doing.
 *
 * The input set is never listed here: it is parsed out of each action's own
 * `fingerprintOf(...)` declaration (`src/test/confirm-gate-declaration.ts`),
 * and the probes only have to identify one declared part each. Adding a part to
 * a fingerprint therefore fails the coverage test until it gets a probe, and
 * dropping one fails until its probe goes with it — a change to what an action
 * guards always moves a test file, never just the code.
 *
 * The embedder is mocked (same recipe as the sibling contract suites) because
 * `auto_cluster` embeds its candidate pool; the vectors are content-keyed so a
 * probe can add a candidate that joins no cluster without touching the planned
 * groups.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { getDb } from '../../context/container'
import { closeDb } from '../../db/init'
import { GATE_CASES } from '../../test/confirm-gate-cases'
import { bindProbeKeys, fingerprintDeclaration } from '../../test/confirm-gate-declaration'
import { FINGERPRINT_CASES } from '../../test/confirm-gate-fingerprints'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

/** A candidate whose content carries this marker is embedded onto a second axis. */
const FAR_MARKER = 'gate cluster far'

function embeddingFor(text: string): Float32Array {
  const vector = new Float32Array(384)
  vector[text.includes(FAR_MARKER) ? 1 : 0] = 1
  return vector
}

mock.module('../../embedder/client', () => ({
  generateEmbedding: (text: string) => embeddingFor(text),
  generateEmbeddings: (texts: string[]) => texts.map(text => embeddingFor(text)),
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'confirm-gate-fingerprint-test', version: '1.0.0' })
  registerAllMemoryTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const result = new Client({ name: 'test-client', version: '1.0.0' })
  await result.connect(clientTransport)
  return result
}

async function call(tool: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: tool, arguments: args })
  const response = result as { content: Array<{ text: string }>; isError?: boolean }
  const text = response.content?.[0]?.text ?? '{}'
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {
    /* keep text */
  }
  return { data: data as any, isError: response.isError === true, text }
}

/** The token a preview issued, from the envelope mirror or the item itself. */
function previewToken(data: any): string {
  const token = data?.meta?.preview?.token ?? data?.item?.preview_token
  expect(typeof token).toBe('string')
  return token as string
}

/** The token row a preview left behind, for the declared-scope assertion. */
function tokenScope(token: string): { kind: string; target_id: string } | undefined {
  return getDb().prepare('SELECT kind, target_id FROM preview_tokens WHERE token = ?').get(token) as
    | { kind: string; target_id: string }
    | undefined
}

function gateCaseOf(label: string) {
  const gate = GATE_CASES.find(candidate => candidate.label === label)
  if (gate === undefined) throw new Error(`no contract fixture for '${label}'`)
  return gate
}

beforeEach(createTestDb)
afterEach(closeDb)
beforeAll(async () => {
  client = await setupClient()
})

describe('fingerprint declaration coverage', () => {
  test('the fingerprint matrix drives the same 12 actions as the contract matrix', () => {
    expect(FINGERPRINT_CASES.map(entry => entry.label).sort()).toEqual(
      GATE_CASES.map(entry => entry.label).sort()
    )
    expect(new Set(FINGERPRINT_CASES.map(entry => entry.kind)).size).toBe(12)
    expect(new Set(FINGERPRINT_CASES.map(entry => entry.label)).size).toBe(12)
  })

  test('every declared fingerprint input has exactly one probe, in both directions', () => {
    for (const entry of FINGERPRINT_CASES) {
      const declaration = fingerprintDeclaration(entry.module, entry.kind)
      // Throws when a declared part has no probe key, or a key binds none or two.
      const bindings = bindProbeKeys(declaration.parts, Object.keys(entry.probes))
      expect(bindings.map(binding => binding.part)).toEqual(declaration.parts)
      for (const probes of Object.values(entry.probes)) {
        expect(probes.length).toBeGreaterThan(0)
      }
    }
  })

  test('every action declares the token scope the tool actually mints', async () => {
    for (const entry of FINGERPRINT_CASES) {
      const declaration = fingerprintDeclaration(entry.module, entry.kind)
      const gate = gateCaseOf(entry.label)
      const preview = await call(gate.tool, gate.setup())
      expect(preview.isError).toBe(false)
      expect({ label: entry.label, kind: tokenScope(previewToken(preview.data))?.kind }).toEqual({
        label: entry.label,
        kind: declaration.kind
      })
    }
  })
})

describe('per-input fingerprint matrix over the converted actions', () => {
  for (const entry of FINGERPRINT_CASES) {
    const gate = gateCaseOf(entry.label)

    describe(`${entry.label} (${entry.kind})`, () => {
      for (const [key, probes] of Object.entries(entry.probes)) {
        for (const probe of probes) {
          test(`${key} · ${probe.change}`, async () => {
            const args = gate.setup()
            const preview = await call(gate.tool, args)
            expect(preview.isError).toBe(false)
            const token = previewToken(preview.data)

            const confirmArgs = probe.run(args)
            const refused = await call(gate.tool, {
              ...confirmArgs,
              confirm: true,
              preview_token: token
            })

            // The refusal IS the proof the mutation did not run: the gate throws
            // before `apply`, and a probe may legitimately move the guarded state
            // the fixtures assert on, so `assertUntouched` cannot be used here.
            expect(refused.isError).toBe(true)
            expect(refused.text).toContain(`preview token ${probe.refusal}`)
          })
        }
      }
    })
  }
})

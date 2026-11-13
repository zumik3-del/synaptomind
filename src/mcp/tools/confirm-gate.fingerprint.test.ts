/**
 * The plan itself must come from the real service: a process-global
 * `mock.module` stub of a shared service, left behind by an earlier file of the
 * same `bun test` process, freezes `candidates`/`groups`, so every probe's
 * confirm matches the fingerprint and the whole matrix goes vacuously green.
 * Under the serial oracle that is exactly what task #2496 found, and the
 * freshness case below fails with the stubbed plan named.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { getDb } from '../../context/container'
import { closeDb } from '../../db/init'
import { runAutoCluster } from '../../services/auto-cluster.service'
import { GATE_CASES } from '../../test/confirm-gate-cases'
import { bindProbeKeys, fingerprintDeclaration } from '../../test/confirm-gate-declaration'
import { FINGERPRINT_CASES } from '../../test/confirm-gate-fingerprints'
import { createTestDb } from '../../test/helpers'
import { registerAllMemoryTools } from '.'

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
  } catch {}
  return { data: data as any, isError: response.isError === true, text }
}

function previewToken(data: any): string {
  const token = data?.meta?.preview?.token ?? data?.item?.preview_token
  expect(typeof token).toBe('string')
  return token as string
}

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

describe('auto_cluster plan freshness', () => {
  test('the plan comes from the real planner, not a stub left by another file', async () => {
    gateCaseOf('memory_crystallize action=auto_cluster').setup()
    const planned = await runAutoCluster({
      dryRun: true,
      minAgeDays: 0,
      minSimilarity: 0.5,
      minMembers: 3
    })
    expect({ candidates: planned.candidates, groups: planned.groups.length }).toEqual({
      candidates: 3,
      groups: 1
    })
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

            expect(refused.isError).toBe(true)
            expect(refused.text).toContain(`preview token ${probe.refusal}`)
          })
        }
      }
    })
  }
})

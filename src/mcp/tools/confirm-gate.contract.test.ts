/**
 * End-to-end matrix for the one destructive-confirm protocol (audit F1,
 * task #2466).
 *
 * Every converted action is driven through its real MCP tool surface over an
 * in-memory client, one row per preview/confirm site: a preview mints a token
 * and mutates nothing, a confirm with that token mutates once, replaying it
 * cannot mutate twice, and a token minted before the guarded state drifted is
 * refused with the one typed gate error and mutates nothing. The fixtures live
 * in `src/test/confirm-gate-cases.ts`; nothing here imports the gate, so the
 * assertions stay on the wire.
 *
 * The embedder is mocked (same recipe as the sibling contract suites) because
 * `auto_cluster` embeds its candidate pool; without it the case would spawn the
 * real child process.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { closeDb } from '../../db/init'
import { createTestDb } from '../../test/helpers'
import { GATE_CASES, type GateCase } from '../../test/confirm-gate-cases'
import { registerAllMemoryTools } from '.'

mock.module('../../embedder/client', () => ({
  generateEmbedding: () => new Float32Array(384).fill(1),
  generateEmbeddings: (texts: string[]) => texts.map(() => new Float32Array(384).fill(1)),
  restartEmbedder: () => {},
  isEmbedderReady: () => true
}))

let client: Client

async function setupClient(): Promise<Client> {
  const server = new McpServer({ name: 'confirm-gate-contract-test', version: '1.0.0' })
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

beforeEach(createTestDb)
afterEach(closeDb)
beforeAll(async () => {
  client = await setupClient()
})

describe('confirm-gate matrix over the converted actions', () => {
  for (const gate of GATE_CASES) {
    describe(`${gate.kind} · ${gate.label}`, () => {
      test('preview mints a token, the confirm mutates once, replay is refused', async () => {
        const args = gate.setup()
        const preview = await call(gate.tool, args)

        expect(preview.isError).toBe(false)
        const token = previewToken(preview.data)
        // The envelope mirror is the client-facing gate (task #2181); the one
        // action that does not set it (memory_manage delete) exposes the token
        // on the item, which previewToken already read.
        if (preview.data.meta?.preview !== undefined) {
          expect(preview.data.meta.preview.destructive).toBe(true)
        }
        gate.assertUntouched()

        const confirmed = await call(gate.tool, { ...args, confirm: true, preview_token: token })
        expect(confirmed.isError).toBe(false)
        gate.assertMutated()

        // A confirm claims (deletes) its token, so the same token cannot win a
        // second mutation: either the gate refuses it as not_found, or the
        // action's own not-found answer stands because the target is gone
        // (unlink/primer/retention/manage-delete/retype).
        const replay = await call(gate.tool, { ...args, confirm: true, preview_token: token })
        if (gate.replay === 'token') {
          expect(replay.isError).toBe(true)
          expect(replay.text).toContain('preview token not_found')
        } else {
          expect(replay.text).not.toContain('preview token not_found')
        }
        gate.assertMutated()
      })

      test('a confirm without a token is refused as missing and mutates nothing', async () => {
        const args = gate.setup()
        const refused = await call(gate.tool, { ...args, confirm: true })

        expect(refused.isError).toBe(true)
        expect(refused.text).toContain('preview_token is required')
        gate.assertUntouched()
      })

      test('drifted state refuses the token as stale and mutates nothing', async () => {
        const args = gate.setup()
        const preview = await call(gate.tool, args)
        const token = previewToken(preview.data)

        const drifted = gate.drift(args)
        const refused = await call(gate.tool, { ...drifted, confirm: true, preview_token: token })

        expect(refused.isError).toBe(true)
        expect(refused.text).toContain('preview token stale')
        gate.assertUntouched()
      })
    })
  }
})

describe('matrix inventory', () => {
  test('covers all 12 converted sites and all four token scopes', () => {
    expect(GATE_CASES).toHaveLength(12)
    expect(GATE_CASES.map((c: GateCase) => c.label)).toEqual([
      'memory_store action=unlink',
      'memory_store action=retype',
      'edge_review action=rollback',
      'edge_review action=apply',
      'edge_review action=apply_batch',
      'memory_crystallize action=auto_cluster',
      'memory_manage action=delete',
      'memory_supersede action=archive',
      'memory_supersede action=archive_batch',
      'memory_supersede action=merge',
      'retention_review action=delete',
      'memory_primers action=delete'
    ])
    expect(new Set(GATE_CASES.map(c => c.kind))).toEqual(
      new Set(['edge', 'thought', 'batch', 'other'])
    )
  })
})

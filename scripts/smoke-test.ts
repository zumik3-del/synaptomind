import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const MARKER = `SMOKE_MARKER_${Date.now()}`

/**
 * The checkout root. Since the read-side envelope unification every
 * project-scoped read (`memory_recall action=search` included) requires `cwd`,
 * so the round-trip runs inside a real project scope: resolve-or-create the
 * project registered at this path first, then store and recall with the same
 * `cwd`.
 */
const CWD = process.cwd()

function text(result: unknown): { text: string; isError: boolean } {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  return { text: r.content?.[0]?.text ?? '', isError: r.isError === true }
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['run', 'src/index.ts', '--stdio'],
    stderr: 'pipe'
  })

  const client = new Client({ name: 'smoke-test', version: '0.0.0' })
  await client.connect(transport)

  let serverStderr = ''
  transport.stderr?.on('data', chunk => {
    serverStderr += String(chunk)
  })

  try {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    console.log(`[smoke] tools: ${names.join(', ')}`)

    // A fresh database has no project for this checkout, and `cwd` is required
    // by every project-scoped read — register it once (idempotent: resolve
    // first, create only when the path is unknown).
    const resolved = await client.callTool({
      name: 'memory_manage',
      arguments: { action: 'resolve', cwd: CWD }
    })
    if (text(resolved).isError) {
      const created = await client.callTool({
        name: 'memory_manage',
        arguments: { action: 'create', name: 'synaptomind-smoke', local_path: CWD }
      })
      if (text(created).isError) {
        console.error(`[smoke] project registration failed: ${text(created).text}`)
        process.exit(1)
      }
    }

    const store = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: MARKER, status: 'active', cwd: CWD }
    })
    // Single-object actions answer `{ item, meta }`.
    const stored = JSON.parse(text(store).text) as { item?: { id?: string }; id?: string }
    const storedId = stored.item?.id ?? stored.id
    console.log(`[smoke] created thought: ${storedId}`)

    const recall = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: MARKER, limit: 10, cwd: CWD }
    })
    // Collections answer `{ items, meta }`.
    const answer = JSON.parse(text(recall).text) as { items?: unknown[] } | unknown[]
    const results = Array.isArray(answer) ? answer : (answer.items ?? [])

    const found = results.some(r => {
      const hit = r as { thought?: { content?: string } } | string
      const content = hit && typeof hit === 'object' ? hit.thought?.content : hit
      return String(content ?? '').includes(MARKER)
    })

    if (!found) {
      console.error(`[smoke] recall results: ${JSON.stringify(results).slice(0, 1500)}`)
    }

    if (names.includes('memory_store') && names.includes('memory_recall') && storedId && found) {
      console.log(`[smoke] PASS — marker "${MARKER}" stored and found`)
      process.exit(0)
    }

    console.error('[smoke] FAIL — MCP round-trip did not complete')
    process.exit(1)
  } finally {
    await client.close()
    await transport.close()
    if (serverStderr && process.exitCode === 1) console.error(`[smoke] server stderr:\n${serverStderr}`)
  }
}

main().catch(err => {
  console.error(`[smoke] error: ${err?.stack ?? err}`)
  process.exit(1)
})
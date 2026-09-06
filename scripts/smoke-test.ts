import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const MARKER = `SMOKE_MARKER_${Date.now()}`

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

    const store = await client.callTool({
      name: 'memory_store',
      arguments: { action: 'create', content: MARKER, status: 'active' }
    })
    const stored = JSON.parse(text(store).text)
    console.log(`[smoke] created thought: ${stored.id}`)

    const recall = await client.callTool({
      name: 'memory_recall',
      arguments: { action: 'search', query: MARKER, top_k: 10 }
    })
    const results = JSON.parse(text(recall).text)

    const found = Array.isArray(results) && results.some(r => {
      const content = r?.thought?.content ?? (typeof r === 'string' ? r : JSON.stringify(r))
      return String(content).includes(MARKER)
    })

    if (!found) {
      console.error(`[smoke] recall results: ${JSON.stringify(results).slice(0, 1500)}`)
    }

    if (names.includes('memory_store') && names.includes('memory_recall') && stored.id && found) {
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
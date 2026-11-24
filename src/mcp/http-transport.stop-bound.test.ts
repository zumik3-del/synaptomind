import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import net from 'node:net'
import { clearRegistry } from '../db'
import { clearHealthProbeCache } from '../services/health.service'
import { createTestDb } from '../test/helpers'
import { MAX_REQUEST_BODY_BYTES, startMcpHttpServer } from './http-transport'

// Both cases drive `stop()` with a raw socket on purpose: `fetch` decides when to give up on an
// upload, so it cannot hold a half-sent chunked body in flight deterministically.
const SECRET = 'mcp-stop-bound-test-secret'
const CHUNK_BYTES = 64 * 1024
// 12.8 MB, well past the 5 MB cap: the rest of the body is still in flight when stop() starts.
const OVERSIZED_CHUNKS = 200
// The defect: Bun leaves a connection its own reader refused to the 10 s idle timeout, so `stop()`
// took ~11.9 s. Measured 1 ms once bounded; 1 s is far above that and far below the stall, so it
// fails on the unbounded shape without turning machine load into a flake.
const STOP_BOUND_MS = 1_000
const INIT_MESSAGE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'http-transport-stop-bound-test', version: '1.0.0' }
  }
}

let previousSecret: string | undefined
let previousServiceToken: string | undefined
let previousInsecure: string | undefined

interface RawResponse {
  statusLine: string
  head: string
  text: string
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve did not report a bound port')
  return port
}

function connect(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1')
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function collect(socket: net.Socket): { read: () => RawResponse; settled: () => boolean } {
  const chunks: Buffer[] = []
  let arrived = false
  socket.on('data', data => {
    arrived = true
    chunks.push(typeof data === 'string' ? Buffer.from(data) : data)
  })
  const text = () => Buffer.concat(chunks).toString('latin1')
  return {
    read: () => {
      const response = text()
      const split = response.indexOf('\r\n\r\n')
      return {
        statusLine: response.split('\r\n')[0] ?? '',
        head: split < 0 ? response : response.slice(0, split),
        text: split < 0 ? '' : response.slice(split + 4)
      }
    },
    settled: () => arrived
  }
}

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${ms} ms`)
    await Bun.sleep(5)
  }
}

function requestHead(extra = ''): string {
  return (
    'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
    `Authorization: Bearer ${SECRET}\r\n` +
    'Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    `${extra}\r\n`
  )
}

function frame(part: string): string {
  return `${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`
}

// The refused upload must still be arriving when the shutdown starts: a body that is merely
// unfinished but already buffered does not pin the pre-fix stop(), a body still in flight does.
async function uploadOversized(socket: net.Socket): Promise<void> {
  const chunk = frame('x'.repeat(CHUNK_BYTES))
  for (let sent = 1; sent <= OVERSIZED_CHUNKS; sent++) {
    if (!socket.write(chunk)) await Promise.race([once(socket, 'drain'), Bun.sleep(50)])
    if (sent % 20 === 0) await Bun.sleep(5)
  }
}

// A hung stop() must fail with its real duration rather than hang the suite, so the guard sits well
// above the 10 s idle timeout the defect ran into.
const STOP_GUARD_MS = 30_000

async function timedStop(stop: Promise<void>): Promise<{ settled: boolean; ms: number }> {
  const started = performance.now()
  const settled = await Promise.race([
    stop.then(() => true),
    Bun.sleep(STOP_GUARD_MS).then(() => false)
  ])
  return { settled, ms: Math.round(performance.now() - started) }
}
beforeAll(() => {
  previousSecret = process.env.SYNAPTOMIND_SECRET
  previousServiceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN
  previousInsecure = process.env.SYNAPTOMIND_ALLOW_INSECURE
  process.env.SYNAPTOMIND_SECRET = SECRET
  delete process.env.SYNAPTOMIND_SERVICE_TOKEN
  delete process.env.SYNAPTOMIND_ALLOW_INSECURE
  createTestDb()
  clearHealthProbeCache()
})

afterAll(() => {
  clearRegistry()
  clearHealthProbeCache()
  for (const [key, value] of [
    ['SYNAPTOMIND_SECRET', previousSecret],
    ['SYNAPTOMIND_SERVICE_TOKEN', previousServiceToken],
    ['SYNAPTOMIND_ALLOW_INSECURE', previousInsecure]
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('bounded stop()', () => {
  test(
    'a rejected chunked oversized POST no longer pins stop() beyond the bound',
    async () => {
      // If the cap ever moves past the upload, this case would stop exercising the refusal at all.
      expect(OVERSIZED_CHUNKS * CHUNK_BYTES).toBeGreaterThan(MAX_REQUEST_BODY_BYTES)

      const port = await freePort()
      const server = startMcpHttpServer('127.0.0.1', port)
      let socket: net.Socket | undefined
      let stopped = false
      let stop: Promise<void> | undefined
      try {
        socket = await connect(port)
        const response = collect(socket)
        socket.write(requestHead())

        // No terminating chunk: the refusal is answered while this side is still mid-upload, the
        // connection Bun would otherwise hold for the 10 s idle timeout.
        await uploadOversized(socket)

        await waitFor(
          () => response.read().text.includes('Request body too large'),
          5_000,
          'the 413 answer'
        )
        expect(response.read().statusLine).toContain('413')

        stop = server.stop()
        const result = await timedStop(stop)
        stopped = result.settled
        expect(result.settled).toBe(true)
        expect(result.ms).toBeLessThan(STOP_BOUND_MS)
      } finally {
        socket?.destroy()
        if (!stopped) await Promise.race([server.stop().catch(() => {}), Bun.sleep(5_000)])
        void stop?.catch(() => {})
      }
    },
    STOP_GUARD_MS
  )

  test('a valid in-flight request is drained, not cut, when stop() is requested mid-upload', async () => {
    const port = await freePort()
    const server = startMcpHttpServer('127.0.0.1', port)
    let socket: net.Socket | undefined
    let stopped = false
    try {
      socket = await connect(port)
      const response = collect(socket)
      socket.write(requestHead())

      // Trailing spaces keep the JSON valid while the body spans several chunks, so the request is
      // genuinely unfinished when the shutdown starts.
      const payload = JSON.stringify(INIT_MESSAGE) + ' '.repeat(8 * 1024 * 5)
      const parts: string[] = []
      for (let offset = 0; offset < payload.length; offset += 8 * 1024)
        parts.push(payload.slice(offset, offset + 8 * 1024))

      socket.write(frame(parts[0]))
      await Bun.sleep(80)

      const stopStarted = performance.now()
      const stop = server.stop()
      let stopMs = -1
      void stop.then(() => {
        stopMs = Math.round(performance.now() - stopStarted)
      })

      for (const part of parts.slice(1)) {
        socket.write(frame(part))
        await Bun.sleep(60)
      }
      socket.write('0\r\n\r\n')
      const uploadMs = Math.round(performance.now() - stopStarted)

      stopped = await Promise.race([stop.then(() => true), Bun.sleep(5_000).then(() => false)])
      await waitFor(
        () => response.read().text.includes('"serverInfo"'),
        2_000,
        'the initialize response'
      )

      const answer = response.read()
      expect(answer.statusLine).toContain('200')
      expect(answer.head).toMatch(/mcp-session-id:/i)
      expect(answer.text).toContain('"serverInfo"')
      expect(stopped).toBe(true)
      // It waited for the upload to finish instead of closing the connection under it.
      expect(stopMs).toBeGreaterThanOrEqual(uploadMs)
    } finally {
      socket?.destroy()
      if (!stopped) await Promise.race([server.stop().catch(() => {}), Bun.sleep(5_000)])
    }
  })
})

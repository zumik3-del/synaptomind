import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createIntervalJob } from './interval-job'

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

test('start runs the body once immediately, before the interval can elapse', async () => {
  let ticks = 0
  const job = createIntervalJob({ name: 'immediate', intervalMs: 60_000 }, () => {
    ticks++
  })

  job.start()
  try {
    expect(ticks).toBe(1)
  } finally {
    await job.stop()
  }
})

test('stop resolves only after the in-flight async run finishes', async () => {
  let release: () => void = () => {}
  let finished = false
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const job = createIntervalJob({ name: 'slow', intervalMs: 60_000 }, async () => {
    await gate
    finished = true
  })

  job.start()
  let stopResolved = false
  const stopped = job.stop().then(() => {
    stopResolved = true
  })
  await Bun.sleep(10)
  expect(stopResolved).toBe(false)
  expect(finished).toBe(false)

  release()
  await stopped
  expect(stopResolved).toBe(true)
  expect(finished).toBe(true)
})

test('the shipped jobs all schedule through this one runner', () => {
  const embedder = source('./embedder/embedder-process.ts')
  expect(embedder.match(/createIntervalJob\(/g)).toHaveLength(2)
  expect(embedder).toContain("name: 'embedder-poll'")
  expect(embedder).toContain("name: 'embedder-sweep'")

  const decay = source('./services/decay.service.ts')
  expect(decay.match(/createIntervalJob\(/g)).toHaveLength(1)
  expect(decay).toContain("name: 'decay'")

  const retention = source('./services/preview-token-retention.service.ts')
  expect(retention.match(/createIntervalJob\(/g)).toHaveLength(1)
  expect(retention).toContain("name: 'preview-token-retention'")
})

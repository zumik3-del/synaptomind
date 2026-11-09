import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

mock.module('../services/decay.service', () => ({
  startDecayJob: () => {},
  stopDecayJob: () => {
    throw new Error('injected shutdown failure')
  }
}))

const wiredFile = join(process.cwd(), 'shutdown-wired.json')
const originalOn = process.on.bind(process)
process.on = ((event: string, listener: (...args: never[]) => void) => {
  const result = originalOn(event as never, listener as never)
  if (event === 'exit') writeFileSync(wiredFile, 'installed')
  return result
}) as typeof process.on

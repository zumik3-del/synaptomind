import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const portFile = join(process.cwd(), 'api-ports.json')
const ports: number[] = []

const originalServe = Bun.serve as unknown as (options: object) => { port: number }
Bun.serve = ((options: object) => {
  const server = originalServe(options)
  ports.push(server.port)
  writeFileSync(portFile, JSON.stringify(ports))
  return server
}) as unknown as typeof Bun.serve

const originalOn = process.on.bind(process)
process.on = ((event: string, listener: (...args: never[]) => void) => {
  const result = originalOn(event as never, listener as never)
  if (event === 'unhandledRejection') {
    setTimeout(() => {
      Promise.reject(new Error('preload rejection'))
    }, 0)
  }
  return result
}) as typeof process.on

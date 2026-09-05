import { expect, test } from 'bun:test'
import { redirectConsoleOutputToStderr } from './stdio-console'

test('redirects regular console output to stderr', () => {
  const stderr: unknown[][] = []
  const output = {
    log: (..._args: unknown[]) => {},
    info: (..._args: unknown[]) => {},
    debug: (..._args: unknown[]) => {},
    error: (...args: unknown[]) => stderr.push(args)
  }

  redirectConsoleOutputToStderr(output)
  output.log('log', 1)
  output.info('info', 2)
  output.debug('debug', 3)

  expect(stderr).toEqual([
    ['log', 1],
    ['info', 2],
    ['debug', 3]
  ])
})

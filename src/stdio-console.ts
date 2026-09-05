interface ConsoleOutput {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** Keep MCP stdio stdout reserved for JSON-RPC messages. */
export function redirectConsoleOutputToStderr(target: ConsoleOutput = console): void {
  const writeToStderr = target.error.bind(target)
  target.log = writeToStderr
  target.info = writeToStderr
  target.debug = writeToStderr
}

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// In a `bun build --compile` binary `import.meta.dir` is `/$bunfs/root`, so any
// `import.meta.dir`-relative path silently points inside the embedded filesystem; `process.execPath`
// is the only reliable anchor for a file shipped next to the executable.
const VEC0_FILENAME = 'vec0.so'

export function isCompiled(): boolean {
  return import.meta.dir.startsWith('/$bunfs')
}

function appRootDir(): string {
  return dirname(process.execPath)
}

export function vec0Path(): string {
  const override = process.env.SYNAPTOMIND_VEC0_PATH
  if (override) return override

  const payloadPath = join(appRootDir(), VEC0_FILENAME)
  if (isCompiled()) return payloadPath
  return existsSync(payloadPath) ? payloadPath : join(import.meta.dir, '..', VEC0_FILENAME)
}

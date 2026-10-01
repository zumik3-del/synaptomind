import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * "Where am I running?" — the single resolver for runtime file/process
 * resolution (ADR 0001 §2.5).
 *
 * In a `bun build --compile` binary `import.meta.dir` is `/$bunfs/root`, so every
 * `import.meta.dir`-relative path silently points inside the embedded
 * filesystem. `process.execPath` is the executable itself in both modes, which
 * makes it the only reliable anchor for a file shipped next to it.
 */

/** Payload-root file name — the name `scripts/setup-vec0.sh` installs. */
const VEC0_FILENAME = 'vec0.so'

/**
 * Compiled-binary detection. The `/$bunfs` prefix is a Bun implementation detail
 * (measured on bun 1.4.2); it only *orders* candidates, it never fails, and
 * `SYNAPTOMIND_VEC0_PATH` is the escape hatch if a future Bun changes it.
 */
export function isCompiled(): boolean {
  return import.meta.dir.startsWith('/$bunfs')
}

/** Directory holding the running executable — the release payload root. */
export function appRootDir(): string {
  return dirname(process.execPath)
}

/**
 * Locate `vec0.so`, the SQLite loadable extension (ADR 0001 §2.3).
 *
 * Order: `SYNAPTOMIND_VEC0_PATH` → the payload root next to the executable →
 * the repository root (source mode, unchanged from the pre-ADR constant).
 *
 * Returns the expected path even when nothing exists, so the caller's error
 * names a path an operator can actually create.
 */
export function vec0Path(): string {
  const override = process.env.SYNAPTOMIND_VEC0_PATH
  if (override) return override

  const payloadPath = join(appRootDir(), VEC0_FILENAME)
  if (isCompiled()) return payloadPath
  // Source mode: the payload root is the bun runtime's directory, which holds no
  // vec0.so — so probe it and fall back to the repo root.
  return existsSync(payloadPath) ? payloadPath : join(import.meta.dir, '..', VEC0_FILENAME)
}

/**
 * Test preload — wired from `bunfig.toml` as `[test] preload`.
 *
 * A fresh git worktree has no `vec0.so` of its own (gitignored build artifact),
 * so every vector-backed suite there dies with "vec0 extension failed to load".
 * This sets `SYNAPTOMIND_VEC0_PATH` to the copy in the main checkout that owns
 * the worktree and prints one line naming the file actually used.
 *
 * The fallback fires only when the running checkout has no `vec0.so`; a local
 * copy always wins, and an explicit `SYNAPTOMIND_VEC0_PATH` is never
 * overwritten. See `src/test/vec0-fallback.ts` for the resolution order and the
 * reasoning behind the limit.
 */
import { resolve } from 'node:path'
import { resolveVec0 } from './vec0-fallback'

const repoRoot = resolve(import.meta.dir, '..', '..')

if (!process.env.SYNAPTOMIND_VEC0_PATH) {
  const resolution = resolveVec0({ repoRoot, cwd: process.cwd() })
  // 'repo-root' is what `vec0Path()` resolves anyway — nothing to override.
  if (resolution && resolution.source !== 'repo-root') {
    process.env.SYNAPTOMIND_VEC0_PATH = resolution.path
    const origin =
      resolution.source === 'main-checkout'
        ? 'from the main checkout'
        : 'from the working directory'
    process.stderr.write(
      `[test] vec0.so: no copy in ${repoRoot}; using ${resolution.path} (${origin})\n`,
    )
  }
}

/**
 * Where should a *test* run load `vec0.so` from?
 *
 * `vec0.so` is a build artifact: gitignored, installed by `bun install`
 * (`scripts/setup-vec0.sh`) into the checkout that ran it. A task worktree
 * (`git worktree add`, `.lane/trees/<task>`) therefore starts without one, and
 * every vector-backed suite fails with "vec0 extension failed to load" even
 * though the code under test is fine. This resolver points such a run at the
 * copy that already exists in the main checkout, so a fresh worktree runs the
 * suite unmodified.
 *
 * Limits, on purpose:
 * - It never fires when the running checkout has a `vec0.so` of its own — a
 *   local copy always wins, including a broken one, so a corrupt extension
 *   still fails loudly instead of being masked by the fallback.
 * - It is wired only through `bunfig.toml`'s `[test] preload` (see
 *   `src/test/preload.ts`), never into the server's own resolution
 *   (`src/runtime-mode.ts`), so production behaviour is untouched.
 * - An explicit `SYNAPTOMIND_VEC0_PATH` wins over everything; the preload does
 *   not overwrite it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Payload-root file name — the name `scripts/setup-vec0.sh` installs. */
export const VEC0_FILENAME = 'vec0.so'

/** Where a resolved extension file came from. */
type Vec0Source = 'cwd' | 'repo-root' | 'main-checkout'

export interface Vec0Resolution {
  path: string
  source: Vec0Source
}

/**
 * Root of the checkout that owns the worktree living at `repoRoot`, or `null`
 * when `repoRoot` is not a linked worktree.
 *
 * A linked worktree has a `.git` *file* holding
 * `gitdir: <main>/.git/worktrees/<name>`; a main checkout has a `.git`
 * *directory* and is its own root.
 */
export function mainCheckoutRoot(repoRoot: string): string | null {
  const dotGit = join(repoRoot, '.git')
  if (!existsSync(dotGit)) return null

  let content: string
  try {
    content = readFileSync(dotGit, 'utf8')
  } catch {
    // A directory (main checkout) cannot be read as a file — not a worktree.
    return null
  }

  const gitdirLine = content
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('gitdir:'))
  if (!gitdirLine) return null

  const gitDir = resolve(repoRoot, gitdirLine.slice('gitdir:'.length).trim())
  const normalized = gitDir.replace(/\\/g, '/')
  const marker = '/worktrees/'
  const at = normalized.lastIndexOf(marker)
  if (at < 0) return null

  // `<main>/.git/worktrees/<name>` -> `<main>/vec0.so` lives in `dirname(<main>/.git)`.
  return dirname(normalized.slice(0, at))
}

/**
 * Pick the extension file a test run should load.
 *
 * Order: the working directory's own copy -> the checkout root's copy (that is
 * what `vec0Path()` resolves by default, so no override is needed) -> the main
 * checkout that owns the worktree. `null` means "nothing local and nothing to
 * fall back to": the caller leaves the resolution alone and the suite fails
 * with the production error message.
 */
export function resolveVec0(options: {
  repoRoot: string
  cwd?: string
}): Vec0Resolution | null {
  const { repoRoot } = options
  const cwd = options.cwd ?? repoRoot
  const cwdVec0 = join(cwd, VEC0_FILENAME)
  const repoRootVec0 = join(repoRoot, VEC0_FILENAME)

  if (cwd !== repoRoot && existsSync(cwdVec0)) {
    return { path: cwdVec0, source: 'cwd' }
  }
  if (existsSync(repoRootVec0)) {
    return { path: repoRootVec0, source: 'repo-root' }
  }
  if (existsSync(cwdVec0)) {
    return { path: cwdVec0, source: 'cwd' }
  }

  const mainRoot = mainCheckoutRoot(repoRoot)
  if (!mainRoot) return null
  const mainVec0 = join(mainRoot, VEC0_FILENAME)
  if (!existsSync(mainVec0)) return null
  return { path: mainVec0, source: 'main-checkout' }
}

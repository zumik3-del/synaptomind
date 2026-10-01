/**
 * Temporary-tree ownership for the deploy suites.
 *
 * WHY THIS EXISTS. /tmp is NOT a scratch space on this host — it is the SAME
 * filesystem that holds production's SQLite database (`/var/lib/synaptomind`).
 * On 2026-09-30 that filesystem hit 100% with zero bytes free, which broke
 * other agents' tool output and put production's own writes at risk (AGENTS.md
 * §8). Every `mkdtempSync(join(tmpdir(), 'synapto-*'))` that outlives its test
 * is therefore a production-risk defect, not untidiness: these suites create
 * ~28 such directories PER RUN, and each `bun test ./deploy/` is cheap enough
 * that they are run many times a day.
 *
 * WHY A REGISTRY AND NOT PER-SITE `rmSync`. The previous shape was one
 * `mkdtempSync` per fixture helper plus one `rmSync` per CALL SITE — 15
 * `setupBootstrap()` callers in updater.sh.test.ts alone, each of which had to
 * remember to clean up, and none of which did. A per-site cleanup call is
 * exactly the failure mode: the next test added to the describe forgets it and
 * the leak comes straight back. Here the CREATION function owns the path: it
 * registers on the way in and the sweep removes it afterwards, so adding a test
 * cannot reintroduce the leak.
 *
 * WHY `installCleanup()` IS CALLED BY EVERY FILE, WITH NO IDEMPOTENCE FLAG.
 * bun runs each test FILE in the same process with one shared module registry,
 * so a module-level `let installed` guard makes the SECOND file a no-op: it
 * calls `installCleanup()`, gets a cached module back, registers no hook, and
 * every tree it creates leaks. Measured on this repo: with a guard, file 2
 * finished with 1 of 2 trees surviving; without one, 0 of 5 across five files.
 * Each file therefore installs its own hook and every hook sweeps the same
 * registry — repeated `afterEach` registrations are harmless and idempotent
 * because the sweep empties the set it walks.
 *
 * NEVER removes a path this module did not create: `owned` only ever receives
 * the return value of our own `mkdtempSync`. The host's /tmp also holds other
 * sessions' scratch, so there is no glob, no `rm -rf /tmp/*`, and no
 * age-based sweep anywhere in this file. There is deliberately no "clean up
 * anything older than N" convenience — that is how a test harness deletes
 * somebody else's work.
 */

import { afterEach } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every tree this process created through `mkTempTree`, and therefore every
 * tree this process is allowed to remove.
 */
const owned = new Set<string>()

/** Trees created but not yet swept. Exported for the ownership tests only. */
export function pendingTempTrees(): string[] {
  return [...owned]
}

/**
 * Remove every tree created by `mkTempTree` in this process.
 *
 * Safe to call when nothing is pending, and safe to call twice: `owned` is
 * emptied as it is walked, so the second call is a no-op rather than a second
 * `rm -rf` of a path someone else may have taken over in the meantime.
 */
export function sweepTempTrees(): number {
  const paths = [...owned]
  for (const path of paths) {
    owned.delete(path)
    // `force` covers the case where the test itself already removed the tree,
    // so a suite that cleans up eagerly does not start failing on ENOENT.
    rmSync(path, { recursive: true, force: true })
  }
  return paths.length
}

/**
 * A private temp directory owned by the caller.
 *
 * This is the ONLY supported way to create a scratch tree in the deploy
 * suites — the bare `mkdtempSync` is what let trees escape in the first place.
 * The path is returned for the caller to populate and assert against; removal
 * is the sweep's job and is not the caller's to remember.
 */
export function mkTempTree(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  owned.add(path)
  return path
}

/**
 * `mkTempTree` plus an immediate removal — for the fixture helpers whose whole
 * job is to produce a value (a rendered unit, a resolved tag) that the test
 * asserts on afterwards. The tree is released before returning so it cannot
 * outlive the helper, and the result is still returned intact.
 *
 * The `finally` is load-bearing: `seedBinaryUpdate` and friends assert while
 * they build, so a failure mid-construction must still release the tree.
 */
export function withTempTree<T>(prefix: string, build: (path: string) => T): T {
  const path = mkTempTree(prefix)
  try {
    return build(path)
  } finally {
    owned.delete(path)
    rmSync(path, { recursive: true, force: true })
  }
}

/**
 * Register the per-test sweep. Call once at the top level of EVERY deploy test
 * file — see the note above on why this cannot be made idempotent.
 *
 * Two hooks, because they fail differently:
 *   - `afterEach` is the normal path: it runs after every test, including one
 *     that threw, and so covers the per-test leak.
 *   - `process.on('exit')` is the backstop for the case `afterEach` cannot
 *     cover — the run is killed, or the process dies on an unhandled error
 *     between tests. It is `once` because one sweep at exit is enough.
 */
export function installCleanup(): void {
  afterEach(() => {
    sweepTempTrees()
  })
  process.once('exit', () => {
    sweepTempTrees()
  })
}

/** Exported for the ownership tests: does a path still exist? */
export { existsSync }
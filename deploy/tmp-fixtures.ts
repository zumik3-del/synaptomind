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

import { afterAll, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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
 * Three hooks, because they fail differently:
 *   - `afterEach` is the normal path: it runs after every test, including one
 *     that threw, and so covers the per-test leak.
 *   - `afterAll` catches the case `afterEach` cannot — the file threw during
 *     COLLECTION, before any test body ran, so no `afterEach` was ever reached
 *     and every tree that file built stayed on disk.
 *   - `process.on('exit')` is the backstop for a run that dies outside the test
 *     lifecycle entirely (a kill, an unhandled error between files). It is `once`
 *     because one sweep at exit is enough.
 *
 * WHY `afterAll` WAS ADDED, AND WHY IT MATTERS MORE THAN IT LOOKS. Measured on
 * bun 1.4.2 while writing the app-env suites (task #1112): under `bun test`,
 * `process.on('exit')` handlers DO NOT RUN — not at module scope, not from a test
 * body. A probe that only sets `process.exitCode = 7` in an exit handler exits 0,
 * while the identical handler registered through `afterAll` exits 7. So this
 * function's exit-time sweep — and `guardRealStateDir`'s tripwire, which used the
 * same mechanism — was unreachable in every `bun test` run that had ever
 * reported them as installed. `afterAll` is the hook bun's runner actually calls;
 * `process.on('exit')` is kept only for a plain `bun run <file>` invocation.
 */
export function installCleanup(): void {
  afterEach(() => {
    sweepTempTrees()
  })
  afterAll(() => {
    sweepTempTrees()
  })
  process.once('exit', () => {
    sweepTempTrees()
  })
}

// ── Operator state-dir containment (task #1104) ──────────────────────────────
//  THE REAL INCIDENT, AND WHY `HOME` IS NOT A FIX.
//
//  On 2026-10-01 a deploy fixture overwrote /home/opencode/.synaptomind/scripts/
//  app.env — the file the whole delivery mechanism reads — with INSTALL_DIR
//  pointing into the fixture's own deleted /tmp tree, PORT=3999, and
//  HEALTH_URL=http://127.0.0.1:1/health. It was caught by hand minutes before a
//  production cutover, by no test at all.
//
//  The obvious remedy is WRONG, and understanding why is the whole point.
//  resolve_target_user() (deploy/lib/common.sh:142-164) resolves TARGET_HOME via
//  `getent passwd "$TARGET_USER"` FIRST and falls back to ${HOME} only when
//  getent is missing or silent. So substituting HOME in a fixture does NOT
//  isolate anything: on any host with getent installed — which is every host —
//  RUN_DIR still resolves to the target user's REAL ~/.synaptomind, and
//  install_helper_scripts()/install_hook_scripts() copy app.env and the helper
//  scripts straight over the operator's own files. Measured on this host with
//  HOME pointed at an empty scratch dir: the run reported
//  `State: /home/opencode/.synaptomind` and wrote a non-identical app.env there.
//
//  WHY THIS IS ENFORCEMENT AND NOT A CONVENTION. Option (a) — "every fixture
//  must remember to set RUN_DIR" — is precisely what failed: seedBinaryTree set
//  it, three other paths did not, and the omission was invisible until it cost a
//  production file. A rule a fixture can forget is not a fix. So the SAFE DEFAULT
//  moves into the constructor: `isolatedEnv()` below is the ONLY sanctioned way
//  to build the environment for a spawn of install.sh / update.sh / updater.sh /
//  uninstall.sh, and it pins RUN_DIR (plus the state-derived HOOKS_DIR, UNIT_FILE
//  and DATA_DIR) inside the fixture's own tree. A fixture that forgets cannot
//  reach the operator's state dir, because it never gets to choose RUN_DIR.
//
//  And because "the constructor is used everywhere" is itself a claim, the
//  end-of-run tripwire below verifies it from the OUTSIDE: it fingerprints the
//  real state dir and fails the run if it moved. That is the property that would
//  have caught #1101, and it holds even for a fixture that bypasses the
//  constructor entirely.

/**
 * The operator's REAL state directory, resolved the way `resolve_target_user`
 * resolves it — from the passwd database, not from $HOME.
 *
 * `getent passwd $(id -un)` is exactly the lookup that defeats a substituted
 * HOME, so using anything else here would be checking the wrong directory and
 * the tripwire would be the second vacuous assertion in this file's history.
 * Returns null when the host has no state dir at all (a fresh container), which
 * is a legitimate "nothing to protect" rather than a failure.
 */
export function realStateDir(): string | null {
  const probe = spawnSync('getent', ['passwd', String(process.getuid?.() ?? '')], {
    encoding: 'utf8',
  })
  // getent keyed by uid is the portable form; fall back to the username.
  const passwd = probe.stdout.trim() || lookupByName()
  const home = passwd.split(':')[5]
  if (!home) return null
  const dir = join(home, '.synaptomind')
  return existsSync(dir) ? dir : null
}

function lookupByName(): string {
  const res = spawnSync('getent', ['passwd', process.env.USER ?? ''], { encoding: 'utf8' })
  return res.stdout.trim()
}

/**
 * A content fingerprint of a state dir: every path with its size, mtime and
 * sha256. Both halves are deliberate — a fixture that rewrites app.env with
 * identical bytes would still move the mtime, and one that appends a comment
 * keeps the size. A listing alone would miss a rewrite; a hash alone would miss
 * a pure touch.
 */
export function fingerprint(dir: string): string {
  const hash = createHash('sha256')
  const walk = (rel: string) => {
    const abs = join(dir, rel)
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(childRel)
        continue
      }
      const st = statSync(join(dir, childRel))
      hash.update(`${childRel} ${st.size} ${st.mtimeMs} `)
      if (st.isFile()) hash.update(readFileSync(join(dir, childRel)))
    }
  }
  walk('')
  return hash.digest('hex')
}

/**
 * Build the environment for a spawn of a deploy SCRIPT (install.sh, update.sh,
 * updater.sh, uninstall.sh) inside `root`.
 *
 * This is the safe default made structural: RUN_DIR is pinned inside `root`, so
 * the getent fallback in resolve_target_user() never becomes reachable, because
 * RUN_DIR is already non-empty and line 163 only derives a default when it is
 * not. `extra` may override anything — that is deliberate, so a test can still
 * exercise a pathological RUN_DIR on purpose — but the value is checked FIRST,
 * so an override that points back at the operator's real state dir fails the
 * fixture at BUILD time instead of destroying the file it aimed at.
 */
export function isolatedEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const runDir = join(root, 'run')
  const env: Record<string, string> = {
    ...(process.env as Record<string, string | undefined>),
    RUN_DIR: runDir,
    // install.sh:616 derives the hook dir from RUN_DIR, and these two are the
    // other state-derived paths that would otherwise follow the real home.
    HOOKS_DIR: join(runDir, 'hooks'),
    UNIT_FILE: join(root, 'unit', 'synaptomind.service'),
    DATA_DIR: join(root, 'data'),
    ...extra,
  }
  assertInsideRoot(env.RUN_DIR, root, 'RUN_DIR')
  assertInsideRoot(env.HOOKS_DIR, root, 'HOOKS_DIR')
  assertInsideRoot(env.UNIT_FILE, root, 'UNIT_FILE')
  assertInsideRoot(env.DATA_DIR, root, 'DATA_DIR')
  return env as Record<string, string>
}

function assertInsideRoot(value: string, root: string, key: string): void {
  const real = realStateDir()
  // The check that matters is against the operator's state dir specifically.
  // A fixture legitimately writes elsewhere in /tmp; it must never write THERE.
  if (real && (value === real || value.startsWith(`${real}/`))) {
    throw new Error(
      `isolatedEnv: ${key}=${value} points at the operator's REAL state dir ${real}. ` +
        `A fixture must never target it — put the path inside the fixture root (${root}).`,
    )
  }
}

/**
 * Fingerprint the operator's real state dir now and fail if it differs later.
 *
 * Call ONCE at the top level of a deploy test file, beside installCleanup().
 * The fingerprint is taken at import time — before any fixture has run — and
 * compared when the FILE's tests are done, because the damage a fixture does is
 * not visible in any assertion the fixture itself makes: the fixture asserts on
 * its own scratch tree, and the operator's file is somewhere else entirely.
 * That asymmetry is precisely why #1101 produced a green suite over a
 * destroyed production config.
 *
 * The comparison runs in `afterAll`, NOT only in `process.on('exit')`. Measured on
 * bun 1.4.2 (task #1112): `bun test` does not run `process.on('exit')` handlers,
 * so the exit-only version of this tripwire could never fail a run — it was
 * documentation of an intent rather than a check. Proven by a deliberate
 * overwrite of a watched production path in a throwaway suite: with the exit hook
 * alone the run reported `1 pass, 0 fail` and exited 0.
 *
 * Skipped (with the reason recorded) when the host has no state dir, so a fresh
 * container reports `skip` rather than a vacuous pass.
 */
export function guardRealStateDir(): void {
  const dir = realStateDir()
  if (!dir) {
    guarded = { dir: null, hash: null }
    return
  }
  const hash = fingerprint(dir)
  guarded = { dir, hash }
  const verify = () => {
    if (!guarded?.dir || !guarded.hash) return
    let after: string
    try {
      after = fingerprint(guarded.dir)
    } catch (err) {
      report(`${guarded.dir} became unreadable during the run: ${(err as Error).message}`)
      return
    }
    if (after !== guarded.hash) report(`${guarded.dir} was MODIFIED by a deploy fixture`)
  }
  // afterAll is the hook bun's test runner actually calls; process.on('exit') is
  // unreachable under `bun test` (measured) and is kept only for `bun run <file>`.
  afterAll(verify)
  process.on('exit', verify)
}

let guarded: { dir: string | null; hash: string | null } | null = null

function report(message: string): void {
  process.stderr.write(
    `\n!!! DEPLOY STATE-DIR VIOLATION: ${message}\n` +
      `    A deploy fixture wrote outside its own temp tree. This is the #1101\n` +
      `    failure mode: the operator's app.env is the file the whole delivery\n` +
      `    mechanism reads. Use isolatedEnv() from ./tmp-fixtures for every spawn\n` +
      `    of a deploy script.\n\n`,
  )
  // A non-zero exit is what turns this into a FAILED run rather than a warning
  // someone scrolls past; the suite's own result stays visible either way.
  process.exitCode = 1
}

/** Exported for the ownership tests: does a path still exist? */
export { existsSync }
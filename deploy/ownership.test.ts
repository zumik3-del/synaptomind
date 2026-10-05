/**
 * Ownership — the tree-wide chown every install and update ends with
 * (deploy/lib/common.sh §Ownership: ownership_mismatch, chown_target,
 * apply_ownership, apply_run_dir_ownership).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT PART OF THE PER-TARGET SUITE. The
 * apply_ownership tests in app-env-conformance.test.ts (added by #1108) install a
 * `stat` stub that answers `%U:%G` with `root:root`. That makes the fixture tree
 * look root-owned, which puts the run on the FIRST line of ownership_mismatch —
 * `stat` disagrees with the target spec, so it answers "mismatch" there and the
 * `find` walk below it never runs. Every one of those tests therefore passes
 * identically against the pre-#1121 implementation, which made the same
 * `stat`-alone decision inline in apply_ownership. A green suite, and a defect
 * that survived it: #1114 left 387 root-owned entries under /opt/subagentix
 * while the top directory itself read opencode:opencode, including .git/index,
 * which is what a `git status` as the service user fails on.
 *
 * So the tests here are built to REACH the tree walk, which means the fixture
 * must contain an entry whose ownership genuinely differs from the top
 * directory's — and that has to be arranged without root. See
 * `secondaryGroup` for the only mechanism that works for an unprivileged
 * process, and for why it is the group axis.
 *
 * WHAT IS ASSERTED, AND WHERE THE BOUNDARY IS. These are function-level tests
 * (the same shape as atomic-write.test.ts) because the decision under test —
 * "which paths does this chown, to which spec, or none at all" — is a property
 * of the function, and no full install run can arrange a half-foreign tree under
 * INSTALL_DIR. The privilege boundary itself (run_root → sudo) is a recording
 * stub in most of these tests, because a real chown to another user needs
 * privilege this suite must not use. ONE test ("a foreign-owned child is
 * repaired") lets the real chown run, and that is safe precisely because the
 * target owner is the test runner: an owner may always chgrp a file it owns to
 * a group it belongs to, so the repair is exercised without elevating.
 *
 * No systemctl, no network, nothing outside the fixture root. `sudo` is a PATH
 * stub that refuses any absolute argument outside the root — the same
 * containment atomic-write.test.ts uses.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chownSync, chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { guardRealStateDir, installCleanup, mkTempTree } from './tmp-fixtures'

installCleanup()
guardRealStateDir()

const LIB = join(import.meta.dir, 'lib', 'common.sh')
const APP = 'synaptomind'

// ── Who the runner is, as stat(1)/find(1)/chown(1) name them ──────────────────
//
// TARGET_USER/TARGET_GROUP are what resolve_target_user() produces on this host,
// and ownership_mismatch compares NAMES (stat -c %U:%G), not ids — so the tests
// have to speak the same names the tools print. Probed rather than read from
// $USER/$GROUP, which a test runner need not export.
const ME = command(['id', '-un'])
const MY_GROUP = command(['id', '-gn'])
/** The absolute path of the real `stat`, for stubs that must forward to it. */
const REAL_STAT = command(['bash', '-c', 'command -v stat'])
/** The absolute path of the real `find`, ditto. */
const REAL_FIND = command(['bash', '-c', 'command -v find'])
/**
 * The absolute path of bash itself, because one test hands the spawn a PATH that
 * holds no shell at all (that is the point of it) and execvp resolves the
 * interpreter through the child's PATH.
 */
const REAL_BASH = command(['bash', '-c', 'command -v bash'])

function command(argv: string[]): string {
  const res = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10_000 })
  return (res.stdout ?? '').trim()
}

type Run = { status: number | null; stdout: string; stderr: string }

type RunOpts = {
  /** The framework function to call, with its arguments. */
  call: string[]
  /** Environment for the spawn. PATH is built by `stubs` unless `env` carries one. */
  env?: Record<string, string>
  /** A lib to source instead of the shipped one (mutations only). */
  lib?: string
  /** Directories prepended to PATH, in order. */
  stubs?: string[]
  /** Record run_root instead of crossing the privilege boundary (default true). */
  spyRoot?: boolean
  /** Exit status the recorded run_root returns; non-zero exercises the warning. */
  spyRc?: number
}

/**
 * Source the real lib/common.sh and call one function, recording the chowns.
 *
 * `set -u` and NOT `set -e`. The framework's entry points run `set -euo
 * pipefail`, and the -u half is load-bearing here: both apply_ownership and
 * apply_run_dir_ownership document that they must not abort on an unset
 * INSTALL_DIR/DATA_DIR/RUN_DIR, and that claim is only testable under -u. The
 * -e half would be actively harmful: ownership_mismatch RETURNS 1 for "already
 * owned", so -e would turn the function's own answer into an early abort and the
 * harness could not observe a return value at all.
 */
function runOwnership(opts: RunOpts): Run {
  const prelude = ['set -uo pipefail', '. "$1"', 'shift']
  if (opts.spyRoot !== false) {
    prelude.push(
      // The privilege boundary, recorded rather than crossed. run_root is
      // `sudo "$@"` for a non-root caller, and the DECISION under test (which
      // path, which spec, or none at all) is entirely upstream of it.
      'run_root() { printf \'RUN_ROOT %s\\n\' "$*"; return "${OWNERSHIP_SPY_RC:-0}"; }',
    )
  }
  const path = [...(opts.stubs ?? []), process.env.PATH].join(':')
  const res = spawnSync(
    REAL_BASH,
    ['-c', [...prelude, '"$@"'].join('\n'), 'ownership', opts.lib ?? LIB, ...opts.call],
    {
      encoding: 'utf8',
      env: {
        ...(process.env as Record<string, string | undefined>),
        PATH: path,
        APP_NAME: APP,
        TARGET_USER: ME,
        TARGET_GROUP: MY_GROUP,
        OWNERSHIP_SPY_RC: String(opts.spyRc ?? 0),
        ...opts.env,
      } as Record<string, string>,
      timeout: 30_000,
    },
  )
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Every chown the harness recorded, parsed out of `RUN_ROOT chown -R spec path`. */
function chowns(res: Run): { spec: string; path: string }[] {
  return res.stdout
    .split('\n')
    .filter((l) => l.startsWith('RUN_ROOT chown'))
    .map((l) => l.replace('RUN_ROOT chown -R ', '').split(' '))
    .map(([spec, path]) => ({ spec, path }))
}

/** Just the paths, which is what most of these assertions read. */
function chownedPaths(res: Run): string[] {
  return chowns(res).map((c) => c.path)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A group the runner belongs to that is NOT its own primary group, or null.
 *
 * WHY THE GROUP AXIS IS THE ONLY ONE AVAILABLE. The mismatch these tests need is
 * "the top directory is right and something beneath it is wrong" — the #1114
 * shape. The top directory has to pass the `stat -c %U:%G` gate first, so it must
 * genuinely belong to TARGET_USER:TARGET_GROUP, i.e. to the runner. That leaves
 * one way to make a child disagree without root:
 *
 *   - USER: chown to another user always needs root, and a hardlink to a
 *     root-owned file would carry root's ownership for free — but
 *     protected_hardlinks=1 (the default) refuses exactly that. Both were tried
 *     on the dev host: `ln /etc/hostname <tmp>` → "Operation not permitted".
 *   - GROUP: chgrp to a group you are a member of is permitted, and a setgid
 *     directory propagates its group to the files created inside it. So a setgid
 *     subdirectory chgrp'd to a secondary group, holding one file, is a real
 *     `find ! -group` hit built with no privilege at all.
 *
 * The consequence is a host dependency, and it is stated rather than hidden: on a
 * host whose runner belongs to no secondary group, the two group-dependent
 * describes report `skip` — not a vacuous pass.
 */
function secondaryGroup(): { name: string; gid: number } | null {
  const mine = command(['id', '-g'])
  for (const gid of command(['id', '-G']).split(/\s+/).filter(Boolean)) {
    if (gid === mine) continue
    const name = command(['getent', 'group', gid]).split(':')[0]
    if (name) return { name, gid: Number(gid) }
  }
  return null
}

const FOREIGN = secondaryGroup()

/**
 * `dir/rel`, holding one file, owned by ME but NOT by the target's group.
 *
 * `chownSync(path, -1, gid)` is the documented "leave the user alone" form. The
 * setgid bit is what makes the FILE land in the foreign group too: without it a
 * new file takes the creator's primary group and the walk finds nothing.
 */
function seedForeignOwnedEntry(dir: string, rel: string, group: { gid: number }): string {
  const sub = join(dir, rel)
  mkdirSync(sub, { recursive: true })
  chownSync(sub, -1, group.gid)
  chmodSync(sub, 0o2775)
  const file = join(sub, 'payload')
  writeFileSync(file, 'payload\n')
  return file
}

/** A `stat` that reports `root:root` for `%U:%G` and forwards everything else. */
function seedForeignOwnerStat(root: string): string {
  const stubs = join(root, 'stat-stubs')
  mkdirSync(stubs, { recursive: true })
  writeFileSync(
    join(stubs, 'stat'),
    [
      '#!/usr/bin/env bash',
      'for a in "$@"; do',
      // Only %U:%G is intercepted. %a (mode) is what the unit writer uses to
      // preserve an operator's 600, and forwarding the rest keeps that path real.
      '  if [ "$a" = "%U:%G" ]; then printf \'root:root\\n\'; exit 0; fi',
      'done',
      `exec ${JSON.stringify(REAL_STAT)} "$@"`,
    ].join('\n'),
  )
  chmodSync(join(stubs, 'stat'), 0o755)
  return stubs
}

/** A `sudo` that records its argv and then really runs the command. */
function seedSudoStub(root: string): { stubs: string; log: string } {
  const stubs = join(root, 'sudo-stubs')
  const log = join(root, 'sudo.log')
  mkdirSync(stubs, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(
    join(stubs, 'sudo'),
    [
      '#!/usr/bin/env bash',
      'for a in "$@"; do printf \' %s\' "$a" >> "$SUDO_LOG"; done',
      'printf \'\\n\' >> "$SUDO_LOG"',
      'for a in "$@"; do',
      '  case "$a" in',
      `    /*) case "$a" in ${root}/*) ;; *) echo "STUB: refused path $a" >&2; exit 99 ;; esac ;;`,
      '  esac',
      'done',
      // `exec`, so the chown really happens: what is under test is the shipped
      // `chown -R <spec> <path>` and its EFFECT, and a stub that swallowed the
      // command would prove nothing about the repair.
      'exec "$@"',
    ].join('\n'),
  )
  chmodSync(join(stubs, 'sudo'), 0o755)
  return { stubs, log }
}

/**
 * A `find` that records that it was called and then really runs.
 *
 * The recording is the point. "A chown was issued" and "the tree was walked" are
 * different claims: ownership_mismatch can answer "mismatch" from its FIRST line
 * (the stat gate), so a test that asserted only the chown would pass against an
 * implementation that never looks at the tree — which is the pre-#1121 defect.
 */
function seedFindWrapper(root: string): { stubs: string; log: string } {
  const stubs = join(root, 'find-stubs')
  const log = join(root, 'find.log')
  mkdirSync(stubs, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(
    join(stubs, 'find'),
    ['#!/usr/bin/env bash', 'printf \'%s\\n\' "$*" >> "$FIND_LOG"', `exec ${JSON.stringify(REAL_FIND)} "$@"`].join('\n'),
  )
  chmodSync(join(stubs, 'find'), 0o755)
  return { stubs, log }
}

/** A `find` that always fails, as one without `-quit` support does. */
function seedFailingFind(root: string): string {
  const stubs = join(root, 'failfind-stubs')
  mkdirSync(stubs, { recursive: true })
  writeFileSync(join(stubs, 'find'), ['#!/usr/bin/env bash', 'echo "find: unsupported" >&2', 'exit 1'].join('\n'))
  chmodSync(join(stubs, 'find'), 0o755)
  return stubs
}

/**
 * A copy of lib/common.sh with `ownership_mismatch` reduced to the pre-#1121
 * decision: the top directory alone, via `stat`.
 *
 * NEVER the repo's file. The mutation exists only to prove a neighbouring
 * assertion can fail — the technique install.sh.test.ts's mutateInstallScript
 * uses. Throwing when the target text is absent is deliberate: a reformat would
 * otherwise leave the mutation a silent no-op and the non-vacuity test would
 * quietly stop testing anything.
 */
function seedTopDirOnlyOwnership(root: string): string {
  const lib = join(root, 'lib')
  mkdirSync(lib, { recursive: true })
  const copy = join(lib, 'common.sh')
  copyFileSync(LIB, copy)
  const src = readFileSync(copy, 'utf8')
  const from = `ownership_mismatch() {
  local p="$1" hit rc=0
  [ "$(stat -c '%U:%G' "$p" 2>/dev/null || true)" = "$(ownership_target)" ] || return 0
  command -v find >/dev/null 2>&1 || return 0
  hit="$(find "$p" \\( ! -user "\${TARGET_USER}" -o ! -group "\${TARGET_GROUP:-\${TARGET_USER}}" \\) \\
    -print -quit 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] || return 0
  [ -n "$hit" ]
}`
  const to = `ownership_mismatch() {
  [ "$(stat -c '%U:%G' "$1" 2>/dev/null || true)" != "$(ownership_target)" ]
}`
  if (!src.includes(from)) {
    throw new Error('mutation target absent from common.sh: the ownership_mismatch body moved')
  }
  writeFileSync(copy, src.replace(from, to))
  return copy
}

/** A tree entirely ME's, the way a non-root install into your own home leaves it. */
function seedOwnedTree(root: string, rel: string): string {
  const dir = join(root, rel)
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'app'), 'x\n')
  writeFileSync(join(dir, 'sub', 'index'), 'x\n')
  return dir
}

// ── apply_ownership: the tree walk ───────────────────────────────────────────

describe('ownership_mismatch — a correct top directory is not the question', () => {
  test.skipIf(FOREIGN === null)(
    'a foreign-owned child under a clean top directory is repaired by the real chown',
    () => {
      // The #1114 case, end to end: the top directory reads ME:ME (so the stat
      // gate PASSES and the walk is what decides), the subtree beneath it does
      // not, and the shipped `chown -R ME:ME` puts it right. The pre-#1121
      // implementation skipped this tree entirely.
      const root = mkTempTree('synapto-own-')
      const tree = seedOwnedTree(root, 'opt')
      const child = seedForeignOwnedEntry(tree, 'sub', FOREIGN!)
      const { stubs, log } = seedSudoStub(root)
      const find = seedFindWrapper(root)
      expect(statSync(child).gid, 'the fixture must start out mismatched').not.toBe(statSync(tree).gid)

      const res = runOwnership({
        call: ['apply_ownership'],
        stubs: [find.stubs, stubs],
        spyRoot: false,
        env: { FIND_LOG: find.log, SUDO_LOG: log, INSTALL_DIR: tree, DATA_DIR: join(root, 'absent-data') },
      })

      expect(res.status, res.stdout + res.stderr).toBe(0)
      // The walk was reached, not short-circuited by the stat gate.
      expect(readFileSync(find.log, 'utf8'), 'find was never consulted').toContain(tree)
      // The chown named the tree — and the REAL chown ran, through the stub.
      expect(readFileSync(log, 'utf8'), res.stdout).toContain(`chown -R ${ME}:${MY_GROUP} ${tree}`)
      // And the tree is actually repaired, which an argv assertion alone cannot show.
      expect(statSync(child).gid, 'the child is still in the foreign group').toBe(statSync(tree).gid)
    },
  )

  test('a fully owned tree is NOT chowned — the walk finds nothing', () => {
    // The other half of the same decision, and the one that keeps the "say
    // nothing" contract honest: a non-root install into the caller's own
    // directory must not pay a recursive chown over a large node_modules on every
    // run. This test is also what proves the stat gate PASSES for an ME:ME tree,
    // which is the premise both tests below rely on.
    const root = mkTempTree('synapto-own-')
    const tree = seedOwnedTree(root, 'opt')
    const find = seedFindWrapper(root)

    const res = runOwnership({
      call: ['apply_ownership'],
      stubs: [find.stubs],
      env: { FIND_LOG: find.log, INSTALL_DIR: tree, DATA_DIR: join(root, 'absent-data') },
    })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(readFileSync(find.log, 'utf8'), 'find was never consulted').toContain(tree)
    expect(res.stdout, 'a no-op recursive chown was issued').not.toContain('RUN_ROOT chown')
    expect(res.stdout, 'and nothing at all was reported').toBe('')
  })

  test.skipIf(FOREIGN === null)(
    'against the pre-#1121 top-directory-only decision the same tree gets NO chown',
    () => {
      // THE NON-VACUITY PROOF. Without it the test above could pass for the
      // wrong reason: an implementation that chowned unconditionally would
      // satisfy it too, and so would the old one on a different fixture. Here the
      // same tree, the same walk and the same recorder run against a mutated copy
      // whose ownership_mismatch is the stat-alone predicate — and it must produce
      // nothing. If this test ever fails, the mutation stopped matching the
      // shipped body and the test above is no longer proving anything.
      const root = mkTempTree('synapto-own-')
      const tree = seedOwnedTree(root, 'opt')
      seedForeignOwnedEntry(tree, 'sub', FOREIGN!)
      const lib = seedTopDirOnlyOwnership(root)
      const find = seedFindWrapper(root)

      const res = runOwnership({
        call: ['apply_ownership'],
        lib,
        stubs: [find.stubs],
        env: { FIND_LOG: find.log, INSTALL_DIR: tree, DATA_DIR: join(root, 'absent-data') },
      })

      expect(res.status, res.stdout + res.stderr).toBe(0)
      expect(res.stdout, 'the top-directory-only decision still chowned the tree').not.toContain('RUN_ROOT chown')
    },
  )
})

describe('ownership_mismatch — an unverifiable tree is a mismatch', () => {
  test('a find that fails is a MISMATCH, so the tree is chowned rather than trusted', () => {
    // Degraded behaviour by design: a find without -quit support, or one that
    // cannot descend, exits non-zero. The alternative — reading an unverifiable
    // tree as clean — is the failure #1114 was, one indirection further away.
    const root = mkTempTree('synapto-own-')
    const tree = seedOwnedTree(root, 'opt')

    const res = runOwnership({
      call: ['apply_ownership'],
      stubs: [seedFailingFind(root)],
      env: { INSTALL_DIR: tree, DATA_DIR: join(root, 'absent-data') },
    })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(chownedPaths(res), 'a failing find must not be read as "clean"').toEqual([tree])
    // The premise shared with 'a fully owned tree is NOT chowned': the stat gate
    // passed, so the mismatch can only have come from the walk.
    expect(res.stdout).toContain(`RUN_ROOT chown -R ${ME}:${MY_GROUP} ${tree}`)
  })

  test('no find at all is a MISMATCH too', () => {
    // The last degraded path, and the one the `command -v find` guard exists for.
    // PATH is reduced to a directory holding only `stat`, so it is the guard in
    // front of the walk that is being exercised: the top directory is still
    // ME:ME, so the stat gate passes and the missing find is what makes the tree
    // unverifiable.
    const root = mkTempTree('synapto-own-')
    const tree = seedOwnedTree(root, 'opt')
    const stubs = join(root, 'bare-stubs')
    mkdirSync(stubs, { recursive: true })
    // A symlink, not a `#!/usr/bin/env bash` script: PATH has no shell in it, so
    // a script stub could not even start.
    symlinkSync(REAL_STAT, join(stubs, 'stat'))

    const res = runOwnership({
      call: ['apply_ownership'],
      env: { PATH: stubs, INSTALL_DIR: tree, DATA_DIR: join(root, 'absent-data') },
    })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(chownedPaths(res)).toEqual([tree])
  })
})

describe('apply_ownership — both trees', () => {
  test('INSTALL_DIR and DATA_DIR are each chowned to the target spec', () => {
    // The two trees the gap was about: the payload the service reads, and the
    // directory it writes to. The stat stub is what puts both on the "the top
    // directory itself disagrees" branch — the same trick
    // app-env-conformance.test.ts uses, and the only way to reach that branch
    // unprivileged.
    const root = mkTempTree('synapto-own-')
    const install = seedOwnedTree(root, 'opt')
    const data = seedOwnedTree(root, 'data')

    const res = runOwnership({
      call: ['apply_ownership'],
      stubs: [seedForeignOwnerStat(root)],
      env: { INSTALL_DIR: install, DATA_DIR: data },
    })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(chownedPaths(res), 'both trees, in order').toEqual([install, data])
    // To the pair the unit runs as — not root, and not an empty field.
    for (const { spec } of chowns(res)) expect(spec).toBe(`${ME}:${MY_GROUP}`)
  })

  test('an unset DATA_DIR is skipped, not fatal, and the pass continues', () => {
    // A host whose app.env omits DATA_DIR must not abort the install here over a
    // key it cannot set: setup_data() already tolerates exactly that, and this
    // runs before the unit exists. Only `set -u` can catch such an abort, which
    // is why runOwnership sets it.
    const root = mkTempTree('synapto-own-')
    const install = seedOwnedTree(root, 'opt')

    const res = runOwnership({ call: ['apply_ownership'], env: { INSTALL_DIR: install } })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(res.stderr, 'set -u must not abort on an unset DATA_DIR').not.toContain('unbound variable')
  })
})

describe('chown_target — a chown that fails is reported, and is never fatal', () => {
  test('a refused chown warns with the consequence and the fix, and returns 0', () => {
    // Not fatal by decision (ADR §3c): a run without root and without sudo cannot
    // chown anything to another user, and that is a legitimate configuration
    // (--no-service in a container, a --dir install under your own home). Aborting
    // would turn a cosmetic ownership difference into a failed install.
    const root = mkTempTree('synapto-own-')
    const tree = seedOwnedTree(root, 'opt')

    const res = runOwnership({
      call: ['apply_ownership'],
      stubs: [seedForeignOwnerStat(root)],
      spyRc: 1,
      env: { INSTALL_DIR: tree, DATA_DIR: join(root, 'absent-data') },
    })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    // The attempt stays visible, so "warned" and "never tried" cannot be confused.
    expect(res.stdout).toContain('RUN_ROOT chown')
    expect(res.stderr).toContain('cannot chown')
    expect(res.stderr).toMatch(/EACCES/)
    expect(res.stderr).toMatch(/fix: sudo chown/)
  })
})

// ── apply_run_dir_ownership ──────────────────────────────────────────────────

describe('apply_run_dir_ownership — RUN_DIR, scripts/ and hooks/ only', () => {
  test('all three paths are chowned, and nothing else under RUN_DIR is', () => {
    // The contract is a list of three paths, not a `chown -R ${RUN_DIR}`: RUN_DIR
    // may also hold app state the framework does not own (a legacy data/, a
    // settings.json), and a blind recursive chown would silently take that too —
    // so `data/` is given a child of its own and must be left alone.
    const root = mkTempTree('synapto-own-')
    const runDir = join(root, 'run')
    for (const d of ['scripts', 'hooks', 'data']) mkdirSync(join(runDir, d), { recursive: true })
    // The mode-600 app.env the pre-update hook has to READ as TARGET_USER: the
    // file #1113's database backup could not read.
    writeFileSync(join(runDir, 'scripts', 'app.env'), 'INSTALL_DIR=/opt/x\n')
    chmodSync(join(runDir, 'scripts', 'app.env'), 0o600)

    const res = runOwnership({
      call: ['apply_run_dir_ownership'],
      stubs: [seedForeignOwnerStat(root)],
      env: { RUN_DIR: runDir },
    })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(chownedPaths(res), 'the three documented paths, in order').toEqual([
      runDir,
      join(runDir, 'scripts'),
      join(runDir, 'hooks'),
    ])
    expect(res.stdout, "RUN_DIR/data is not the framework's to chown").not.toContain(join(runDir, 'data'))
  })

  test.skipIf(FOREIGN === null)(
    'a foreign-owned child under scripts/ is found, and hooks/ is left alone',
    () => {
      // The tree walk again, this time inside RUN_DIR: a foreign-owned entry under
      // scripts/ while hooks/ is clean must still produce a chown, and hooks/ must
      // not get one. RUN_DIR itself IS chowned as well, and that is correct rather
      // than a leak: the walk is recursive, so RUN_DIR contains the mismatch, and
      // RUN_DIR is one of the three documented paths.
      const root = mkTempTree('synapto-own-')
      const runDir = join(root, 'run')
      mkdirSync(join(runDir, 'hooks'), { recursive: true })
      mkdirSync(join(runDir, 'scripts'), { recursive: true })
      seedForeignOwnedEntry(join(runDir, 'scripts'), 'node_modules', FOREIGN!)
      const find = seedFindWrapper(root)

      const res = runOwnership({
        call: ['apply_run_dir_ownership'],
        stubs: [find.stubs],
        env: { FIND_LOG: find.log, RUN_DIR: runDir },
      })

      expect(res.status, res.stdout + res.stderr).toBe(0)
      expect(chownedPaths(res), 'the mismatched path and its scanned parent, in loop order').toEqual([
        runDir,
        join(runDir, 'scripts'),
      ])
      expect(readFileSync(find.log, 'utf8')).toContain(join(runDir, 'scripts'))
    },
  )

  test('an empty RUN_DIR returns 0 without tripping set -u', () => {
    // Both new app.envs carry `RUN_DIR=""` (the documented "derive from HOME"
    // form) on a host that never reached resolve_target_user. The guard is
    // BEFORE the loop on purpose: the loop list is expanded when the `for` runs,
    // so a test inside the body would be reached only after "${RUN_DIR}/scripts"
    // had already aborted the script.
    const res = runOwnership({ call: ['apply_run_dir_ownership'], env: { RUN_DIR: '' } })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(res.stderr).not.toContain('unbound variable')
    expect(res.stdout).not.toContain('RUN_ROOT chown')
  })

  test('an absent hooks/ is skipped and the other two are still chowned', () => {
    // A --no-service run, or a host with no hooks installed, must not abort the
    // pass over the paths that do exist.
    const root = mkTempTree('synapto-own-')
    const runDir = join(root, 'run')
    mkdirSync(join(runDir, 'scripts'), { recursive: true })

    const res = runOwnership({
      call: ['apply_run_dir_ownership'],
      stubs: [seedForeignOwnerStat(root)],
      env: { RUN_DIR: runDir },
    })

    expect(res.status, res.stdout + res.stderr).toBe(0)
    expect(chownedPaths(res)).toEqual([runDir, join(runDir, 'scripts')])
  })
})

// ── The shipped source, not a copy of it ─────────────────────────────────────

describe('lib/common.sh — the ownership helpers are the ones under test', () => {
  test('every helper this file calls is defined in the shipped lib', () => {
    // A renamed or dropped helper would otherwise surface as "command not found"
    // in one spawn's stderr, which a status-0 assertion elsewhere could hide.
    const helpers = ['ownership_target', 'ownership_mismatch', 'chown_target', 'apply_ownership', 'apply_run_dir_ownership']
    const res = runOwnership({ call: ['declare', '-F', ...helpers] })
    for (const fn of helpers) expect(res.stdout, `${fn} is not defined in ${LIB}`).toContain(fn)
  })

  test('the shipped lib passes bash -n', () => {
    const res = spawnSync('bash', ['-n', LIB], { encoding: 'utf8' })
    expect(res.status, res.stderr).toBe(0)
  })
})

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { guardRealStateDir, installCleanup, mkTempTree } from './tmp-fixtures'

// seed()'s scratch tree is owned by mkTempTree, so the sweep removes it even
// when a test throws mid-run. The per-test try/finally pairs stay (they release
// earlier; the sweep is `force`). See tmp-fixtures.ts.
installCleanup()
// Tripwire for #1101: this suite sources the real lib/common.sh, which carries
// resolve_target_user()'s getent-first resolution — the mechanism that wrote
// into the operator's real ~/.synaptomind. The tripwire fails the run if it moves.
guardRealStateDir()

// write_file_atomically() (deploy/lib/common.sh) is the ONE mechanism every unit
// write goes through — install.sh's install_service, update.sh's refresh_unit and
// its ensure_restart_policy all call it, so a fix cannot reach one entry point
// and miss the others.
//
// It is tested here, directly, rather than through an entry point, because its
// contract is a FUNCTION-level invariant and the way to break it is to fail one
// of its steps:
//
//   the destination moves from the old file to the new one, and never passes
//   through an absent state.
//
// An entry-point harness can only inject a failure the entry point happens to
// reach first (they assert one step each, and the step that fails depends on the
// order the code happens to use); this one injects a failure at EVERY step in a
// single sweep, which is the only way to see the states in between.
//
// Where the invariant came from: task #1094 introduced the shared writer, and the
// #1095 review of it found that a DANGLING symlink at the destination was
// `rm -f`'d BEFORE the four fallible steps, so a failure in any of them — and
// the window spanned the whole touch -> chmod -> cp sequence — left nothing at
// the destination at all. It was a regression rather than an inherited bug:
// GNU cp, which the code it replaced used, refuses a dangling symlink outright
// ("not writing through dangling symlink"), so the old writer left the link in
// place and reported the failure.
//
// No sudo, no systemctl, no network, nothing outside the fixture root: `sudo` is
// a PATH stub that refuses any path outside the root, so the real one is never
// invoked. Skipped when the suite runs as root, because run_root() then calls the
// command directly and the injected failures would not happen at all.
const LIB = join(import.meta.dir, 'lib', 'common.sh')
const APP = 'synaptomind'

const OLD_UNIT = '[Unit]\nDescription=the OLD unit\n'
const NEW_UNIT = '[Unit]\nDescription=the NEW unit\n\n[Service]\nExecStart=/bin/true\n'

/**
 * Every step the replacement cannot do without: the staging file, its mode, the
 * payload and the swap. `rm` is deliberately NOT here — the only rm left is the
 * best-effort cleanup of a staging file left by a dead run, which is followed by
 * `touch` overwriting it anyway, so failing it cannot lose the destination (and
 * before #1096 it was the rm of a DANGLING LINK, which could: that is the very
 * step this suite exists to pin).
 */
const STEPS = ['touch', 'chmod', 'cp', 'mv'] as const

type Kind = 'file' | 'link' | 'dangling'
type Fixture = { root: string; unitFile: string; src: string; stubs: string; target: string }

/**
 * A scratch root with a DESTINATION of the given shape and a payload beside it,
 * plus a `sudo` stub that refuses any absolute path outside the root and fails
 * ONE named primitive on demand (`broken`).
 */
function seed(opts: { kind?: Kind; broken?: string } = {}): Fixture {
  const kind = opts.kind ?? 'file'
  const root = mkTempTree('synapto-atomic-')
  const unitDir = join(root, 'unit')
  const srcDir = join(root, 'src')
  const targetDir = join(root, 'linked')
  const stubs = join(root, 'stubs')
  for (const d of [unitDir, srcDir, targetDir, stubs]) mkdirSync(d, { recursive: true })
  const unitFile = join(unitDir, `${APP}.service`)
  const target = join(targetDir, `${APP}.service`)
  const src = join(srcDir, 'rendered.service')

  writeFileSync(target, OLD_UNIT)
  if (kind === 'file') {
    writeFileSync(unitFile, OLD_UNIT)
  } else {
    symlinkSync(target, unitFile)
    if (kind === 'dangling') rmSync(target)
  }

  writeFileSync(src, NEW_UNIT)
  chmodSync(src, 0o644)
  writeFileSync(
    join(stubs, 'sudo'),
    [
      '#!/usr/bin/env bash',
      'for a in "$@"; do',
      '  case "$a" in',
      // Only ABSOLUTE arguments are checked — a relative one is the command
      // name — and every one of them must live under the fixture root, so this
      // stub cannot reach a path outside it whatever it is asked to do.
      `    /*) case "$a" in ${root}/*) ;; *) echo "STUB: refused path $a" >&2; exit 99 ;; esac ;;`,
      '  esac',
      'done',
      opts.broken
        ? `case " $* " in *" ${opts.broken} "*) echo "stub: ${opts.broken} failed" >&2; exit 1 ;; esac`
        : ':',
      'exec "$@"',
    ].join('\n'),
  )
  chmodSync(join(stubs, 'sudo'), 0o755)
  return { root, unitFile, src, stubs, target }
}

/** Run write_file_atomically against the fixture, with the stub on PATH. */
function write(fx: Fixture, mode?: string) {
  // MODE is passed as a third ARGUMENT only when the caller supplies one, the
  // way install.sh and update.sh call it (they inherit the mode instead).
  const script = '. "$1"\nwrite_file_atomically "$2" "$3" ' + (mode ? '"$4"' : '')
  const res = spawnSync('bash', ['-c', script, 'write_file_atomically', LIB, fx.unitFile, fx.src, ...(mode ? [mode] : [])], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fx.stubs}:${process.env.PATH}`, APP_NAME: APP },
    timeout: 30_000,
  })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

/** What is at the destination, as an operator would find it. */
function destState(fx: Fixture): 'absent' | 'dangling link' | 'file' {
  const st = lstatSync(fx.unitFile, { throwIfNoEntry: false })
  if (!st) return 'absent'
  if (st.isSymbolicLink() && !existsSync(fx.unitFile)) return 'dangling link'
  return 'file'
}

/** Staging litter in the destination's directory (a name systemd never loads). */
function leftovers(fx: Fixture): string[] {
  return readdirSync(join(fx.root, 'unit')).filter((f) => f.includes('.new.'))
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe.skipIf(isRoot)('write_file_atomically — the destination is never absent', () => {
  // The direction test for #1096 F2: against ebb26c8 this fails for touch, chmod,
  // cp and mv, each with 'absent'.
  test('a failure at EVERY step leaves a dangling link exactly where it was', () => {
    for (const broken of STEPS) {
      const fx = seed({ kind: 'dangling', broken })
      try {
        const res = write(fx)
        expect(res.status, `${broken}: the write must be refused`).not.toBe(0)
        // THE INVARIANT. Not "the write failed" — the destination is still
        // there, exactly as the run found it.
        expect(destState(fx), `${broken}: the destination must not pass through absent`).toBe(
          'dangling link',
        )
        // And the report says what is really there, not "it does not exist".
        expect(res.stderr, `${broken}: the report must name the real state`).toContain('dangling link')
        expect(res.stderr, `${broken}: it must not claim the file is gone`).not.toContain(
          'it does not exist',
        )
        expect(leftovers(fx), `${broken}: no staging litter`).toEqual([])
      } finally {
        rmSync(fx.root, { recursive: true, force: true })
      }
    }
  })

  test('a failure at EVERY step leaves a regular destination byte-identical', () => {
    // The general form of the invariant, and the case the entry-point suites
    // cover end to end: the destination is whatever it was, at whatever mode.
    for (const broken of STEPS) {
      const fx = seed({ kind: 'file', broken })
      try {
        const res = write(fx)
        expect(res.status, `${broken}: the write must be refused`).not.toBe(0)
        expect(destState(fx), `${broken}: the destination must not pass through absent`).toBe('file')
        expect(readFileSync(fx.unitFile, 'utf8'), `${broken}: byte-identical`).toBe(OLD_UNIT)
        expect(leftovers(fx), `${broken}: no staging litter`).toEqual([])
      } finally {
        rmSync(fx.root, { recursive: true, force: true })
      }
    }
  })

  test('a successful write over a dangling link installs the new unit', () => {
    // The end shape the removed `rm -f` was there to produce, now reached by the
    // rename alone: a regular file at the destination carrying the new body, with
    // the link gone. The caller passes no mode — as install.sh and update.sh do —
    // so the payload's own mode is what lands.
    const fx = seed({ kind: 'dangling' })
    try {
      const res = write(fx)
      expect(res.status, res.stderr).toBe(0)
      expect(destState(fx)).toBe('file')
      expect(readFileSync(fx.unitFile, 'utf8')).toBe(NEW_UNIT)
      expect(statSync(fx.unitFile).mode & 0o777).toBe(0o644)
      expect(res.stdout).toContain('is a dangling link; replaced it with a regular file')
      expect(leftovers(fx)).toEqual([])
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  test('a live link is still written THROUGH, never replaced', () => {
    // The #1094 decision, pinned beside the dangling case so the two branches
    // cannot be swapped: a link with a live target keeps its shape, because
    // replacing it would orphan the file systemd is actually loading — and
    // `stat` without -L would report the link's own mode, always 777.
    const fx = seed({ kind: 'link' })
    try {
      const res = write(fx)
      expect(res.status, res.stderr).toBe(0)
      expect(lstatSync(fx.unitFile).isSymbolicLink(), 'the link must survive').toBe(true)
      expect(readFileSync(fx.target, 'utf8')).toBe(NEW_UNIT)
      expect(res.stdout).toContain('is a link; wrote through it to')
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })
})

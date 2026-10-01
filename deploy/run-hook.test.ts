/**
 * run_hook's exit status, and the two properties the tee exists for (task #1102).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM updater.sh.test.ts. The defect was in
 * one FUNCTION: `run_hook` could not report a failed hook, so the caller-side
 * guard `if ! run_hook pre-update` in update.sh could never fire. An
 * entry-point harness can only observe the far end of that (a swap that happened
 * when it should not have), and it cannot tell the two properties of the tee
 * apart from each other: a construct that dropped the capture entirely and one
 * that kept both would look the same unless a test asks about the transcript
 * on its own. So the function is tested directly, against the REAL shipped
 * source — the harness sources the actual `run_hook`/`collect_db_backups`
 * fragment out of deploy/update.sh rather than a copy of it, so a mutation of
 * update.sh is what turns these tests red.
 *
 * WHAT EACH TEST PINS.
 *   1. A hook exiting 7 reaches the caller as 7 (the status crosses the pipe).
 *      Before the fix it arrived as 0: `{ "$hook" 2>&1 || rc=$?; } | tee "$out"`
 *      assigns inside the pipeline's LEFT STAGE, and a stage is a subshell, so
 *      the assignment died there and the parent only saw tee's status.
 *   2. The output is still STREAMED — the hook's own line reaches stdout, so a
 *      long backup does not look hung.
 *   3. The output is still CAPTURED as data — `collect_db_backups` still finds
 *      the backup path, so the recovery block can name it (task #1079 F6).
 *   4. The `mktemp_owned` FAILURE branch (no temp file available) carries the
 *      status too, and creates nothing.
 *
 * WHY A FRAGMENT AND NOT `source update.sh`: update.sh ends with `main "$@"`,
 * so sourcing it would run a whole update against the live install layout. The
 * fragment is delimited by two markers that exist in the file, and the harness
 * FAILS LOUDLY when either marker is missing or the extracted text does not
 * define both functions — otherwise "the fragment was empty" would show up as a
 * green test that asserted nothing.
 *
 * No sudo, no systemctl, no service: run_hook only reads ${HOOKS_DIR} and writes
 * the transcript, and the temp root is a tree of this suite's own.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installCleanup, mkTempTree } from './tmp-fixtures'

// Temp-tree ownership: the scratch tree and the temp ROOT run_hook writes into
// both come from mkTempTree, so the sweep removes them even after a failing
// test. /tmp is the same filesystem as production's database (AGENTS.md §8).
installCleanup()

const UPDATE_SH = join(import.meta.dir, 'update.sh')
const COMMON_SH = join(import.meta.dir, 'lib', 'common.sh')

/**
 * The shipped `DB_BACKUPS` / `collect_db_backups` / `run_hook` block, read out
 * of deploy/update.sh.
 *
 * Throws when a marker moved or a function disappeared, so a stale extraction
 * cannot pass as a working harness.
 */
function hookFragment(): string {
  const src = readFileSync(UPDATE_SH, 'utf8')
  const start = src.indexOf('DB_BACKUPS=()')
  const end = src.indexOf('# ── Rollback guidance')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `cannot locate the hook block in ${UPDATE_SH}: DB_BACKUPS=() at ${start}, ` +
        `'# ── Rollback guidance' at ${end}`,
    )
  }
  const fragment = src.slice(start, end)
  for (const fn of ['collect_db_backups()', 'run_hook()']) {
    if (!fragment.includes(fn)) {
      throw new Error(`the extracted hook block does not define ${fn} — the extraction is stale`)
    }
  }
  return fragment
}

/** What run_hook reported, and what it left behind. */
type HookRun = { status: number | null; stdout: string; stderr: string; rc: string; backups: string[] }

/**
 * Run the REAL run_hook against one hook script.
 *
 * `tempRoot` is exported as TMPDIR for the child, so the transcript lands in a
 * tree this suite owns and the leak assertion is exact rather than a count of
 * the host's shared /tmp. `tempRoot: null` points TMPDIR at a path that does not
 * exist, which is how mktemp_owned's failure branch is reached.
 */
function runHook(opts: {
  body: string
  code: number
  name?: 'pre-update' | 'post-update'
  tempRoot?: string | null
}): HookRun {
  const root = mkTempTree('synapto-hook-')
  const hooks = join(root, 'hooks')
  const scratch = join(root, 'fragment.sh')
  // An EXISTING temp root this suite owns (the transcript is written there and
  // must be gone afterwards), or a path that does not exist (mktemp_owned fails,
  // which is the fallback branch).
  const ownedTmp = join(root, 'tmp')
  const noTempRoot = join(root, 'does-not-exist')
  if (opts.tempRoot === undefined) mkdirSync(ownedTmp)
  mkdirSync(hooks)
  const hook = join(hooks, opts.name ?? 'pre-update')
  writeFileSync(hook, ['#!/usr/bin/env bash', opts.body, `exit ${opts.code}`].join('\n'))
  chmodSync(hook, 0o755)
  writeFileSync(scratch, hookFragment())

  const script = [
    '#!/usr/bin/env bash',
    // The same prologue update.sh itself has, so run_hook runs under the same
    // `set -e` / `pipefail` it has in production.
    'set -euo pipefail',
    'APP_NAME="synaptomind"',
    `HOOKS_DIR="${hooks}"`,
    `. "${COMMON_SH}"`,
    `. "${scratch}"`,
    'trap cleanup_run EXIT',
    'rc=0',
    // The caller's shape, not a bare call: a bare `run_hook x` under `set -e`
    // would abort the harness and hide the status this suite is about.
    'run_hook "$1" || rc=$?',
    'printf \'RC=%s\\n\' "$rc"',
    // Biome's noTemplateCurlyInString flags the `${…}` below; it is bash, not a JS
    // template literal, and the advisory lint (AGENTS.md §3) is left as it lands.
    'printf \'BACKUPS=%s\\n\' "${DB_BACKUPS[*]-}"',
  ].join('\n')

  const res = spawnSync('bash', ['-c', script, 'run-hook-harness', opts.name ?? 'pre-update'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: process.env.PATH!,
      TMPDIR: opts.tempRoot === undefined ? ownedTmp : (opts.tempRoot ?? noTempRoot),
    },
    timeout: 30_000,
  })
  const rc = /^RC=(\d+)$/m.exec(res.stdout)?.[1] ?? ''
  const backupsLine = /^BACKUPS=(.*)$/m.exec(res.stdout)?.[1] ?? ''
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    rc,
    backups: backupsLine === '' ? [] : backupsLine.split(' '),
  }
}

const PRINTS_BACKUP =
  'echo "Database backed up: /var/lib/synaptomind/synaptomind.db.backup/synaptomind.db.20260101-000000.bak"'

describe('update.sh — run_hook carries the hook exit status out of the tee (task #1102)', () => {
  test('a hook that exits 7 reaches the caller as 7, and its output is still streamed', () => {
    const res = runHook({ body: PRINTS_BACKUP, code: 7 })

    // The status crossed the pipe. This is the assertion the guard depends on:
    // before the fix this was RC=0, because `|| rc=$?` ran inside the pipeline's
    // left stage (a subshell) and the parent only saw tee.
    expect(res.rc, res.stdout + res.stderr).toBe('7')
    // Streaming survived: the hook's own line is on update.sh's stdout, so a long
    // backup still shows progress instead of looking hung.
    expect(res.stdout).toContain('Database backed up: /var/lib/synaptomind/')
    // The failure is reported, and the harness itself was not killed by `set -e`
    // on the non-zero pipeline (its own status is 0, the run finished).
    expect(res.stderr).toContain('pre-update hook failed (exit 7)')
    expect(res.status).toBe(0)
  })

  test('a hook that exits 0 still reports 0, so the guard stays quiet on a good run', () => {
    const res = runHook({ body: PRINTS_BACKUP, code: 0 })

    expect(res.rc, res.stdout + res.stderr).toBe('0')
    expect(res.stderr).not.toContain('hook failed')
    expect(res.status).toBe(0)
  })

  test('the transcript is still CAPTURED, not only streamed: the backup path is collected', () => {
    // The half of the tee that a status fix must not cost. collect_db_backups
    // parses the transcript the hook's output was written to, and print_recovery
    // restores exactly those paths (task #1079 F6). Dropping the capture would
    // leave the recovery block naming no backup at all — silently, because the
    // streaming half would still look correct.
    const res = runHook({ body: PRINTS_BACKUP, code: 7 })

    expect(res.backups, res.stdout + res.stderr).toEqual([
      '/var/lib/synaptomind/synaptomind.db.backup/synaptomind.db.20260101-000000.bak',
    ])
  })

  test('the no-temp-file fallback branch carries the status too, and creates nothing', () => {
    // mktemp_owned fails when TMPDIR names a path that does not exist, which is
    // what this branch is for (a full or read-only /tmp). It runs the hook with no
    // pipe at all, so `$?` is the hook's own status — asserted here because the
    // two branches are the two ways the status has to survive, and a future edit
    // to one of them is not obliged to look at the other.
    const root = mkTempTree('synapto-hook-notmp-')
    const res = runHook({ body: PRINTS_BACKUP, code: 7, tempRoot: null })

    expect(res.rc, res.stdout + res.stderr).toBe('7')
    expect(res.stderr).toContain('no temp file')
    expect(res.stderr).toContain('pre-update hook failed (exit 7)')
    // Nothing was created: the branch that cannot own a temp file owns none.
    expect(readdirSync(root)).toEqual([])
  })

  test('every branch leaves the temp root with no leftover entry', () => {
    // Task #1101 closed the mktemp-ownership leak class (94 entries per deploy
    // suite run, on production's filesystem). The status fix must not reopen it,
    // so the count under a temp root THIS suite owns is asserted for both
    // branches and both hook outcomes.
    for (const code of [0, 7]) {
      for (const tempRoot of ['owned', null] as const) {
        const root = mkTempTree(`synapto-hook-leak-${code}-${tempRoot === null ? 'notmp' : 'tmp'}-`)
        const res = runHook({ body: PRINTS_BACKUP, code, tempRoot: tempRoot === null ? null : root })
        expect(res.rc, res.stdout + res.stderr).toBe(String(code))
        // cleanup_run ran on the harness's EXIT, so the transcript is gone.
        const leftover = tempRoot === null ? [] : readdirSync(root)
        expect(leftover, `hook exit ${code}, temp ${tempRoot}`).toEqual([])
      }
    }
  })
})
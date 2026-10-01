/**
 * app-targets — the production-path tripwire's watch list.
 *
 * WHY THIS FILE. guardProductionPaths() can only report by writing to stderr and
 * setting process.exitCode from an afterAll hook, so a test cannot assert on it
 * directly without reproducing the incident it exists to catch. What IS checkable
 * — and what the false positive of task #1128 was actually about — is WHICH PATHS
 * it watches, so `productionWatchPaths` is exported and pure, and that is what
 * these tests assert.
 *
 * THE DEFECT. The tracker this suite reports through IS the live ziptask service,
 * and its SQLite WAL moves on every task update. #1123/#1124 moved ziptask's
 * config home to DATA_DIR (ADR addendum R1), so the database and settings.json now
 * live in /var/lib/ziptask — which the watch list named, because the list is built
 * from the app name (`/var/lib/<label>`). The first version of the exclusion for
 * this path was the literal `~/.ziptask/data`, which the same move invalidated.
 * Measured: a `DEPLOY_APP_ENVS=…ziptask…` run printed
 *   `DEPLOY SANDBOX VIOLATION: /var/lib/ziptask was MODIFIED by a deploy fixture.`
 * over 52 passing tests, with the only writer the live service handling the agent's
 * own bookkeeping.
 *
 * THE FIX, and what must not regress: the exclusion is DERIVED — a target's
 * DATA_DIR is dropped when that app's unit is live on this host — and it is
 * dropped from the DATA_DIR THE APP.ENV DECLARES, not from a hardcoded
 * `/var/lib/<label>`. A hardcoded path would be the same class of defect waiting
 * for the next config-home move. Everything a fixture could actually escape to
 * (/opt/<app>, the state dir, scripts/, hooks/, the unit, the host's own
 * deploy/app.env) must stay watched, or the #1101 tripwire is decoration.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveServiceDataDirs, productionWatchPaths, type AppTarget } from './app-targets'
import { installCleanup, mkTempTree } from './tmp-fixtures'

installCleanup()

/**
 * The operator's home, resolved the way guardProductionPaths resolves it: from
 * the passwd database, NOT from $HOME.
 *
 * Mirroring the lookup rather than importing it is deliberate — the assertions
 * below are about the watch list holding these exact paths, and a test that
 * imported the same resolver could not disagree with it. tmp-fixtures.ts records
 * why substituting $HOME is not an equivalent shortcut: resolve_target_user()
 * prefers getent, so a $HOME-based expectation would name a path the guard never
 * looks at.
 */
const HOME_DIR = spawnSync('bash', ['-c', 'getent passwd "$(id -un)" | cut -d: -f6'], {
  encoding: 'utf8',
}).stdout.trim()

/**
 * A target with a REAL app.env on disk, which is the only thing
 * liveServiceDataDirs reads. Written rather than borrowed from a repo so the
 * DATA_DIR can be anything — including a path that has nothing to do with the
 * `/var/lib/<label>` convention, which is the point.
 */
function seedTarget(label: string, appEnv: string): AppTarget {
  const deployDir = mkTempTree('synapto-targets-')
  writeFileSync(join(deployDir, 'app.env'), appEnv)
  writeFileSync(join(deployDir, 'install.sh'), '#!/usr/bin/env bash\n')
  return { label, deployDir, appEnvPath: join(deployDir, 'app.env') }
}

/** Every path a target contributes, with the live-service exclusion NOT applied. */
function expectedPaths(target: AppTarget): string[] {
  const label = target.label
  return [
    join('/opt', label),
    join('/var/lib', label),
    join(HOME_DIR, `.${label}`),
    join(HOME_DIR, `.${label}`, 'scripts'),
    join(HOME_DIR, `.${label}`, 'hooks'),
    join('/etc/systemd/system', `${label}.service`),
    join(target.deployDir, 'app.env'),
  ]
}

describe('productionWatchPaths — a live service\'s data dir is not a tripwire', () => {
  test('a live unit drops its DATA_DIR, and only its DATA_DIR', () => {
    const target = seedTarget('ziptask', 'APP_NAME="ziptask"\nDATA_DIR="/var/lib/ziptask"\n')
    const watched = productionWatchPaths([target], (unit) => unit === 'ziptask.service')

    expect(watched).not.toContain('/var/lib/ziptask')
    // Everything else, in order. Asserted as the exact list rather than by
    // subtraction, so a path that quietly DISAPPEARS from the watch list is a
    // failure here rather than a tripwire nobody notices is gone.
    expect(watched).toEqual(expectedPaths(target).filter((p) => p !== '/var/lib/ziptask'))
  })

  test('an inactive unit keeps its DATA_DIR watched', () => {
    // The asymmetry is the design: a stopped service writes nothing, so there is
    // nothing to exclude, and the loud direction is the one that matters.
    const target = seedTarget('ziptask', 'APP_NAME="ziptask"\nDATA_DIR="/var/lib/ziptask"\n')
    const watched = productionWatchPaths([target], () => false)

    expect(watched).toEqual(expectedPaths(target))
  })

  test('the exclusion follows the DATA_DIR the app.env declares, not /var/lib/<label>', () => {
    // If this test ever fails, the exclusion has become a hardcoded convention —
    // and the next app to move its config home (or to use a data dir that is not
    // under /var/lib) silently loses its tripwire. This is the same defect class
    // as the `~/.ziptask/data` literal that #1123 invalidated.
    const target = seedTarget('oddapp', 'APP_NAME="oddapp"\nDATA_DIR="/srv/oddapp-state"\n')
    const watched = productionWatchPaths([target], () => true)

    expect(watched).not.toContain('/srv/oddapp-state')
    // And the conventional path is NOT excluded for an app that does not use it:
    // a fixture writing /var/lib/oddapp is still an escape.
    expect(watched, '/var/lib/<label> must stay watched when the app.env says otherwise').toContain(
      '/var/lib/oddapp',
    )
  })

  test('a path UNDER a live data dir is excluded too', () => {
    const target = seedTarget('ziptask', 'APP_NAME="ziptask"\nDATA_DIR="/var/lib/ziptask"\n')
    const watched = productionWatchPaths([target], () => true)

    expect(watched.some((p) => p.startsWith('/var/lib/ziptask/'))).toBe(false)
  })

  test('an app.env that cannot be sourced leaves the path WATCHED', () => {
    // Fail loud. If the DATA_DIR cannot be read, "is this a live service's data
    // dir" is unknown — and the unknown case must not become the quiet one.
    const target = seedTarget('brokenapp', 'APP_NAME="brokenapp"\nDATA_DIR="${NOT_SET_ANYWHERE}"\n')
    const watched = productionWatchPaths([target], () => true)

    expect(liveServiceDataDirs([target], () => true)).toEqual([])
    expect(watched).toEqual(expectedPaths(target))
  })

  test("the host's own deploy/app.env is watched whether or not the service is live", () => {
    // The file #1101 overwrote, and the only path in the list that is a FILE
    // rather than a tree. Dropping it would disable the original tripwire while
    // every test stayed green.
    for (const isLive of [() => true, () => false]) {
      const target = seedTarget('ziptask', 'APP_NAME="ziptask"\nDATA_DIR="/var/lib/ziptask"\n')
      expect(productionWatchPaths([target], isLive)).toContain(join(target.deployDir, 'app.env'))
    }
  })

  test('each target is decided on its own unit', () => {
    // Two targets, one live: the live one's data dir is dropped and the other's is
    // not. A guard that keyed on "any service is live" would blind itself to every
    // other app on the host.
    const live = seedTarget('liveapp', 'APP_NAME="liveapp"\nDATA_DIR="/var/lib/liveapp"\n')
    const idle = seedTarget('idleapp', 'APP_NAME="idleapp"\nDATA_DIR="/var/lib/idleapp"\n')
    const watched = productionWatchPaths([live, idle], (unit) => unit === 'liveapp.service')

    expect(watched).not.toContain('/var/lib/liveapp')
    expect(watched).toContain('/var/lib/idleapp')
  })
})

// ── The host this actually runs on ───────────────────────────────────────────
//
// The derivation above is only worth anything if it holds for the real services
// on this host, and the AC for this task is about one of them specifically. These
// two tests therefore ask the real question with the real probe, and SKIP (with
// the reason recorded) where the app is not installed — a fresh container must
// report `skip`, not a vacuous pass.

const ZIPTASK_DEPLOY = '/mnt/external/zum/PROJECTS/local/ziptask/deploy'

describe('productionWatchPaths — the live ziptask service on this host', () => {
  const installed = existsSync(join(ZIPTASK_DEPLOY, 'app.env'))
  const live = spawnSync('systemctl', ['is-active', '--quiet', 'ziptask.service'], { encoding: 'utf8' }).status === 0

  test.skipIf(!installed || !live)(
    'its DATA_DIR is not watched, while the paths a fixture would escape to are',
    () => {
      const target: AppTarget = {
        label: 'ziptask',
        deployDir: ZIPTASK_DEPLOY,
        appEnvPath: join(ZIPTASK_DEPLOY, 'app.env'),
      }
      expect(liveServiceDataDirs([target])).toEqual(['/var/lib/ziptask'])
      const watched = productionWatchPaths([target])
      expect(watched, 'the false positive of task #1128').not.toContain('/var/lib/ziptask')
      for (const path of [
        '/opt/ziptask',
        join(HOME_DIR, '.ziptask'),
        join(HOME_DIR, '.ziptask', 'scripts'),
        join(HOME_DIR, '.ziptask', 'hooks'),
        '/etc/systemd/system/ziptask.service',
        join(ZIPTASK_DEPLOY, 'app.env'),
      ]) {
        expect(watched, `${path} must stay watched`).toContain(path)
      }
    },
  )

  test.skipIf(!installed)('the watch list is what the app.env declares, read from the real file', () => {
    // The service's data dir really does hold the state the tracker writes: this
    // is the path the R1 config home put the database and settings.json in, and
    // therefore the path that moves on every task update.
    const target: AppTarget = {
      label: 'ziptask',
      deployDir: ZIPTASK_DEPLOY,
      appEnvPath: join(ZIPTASK_DEPLOY, 'app.env'),
    }
    const dirs = liveServiceDataDirs([target], () => true)
    expect(dirs).toEqual(['/var/lib/ziptask'])
    expect(existsSync(join(dirs[0], 'ziptask.db')), 'the live database is in that directory').toBe(true)
  })
})

// ── The composition itself ───────────────────────────────────────────────────

describe('productionWatchPaths — the list as a whole', () => {
  test('no targets means nothing watched, which is what CI sees by default', () => {
    // DEPLOY_APP_ENVS unset is the default, so the default run watches no host
    // path at all. Asserted because "the guard found nothing" and "the guard
    // watched nothing" are the same green.
    expect(productionWatchPaths([])).toEqual([])
  })

  test('the list holds each path once, with no empties', () => {
    // A duplicated entry costs a second fingerprint walk of a live tree, and an
    // empty path would fingerprint `''` — which exists, is a directory, and reads
    // as "the whole current directory" to readdirSync.
    const target = seedTarget('ziptask', 'APP_NAME="ziptask"\nDATA_DIR="/var/lib/ziptask"\n')
    const watched = productionWatchPaths([target], () => true)
    expect(new Set(watched).size).toBe(watched.length)
    expect(watched.filter((p) => p === '')).toEqual([])
  })
})

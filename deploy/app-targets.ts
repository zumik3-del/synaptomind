/**
 * Where the framework suite finds the apps it has to prove itself against.
 *
 * WHY THIS EXISTS. The deploy/ framework is vendored: synaptomind is its home
 * repo and its test suite, and ziptask (#1110) and subagentix (#1111) each got a
 * `deploy/` COPY plus their own `deploy/app.env`. Neither vendored the suite —
 * deliberately, because those suites are hardwired to `APP="synaptomind"`, to
 * synaptomind's raw URL and to the `~/.synaptomind` tripwire, and dropping them
 * into those repos would turn a 400-test `bun test` into a ~2000-test one that
 * fails for reasons that have nothing to do with the app under test.
 *
 * So the conformance proof has to travel the other way: from the framework's
 * home suite to the OTHER repos' real app.env files. `DEPLOY_APP_ENVS` is how it
 * says where they are:
 *
 *     DEPLOY_APP_ENVS='subagentix=/path/to/subagentix/deploy,ziptask=/path/to/ziptask/deploy' \
 *       bun test ./deploy/app-env-conformance.test.ts
 *
 * Unset (the default, and therefore what CI sees) means "no target": every
 * app-env describe reports SKIPPED, and the suite's own result is unchanged. That
 * is deliberate — an absolute path hardwired into the repo would either be wrong
 * on every other machine or, worse, resolve to some other checkout and pass
 * against the wrong app.
 *
 * WHY A MISSING TARGET IS A FAILURE AND NOT A SKIP. A skip is honest about "this
 * environment has nothing to check" and dishonest about "I named a path and it
 * was wrong". `unresolvedTargets()` keeps the two apart: the app-env suites are
 * gated on RESOLVED targets, and `checkCoverage()` — which always runs — turns
 * every requested-but-unresolved path into a failed assertion. A typo in
 * DEPLOY_APP_ENVS cannot come back green.
 *
 * WHY OVERRIDES ARE APPLIED TO THE FILE, NOT THE ENVIRONMENT. `load_app_env()`
 * SOURCES app.env, so a plain assignment there WINS over the process
 * environment — `RUN_DIR=""` in ziptask's app.env resets whatever the caller set.
 * Both new app.envs carry `RUN_DIR=""` (meaning "${HOME}/.app"), and
 * `resolve_target_user()` then falls back to `getent passwd`, i.e. the operator's
 * REAL ~/.ziptask / ~/.subagentix. That is precisely the #1101 incident (a
 * fixture overwrote the live app.env). So the sandbox lives in the app.env COPY:
 * every path the scripts write to is redirected into the fixture root here, and
 * `assertSandboxed` refuses to emit an override that points anywhere else. The
 * `guardRealStateDir()` tripwire in each suite verifies from the outside that
 * the real state dir did not move.
 */

import { afterAll } from 'bun:test'
import { readAppEnvValues } from './app-env-targets'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** One app whose real `deploy/app.env` a sandboxed install will be run against. */
export interface AppTarget {
  /** Short label from DEPLOY_APP_ENVS (e.g. "subagentix"). */
  label: string
  /** Absolute path of the app's deploy/ directory. */
  deployDir: string
  /** The app.env this target means. Always `<deployDir>/app.env`. */
  appEnvPath: string
}

export interface TargetResolution {
  /** Targets that exist and carry both app.env and install.sh, in request order. */
  resolved: AppTarget[]
  /** Every label named in DEPLOY_APP_ENVS, resolved or not. */
  requested: string[]
  /** `label=path` entries that did not resolve, with the reason. */
  unresolved: string[]
}

/** The raw DEPLOY_APP_ENVS value; '' when unset or empty. */
function appEnvsSpec(): string {
  return process.env.DEPLOY_APP_ENVS?.trim() ?? ''
}

/**
 * A target is only usable when it carries BOTH app.env and install.sh.
 *
 * install.sh is what a sandboxed install actually runs; app.env is what the
 * point of the exercise is. A deploy/ directory missing either is a partial
 * vendoring (which is a real state these repos have been in), and treating it as
 * a target would make the suite assert against a DEFAULTED app.env and pass —
 * the vacuous pass this file exists to prevent.
 */
function probe(label: string, dir: string): AppTarget | string {
  if (!isAbsolute(dir)) return `${label}=${dir} (not an absolute path)`
  if (!existsSync(join(dir, 'app.env'))) return `${label}=${dir} (no app.env)`
  if (!existsSync(join(dir, 'install.sh'))) return `${label}=${dir} (no install.sh)`
  return { label, deployDir: dir, appEnvPath: join(dir, 'app.env') }
}

/**
 * Parse DEPLOY_APP_ENVS into targets. Malformed entries become `unresolved`
 * rather than being dropped, so they surface through checkCoverage().
 */
export function resolveTargets(): TargetResolution {
  const out: TargetResolution = { resolved: [], requested: [], unresolved: [] }
  const spec = appEnvsSpec()
  if (!spec) return out
  for (const raw of spec.split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    const eq = entry.indexOf('=')
    if (eq <= 0) {
      out.unresolved.push(`${entry} (expected label=/absolute/path/to/deploy)`)
      continue
    }
    const label = entry.slice(0, eq).trim()
    const dir = entry.slice(eq + 1).trim()
    out.requested.push(label)
    const found = probe(label, dir)
    if (typeof found === 'string') out.unresolved.push(found)
    else out.resolved.push(found)
  }
  return out
}

/**
 * The always-on assertion that keeps an env-var-driven suite honest.
 *
 * Returns the labels that were actually exercised. Throws (i.e. fails the test)
 * when DEPLOY_APP_ENVS named something that did not resolve: a suite that was
 * ASKED to prove an app and quietly proved none is the failure mode an opt-in
 * cross-repo suite is most exposed to.
 */
export function checkCoverage(resolution: TargetResolution, exercised: string[]): string[] {
  const missing = resolution.requested.filter((label) => !exercised.includes(label))
  if (missing.length > 0) {
    throw new Error(
      `DEPLOY_APP_ENVS named ${missing.join(', ')} but no test exercised it.\n` +
        `  requested: ${resolution.requested.join(', ') || '(none)'}\n` +
        `  unresolved: ${resolution.unresolved.join('; ') || '(none)'}\n` +
        `  exercised:  ${exercised.join(', ') || '(none)'}\n` +
        `  A requested target that resolves to nothing would leave this suite green\n` +
        `  while proving nothing about that app.`,
    )
  }
  const missingFiles = resolution.unresolved.filter((e) => /no app\.env|no install\.sh/.test(e))
  if (missingFiles.length > 0) {
    throw new Error(`DEPLOY_APP_ENVS pointed at an incomplete deploy/ directory: ${missingFiles.join('; ')}`)
  }
  return exercised
}

// App.env parsing and sandbox helpers live in ./app-env-targets.

// ── Production-path containment ──────────────────────────────────────────────

/**
 * Fingerprint the HOST paths a sandboxed install would write if it escaped, and
 * fail the process if any of them moved.
 *
 * WHY NOT JUST ASSERT IN THE REPORT. Every test in these two suites already
 * redirects INSTALL_DIR / DATA_DIR / RUN_DIR into a temp tree, and `bun test`
 * passing is not evidence that the redirection held: #1101 was a green suite that
 * had overwritten the operator's live `app.env` (`deploy/tmp-fixtures.ts` records
 * the incident and the reasoning). The failure was invisible from inside because
 * a fixture asserts on ITS OWN scratch tree while the damage is somewhere else
 * entirely. So containment has to be checked from the outside, at exit.
 *
 * WHY THIS LIST AND NOT `guardRealStateDir()`. That helper guards `~/.synaptomind`,
 * which is this repo's app — correct for the framework suite and useless for
 * ziptask and subagentix, whose installs would land in `~/.ziptask` and
 * `~/.subagentix`. The list itself is built by productionWatchPaths() below, and
 * it is exactly the paths RUN_DIR, INSTALL_DIR, DATA_DIR and HOOKS_DIR resolve to
 * on this host for every resolved target, plus the host service tree.
 *
 * WHAT IS DELIBERATELY EXCLUDED, AND WHY IT IS NOT A CONSTANT. A path that a
 * LIVE, out-of-sandbox service legitimately writes cannot be fingerprinted: it
 * moves under the suite for reasons that have nothing to do with any fixture.
 * The first version of this file already knew that and excluded one such path
 * (`~/.ziptask/data`) by name, because the tracker these suites report through IS
 * the live ziptask service and its WAL changes on every task update. That
 * exclusion became wrong rather than useless when #1123/#1124 moved ziptask's
 * config home to DATA_DIR (ADR addendum R1): the database and settings.json now
 * live in /var/lib/ziptask, so the path that moves on every task update is
 * /var/lib/ziptask itself — the very entry this list watches. Measured, not
 * argued: a run with `DEPLOY_APP_ENVS=…ziptask…` reported
 *   `DEPLOY SANDBOX VIOLATION: /var/lib/ziptask was MODIFIED by a deploy fixture`
 * over 52 passing tests, with the only writer the live service persisting the
 * agent's own tracker bookkeeping.
 *
 * So the exclusion is DERIVED (`liveServiceDataDirs`) rather than hardcoded: a
 * target's DATA_DIR is dropped from the watch list when that app's unit is
 * actually running on this host. Hardcoding a path would have been a second
 * #1124 waiting to happen — the next ADR that moves a config home would leave
 * the exclusion pointing at an empty directory and the false positive would come
 * back under a new name.
 *
 * WHAT THE GUARD KEEPS WATCHING, which is the half that matters: /opt/<app>, the
 * state dir and its scripts/ and hooks/ (the paths install_helper_scripts and
 * install_hook_scripts write), the unit file, and the host's own deploy/app.env —
 * the file #1101 overwrote. Those are the paths a fixture could escape to, and
 * none of them is written by a running service.
 *
 * THE FAILURE DIRECTION. When a target's unit cannot be found (no systemctl, a
 * CI container) or its app.env cannot be sourced, the path stays WATCHED. The
 * blind case is a stopped unit and a false alarm; the loud case is a #1101. That
 * asymmetry is the whole design, so it is worth stating rather than leaving to a
 * reader who assumes the exclusion is unconditional.
 */
export function guardProductionPaths(targets: readonly AppTarget[]): void {
  const watched = productionWatchPaths(targets)
  const before = new Map<string, string | null>()
  for (const path of watched) before.set(path, fingerprintOrNull(path))
  const verify = () => {
    for (const [path, hash] of before) {
      const after = fingerprintOrNull(path)
      if (after !== hash) {
        process.stderr.write(
          `\n!!! DEPLOY SANDBOX VIOLATION: ${path} was ${after === null ? 'CREATED' : 'MODIFIED'} by a deploy fixture.\n` +
            `    This is the #1101 failure mode: an install escaped its temp tree and wrote\n` +
            `    to the host's production path. The suite's own assertions cannot see it.\n\n`,
        )
        process.exitCode = 1
      }
    }
  }
  // `afterAll`, not `process.on('exit')`: measured on bun 1.4.2, `bun test` never
  // runs an exit handler, so an exit-only containment check is decoration — it
  // cannot fail a run. See the note on tmp-fixtures.installCleanup, which was
  // written the same way and had the same dead tripwire.
  afterAll(verify)
  process.on('exit', verify)
}

function homeDir(): string {
  const home = spawnSync('bash', ['-c', 'getent passwd "$(id -un)" | cut -d: -f6'], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  return home.stdout?.trim() || process.env.HOME || '/root'
}

/**
 * Is this app's unit actually running on this host?
 *
 * `systemctl is-active --quiet` answers through its exit status (0 active), which
 * is the interface a `--no-service`-style caller branches on. A missing systemctl
 * answers false, and false means "nothing is writing there", so the watch list
 * stays armed — the loud direction, deliberately (see the header).
 */
function unitIsLive(unit: string): boolean {
  const res = spawnSync('systemctl', ['is-active', '--quiet', unit], { encoding: 'utf8', timeout: 10_000 })
  if (res.error) return false
  return res.status === 0
}

/**
 * The DATA_DIR of every target whose service is live here — the directories a
 * running process owns and writes, which therefore cannot be tripwires.
 *
 * Read from the target's REAL app.env rather than assumed to be `/var/lib/<label>`:
 * a fixture only has to be prevented from writing where the app's own app.env says
 * the app writes. An app.env that cannot be sourced contributes nothing, and its
 * `/var/lib/<label>` therefore stays watched — same asymmetry as unitIsLive.
 */
export function liveServiceDataDirs(
  targets: readonly AppTarget[],
  isLive: (unit: string) => boolean = unitIsLive,
): string[] {
  const dirs: string[] = []
  for (const target of targets) {
    if (!isLive(`${target.label}.service`)) continue
    let dataDir: string | undefined
    try {
      dataDir = readAppEnvValues(target.appEnvPath).DATA_DIR
    } catch {
      continue
    }
    const trimmed = dataDir?.replace(/\/+$/, '')
    if (trimmed && !dirs.includes(trimmed)) dirs.push(trimmed)
  }
  return dirs
}

/**
 * The paths guardProductionPaths fingerprints, in order.
 *
 * Exported (and pure) so the composition can be asserted directly: the tripwire
 * itself can only report by writing to stderr and setting process.exitCode, which
 * is a poor thing to test and an easy thing to get wrong. What the tests need to
 * know is which paths are in the list, and a list is checkable.
 *
 * `isLive` is injectable so the composition is testable on a host that is not
 * running the app under test — see ./app-targets.test.ts.
 */
export function productionWatchPaths(
  targets: readonly AppTarget[],
  isLive: (unit: string) => boolean = unitIsLive,
): string[] {
  const live = liveServiceDataDirs(targets, isLive)
  const watched: string[] = []
  for (const target of targets) {
    const label = target.label
    for (const path of [
      join('/opt', label),
      join('/var/lib', label),
      join(homeDir(), `.${label}`),
      join(homeDir(), `.${label}`, 'scripts'),
      join(homeDir(), `.${label}`, 'hooks'),
      join('/etc/systemd/system', `${label}.service`),
      // The host app.env itself, which is the file the whole delivery mechanism
      // reads and the one #1101 overwrote.
      join(target.deployDir, 'app.env'),
    ]) {
      // A live service's own data dir, and anything under it, is not a tripwire.
      if (live.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue
      watched.push(path)
    }
  }
  return watched
}

/**
 * size + mtime + sha256 of every file under `path`, or null when absent.
 *
 * All three, for the same reasons tmp-fixtures.fingerprint uses them: a rewrite
 * with identical bytes still moves the mtime, and an append keeps the size.
 */
function fingerprintOrNull(path: string): string | null {
  if (!existsSync(path)) return null
  const hash = createHash('sha256')
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs, childRel)
        continue
      }
      const st = statSync(abs)
      hash.update(`${childRel} ${st.size} ${st.mtimeMs} `)
      hash.update(readFileSync(abs))
    }
  }
  try {
    const st = statSync(path)
    hash.update(`${path} ${st.mode} ${st.mtimeMs} `)
    if (st.isDirectory()) walk(path, '')
    else hash.update(readFileSync(path))
  } catch (err) {
    return `unreadable:${(err as Error).message}`
  }
  return hash.digest('hex')
}

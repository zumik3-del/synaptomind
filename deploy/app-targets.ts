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
export function appEnvsSpec(): string {
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

// ── app.env handling ─────────────────────────────────────────────────────────

/**
 * The assignment KEYS an app.env declares, read from its text.
 *
 * Deliberately the FILE's keys and not `compgen -v`'s. Sourcing app.env inside
 * the test process's own environment would report every inherited variable too
 * — the first draft of this helper returned 60+ keys for a 30-key app.env, all
 * but 30 of them BASHOPTS/AGENT/PWD and friends, and every downstream
 * "this app.env declares X" assertion became a lookup that could not fail.
 * The declared keys are what an app.env is accountable for.
 */
export function appEnvKeys(appEnvPath: string): string[] {
  const keys: string[] = []
  for (const line of readFileSync(appEnvPath, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line)
    if (m) keys.push(m[1])
  }
  return keys
}

/**
 * The VALUES app.env assigns to its own keys, read by SOURCING it in bash.
 *
 * The values are not parsed in TypeScript. app.env is shell: a value may be
 * double-quoted, or single-quoted to keep a `${APP_NAME}` template unexpanded
 * (ziptask's ASSET_PATTERN and APP_VERSION_CMD both are), and a regexp over that
 * would have to re-implement shell quoting to be right. Bash is the reference
 * implementation and is already a dependency of these suites.
 *
 * Only the keys the file declares are read back, and the read happens in a
 * CLEAN environment: an inherited INSTALL_DIR or DIST would otherwise be
 * reported as one of the app's own values, and a test asserting "this app.env
 * does not set INSTALL_DIR" would be reading the test runner's.
 */
export function readAppEnvValues(appEnvPath: string): Record<string, string> {
  const keys = appEnvKeys(appEnvPath)
  if (keys.length === 0) throw new Error(`${appEnvPath} declares no keys`)
  // NUL-separated, not newline-separated: a value may legitimately contain a
  // newline (a multi-line PEM in an env file), and a newline-separated read
  // would silently truncate it and report the tail as an unrelated key.
  const res = spawnBash(
    `set -u; . "$1"; for k in $2; do printf '%s=%s\\0' "$k" "\${!k-}"; done`,
    [appEnvPath, keys.join(' ')],
  )
  if (res.status !== 0) {
    throw new Error(`cannot source ${appEnvPath}: ${res.stderr.trim() || res.stdout.trim()}`)
  }
  const values: Record<string, string> = {}
  for (const record of res.stdout.split('\0')) {
    if (!record) continue
    const eq = record.indexOf('=')
    if (eq < 0) continue
    values[record.slice(0, eq)] = record.slice(eq + 1)
  }
  const absent = keys.filter((k) => !(k in values))
  if (absent.length > 0) throw new Error(`${appEnvPath}: keys vanished while sourcing: ${absent.join(', ')}`)
  return values
}

/**
 * The app.env text with `overrides` applied, comments and everything else kept.
 *
 * A key already present has its WHOLE line replaced (the assignment, never the
 * comments around it); a key that is absent is appended. Rewriting the file
 * rather than the environment is load-bearing — see the header note on
 * load_app_env() sourcing app.env over the caller's environment.
 *
 * New values are double-quoted. `quote()` rejects a value that would change
 * meaning inside double quotes (`"`, `$`, a backtick), so an override can never
 * smuggle a substitution into the app.env it is written into.
 */
export function sandboxAppEnvText(appEnvPath: string, overrides: Record<string, string>): string {
  const lines = readFileSync(appEnvPath, 'utf8').split('\n')
  const pending = new Map<string, string>()
  for (const [key, value] of Object.entries(overrides)) {
    pending.set(key, `${key}=${quote(value)}`)
  }
  const out: string[] = []
  for (const line of lines) {
    const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line)
    const replacement = m ? pending.get(m[1]) : undefined
    if (replacement !== undefined) {
      out.push(replacement)
      pending.delete(m?.[1] ?? '')
    } else {
      out.push(line)
    }
  }
  for (const line of pending.values()) out.push(line)
  return out.join('\n')
}

/**
 * POSIX single-quoting for a double-quoted shell value's interior — which is
 * what every app.env key here uses, and what makes an override's text survive
 * as literal characters.
 *
 * `"`, `$` and a backtick are refused rather than escaped. An escape would
 * silently change the value the framework reads, and a test asserting on the
 * app's own keys would then be asserting on a fixture's rewrite of them. The
 * overrides this helper ever receives are temp paths and health URLs.
 *
 * A NEWLINE is deliberately allowed: two of the unit-extra rejection tests set a
 * value that systemd's parser would fold, and a quote() that refused it would
 * make those tests assert about a value the app could never actually ship.
 */
function quote(value: string): string {
  if (/["$`]/.test(value)) {
    throw new Error(
      `sandbox override refuses the value ${JSON.stringify(value)}: " $ \` change meaning inside double quotes`,
    )
  }
  return `"${value}"`
}

/**
 * Every path-shaped override must land inside the fixture root.
 *
 * The check is against the fixture root AND the host's real application
 * directories, because those are the two ways a sandbox escapes: an override
 * computed from the wrong root, and an override copied verbatim out of a shipped
 * app.env (/opt/<app>, /var/lib/<app>). Throwing at BUILD time is the point —
 * by the time a script has written to a host path, the write already happened.
 */
export function assertSandboxed(
  overrides: Record<string, string>,
  root: string,
  keys: readonly string[],
  forbidden: readonly string[],
): void {
  const realRoot = root.endsWith('/') ? root.slice(0, -1) : root
  for (const key of keys) {
    const value = overrides[key]
    if (value === undefined || value === '') continue
    if (!value.startsWith(`${realRoot}/`) && value !== realRoot) {
      throw new Error(`sandbox override ${key}=${value} is outside the fixture root ${realRoot}`)
    }
    for (const bad of forbidden) {
      if (value === bad || value.startsWith(`${bad}/`)) {
        throw new Error(`sandbox override ${key}=${value} points at the host path ${bad}`)
      }
    }
  }
}

/** Minimal `bash -c` wrapper, so the file needs no child_process import elsewhere. */
function spawnBash(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bash', ['-c', script, 'app-targets', ...args], { encoding: 'utf8', timeout: 30_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

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
 * `~/.subagentix`. The paths below are exactly the ones RUN_DIR, INSTALL_DIR,
 * DATA_DIR and HOOKS_DIR resolve to on this host for every resolved target, plus
 * the host service tree.
 *
 * WHAT IS DELIBERATELY EXCLUDED: `~/.ziptask/data`. The tracker these suites are
 * reporting through is the live ziptask service, and its SQLite WAL changes on
 * every task update — fingerprinting it would make the tripwire fire on the
 * agent's own bookkeeping. The write paths under test are `scripts/` and `hooks/`
 * (install_helper_scripts / install_hook_scripts); a database the running service
 * owns is not one of them.
 */
export function guardProductionPaths(targets: readonly AppTarget[]): void {
  const watched: string[] = []
  for (const target of targets) {
    const label = target.label
    watched.push(
      join('/opt', label),
      join('/var/lib', label),
      join(homeDir(), `.${label}`),
      join(homeDir(), `.${label}`, 'scripts'),
      join(homeDir(), `.${label}`, 'hooks'),
      join('/etc/systemd/system', `${label}.service`),
      // The host app.env itself, which is the file the whole delivery mechanism
      // reads and the one #1101 overwrote.
      join(target.deployDir, 'app.env'),
    )
  }
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
  const passwd = spawnBash(`getent passwd "$(id -un)" | cut -d: -f6`, [])
  return passwd.stdout.trim() || process.env.HOME || '/root'
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

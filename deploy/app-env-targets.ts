/** App.env parsing and sandbox override helpers for deploy conformance tests. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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

function spawnBash(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bash', ['-c', script, 'app-targets', ...args], { encoding: 'utf8', timeout: 30_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
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

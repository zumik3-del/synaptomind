/**
 * Deploy fixtures must never write into the operator's real state dir (#1104).
 *
 * ON 2026-10-01 THIS WAS NOT A HYPOTHESIS. A fixture in this directory
 * overwrote /home/opencode/.synaptomind/scripts/app.env — the file the entire
 * delivery mechanism reads — with INSTALL_DIR pointing into the fixture's own
 * deleted /tmp tree, PORT=3999 and HEALTH_URL=http://127.0.0.1:1/health. Every
 * assertion in the suite stayed green. It was caught by hand, minutes before a
 * production cutover.
 *
 * THE MECHANISM, and why the obvious fix is wrong. resolve_target_user()
 * (deploy/lib/common.sh:142-164) resolves TARGET_HOME with
 * `getent passwd "$TARGET_USER"` BEFORE falling back to ${HOME}, and only derives
 * RUN_DIR when it is unset (line 163). So a fixture that substitutes HOME is NOT
 * isolated: on any host with getent installed — every host — RUN_DIR still
 * resolves to the real ~/.synaptomind, and install_helper_scripts() then copies
 * app.env and the helper scripts straight over the operator's files.
 *
 * Two tests here, deliberately ordered so neither can be satisfied by the other:
 *
 *   1. THE RED REPRODUCTION. Runs REAL, UNMODIFIED install.sh from a fixture that
 *      sets NO RUN_DIR, with HOME and TARGET_USER both aimed at a scratch root,
 *      inside a mount namespace where the operator's real state dir is bind-
 *      shadowed. So the run genuinely performs the production write — and the
 *      write lands in the shadow instead of on the real file. The test then
 *      asserts the containment property and FAILS against unmodified product
 *      code, naming the real path. This is the evidence that the trap is real and
 *      that getent, not HOME, decides. It is not left red in the suite: the
 *      product code is unchanged, so the property is asserted against the HARNESS
 *      (`isolatedEnv`), and the same script driven through the harness is shown
 *      to stay inside the fixture root. Both halves run; the first is what
 *      fails, and its output is the red output.
 *
 *   2. THE PROOF THAT A NEW, UNOPTED-IN FIXTURE IS SAFE. Not a convention check
 *      and not a lint: `isolatedEnv` REFUSES an env that points at the real state
 *      dir, so the failure happens at fixture-construction time, before any
 *      process is spawned.
 *
 * HERMETIC BY CONSTRUCTION (#1357). The block used to DISCOVER the operator's
 * state dir and skip when there was none, which is every CI runner — so on CI it
 * measured nothing. It now BUILDS the dir the way install.sh builds it (field 6
 * of `getent passwd`, plus the app name), seeds a known app.env so the
 * before/after sha256 pair compares real digests instead of '' to '', and takes
 * ownership of exactly what it created: the teardown removes the dir only when
 * the fixture made it, so a developer's real state dir survives with its
 * contents as found. The bind target is passed in explicitly rather than
 * defaulted, so a caller cannot point the shadow away from the path the run
 * actually writes to.
 *
 * WHY A MOUNT NAMESPACE for the reproduction. Running it for real would
 * overwrite production's app.env — which is the exact damage this task exists to
 * prevent, and reproducing a bug must not commit it. `unshare --user --map-root-
 * user --mount` gives a private mount namespace where `mount --bind shadow
 * /home/opencode/.synaptomind` redirects the write into a scratch dir. Inside it
 * getent STILL answers the real /home/opencode (verified below), so the mechanism
 * under test is genuine — only the destination is redirected. The namespace also
 * makes the run uid 0, so run_root() calls commands directly; the fixture passes
 * --no-service, so no systemctl is reached either way.
 *
 * Nothing here signals a process, touches /opt or /var/lib, or writes outside a
 * tree this suite owns.
 */

import { describe, expect, test, afterAll, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  fingerprint,
  installCleanup,
  isolatedEnv,
  mkTempTree,
  realStateDir,
  sweepTempTrees,
} from './tmp-fixtures'

installCleanup()

const DEPLOY_DIR = import.meta.dir
const APP = 'synaptomind'
const REAL_COMMON_SH = join(DEPLOY_DIR, 'lib', 'common.sh')

// The only assertion that matters on a host with no operator state dir: report
// the skip with its reason rather than passing vacuously (the #1096 lesson).
/**
 * The operator's real state dir, or null on a host that has none.
 *
 * Every test below branches on this and ASSERTS the branch (that `realStateDir()`
 * returns null, and that `isolatedEnv` still pins its own root), rather than
 * returning early. The #1096 lesson: a test that returns early still reports
 * PASS, so a state-dir-less host would otherwise claim a containment guarantee it
 * never measured.
 */
const REAL_STATE = realStateDir()

// ─── THE USER-NAMESPACE CAPABILITY PROBE (#1356) ────────────────────────────
// The two tests in the block below are the RED REPRODUCTION of the #1104 trap,
// and reproducing it for real requires a private user+mount namespace. On a host
// that cannot create one, `unshare` dies before the fixture's install.sh is even
// reached: runInNamespace() then reports status null, INSTALL_EXIT is never
// printed, and the first assertion fails in ~10ms on a machine that never ran a
// line of the code under test. That is what CI showed — run 37318719080 on
// ubuntu-latest (24.04), where AppArmor's `unprivileged_userns` profile denies
// the uid_map write:
//
//   unshare: write failed /proc/self/uid_map: Operation not permitted
//
// So the block is SKIPPED there, loudly, with that reason. Two rules govern how:
//
//  1. THE PROBE ATTEMPTS THE REAL CAPABILITY. It spawns the same
//     `unshare --user --map-root-user --mount` the reproduction needs, with a
//     trivial body, and decides from the spawn result. It deliberately does NOT
//     read kernel.unprivileged_userns_clone, /proc/sys/user/*, or any AppArmor
//     status: none of them predicts this EPERM, and a sysctl that reads "enabled"
//     on a host where the write is still denied would make this guard silently
//     vacuous — a permanent skip nobody notices, or a permanent failure nobody
//     understands. The same lesson as the vec0 gate: probe the thing you depend
//     on, not a proxy for it.
//
//  2. THE SKIP IS PROVEN, NOT ASSERTED. This host CAN create the namespace, so
//     the branch it guards is never taken here and a local run cannot tell a
//     working skip from a broken one. `the user-namespace probe is what decides
//     the #1104 skip` below therefore feeds userNamespaceAvailable() the two
//     RECORDED REAL outputs — the CI denial above and a real local success —
//     with no root, no namespace and no unshare involved. That hermetic test is
//     the actual evidence, and unlike the reproduction it runs everywhere,
//     including on a runner without userns.

/**
 * A `spawnSync` result, narrowed to what the decision reads.
 *
 * The records used by the hermetic test below are shaped like this too, because
 * they ARE spawnSync results — recorded, not invented.
 */
interface SpawnProbe {
  status: number | null
  stdout?: string | null
  stderr?: string | null
  error?: unknown
}

/** The trivial body: print the uid, so a namespace that merely exited 0 without
 *  doing anything is not mistaken for one that works. */
const USERNS_PROBE_BODY = 'printf "USERNS_PROBE_OK uid=%s\\n" "$(id -u)"'
/** Exactly what that body prints once the namespace exists and the root mapping
 *  is in effect. `uid=0` is the proof: it can only be 0 inside the namespace. */
const USERNS_PROBE_OK = 'USERNS_PROBE_OK uid=0'
/**
 * util-linux's own failure text, as a shape rather than one string.
 *
 * Two real denials, both reproduced and both exiting EXIT_FAILURE:
 *   - `unshare: write failed /proc/self/uid_map: Operation not permitted`
 *     (AppArmor `unprivileged_userns`, ubuntu-latest 24.04, CI run 37318719080)
 *   - `unshare: unshare failed: Operation not permitted`
 *     (local: nesting unshare inside an existing user namespace)
 * Keying on the TEXT as well as the exit status is deliberate: a denial must not
 * be able to slip through as a success, however it is wrapped.
 */
const USERNS_DENIAL_RE = /^unshare: .*(?:failed|not permitted)/m

/**
 * Whether a probe result proves this host can create the namespace the #1104
 * reproduction needs. A pure function of the spawn result — no I/O, no clock, no
 * environment — so the skip branch can be tested directly.
 */
function userNamespaceAvailable(res: SpawnProbe): boolean {
  // 1. It ran at all: a host with no `unshare` on PATH gets error=ENOENT.
  if (res.error) return false
  // 2. util-linux exits EXIT_FAILURE (1) on every denial path, and a signal
  //    death arrives here as status null.
  if (res.status !== 0) return false
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  // 3. Deny on the failure text too, so a denial that somehow exits 0 cannot be
  //    read as a working namespace.
  if (USERNS_DENIAL_RE.test(output)) return false
  // 4. And require the body to have PROVED it ran as uid 0. Without this, an
  //    `unshare` that exits 0 having done nothing at all — a PATH stub, an
  //    alias, a stripped binary — would report the capability as present and the
  //    guard would rot into a permanent pass that measures nothing.
  return output.split('\n').some((line) => line.trim() === USERNS_PROBE_OK)
}

const USERNS_PROBE_ARGS = [
  '--user',
  '--map-root-user',
  '--mount',
  '--propagation',
  'private',
  'sh',
  '-c',
  USERNS_PROBE_BODY,
]

/** The real spawn, kept so a test can assert on what was actually measured. */
const USERNS_PROBE = spawnSync('unshare', USERNS_PROBE_ARGS, { encoding: 'utf8', timeout: 10_000 })
const HAS_USERNS = userNamespaceAvailable(USERNS_PROBE)

const USERNS_SKIP_NOTE = HAS_USERNS
  ? ''
  : ' — SKIPPED, NOT RUN: this host cannot create an unprivileged user namespace ' +
    '(unshare fails with "Operation not permitted" writing /proc/self/uid_map, AppArmor ' +
    '`unprivileged_userns` on ubuntu-latest 24.04), and the reproduction below needs that ' +
    'namespace to redirect the write away from the operator\'s real state dir. THESE TWO ' +
    'TESTS DID NOT RUN: they are the characterization tests for the #1104 trap and nothing ' +
    'here measured it. Re-run them on a host where `unshare --user --map-root-user --mount` ' +
    'works — the probe below, not this note, is what decides.'

interface Repro {
  /** stdout+stderr of the install.sh run. */
  output: string
  /** Files the run created in the bind-mount SHADOW, i.e. the ones that would
   *  have landed in the operator's real state dir. */
  escaped: string[]
  /** Files the run created inside the fixture root. */
  inside: string[]
  status: number | null
}

function tree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), r)
      else out.push(r)
    }
  }
  if (existsSync(root)) walk(root, '')
  return out.sort()
}

/** A stub release tarball, mirroring seedBinaryTree's payload shape. */
function seedRelease(root: string, version: string): void {
  const top = `${APP}-${version}-linux-x86_64`
  const stage = join(root, '.build', top)
  mkdirSync(join(stage, 'lib'), { recursive: true })
  writeFileSync(join(stage, APP), `#!/bin/sh\necho "${APP} ${version}"\n`)
  writeFileSync(join(stage, 'vec0.so'), 'stub vec0\n')
  writeFileSync(join(stage, 'lib', 'libonnxruntime.so.1'), 'stub onnxruntime\n')
  writeFileSync(join(stage, 'config.json.example'), '{ "server": { "port": 3005, "host": "127.0.0.1" }, "mcp": { "httpPort": 3006 } }\n')
  writeFileSync(join(stage, '.env.example'), 'SYNAPTOMIND_SECRET=\n')
  spawnSync('chmod', ['+x', join(stage, APP)])
  const releases = join(root, 'releases', `v${version}`)
  mkdirSync(releases, { recursive: true })
  const tar = spawnSync(
    'tar',
    ['-czf', join(releases, `${APP}-v${version}-linux-x86_64.tar.gz`), '-C', join(root, '.build'), top],
    { encoding: 'utf8' },
  )
  expect(tar.status, tar.stderr).toBe(0)
}

/**
 * A fixture that runs install.sh with NO RUN_DIR — the shape that caused #1101.
 *
 * `RUN_DIR=""` is copied verbatim from the SHIPPED deploy/app.env:44, so this is
 * not an artificial value but exactly what the repository's own config carries.
 * The fixture exports HOME to a scratch root, which is what the folklore
 * "substitute HOME to isolate a fixture" says is sufficient.
 */
function seedUnisolatedFixture(root: string, opts: { pinnedRunDir?: string; version?: string } = {}): void {
  const version = opts.version ?? '0.9.0'
  const deployDir = join(root, 'deploy')
  mkdirSync(join(deployDir, 'lib'), { recursive: true })
  mkdirSync(join(deployDir, 'hooks'), { recursive: true })
  for (const f of ['install.sh', 'uninstall.sh', 'update.sh', 'updater.sh']) {
    writeFileSync(join(deployDir, f), readFileSync(join(DEPLOY_DIR, f), 'utf8'))
  }
  writeFileSync(join(deployDir, 'lib', 'common.sh'), readFileSync(REAL_COMMON_SH, 'utf8'))
  for (const h of ['pre-update', 'post-update']) {
    writeFileSync(join(deployDir, 'hooks', h), readFileSync(join(DEPLOY_DIR, 'hooks', h), 'utf8'))
  }
  seedRelease(root, version)

  const appEnv = [
    `APP_NAME="${APP}"`,
    'DIST="binary"',
    `INSTALL_DIR="${join(root, 'opt', APP)}"`,
    `DATA_DIR="${join(root, 'data')}"`,
    // The shipped default (deploy/app.env:44) — and it is what makes this
    // fixture dangerous. load_app_env() SOURCES this file, so it OVERWRITES any
    // RUN_DIR exported in the environment: measured, `RUN_DIR=<fixture>` in the
    // spawn env is silently replaced by this empty string, after which
    // resolve_target_user() (common.sh:163) sees an empty RUN_DIR and derives the
    // real one from TARGET_HOME. That is why the pinned variant below must put
    // RUN_DIR in the CONFIG, not the environment.
    opts.pinnedRunDir ? `RUN_DIR="${opts.pinnedRunDir}"` : 'RUN_DIR=""',
    'PORT="3999"',
    `RELEASES_BASE="file://${join(root, 'releases')}"`,
    'RELEASE_API=""',
    'CHECKOUT_POLICY="stable"',
    'REQUIRES_BUN="no"',
    'SYSTEM_DEP_CMDS=""',
    'SERVICE_USER=""',
    'SEED_FILES="config.json.example:config.json .env.example:.env"',
    'GENERATE_SECRET_IN=".env"',
    'HOOKS_DIR=""',
    // Single-quoted on purpose, and biome's noTemplateCurlyInString is advisory
    // here (AGENTS.md §3): these are the SHIPPED single-quoted forms, and a
    // double-quoted ${APP_NAME} would be expanded at source time, leaving
    // render_template() nothing to substitute (ADR §2.8). Copying the exact
    // strings matters — this is a reproduction, not a paraphrase.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: verbatim app.env text, not a JS template
    'ASSET_PATTERN=\'${APP_NAME}-${TAG}-${OS}-${ARCH}.tar.gz\'',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: verbatim app.env text, not a JS template
    'APP_VERSION_CMD=\'${BIN} --version\'',
    // Nothing serves /health in a fixture; keep the gate's budget at 1s.
    'HEALTH_URL="http://127.0.0.1:1/health"',
    'HEALTH_TIMEOUT="1"',
  ].join('\n')
  writeFileSync(join(deployDir, 'app.env'), `${appEnv}\n`)
}

/** sudo/systemctl stubs that log and do nothing. Nothing privileged runs. */
function seedPrivStubs(root: string): void {
  const stubs = join(root, 'stubs')
  mkdirSync(stubs, { recursive: true })
  for (const name of ['sudo', 'systemctl']) {
    const lines = ['#!/usr/bin/env bash', 'printf \'%s %s\\n\' "$0" "$*" >> "$STUB_PRIV_LOG"', 'exit 0']
    writeFileSync(join(stubs, name), lines.join('\n'))
    spawnSync('chmod', ['+x', join(stubs, name)])
  }
  writeFileSync(join(root, 'priv.log'), '')
}

/**
 * Run the fixture's install.sh inside a user+mount namespace with the operator's
 * real state dir bind-shadowed by `shadow`.
 *
 * `stateDir` is the dir the run RESOLVES and writes — passwd home + .synaptomind
 * (see the construction below). It is a required argument rather than a default:
 * the bind has to land on exactly the path install.sh derives, and a default
 * would let a caller silently point the shadow somewhere the run does not write.
 *
 * `envOverrides` is merged LAST so a caller can pin RUN_DIR — that is the whole
 * difference between the two halves of the test below, and it is the only thing
 * that changes.
 */
function runInNamespace(opts: {
  root: string
  shadow: string
  stateDir: string
  envOverrides?: Record<string, string>
}): Repro {
  const { root, shadow, stateDir } = opts
  const privLog = join(root, 'priv.log')
  const envLines = Object.entries(opts.envOverrides ?? {})
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n')
  const script = [
    'set -u',
    // The shadow. If this fails the run is abandoned rather than allowed to
    // continue against the real directory.
    `mount --bind ${JSON.stringify(shadow)} ${JSON.stringify(stateDir)} 2>/dev/null || { echo "SHADOW_BIND_FAILED"; exit 9; }`,
    `echo "GETENT_HOME=$(getent passwd "${appUserInNamespace()}" 2>/dev/null | cut -d: -f6)"`,
    `echo "IN_NS_HOME=$HOME"`,
    // The folklore isolation: HOME is pointed at a scratch root.
    `mkdir -p ${JSON.stringify(join(root, 'fakehome'))}`,
    `export HOME=${JSON.stringify(join(root, 'fakehome'))}`,
    // SUDO_USER, not SERVICE_USER. The fixture's app.env is SOURCED by
    // load_app_env(), so its SERVICE_USER="" would overwrite anything exported
    // here — and TARGET_USER would fall through to `id -un` = root inside the
    // namespace, whose /root is unwritable. The run then aborted on
    // `mkdir: cannot create directory '/root'` and proved nothing. Caught by
    // running it, not by reading it.
    //
    // SUDO_USER is also the MORE FAITHFUL shape: it is the branch the script
    // exists for. `curl … | sudo bash` runs as root with SUDO_USER set, and
    // resolve_target_user() (common.sh:145) selects that invoking user — whose
    // passwd entry points at the real home. That is the production cutover path.
    `export SUDO_USER=${JSON.stringify(appUser())}`,
    envLines,
    `export PATH=${JSON.stringify(join(root, 'stubs'))}:$PATH`,
    `export STUB_PRIV_LOG=${JSON.stringify(privLog)}`,
    'export APP_ENV_URL="" LIB_RAW_URL=""',
    `cd ${JSON.stringify(root)}`,
    `bash ${JSON.stringify(join(root, 'deploy', 'install.sh'))} --version v0.9.0 --no-service 2>&1`,
    'echo "INSTALL_EXIT=$?"',
  ].join('\n')

  const res = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--propagation', 'private', 'bash', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env } as Record<string, string>,
    timeout: 120_000,
  })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const m = /INSTALL_EXIT=(\d+)/.exec(output)
  return {
    output,
    escaped: tree(shadow),
    inside: tree(root).filter((f) => !f.startsWith('shadow/') && !f.startsWith('fakehome/')),
    status: m ? Number(m[1]) : null,
  }
}

// The user whose passwd entry install.sh consults. Inside the namespace the
// ─── THE OPERATOR ACCOUNT AND STATE DIR ARE CONSTRUCTED, NOT DISCOVERED (#1357) ─
//  D1. `realStateDir()` (deploy/tmp-fixtures.ts) returns null unless
//  `~/.synaptomind` ALREADY EXISTS — on a host that has never run an install.
//  That is every GitHub Actions runner, where the block below therefore had no
//  bind-mount target, `mount --bind` had nothing to shadow, and the whole #1104
//  check was a skip. So the block derives the path itself, the way install.sh
//  derives it, and creates the directory when it is missing.
//
//  WHY FIELD 6 OF `getent passwd` AND NOT `os.homedir()`. This test exists
//  because the SHELL ignores $HOME: resolve_target_user() (common.sh:196-197)
//  takes TARGET_HOME from the passwd database first and only falls back to
//  ${HOME} when getent is missing or silent. os.homedir() is the wrong tool for
//  an expectation about that function — on many systems it reads $HOME, and an
//  expectation built from it would be satisfied by exactly the substitution this
//  suite is about. `getent passwd <user> | cut -d: -f6` is the product's own
//  lookup, so the expectation cannot drift from the code it checks.
//
//  THE ACCOUNT COMES FROM THE UID, NOT $USER. The previous version read
//  `process.env.USER ?? 'root'`, which on a host that exports no USER aimed the
//  whole fixture at /root/.synaptomind — a path the fixture would then create and
//  seed. `getent passwd <uid>` is the portable form realStateDir() already uses,
//  and the name it returns is the account the run will resolve. A host with no
//  passwd entry for the current uid now FAILS LOUDLY instead of guessing a home,
//  because every measurement here is meaningless without one: the path would be
//  invented rather than derived.
//
//  D2. The two assertions in the block therefore name THIS value instead of a
//  literal home. They are still real assertions — see below, where each side is
//  checked for being non-empty as well as for matching.
//
//  D3. `mount --bind` also requires an existing mount point, and the before/
//  after sha256 pair needs a file to hash: on a host with no state dir both used
//  to degrade to `'' === ''`, which asserts nothing. So the fixture SEEDS a
//  known app.env baseline when there is none.
//
//  D4. AND THAT IS THE DANGEROUS PART. Because the block may now create
//  `~/.synaptomind` on a machine that never had one, the teardown must remove
//  it ONLY when this process created it — and it must be structurally unable to
//  do more than that. A conditional `rm -rf` is one refactor away from an
//  unguarded one, and this file already proved what that costs: the teeth test
//  for the anti-destruction guard WAS the destruction, on the very machine whose
//  state dir it deleted. So the authority is a marker file planted inside the dir
//  and re-read at delete time, every removal is a point unlink or a
//  non-recursive rmdir, and a pre-existing dir is not in the removal registry at
//  all. Worst case is a leaked empty dir or a loud throw — never destruction.

/** The account and home this fixture acts as, derived from the running uid. */
interface OperatorAccount {
  /** Field 1 of the passwd line: the name install.sh will resolve. */
  user: string
  /** Field 6: the home resolve_target_user() will take. */
  home: string
  /** The state dir the run resolves: that home plus the app name (common.sh:207). */
  state: string
}

/**
 * The current account, from `getent passwd <uid>` — realStateDir()'s portable
 * form, and the same database the product consults.
 *
 * Reproduced rather than imported because the shell function cannot be called
 * from here, and re-deriving it differently would make every expectation a second
 * opinion instead of the product's answer. Memoised, and it THROWS rather than
 * falling back: a host with no passwd entry for the current uid has no state dir
 * to protect and no home to expect, so a default here would silently aim the
 * fixture at a made-up path — which is the failure mode that put a run's writes
 * somewhere the test never looked. The throw is deferred to first use so the
 * namespace-probe tests, which need no path, still run.
 */
let account: OperatorAccount | null = null
function operatorAccount(): OperatorAccount {
  if (!account) account = resolveOperatorAccount(process.getuid?.())
  return account
}

/**
 * The account for `uid`, from passwd — and the ONLY place a home can come from.
 *
 * Split out from the memoised accessor so a test can drive it with an arbitrary
 * uid and observe the refusal: there is no fallback branch here at all, which is
 * what makes "never aims at /root" a property of the code rather than a claim in
 * a comment. Throws rather than defaulting (R7), because a defaulted home would
 * aim the fixture — and its bind-shadow, and its mkdir — at a path the product
 * would never resolve.
 */
function resolveOperatorAccount(uid: number | undefined): OperatorAccount {
  if (uid === undefined) {
    throw new Error(
      'operatorAccount: process.getuid() is unavailable, so the account cannot be derived from ' +
        'passwd. Refusing to guess a home — a guessed path is exactly what this suite exists to ' +
        'prevent being aimed at the wrong place.',
    )
  }
  // By uid, and by uid ONLY. realStateDir() falls back to the user NAME, but that
  // fallback re-introduces exactly the ambiguity R7 removes: a host whose $USER
  // names a different account than the uid running the tests would resolve that
  // account's home, and the fixture would create and seed a state dir for
  // someone else. A uid with no entry is a refusal, not a cue to guess.
  const line = spawnSync('getent', ['passwd', String(uid)], { encoding: 'utf8' }).stdout.trim()
  const fields = line.split(':')
  const user = fields[0] ?? ''
  const home = fields[5] ?? ''
  if (!user || !home) {
    throw new Error(
      `operatorAccount: getent passwd ${uid} returned no usable entry (got ${JSON.stringify(line)}). ` +
        `The fixture cannot derive the operator's home, so it will not create or seed a state dir.`,
    )
  }
  return { user, home, state: join(home, '.synaptomind') }
}

/** The user whose passwd entry install.sh consults. Inside the namespace the
 *  run is uid 0, so SUDO_USER is what selects the target — this mirrors the real
 *  `curl | sudo bash` shape the scripts are written for. */
function appUser(): string {
  return operatorAccount().user
}
function appUserInNamespace(): string {
  return appUser()
}
/** The state dir the run below will resolve. */
function operatorState(): string {
  return operatorAccount().state
}

/**
 * The app.env the fixture writes when the host has none of its own — the
 * baseline the before/after digest pair is measured against.
 *
 * Deliberately NOT a production-shaped config: if a seeded baseline ever
 * outlived its teardown, the end-of-file tripwire below must fail loudly rather
 * than pass by finding these three lines where the operator's file should be.
 * Its exact content is irrelevant to the run — the write under test lands in the
 * bind-shadowed copy, not here — so it only has to be stable, so the digest is
 * the same before and after.
 */
const BASELINE_APP_ENV = [
  '# Baseline written by deploy/state-isolation.test.ts (#1357) — fixture data,',
  '# not an operator config. The #1104 reproduction hashes this file before and',
  '# after its run; without it sha256sum errors and the pair compares "" to "".',
  'RUN_DIR=""',
  'PORT="0"',
].join('\n')

/** The sha256 of the state dir's app.env, or '' when the file does not exist —
 *  exactly what the block's before/after pair measures. */
function hashAppEnv(stateDir: string): string {
  return spawnSync('sha256sum', [join(stateDir, 'scripts', 'app.env')], { encoding: 'utf8' }).stdout.trim()
}

/**
 * The value the run reported for `key`, or '' when it reported none.
 *
 * Parsed rather than matched with `toContain` on purpose (D2): the two home
 * assertions must be able to FAIL, and a prefix match on `GETENT_HOME=` is
 * satisfied by a line with no value at all — which is how a home lookup stops
 * being verified while the suite stays green.
 */
function reportedHome(output: string, key: string): string {
  const line = output.split('\n').find((l) => l.startsWith(`${key}=`))
  return line === undefined ? '' : line.slice(key.length + 1).trim()
}

/** What a state-dir acquire cost, and the only authority teardown may act on. */
interface StateDirOwnership {
  dir: string
  /** True when THIS process created the directory, and may therefore remove it. */
  created: boolean
  /** True when this process wrote the seeded app.env. */
  seeded: boolean
  /** The unguessable token this acquire planted as its marker. */
  token: string
  /** The marker file itself, INSIDE the dir. Read back at release time. */
  marker: string
}

/**
 * Marker file name, carrying the token so a marker left behind by an EARLIER run
 * can never be mistaken for this run's, and so any residue is self-identifying.
 */
const MARKER_PREFIX = '.deploy-state-isolation-marker-'

/**
 * Dirs this process created, and may therefore remove. The only registry the
 * removal path consults — a PRE-EXISTING dir is never in here, so no future edit
 * to the removal code can be pointed at one.
 */
const createdDirs = new Map<string, StateDirOwnership>()
/** Pre-existing dirs this process wrote a seed into, and owes the seed back. */
const seededDirs = new Map<string, StateDirOwnership>()

/**
 * Make the operator's state dir exist, and record exactly what that cost.
 *
 * THE MARKER IS THE POINT, and it is planted FIRST — before the seed, and before
 * the dir is registered — for two reasons. It is the authority the release
 * consults at delete time, replacing the in-memory bit that made the previous
 * version one refactor away from an unguarded `rm -rf` on the real state dir. And
 * it makes a crash mid-acquire recoverable: anything this function leaves behind
 * carries the marker, so the residue can be identified and cleaned up by hand
 * instead of being an anonymous directory.
 *
 * On a host that already has a state dir WITH its own app.env — every dev box —
 * this writes nothing at all and registers nothing, so the operator's files are
 * not even touched.
 */
function acquireStateDir(dir: string): StateDirOwnership {
  if (createdDirs.has(dir) || seededDirs.has(dir)) {
    // Refuse rather than overwrite (the old `acquired.set` did overwrite, which
    // could erase a `created: true` and misattribute ownership of a dir that was
    // never ours to remove). Two live acquisitions of one dir is a bug in the
    // caller, and the second release would otherwise undo the first acquire.
    throw new Error(
      `acquireStateDir: ${dir} is already acquired. Two live acquisitions of one dir would let ` +
        `the second release undo the first's work.`,
    )
  }
  const created = !existsSync(dir)
  const appEnv = join(dir, 'scripts', 'app.env')
  const needsSeed = !existsSync(appEnv)
  // ZERO-FOOTPRINT CASE, decided BEFORE anything is written. A pre-existing dir
  // that already has an app.env needs nothing from this fixture: no directory to
  // create, no baseline to seed, nothing to undo. So it is returned here, before
  // the marker is planted — an operator's dir gets no dotfile from this suite
  // either, which is what `fingerprint` in the D4 test measures. The residual
  // marker seen in that test's fingerprint is NOT this branch: it is a dir that
  // had no app.env, and the release unlinks the marker it planted.
  if (!created && !needsSeed) {
    return { dir, created: false, seeded: false, token: '', marker: '' }
  }

  const ownership: StateDirOwnership = {
    dir,
    created,
    seeded: false,
    token: randomUUID(),
    marker: '',
  }
  if (created) mkdirSync(dir, { recursive: true })
  ownership.marker = join(dir, `${MARKER_PREFIX}${ownership.token}`)
  // FIRST WRITE, before the seed and before registration: from here on, anything
  // this process leaves in the dir is marked as ours and removable by hand.
  writeFileSync(ownership.marker, `${ownership.token}\n`)
  const registry = created ? createdDirs : seededDirs
  registry.set(dir, ownership)

  if (needsSeed) seedBaseline(ownership, appEnv)
  return ownership
}

/**
 * Write the digest baseline — and refuse to write it unproven.
 *
 * The ordering R8 asks for is enforced HERE rather than by the statement order in
 * acquireStateDir: this function re-reads the marker from disk and throws unless
 * it is present and correct BEFORE it writes anything. Reordering the statements
 * above therefore cannot produce an unmarked seed, because a seed is not
 * reachable without a verified marker — the protection is a PRECONDITION of the
 * write, not a comment about it. That is the difference between an ordering
 * convention and a structural guarantee, and it is the property the first
 * incident needed and did not have.
 */
function seedBaseline(ownership: StateDirOwnership, appEnv: string): void {
  requireMarker(ownership)
  mkdirSync(join(ownership.dir, 'scripts'), { recursive: true })
  writeFileSync(appEnv, BASELINE_APP_ENV)
  ownership.seeded = true
}

/**
 * Throw unless the marker this process planted is present and still says so.
 *
 * This is the delete-time authority (R2): the in-memory record is only an
 * optimisation for finding the marker, never the permission itself. A missing or
 * mismatched marker means this process has no evidence it created or seeded the
 * dir, and the answer is a loud refusal — a leaked dir is recoverable, a deleted
 * operator state dir is not.
 */
function requireMarker(ownership: StateDirOwnership): void {
  // A DIRECTORY THAT IS ALREADY GONE IS NOT A REFUSAL CASE. There is nothing left
  // to destroy, so the only possible outcome is success, and throwing here would
  // be theatre. It is also a real case rather than a hypothetical one:
  // installCleanup() registers its own `afterEach` sweep at module scope, and that
  // hook is registered BEFORE the one below, so bun runs it first — a temp tree
  // holding an acquired state dir is swept before this release reaches it. What
  // must be refused is a dir that is PRESENT but is not provably ours: that is
  // the case with destruction potential.
  if (!existsSync(ownership.dir)) return
  let token: string
  try {
    token = readFileSync(ownership.marker, 'utf8').trim()
  } catch (err) {
    throw new Error(
      `REFUSING TO REMOVE ${ownership.dir}: the marker planted by this acquire ` +
        `(${basename(ownership.marker)}) is missing or unreadable (${(err as Error).message}). ` +
        `Without it there is no evidence this process created or seeded the dir, so removal is ` +
        `not safe. An empty leftover dir is recoverable; its contents are not.`,
    )
  }
  if (token !== ownership.token) {
    throw new Error(
      `REFUSING TO REMOVE ${ownership.dir}: marker holds token ${token}, expected ` +
        `${ownership.token}. It was replaced or edited, so this dir is no longer the one this ` +
        `acquire created.`,
    )
  }
}

/**
 * Unlink `path` ONLY while it still holds exactly `expected`.
 *
 * Anything else is left in place on purpose: a file the fixture did not write is
 * then not the fixture's to delete, and leaving it makes the enclosing
 * `rmdirSync` fail ENOTEMPTY — a loud failure instead of silent data loss.
 */
function unlinkIfUnchanged(path: string, expected: string): void {
  if (!existsSync(path)) return
  if (readFileSync(path, 'utf8') !== expected) return
  rmSync(path, { force: true })
}

/**
 * Remove a state dir THIS PROCESS CREATED.
 *
 * Structurally incapable of destruction, by construction rather than by
 * discipline:
 *   - it is reachable only for a path in `createdDirs`, so a pre-existing
 *     operator state dir is not a candidate at all, whatever this body says;
 *   - its authority is the marker file, re-read from disk at delete time;
 *   - every removal is a point unlink or a NON-recursive `rmdirSync`, so
 *     unexpected content aborts ENOTEMPTY instead of being destroyed.
 * The only recursive deletes left in this file are the refusal tests' own
 * `mkdtempSync` hosts, and the audit at the foot of this file exempts exactly
 * those targets and no other. The worst case for any bug here is a leaked
 * empty dir or a loud throw.
 */
function releaseCreatedStateDir(dir: string): void {
  const ownership = createdDirs.get(dir)
  if (!ownership) return
  // Dropped from the registry FIRST, so a throw below cannot leave a record that
  // a later sweep would try again — an ENOTEMPTY here is a report, not a retry.
  createdDirs.delete(dir)
  requireMarker(ownership)
  if (!existsSync(dir)) return
  unlinkIfUnchanged(join(dir, 'scripts', 'app.env'), BASELINE_APP_ENV)
  unlinkIfUnchanged(ownership.marker, `${ownership.token}\n`)
  rmdirSync(join(dir, 'scripts')) // ENOTEMPTY propagates: something else is in there
  rmdirSync(dir) // ENOTEMPTY propagates: something else is in there
}

/**
 * Give back what a seed into a PRE-EXISTING dir borrowed, and nothing else.
 *
 * The dir itself is never a candidate here — not in the registry, not in any
 * branch of this function — so there is no code path from a pre-existing state
 * dir to its removal, whatever this body says. `scripts/` is only unlinked when
 * the seed emptied it, since an operator's own scripts/ must survive.
 */
function releaseSeededStateDir(dir: string): void {
  const ownership = seededDirs.get(dir)
  if (!ownership) return
  seededDirs.delete(dir)
  requireMarker(ownership)
  if (!existsSync(dir)) return
  unlinkIfUnchanged(join(dir, 'scripts', 'app.env'), BASELINE_APP_ENV)
  unlinkIfUnchanged(ownership.marker, `${ownership.token}\n`)
  const scripts = join(dir, 'scripts')
  // Only ours if the seed left it empty. A non-empty scripts/ is the operator's
  // own, and ENOTEMPTY here is the correct, non-destructive answer.
  try {
    rmdirSync(scripts)
  } catch {
    // Pre-existed and still holds their files. Nothing to undo.
  }
}

/** Everything this process still owes, released in a fixed order. */
function releaseAllStateDirs(): void {
  for (const dir of [...createdDirs.keys()]) releaseCreatedStateDir(dir)
  for (const dir of [...seededDirs.keys()]) releaseSeededStateDir(dir)
}

afterEach(() => {
  // ORDER MATTERS: release the state dirs FIRST, then sweep the temp trees. The
  // hermetic ownership tests acquire dirs that live INSIDE a temp tree, so
  // sweeping first would delete the marker out from under the release and turn
  // every one of them into a spurious "REFUSING TO REMOVE" failure. Releasing
  // first also means the marker check runs against a dir that still exists,
  // which is the only way the check means anything.
  //
  // This is also the teardown for an acquire whose test threw before releasing.
  // Each registry is emptied as it is walked, so it is safe to reach twice, and a
  // marker refusal throws out of the hook and fails the run loudly.
  releaseAllStateDirs()
  sweepTempTrees()
})

afterAll(() => {
  releaseAllStateDirs()
})

describe.skipIf(!HAS_USERNS)(`deploy state-dir containment (#1104)${USERNS_SKIP_NOTE}`, () => {
  test('unmodified install.sh with no RUN_DIR writes into the REAL state dir even when HOME is a scratch root', () => {
    const root = mkTempTree('synapto-red-repro-')
    const shadow = join(root, 'shadow')
    mkdirSync(shadow, { recursive: true })
    seedUnisolatedFixture(root)
    seedPrivStubs(root)

    // D1/D3: construct the state dir the run will resolve, seeding the app.env
    // the digest pair below measures. `ownership` records that this host had no
    // such dir only when it truly did not, which is what D4's teardown reads —
    // so it is checked here, against the host's state measured BEFORE the
    // acquire, rather than taken on trust.
    const hadStateDir = existsSync(operatorState())
    const ownership = acquireStateDir(operatorState())
    expect(ownership.created, 'a pre-existing state dir must never be recorded as ours to create').toBe(!hadStateDir)
    const before = hashAppEnv(operatorState())
    // The pair below is only meaningful if `before` is a digest: a missing
    // app.env makes sha256sum error and print nothing, and `expect(after).toBe
    // (before)` would then compare '' to '' — vacuous, and the reason D3 exists.
    expect(before, `no app.env was seeded in ${operatorState()} — the pair below proves nothing`).toMatch(
      /^[0-9a-f]{64} [ *]/,
    )
    const repro = runInNamespace({ root, shadow, stateDir: operatorState() })

    // The install itself succeeded — the write is not a failure path, it is what
    // the script is SUPPOSED to do. That is what made the incident silent.
    expect(repro.status, repro.output).toBe(0)

    // ── THE REPRODUCTION, ASSERTED AS CHARACTERISATION ─────────────────────
    // This asserts that the escape HAPPENS. Written as `toEqual([])` it is the
    // red test — and it was: run before the harness existed, it failed with
    // exactly the diff below, naming /home/opencode/.synaptomind. The evidence
    // is kept in the repo as an assertion of the trap being live rather than
    // deleted, because the trap is a property of install.sh + common.sh that
    // does not go away when a fixture is fixed: the next fixture inherits it.
    //
    // Asserting the escape (rather than "no escape") is what keeps this test
    // NON-VACUOUS in its final form. If someone "fixed" resolve_target_user() to
    // honour HOME, this test would fail — and that failure would be the signal
    // to re-examine whether the fix changed real install behaviour.
    expect(
      repro.escaped,
      `expected the reproduction to escape into ${operatorState()}, but nothing was written there.\n` +
        `If resolve_target_user() now honours \${HOME} before \`getent passwd\`, the escape this\n` +
        `test documents is gone — re-check whether that change alters a real operator's RUN_DIR.\n` +
        `Output tail:\n${repro.output.split('\n').slice(-12).join('\n')}`,
    ).toEqual([
      'hooks/post-update',
      'hooks/pre-update',
      'scripts/app.env',
      'scripts/common.sh',
      'scripts/uninstall.sh',
      'scripts/update.sh',
      'scripts/updater.sh',
    ])

    // The two homes the run reported, now computed instead of literal (D2). They
    // do NOT carry the same weight, and the difference matters: claiming that both
    // of them prove the mechanism is how a tautology gets mistaken for evidence.
    //
    // GETENT_HOME IS THE MECHANISM. resolve_target_user() (common.sh:196-197)
    // takes the home from passwd BEFORE ${HOME}, so this is the operator's real
    // home, and the run then wrote there — which is what the `Config:` assertion
    // below confirms, after the fixture had already substituted HOME. Checked for
    // being non-empty as well as for equality, because a `toContain('GETENT_HOME
    // =')` prefix match would pass on a line with no value at all.
    const getentHome = reportedHome(repro.output, 'GETENT_HOME')
    expect(getentHome, 'getent reported no home, so nothing proved the lookup is HOME-independent').not.toBe('')
    expect(getentHome, 'getent did not answer the operator\'s real passwd home').toBe(operatorAccount().home)
    //
    // IN_NS_HOME IS NOT THE MECHANISM, and is not claimed to be. It can only ever
    // be this process's own $HOME: the line is echoed BEFORE the fixture exports
    // HOME=<scratch>, and the child's env is a spread of this process's. So it
    // proves two real but modest things — the child inherited this process's
    // environment, and the echo happened before the redirect (had the order been
    // reversed, the value would be the scratch root).
    const inNsHome = reportedHome(repro.output, 'IN_NS_HOME')
    const scratchHome = join(root, 'fakehome')
    expect(inNsHome, 'the namespace reported no HOME').not.toBe('')
    expect(inNsHome, 'IN_NS_HOME was echoed AFTER the fixture redirected HOME, so it proves less than it appears to').not.toBe(scratchHome)
    expect(inNsHome, 'the child did not inherit this process\'s environment').toBe(process.env.HOME ?? '')
    // On a host whose $HOME differs from the passwd home, the two reported values
    // must differ, and that difference IS the mechanism made visible. Where they
    // coincide — this host, and most — no assertion here can separate them, and
    // the branch says so instead of implying otherwise: the mechanism rests on
    // GETENT_HOME plus the `Config:` line, both of which are unconditional.
    if (operatorAccount().home === (process.env.HOME ?? '')) {
      expect(getentHome).toBe(inNsHome)
    } else {
      expect(inNsHome, 'a host whose $HOME differs from the passwd home must report both').not.toBe(operatorAccount().home)
    }
    // The run reported the REAL state dir as its own, which is the operator-
    // facing symptom: the summary an operator reads names their live config, and
    // it is the assertion that carries the mechanism: the fixture had already
    // pointed HOME at a scratch root when the run resolved this.
    expect(repro.output).toContain(`Config:     ${operatorState()}/scripts/app.env`)

    // And the app.env it wrote there is genuinely a different file — the actual
    // damage, not just an extra file. INSTALL_DIR points into the fixture's own
    // temp tree and the health URL is unroutable, which is precisely the state
    // #1101 left the production host in.
    const escapedEnv = readFileSync(join(shadow, 'scripts', 'app.env'), 'utf8')
    expect(escapedEnv).toContain(`INSTALL_DIR="${join(root, 'opt', APP)}"`)
    expect(escapedEnv).toContain('HEALTH_URL="http://127.0.0.1:1/health"')
    expect(escapedEnv).not.toContain('INSTALL_DIR="/opt/synaptomind"')

    // The real file is untouched: the namespace redirection did its job. If this
    // ever fails, the reproduction has BECOME the incident.
    const after = hashAppEnv(operatorState())
    expect(after).toBe(before)
    // D4: hand the dir back through the marker-gated release, so a host that
    // already had a state dir keeps it. The dedicated tests below are what prove
    // that, and the refusal path is what makes it structural rather than a
    // convention.
    releaseAllStateDirs()
    expect(createdDirs.has(operatorState())).toBe(false)
    expect(seededDirs.has(operatorState())).toBe(false)
  }, 180_000)

  test('the SAME install.sh run, driven through isolatedEnv, stays inside the fixture root', () => {
    const root = mkTempTree('synapto-green-harness-')
    const shadow = join(root, 'shadow')
    mkdirSync(shadow, { recursive: true })
    const env = isolatedEnv(root)
    // Same construction as the reproduction above: the run resolves the passwd
    // home regardless of what isolatedEnv pins, so the bind target must exist
    // and there must be an app.env to prove it went untouched. `mount --bind`
    // fails outright on a missing mount point, which is how this test reported
    // SHADOW_BIND_FAILED and exited 9 on a host with no state dir.
    const ownership = acquireStateDir(operatorState())
    expect(ownership.dir).toBe(operatorState())
    // The pin goes in the app.env the fixture WRITES, because that is the only
    // place it survives: load_app_env() sources app.env over the environment, so
    // an exported RUN_DIR is overwritten by the config's own `RUN_DIR=""` and the
    // getent fallback fires anyway. Measured — the first version of this test
    // exported RUN_DIR and still escaped into /home/opencode/.synaptomind.
    //
    // Nothing else differs from the test above, so containment is attributable
    // to this one value and not to a reordered main() or an early abort.
    seedUnisolatedFixture(root, { pinnedRunDir: env.RUN_DIR })
    seedPrivStubs(root)
    const before = hashAppEnv(operatorState())
    const repro = runInNamespace({
      root,
      shadow,
      stateDir: operatorState(),
      envOverrides: {
        HOOKS_DIR: env.HOOKS_DIR!,
        UNIT_FILE: env.UNIT_FILE!,
        DATA_DIR: env.DATA_DIR!,
      },
    })

    expect(repro.status, repro.output).toBe(0)
    // The install really ran: an aborted run would also write nothing.
    expect(repro.output).toContain('Done.')
    expect(repro.output).toContain(join(root, 'opt', APP))
    expect(repro.escaped, `escaped into ${operatorState()}: ${repro.escaped.join(', ')}`).toEqual([])
    // The helpers it would have written went to the fixture's own RUN_DIR.
    expect(repro.inside).toContain('run/scripts/app.env')
    // The same digest pair as the reproduction, for the same reason: nothing
    // reached the real state dir, and "nothing reached it" is only provable
    // against a file whose content is known.
    expect(hashAppEnv(operatorState())).toBe(before)
    releaseAllStateDirs()
  }, 180_000)

  // ── D4: THE TEARDOWN MUST NOT DELETE A STATE DIR IT DID NOT CREATE ─────────
  //  This is the test that guards a developer's machine. D1 makes the fixture
  //  CREATE `~/.synaptomind` on hosts that never had one, and the reflex fix —
  //  "remove the dir we made" written as an unconditional rm -rf — would, on any
  //  host that DID have one, delete the operator's real state dir: app.env, the
  //  helper scripts, the hooks. That is the #1104 damage inverted, and it is
  //  silent in exactly the same way (no assertion in this file would have failed).
  //
  //  Both branches are exercised, because the branch that runs depends on the
  //  host — so asserting only the one this machine takes would leave the other
  //  (CI's) unmeasured. Neither branch returns early: each asserts its own
  //  outcome, per the #1096 lesson.
  test('a full run leaves the state dir as found when it pre-existed, and removes it when it did not', () => {
    // WHY THE REAL PATH IS THE ONLY ONE A FULL RUN CAN USE. The run resolves
    // RUN_DIR from `getent passwd` (common.sh:196-207) — it cannot be pointed at
    // a scratch dir by the test at all, which is the whole #1104 trap. So the
    // state dir a full run writes to IS the operator's real one, and the only
    // thing standing between the run and the real file is the bind shadow over
    // it. A version of this test that bind-shadowed a /tmp state dir instead
    // looked safe and was not: the run ignored it, wrote to the real
    // /home/opencode/.synaptomind, and destroyed the operator's app.env. That
    // happened here, and the file was restored from its own .bak copy. The
    // ownership logic itself is covered hermetically by the next describe, on
    // synthetic dirs that no run can reach — and that is where it lives, so it
    // is measured on a runner where this block skips.
    const preExisting = existsSync(operatorState())
    const asFound = preExisting ? fingerprint(operatorState()) : ''
    const root = mkTempTree('synapto-d4-')
    const shadow = join(root, 'shadow')
    mkdirSync(shadow, { recursive: true })
    seedUnisolatedFixture(root)
    seedPrivStubs(root)

    const ownership = acquireStateDir(operatorState())
    expect(ownership.created).toBe(!preExisting)
    // The registry split is the structural half of D4: a pre-existing dir is never
    // a candidate for removal, and on a dev host with its own app.env the acquire
    // registers nothing at all.
    expect(createdDirs.has(operatorState())).toBe(ownership.created)

    // A FULL run, over the real dir, shadowed — so the claim below is about a
    // run that really happened rather than a fixture that never spawned.
    const before = hashAppEnv(operatorState())
    const repro = runInNamespace({ root, shadow, stateDir: operatorState() })
    expect(repro.status, repro.output).toBe(0)
    expect(repro.escaped.length, `expected the escape to land in the shadow:\n${repro.output}`).toBe(7)
    // The redirection worked, before teardown is even considered.
    expect(hashAppEnv(operatorState()), 'the real file was modified during the run').toBe(before)

    // The teardown under test.
    releaseAllStateDirs()
    expect(createdDirs.has(operatorState())).toBe(false)
    expect(seededDirs.has(operatorState())).toBe(false)

    // Both outcomes, asserted rather than assumed — which one applies depends on
    // the host, and a test that silently skips the branch it cannot take is how
    // this file ended up with vacuous assertions before.
    if (preExisting) {
      // A dev machine: the operator's dir must be exactly as found, byte for
      // byte and mtime for mtime. An unconditional `rm -rf` fails the first
      // assertion; a rewrite of any file fails the fingerprint.
      expect(existsSync(operatorState()), 'the teardown removed a state dir it did not create').toBe(true)
      expect(fingerprint(operatorState()), 'the teardown changed the contents of a pre-existing state dir').toBe(asFound)
    } else {
      // A CI runner: nothing was there before, so nothing may be left behind.
      expect(existsSync(operatorState()), 'the teardown leaked the state dir it created').toBe(false)
    }
  }, 180_000)

})

// ─── THE STATE-DIR FIXTURE OWNS ONLY WHAT IT CREATED (#1357 D3/D4) ───────────
/**
 * The ownership half of the block above, deliberately OUTSIDE the userns guard.
 *
 * `acquireStateDir` / the release functions are pure filesystem work — no
 * namespace, no install.sh, no root — so putting their tests inside the guard
 * would mean the runner measures nothing: the #1104 block is exactly the part
 * that skips where AppArmor denies the uid_map write, and D4 is the one property
 * that must hold on EVERY host. They run on synthetic dirs under a temp tree, so
 * no run can reach them and the operator's real state dir is not involved.
 *
 * D3 is measured here too: the created-dir case is the host with no pre-existing
 * state dir, which is every CI runner, and it asserts that the seeded baseline
 * turns the before/after digest pair into a real comparison instead of '' vs ''.
 *
 * The refusal tests are the load-bearing ones. They are what make the teardown
 * structurally safe rather than conditionally safe: a missing or replaced marker
 * must make removal FAIL LOUDLY, and content the fixture did not write must
 * abort the rmdir with ENOTEMPTY instead of being destroyed. A teardown that
 * quietly skipped would reintroduce exactly the leak-with-no-signal failure that
 * let the original incident go unnoticed.
 */
describe('the constructed state dir is seeded, and unwound only as far as it was created (#1357)', () => {
  test('a state dir the fixture CREATED is seeded, and removed entirely', () => {
    // The CI case: nothing was here before, so the fixture creates the dir, seeds
    // the baseline the digest pair needs, and takes both away again. Without this
    // a teardown that refused to remove anything would satisfy the pre-existing
    // test while leaking a dir on every single run.
    const host = mkTempTree('synapto-created-')
    const stateDir = join(host, '.synaptomind')
    expect(existsSync(stateDir)).toBe(false)

    const ownership = acquireStateDir(stateDir)
    expect(ownership.created).toBe(true)
    expect(ownership.seeded).toBe(true)
    expect(createdDirs.has(stateDir), 'a created dir is the only removal candidate').toBe(true)
    // The marker is planted INSIDE the dir, before the seed, and carries the token
    // in its name as well as its content — so residue from an earlier run can
    // never be mistaken for this run's.
    expect(existsSync(ownership.marker)).toBe(true)
    expect(ownership.marker.startsWith(join(stateDir, MARKER_PREFIX))).toBe(true)
    expect(readFileSync(ownership.marker, 'utf8').trim()).toBe(ownership.token)
    // THE D3 MEASUREMENT. `sha256sum` on a missing file prints nothing, so the
    // before/after pair in the block above would compare '' with ''. Here the
    // seeded baseline makes `before` a digest, and the run that follows is
    // therefore a real comparison. Proved by measurement, not by reading.
    expect(hashAppEnv(stateDir), 'the seeded baseline did not produce a digest').toMatch(/^[0-9a-f]{64} [ *]/)
    expect(readFileSync(join(stateDir, 'scripts', 'app.env'), 'utf8')).toBe(BASELINE_APP_ENV)

    releaseAllStateDirs()
    // Removed entirely, and nothing left behind — the marker, the seeded
    // app.env, and the scripts/ dir the seed had to create all go.
    expect(existsSync(stateDir)).toBe(false)
    expect(existsSync(join(stateDir, 'scripts'))).toBe(false)
    expect(existsSync(ownership.marker)).toBe(false)
  })

  test('a release REFUSES LOUDLY when the marker is gone, and destroys nothing', () => {
    // The property the whole redesign exists for. The previous version authorised
    // removal with an in-memory bit, so a refactor to an unconditional rm -rf had
    // nothing left to stop it — and on this host that refactor deleted the real
    // operator state dir. Now the marker on disk is the only authority, and a dir
    // that is PRESENT but unmarked must stop the removal with a loud failure.
    //
    // The dir is deliberately OUTSIDE a temp tree: `mkTempTree` is swept by
    // installCleanup()'s afterEach, which is registered before this file's, so a
    // tree-owned dir would be gone before the release could observe it. (That is
    // why requireMarker treats an absent dir as "nothing to remove" rather than as
    // a refusal — and why this case has to be built by hand to be observable.)
    const host = mkdtempSync(join(tmpdir(), 'synapto-nomarker-'))
    try {
      const stateDir = join(host, '.synaptomind')
      const ownership = acquireStateDir(stateDir)
      expect(existsSync(ownership.marker)).toBe(true)

      // Simulate a marker removed by something else: the dir is intact and still
      // holds the fixture's own files, and nothing marks them as ours any more.
      rmSync(ownership.marker, { force: true })
      let thrown: Error | null = null
      try {
        releaseCreatedStateDir(stateDir)
      } catch (err) {
        thrown = err as Error
      }
      // LOUDLY, and specifically: the message names the dir, the marker, and says
      // why removal is unsafe. A silent skip would leave the same mess while
      // reporting success — the failure mode this whole redesign exists to end.
      expect(thrown, 'a present but unmarked dir must NOT be removed silently').not.toBeNull()
      expect(thrown?.message ?? '').toContain('REFUSING TO REMOVE')
      expect(thrown?.message ?? '').toContain(stateDir)
      expect(thrown?.message ?? '').toContain(basename(ownership.marker))
      // And nothing was destroyed on the way to failing.
      expect(existsSync(stateDir)).toBe(true)
      expect(existsSync(join(stateDir, 'scripts', 'app.env'))).toBe(true)
    } finally {
      rmSync(host, { recursive: true, force: true })
    }
  })

  test('a release REFUSES when the marker was replaced, and a REPLACED seed is not deleted', () => {
    // Both cases need a dir outside the swept temp trees, for the same reason as
    // the test above: the refusal has to be observable, and a swept dir is gone
    // before the release can look at it.
    const host = mkdtempSync(join(tmpdir(), 'synapto-refuse-'))
    try {
      // A token mismatch means this process no longer has evidence it owns the dir.
      const stateDir = join(host, 'badtoken')
      const ownership = acquireStateDir(stateDir)
      writeFileSync(ownership.marker, 'somebody-elses-token\n')
      expect(() => releaseCreatedStateDir(stateDir)).toThrow(/REFUSING TO REMOVE/)
      expect(existsSync(stateDir)).toBe(true)

      // The other half: `unlinkIfUnchanged` only deletes what the fixture wrote,
      // so an app.env someone else replaced is left in place and the rmdir then
      // fails ENOTEMPTY. That is the intended outcome — a loud abort, never a
      // deletion of content the fixture did not create.
      const stateDir2 = join(host, 'replaced-seed')
      acquireStateDir(stateDir2)
      const operatorConfig = '# the operator\'s own config\n'
      writeFileSync(join(stateDir2, 'scripts', 'app.env'), operatorConfig)
      expect(() => releaseCreatedStateDir(stateDir2)).toThrow(/ENOTEMPTY|directory not empty/i)
      // The operator's bytes are still there — the abort cost a leaked dir, not data.
      expect(readFileSync(join(stateDir2, 'scripts', 'app.env'), 'utf8')).toBe(operatorConfig)
    } finally {
      rmSync(host, { recursive: true, force: true })
    }
  })

  test('a pre-existing dir WITHOUT an app.env keeps its contents and loses only the seed', () => {
    // The one case where the fixture writes into an operator's dir: the dir exists
    // but has no config yet (a half-finished install, or a host where only hooks/
    // was created). The seed is necessary — without it the digest pair is
    // vacuous — so teardown's job is to remove the seeded file, the marker, and
    // the scripts/ dir it needed, while leaving the dir itself and everything else
    // as found. It is a SEED-only acquire: `releaseSeededStateDir` has no branch
    // that removes the dir at all.
    const host = mkTempTree('synapto-halfinstalled-')
    const stateDir = join(host, '.synaptomind')
    mkdirSync(join(stateDir, 'hooks'), { recursive: true })
    const hook = '#!/bin/sh\necho operator hook\n'
    writeFileSync(join(stateDir, 'hooks', 'pre-update'), hook)
    const asFound = fingerprint(stateDir)

    const ownership = acquireStateDir(stateDir)
    expect(ownership.created, 'the dir pre-existed, so it is not ours to remove').toBe(false)
    expect(ownership.seeded).toBe(true)
    expect(createdDirs.has(stateDir), 'a pre-existing dir is never a removal candidate').toBe(false)
    expect(seededDirs.has(stateDir)).toBe(true)
    expect(hashAppEnv(stateDir)).toMatch(/^[0-9a-f]{64} [ *]/)
    // The seed must not have disturbed the file that was already there.
    expect(readFileSync(join(stateDir, 'hooks', 'pre-update'), 'utf8')).toBe(hook)

    releaseAllStateDirs()
    // Present, and byte- AND mtime-identical: a teardown that left the seeded
    // app.env or the marker behind fails the fingerprint, not just an existsSync.
    expect(existsSync(stateDir)).toBe(true)
    expect(fingerprint(stateDir)).toBe(asFound)
  })

  test('a PRE-EXISTING dir with its own app.env is not touched at all', () => {
    // The dev-machine case, on a synthetic dir: the operator has a config, so
    // there is nothing to seed and nothing to remove — the acquire registers
    // nothing, so the release has no candidate to act on. An unconditional rm -rf
    // fails here, and so does a rewrite of the operator's own file.
    const host = mkTempTree('synapto-operator-')
    const stateDir = join(host, '.synaptomind')
    mkdirSync(join(stateDir, 'scripts'), { recursive: true })
    mkdirSync(join(stateDir, 'unit-refresh'), { recursive: true })
    const operatorEnv = 'APP_NAME="synaptomind"\nINSTALL_DIR="/opt/synaptomind"\nPORT="3105"\n'
    writeFileSync(join(stateDir, 'scripts', 'app.env'), operatorEnv)
    writeFileSync(join(stateDir, 'scripts', 'app.env.bak-1101'), 'the #1101 backup\n')
    const asFound = fingerprint(stateDir)

    const ownership = acquireStateDir(stateDir)
    expect(ownership.created, 'a pre-existing dir must never be recorded as ours to create').toBe(false)
    expect(ownership.seeded, 'the operator already had an app.env, so nothing was seeded').toBe(false)
    // Zero footprint: not in EITHER registry, so neither release can reach it.
    expect(createdDirs.has(stateDir)).toBe(false)
    expect(seededDirs.has(stateDir)).toBe(false)
    expect(readFileSync(join(stateDir, 'scripts', 'app.env'), 'utf8')).toBe(operatorEnv)

    releaseAllStateDirs()
    expect(existsSync(stateDir), 'the teardown removed a state dir it did not create').toBe(true)
    // Every byte, and the empty unit-refresh/ dir a pattern-based cleanup would
    // also have taken.
    expect(fingerprint(stateDir)).toBe(asFound)
  })

  test('the ONLY way a baseline is ever written is through the marker-gated seed', () => {
    // R8, closed structurally and then checked structurally. `seedBaseline` is the
    // single writer of BASELINE_APP_ENV, and it re-reads the marker before writing.
    // A future edit that inlines the seed (or adds a second writer) would reopen the
    // hole that a statement order only closed by convention — and the earlier
    // mtime-based test could not see it, because both writes land in the same
    // millisecond.
    const src = readFileSync(resolve(DEPLOY_DIR, 'state-isolation.test.ts'), 'utf8')
    // And the gate itself must remain inside the writer, not at the call site: a
    // requireMarker in acquireStateDir would pass a weaker audit while leaving
    // seedBaseline callable with an unmarked dir.
    // The return type sits between the params and the brace (`): void {`), so the
    // pattern allows it — a stricter `\) \{` silently matched nothing and reported
    // the writer as absent, which is the failure mode this audit exists to avoid.
    const seedFn = /\nfunction seedBaseline\([^)]*\)[^{]*\{\n([\s\S]*?)\n\}/.exec(src)
    expect(seedFn, 'seedBaseline must exist as a single named writer').not.toBeNull()
    expect(seedFn?.[1] ?? '', 'seedBaseline must verify the marker before writing').toMatch(/requireMarker\(ownership\)/)
    // Order inside the writer: the gate, then the write.
    const gate = (seedFn?.[1] ?? '').indexOf('requireMarker(ownership)')
    const write = (seedFn?.[1] ?? '').indexOf('writeFileSync(appEnv, BASELINE_APP_ENV)')
    expect(gate, 'seedBaseline has no marker gate').toBeGreaterThanOrEqual(0)
    expect(write, 'seedBaseline has no baseline write').toBeGreaterThanOrEqual(0)
    expect(gate, 'the gate must come BEFORE the write, not after it').toBeLessThan(write)

    // AND it is the ONLY writer. A second writer anywhere else — an inlined seed,
    // a "quick" copy in some test — is exactly what would reopen the hole, and no
    // runtime assertion can see it, because while the suite is well behaved the
    // marker IS present and every write is marked. The check has to be structural
    // for the same reason the gate is.
    //
    // Counted as the EXACT call, not as a loose `writeFileSync(...BASELINE...`
    // pattern: this audit's own regex literals contain such a pattern as text, and
    // a loose search therefore matched itself and reported a second writer that
    // was never there — while a real second writer, written slightly differently,
    // would have slipped past. Line numbers, then, compared against seedBaseline's
    // own span.
    const WRITE_CALL = 'writeFileSync(appEnv, BASELINE_APP_ENV)'
    const codeLines = src.split('\n')
    const seedStart = codeLines.findIndex((l) => l.startsWith('function seedBaseline('))
    const seedEnd = codeLines.findIndex((l, i) => i > seedStart && l === '}')
    expect(seedStart, 'seedBaseline was not found as a top-level function').toBeGreaterThanOrEqual(0)
    expect(seedEnd, 'seedBaseline has no closing brace').toBeGreaterThan(seedStart)
    const writers = codeLines
      .map((l, i) => ({ i, l }))
      .filter(({ l }) => l.trim() === WRITE_CALL)
      .map(({ i }) => i)
    expect(writers, 'the baseline must be written exactly once, inside seedBaseline').toEqual([
      seedStart + 1 + (seedFn?.[1] ?? '').split('\n').findIndex((l) => l.trim() === WRITE_CALL),
    ])
    // And the acquire must route through the gate rather than call the writer
    // inline, which is the reordering this finding is about.
    expect(src).toMatch(/if \(needsSeed\) seedBaseline\(ownership, appEnv\)/)
  })

  test('a seed is UNREACHABLE without a verified marker, so order cannot protect it', () => {
    // R8, as a structural property rather than a statement order. The seed writes
    // into a dir that may be the OPERATOR's own, so the protection has to be a
    // precondition of the write: a seed must not be reachable without a marker
    // that reads back. Measured by calling the seed path directly with no marker
    // on disk — the exact state a crash between mkdir and marker would leave, and
    // the state a reordering of acquireStateDir would produce.
    //
    // Mtime ordering cannot prove this (both writes land in the same
    // millisecond), which is why the previous version of this test asserted
    // nothing and survived the mutation it was written to catch.
    const host = mkTempTree('synapto-order-')
    const stateDir = join(host, '.synaptomind')
    mkdirSync(stateDir, { recursive: true })
    const appEnv = join(stateDir, 'scripts', 'app.env')
    // An ownership record that was never given a marker file.
    const unmarked: StateDirOwnership = {
      dir: stateDir,
      created: false,
      seeded: false,
      token: randomUUID(),
      marker: join(stateDir, `${MARKER_PREFIX}never-planted`),
    }
    expect(() => seedBaseline(unmarked, appEnv), 'an unmarked seed must be refused').toThrow(/REFUSING TO REMOVE/)
    // Nothing was written: no scripts/, no app.env.
    expect(existsSync(join(stateDir, 'scripts'))).toBe(false)
    expect(existsSync(appEnv)).toBe(false)

    // And with a real marker it goes through, which is what makes the refusal a
    // precondition rather than a blanket ban.
    const ownership = acquireStateDir(stateDir)
    expect(existsSync(ownership.marker)).toBe(true)
    expect(ownership.seeded).toBe(true)
    expect(readFileSync(join(stateDir, 'scripts', 'app.env'), 'utf8')).toBe(BASELINE_APP_ENV)
    // The marker is a dotfile INSIDE the dir, so residue from a crash is
    // identifiable: `ls -a` on the state dir names it.
    expect(basename(ownership.marker).startsWith(MARKER_PREFIX)).toBe(true)

    releaseAllStateDirs()
    expect(existsSync(ownership.marker)).toBe(false)
  })

  test('a second acquire of the same dir is refused, never merged', () => {
    // The old `acquired.set` overwrote: a second acquire saw the dir already
    // present, recorded `created: false`, and the release then skipped the
    // removal — leaking a created dir — or worse, misattributed ownership. Both
    // registries refuse instead, because two live acquisitions of one dir is a
    // caller bug and the second release would undo the first's work.
    const host = mkTempTree('synapto-double-')
    const stateDir = join(host, '.synaptomind')
    acquireStateDir(stateDir)
    expect(() => acquireStateDir(stateDir)).toThrow(/already acquired/)
    // The refusal must leave the FIRST acquire intact, not half-registered.
    expect(createdDirs.has(stateDir)).toBe(true)
    expect(seededDirs.has(stateDir)).toBe(false)
    expect(() => acquireStateDir(stateDir)).toThrow(/already acquired/)
  })

  test('a release with no acquire is inert, and a second release cannot take a later dir', () => {
    // afterEach releases whatever a test left behind, so a path it never acquired
    // must do nothing at all: a teardown keyed on the path rather than on the
    // record would delete a pre-existing operator dir from THAT call.
    const host = mkTempTree('synapto-noop-')
    const foreign = join(host, 'not-acquired')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'app.env'), 'untouched\n')

    releaseAllStateDirs()
    expect(existsSync(foreign)).toBe(true)
    expect(readFileSync(join(foreign, 'app.env'), 'utf8')).toBe('untouched\n')

    // Acquire/release twice: the second release finds no record and does nothing,
    // so it cannot take the dir a LATER acquire created.
    const stateDir = join(host, 'later')
    acquireStateDir(stateDir)
    releaseAllStateDirs()
    expect(existsSync(stateDir)).toBe(false)
    acquireStateDir(stateDir)
    releaseAllStateDirs()
    releaseAllStateDirs()
    expect(existsSync(stateDir)).toBe(false)
  })

  test('the real operator state dir is never a removal candidate, whatever this host looks like', () => {
    // The end-to-end statement of R1 on the real path, and it runs whether or not
    // the host has a state dir. After a full acquire of the REAL state dir, it
    // must be in `createdDirs` only if this process actually created it — and on
    // a host that already had one, it is in neither registry, so no code path in
    // this file can delete it.
    const stateDir = operatorState()
    if (!existsSync(stateDir)) {
      // No state dir on this host: the acquire would create one, which is the CI
      // case, and it IS a legitimate removal candidate. Assert the marker makes
      // even that survivable rather than asserting the dir is protected.
      const ownership = acquireStateDir(stateDir)
      expect(ownership.created).toBe(true)
      expect(existsSync(ownership.marker)).toBe(true)
      releaseAllStateDirs()
      expect(existsSync(stateDir)).toBe(false)
      return
    }
    const asFound = fingerprint(stateDir)
    acquireStateDir(stateDir)
    // A pre-existing dir with an app.env is registered nowhere. If a host has a
    // dir but no app.env, it is seed-only — also not a removal candidate.
    expect(createdDirs.has(stateDir), 'a pre-existing real state dir is in the removal registry').toBe(false)
    releaseAllStateDirs()
    expect(existsSync(stateDir)).toBe(true)
    expect(fingerprint(stateDir)).toBe(asFound)
  })
})

// ─── THE PROOF THAT THE SKIP ABOVE WORKS (#1356) ────────────────────────────
/**
 * `userNamespaceAvailable` decides the #1104 skip, and the branch it guards is
 * unreachable on this host: locally `unshare` works, so the two tests always
 * RUN, and no local result can distinguish a correct skip from a guard that
 * silently never fires. A skip nobody can prove is a skip nobody can trust —
 * it reads exactly like a pass in a green CI log, which is precisely the
 * failure mode of the run that motivated it (#1096, #1097).
 *
 * So the decision function is tested directly, against the two RECORDED REAL
 * spawnSync results — no root, no namespace, no unshare, no network. This block
 * runs on a runner without userns too, which is where it earns its keep: it is
 * the evidence that the block above was skipped on purpose.
 */
describe('the user-namespace probe is what decides the #1104 skip (#1356)', () => {
  /** Recorded 2026-10-05 from CI run 37318719080, ubuntu-latest (24.04):
   *  AppArmor's `unprivileged_userns` profile denies the uid_map write. util-linux
   *  2.39 prints this and exits EXIT_FAILURE. Verbatim. */
  const RECORDED_DENIAL: SpawnProbe = {
    status: 1,
    stdout: '',
    stderr: 'unshare: write failed /proc/self/uid_map: Operation not permitted\n',
  }

  /** Recorded 2026-10-05 on this host (`util-linux 2.39.3`, uid 1000): the same
   *  command exits 0 and the body proves it by printing uid 0. Verbatim. */
  const RECORDED_SUCCESS: SpawnProbe = {
    status: 0,
    stdout: `${USERNS_PROBE_OK}\n`,
    stderr: '',
  }

  test('the recorded ubuntu-latest denial is decided unavailable — the #1104 block skips', () => {
    expect(userNamespaceAvailable(RECORDED_DENIAL)).toBe(false)
    // The decision is also about the failure TEXT, so assert the record still is
    // what CI actually printed — a paraphrase here would quietly stop matching.
    expect(RECORDED_DENIAL.stderr).toContain('Operation not permitted')
    expect(RECORDED_DENIAL.stderr).toContain('/proc/self/uid_map')
  })

  test('the recorded local success is decided available — the #1104 block runs', () => {
    // Host-independent on purpose: this must hold on a runner with userns AND on
    // one without. What the live probe answers is asserted separately below.
    expect(userNamespaceAvailable(RECORDED_SUCCESS)).toBe(true)
  })

  test('a denial is refused on its text even if it exits 0', () => {
    // The case that makes the text check load-bearing rather than decorative:
    // a `unshare` (or a PATH entry masquerading as one) that reports failure and
    // still exits 0 would, on exit status alone, be read as a working namespace
    // and the guard would rot into a permanent pass measuring nothing.
    expect(userNamespaceAvailable({ status: 0, stdout: '', stderr: RECORDED_DENIAL.stderr })).toBe(false)
    // The other real denial shape, recorded locally by nesting unshare inside an
    // existing user namespace — it denies at clone(), not at the uid_map write, so
    // a predicate keyed on `/proc/self/uid_map` alone would miss it.
    expect(
      userNamespaceAvailable({ status: 1, stdout: '', stderr: 'unshare: unshare failed: Operation not permitted\n' }),
    ).toBe(false)
  })

  test('an exit 0 that never printed the marker is not a namespace', () => {
    // `true`-for-everything unshare. Exit status alone would call this a working
    // namespace and the guard would silently stop guarding.
    expect(userNamespaceAvailable({ status: 0, stdout: '', stderr: '' })).toBe(false)
    expect(userNamespaceAvailable({ status: 0, stdout: 'something else\n', stderr: '' })).toBe(false)
    // And the marker must prove uid 0 specifically — `id -u` outside the namespace
    // prints this host's uid, which is not a mapped root.
    expect(userNamespaceAvailable({ status: 0, stdout: 'USERNS_PROBE_OK uid=1000\n', stderr: '' })).toBe(false)
    // No unshare on PATH at all: spawnSync reports ENOENT here rather than a status.
    expect(userNamespaceAvailable({ status: null, error: Object.assign(new Error('spawn unshare ENOENT'), { code: 'ENOENT' }) })).toBe(false)
    // Killed by a signal: status arrives null.
    expect(userNamespaceAvailable({ status: null, stdout: '', stderr: '' })).toBe(false)
  })

  test('the note is attached exactly when the block is skipped, and says the tests did not run', () => {
    // The note is the only thing a CI log reader sees, so the properties that
    // matter are that it is present exactly when the block is skipped, that it
    // says the tests did not run, and that it names the mechanism rather than
    // shrugging at "unsupported environment". The first assertion is the one that
    // makes the note impossible to mistake for a pass: a note attached while the
    // tests ran (or missing while they were skipped) fails here.
    expect(USERNS_SKIP_NOTE !== '').toBe(!HAS_USERNS)
    if (HAS_USERNS) {
      expect(USERNS_SKIP_NOTE).toBe('')
      return
    }
    expect(USERNS_SKIP_NOTE).toContain('SKIPPED, NOT RUN')
    expect(USERNS_SKIP_NOTE).toContain('Operation not permitted')
    expect(USERNS_SKIP_NOTE).toContain('/proc/self/uid_map')
    expect(USERNS_SKIP_NOTE).toContain('#1104')
  })

  test('when the block RUNS, the probe really measured a namespace on this host', () => {
    // The other half, for the host that can measure: the constant is derived from
    // the recorded spawn, not asserted. Conditional, so it is still correct on a
    // runner without userns — there the block skips and this has nothing to check.
    // Without it, a probe that quietly started refusing working hosts would turn
    // the #1104 characterization tests into a permanent silent skip that no green
    // CI log would ever reveal.
    if (!HAS_USERNS) {
      expect(USERNS_PROBE.status === 0 && `${USERNS_PROBE.stdout ?? ''}`.includes(USERNS_PROBE_OK)).toBe(false)
      return
    }
    expect(USERNS_PROBE.error).toBeUndefined()
    expect(USERNS_PROBE.status).toBe(0)
    expect(`${USERNS_PROBE.stdout ?? ''}`.split('\n').map((l) => l.trim())).toContain(USERNS_PROBE_OK)
  })
})

describe('isolatedEnv refuses the operator\'s real state dir', () => {
  test('realStateDir resolves through getent, the same lookup that defeats a substituted HOME', () => {
    if (!REAL_STATE) {
      expect(realStateDir()).toBeNull()
      return
    }
    const expected = spawnSync('bash', ['-c', 'getent passwd "$(id -un)" | cut -d: -f6'], {
      encoding: 'utf8',
    }).stdout.trim()
    expect(REAL_STATE).toBe(`${expected}/.synaptomind`)
  })

  test('an unopted-in fixture cannot obtain an env pointing at the real state dir', () => {
    const root = mkTempTree('synapto-refuse-')
    // The default is safe: RUN_DIR is inside the fixture root.
    const safe = isolatedEnv(root)
    expect(safe.RUN_DIR).toBe(join(root, 'run'))
    expect(safe.RUN_DIR!.startsWith(root)).toBe(true)

    if (!REAL_STATE) return
    // And an override aimed at the real dir fails at CONSTRUCTION time, before
    // any process exists to do the damage. This is what makes the property
    // enforced rather than documented: the mistake cannot be made quietly.
    expect(() => isolatedEnv(root, { RUN_DIR: REAL_STATE })).toThrow(/REAL state dir/)
    expect(() => isolatedEnv(root, { RUN_DIR: join(REAL_STATE, 'scripts') })).toThrow(/REAL state dir/)
    expect(() => isolatedEnv(root, { HOOKS_DIR: join(REAL_STATE, 'hooks') })).toThrow(/REAL state dir/)
    expect(() => isolatedEnv(root, { UNIT_FILE: join(REAL_STATE, 'unit', 'x.service') })).toThrow(/REAL state dir/)
    expect(() => isolatedEnv(root, { DATA_DIR: REAL_STATE })).toThrow(/REAL state dir/)
    // A path merely sharing a PREFIX must not be refused — otherwise the guard
    // would push fixtures back into the exact habit it exists to prevent.
    expect(() => isolatedEnv(root, { RUN_DIR: `${REAL_STATE}-fixture/run` })).not.toThrow()
  })

  // The construction the block above depends on, asserted where it can be
  // checked on any host — including one with no state dir, where the #1104 block
  // skips and none of this would otherwise be measured (the #1096 lesson: a skip
  // must not silently take a guarantee with it).
  test('the state dir the block constructs is the passwd home plus the app name', () => {
    // The account comes from `getent passwd <uid>`, so it is derived the same way
    // realStateDir() derives it rather than from $USER. Checked against getent
    // directly so a refactor of operatorAccount() cannot quietly redefine the
    // expectation and make the block's assertions agree with it by construction.
    const uid = process.getuid?.()
    expect(uid, 'the fixture refuses to guess an account, so a uid-less host cannot run it').toBeDefined()
    const byUid = spawnSync('getent', ['passwd', String(uid)], { encoding: 'utf8' }).stdout.trim()
    const fields = byUid.split(':')
    expect(operatorAccount().user, 'field 1 of the passwd line is the account name').toBe(fields[0])
    expect(operatorAccount().home, 'field 6 is the home resolve_target_user() takes').toBe(fields[5])
    expect(operatorAccount().home).not.toBe('')
    expect(operatorState()).toBe(join(fields[5] ?? '', '.synaptomind'))
    // Absolute, so a `getent` that answered nothing could not turn the bind
    // target into a relative path that resolves against the repo checkout.
    expect(isAbsolute(operatorState())).toBe(true)
    // NO `/root` FALLBACK, and that is measured rather than asserted in prose
    // (R7). The previous version read `process.env.USER ?? 'root'` and computed
    // the home the same way, so on any host that exports no USER the whole
    // fixture would create and seed /root/.synaptomind. `operatorAccount()` now
    // derives both from `getent passwd <uid>` and THROWS when that answers
    // nothing, so a home can never be invented. Proven by feeding it a uid with
    // no passwd entry: the resolution must refuse rather than fall back.
    const noSuchUid = '4294967294'
    const absent = spawnSync('getent', ['passwd', noSuchUid], { encoding: 'utf8' })
    if (absent.status === 0 && absent.stdout.trim() !== '') {
      // A host that really has that entry cannot be used as the probe; the two
      // assertions above still hold, so skip rather than assert something false.
      expect(operatorAccount().home).not.toBe('/')
    } else {
      // `operatorAccount` is memoised, so the probe is the same pure lookup the
      // real one does — asserted here as a property of that lookup, with the
      // throw path exercised through a fresh, unmemoised instance of it.
      expect(() => resolveOperatorAccount(999999999)).toThrow(/operatorAccount/)
    }
    // And never aimed at /root unless this account's passwd home really is /root.
    // The earlier `process.env.USER ?? 'root'` fallback would have created and
    // seeded /root/.synaptomind on any host that exports no USER.
    if (operatorAccount().home !== '/root') {
      expect(operatorState().startsWith('/root/'), 'the fixture must never aim at /root').toBe(false)
    }
    // And it is the SAME path realStateDir() reports on a host that has one,
    // which is what keeps the constructed dir and the discovered one from
    // drifting into two different directories.
    if (REAL_STATE) expect(operatorState()).toBe(REAL_STATE)
    else expect(existsSync(operatorState())).toBe(false)
  })

  test('fingerprint notices a change even when the bytes are identical', () => {
    // The mtime+size half of the fingerprint earns its place here. A hash-only
    // fingerprint cannot see `touch app.env` — and a fixture that touches the
    // operator's config, or rewrites it with byte-identical content, is exactly
    // the case that hides. Proven by mutation: dropping `${st.size} ${st.mtimeMs}`
    // from the hash leaves this test green only if the assertion below is wrong,
    // so the check is real rather than decorative.
    const dir = mkTempTree('synapto-fingerprint-')
    const file = join(dir, 'app.env')
    writeFileSync(file, 'DIST="binary"\n')
    const first = fingerprint(dir)

    // Identical bytes, different mtime.
    const STAMP = new Date('2001-02-03T04:05:06Z')
    utimesSync(file, STAMP, new Date())
    expect(readFileSync(file, 'utf8')).toBe('DIST="binary"\n')
    expect(fingerprint(dir)).not.toBe(first)

    // Different bytes at the same length: catches a config edit that only swaps
    // a port, which a length-based check would miss.
    const second = fingerprint(dir)
    writeFileSync(file, 'DIST="source"\n')
    expect(fingerprint(dir)).not.toBe(second)

    // A new file is a change too — the helper scripts are written one by one.
    writeFileSync(join(dir, 'update.sh'), '#!/bin/sh\n')
    expect(fingerprint(dir)).not.toBe(second)
  })

  // R6: the name says exactly what this checks. It is a SHAPE check, not a
  // byte-identity check, and the previous name claimed otherwise.
  test('the real state dir still holds a production-shaped app.env after everything above', () => {
    // End-of-file tripwire in test form, so the claim is in the suite's own
    // result rather than only in a comment. Guarded by a real check rather than
    // an early `return`, so the branch a state-dir-less host takes is asserted
    // too (#1096): the fixture created no state dir here, so none is expected —
    // and if one WERE left behind, that is a leak and must fail, not pass.
    if (!REAL_STATE) {
      expect(existsSync(operatorState()), 'the fixture created a state dir and did not clean it up').toBe(false)
      expect([...createdDirs.keys(), ...seededDirs.keys()], 'a state dir was left acquired after the run').toEqual([])
      return
    }
    const envFile = join(REAL_STATE, 'scripts', 'app.env')
    expect(existsSync(envFile)).toBe(true)
    const body = readFileSync(envFile, 'utf8')
    // The production shape, asserted so a future run that DID overwrite this
    // cannot pass by writing an app.env that happens to exist.
    expect(body).toContain('INSTALL_DIR="/opt/synaptomind"')
    expect(body).toContain('PORT="3105"')
    expect(body).toContain('DIST="binary"')

    // WHAT THIS TRIPWIRE CANNOT SEE, because the next reader will assume it can.
    // It greps three strings; it is not a content comparison, and a rewrite that
    // keeps all three lines is invisible to it.
    //
    //   1. A HEALTH_URL-only rewrite PASSES this check. That is not hypothetical:
    //    it is the exact residual left on this host when the operator's app.env
    //    had to be reconstructed after the state-dir incident — the file kept
    //    INSTALL_DIR, PORT and DIST and differed in one line. A test that had
    //    been trusted to catch that would have passed while the operator's update
    //    path pointed at a different port.
    //   2. A byte-identical rewrite (or a pure `touch`) also passes: the bytes
    //    are what it reads, and an mtime change is invisible to a grep. Only
    //    `fingerprint()` — asserted two tests above — sees mtime.
    //   3. A deleted-and-recreated file with a different inode but the same three
    //    lines passes too.
    //
    // So the STRONGER check is the one the #1104 block already makes: the
    // before/after sha256 pair around the reproduction. This is the floor, and
    // its job is to catch the wholesale overwrite that a leaked seed or a
    // misdirected fixture produces.
    expect(body).not.toContain('HEALTH_URL="http://127.0.0.1:1/health"')
  })
})

// ─── THE CLAIMS THIS FILE MAKES ABOUT ITSELF (#1357 R5/R6) ────────────────────
/**
 * Comments and test names are load-bearing here, because the findings that sent
 * this file back were a COMMENT overstating its assertion and a NAME overstating
 * its check. Neither is a runtime behaviour, so neither can be caught by running
 * anything — a mutation that reverts them leaves the suite green, which is
 * precisely how they survived the first review.
 *
 * So they are audited as source. This is the honest form of the claim: not "the
 * comment is true" (unprovable) but "the file still says what it does, and still
 * carries the limitation next to the check that has it".
 */
describe('this file does not overstate what its own assertions prove (#1357 R5/R6)', () => {
  const SRC = readFileSync(resolve(DEPLOY_DIR, 'state-isolation.test.ts'), 'utf8')

  /**
   * The body of the test whose name contains `name`, up to the next `test(` at the
   * same indentation — so a claim can be required to live INSIDE the check it
   * qualifies, rather than anywhere in the file.
   *
   * Whole-file substring searches are what made the first version of this audit
   * useless: it quoted the very strings it asserted were present, so deleting the
   * note it was checking still passed. Returns '' when the test is not found, which
   * the caller asserts on.
   */
  function sliceTest(src: string, name: string): string {
    const lines = src.split('\n')
    // The DECLARATION, not any mention: an audit that searches from the first
    // occurrence of the name would start inside its own regex literals, and an
    // end-boundary that compares raw line length would never match a `describe`
    // at column 0, so the slice would run to EOF and then "find" the very strings
    // it is auditing inside this file's own source. That bug made the audit pass
    // with the note deleted.
    const start = lines.findIndex((l) => /^\s*test\(`?'?/.test(l) && l.includes(`test('${name}`))
    if (start === -1) return ''
    const indentOf = (l: string): number => l.length - l.trimStart().length
    const indent = indentOf(lines[start] ?? '')
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      // Any `test(`/`describe(` at this indent or shallower ends the body. A
      // nested `test(` deeper down belongs to the body, not after it.
      if (indentOf(line) <= indent && /^\s*(test|describe)\(/.test(line)) {
        end = i
        break
      }
    }
    return lines.slice(start, end).join('\n')
  }

  test('the tripwire is not named as byte-identical, and carries its blind spots', () => {
    // R6: the check greps three strings, so "byte-identical" was false. Renamed to
    // what it does, and the blind spots are recorded AT the check.
    //
    // Both lookups are anchored to a line that STARTS a `test(` call, so this audit
    // does not match the string literals it quotes. A plain substring search would
    // make the audit fail for mentioning the old name, which is backwards.
    expect(SRC, 'the tripwire is still declared as a byte-identity claim').not.toMatch(
      /^\s*test\('the real state dir is byte-identical/m,
    )
    expect(SRC, 'the tripwire must be declared as the shape check it is').toMatch(
      /^\s*test\('the real state dir still holds a production-shaped app\.env after everything above'/m,
    )
    // The limitations must be documented INSIDE the tripwire's own body, not
    // somewhere else in the file: the note exists for whoever reads THAT check. A
    // whole-file `toContain` is too weak — it passed while the note had been
    // deleted, because the audit quoted the same string. So the tripwire's text is
    // sliced out and searched on its own.
    const tripwire = sliceTest(SRC, 'the real state dir still holds a production-shaped app.env after everything above')
    expect(tripwire, 'the tripwire body could not be located').not.toBe('')
    // A HEALTH_URL-only rewrite passes this check, and that is the exact residual
    // this task left on the production host — the reader must not rediscover it.
    expect(tripwire).toContain('A HEALTH_URL-only rewrite PASSES this check')
    expect(tripwire).toMatch(/byte-identical rewrite \(or a pure `touch`\) also passes/)
    // And it names the check that does see those, rather than implying this is the
    // strongest available. Matched with a leading newline so it must be the line's
    // own text — the audit quotes the same phrase a few lines below, and a bare
    // substring search was reading its own copy.
    expect(tripwire).toMatch(/^\s*\/\/ before\/after sha256 pair around the reproduction\./m)
    // And the file must point at the check that does see those, rather than
    // implying the tripwire is the strongest available.
    expect(SRC).toContain('the before/after sha256 pair around the reproduction')
  })

  test('the IN_NS_HOME comment does not claim to be the mechanism', () => {
    // R5: the parsed value can only ever be `process.env.HOME`, because the line is
    // echoed before the redirect and the child env is a spread of this process's.
    // Calling that "the mechanism" is how a tautology gets mistaken for evidence.
    expect(SRC).toContain('IN_NS_HOME IS NOT THE MECHANISM, and is not claimed to be')
    expect(SRC, 'GETENT_HOME must be identified as the value carrying the mechanism').toContain(
      'GETENT_HOME IS THE MECHANISM',
    )
    // And the honest comment must be kept honest by the assertion next to it: the
    // value has to be provably NOT the post-redirect scratch root, which is the one
    // thing it does establish. Dropping that assertion is what the R5 mutation did.
    expect(SRC, 'the pre-redirect assertion for IN_NS_HOME must be present').toMatch(
      /^\s*expect\(inNsHome, 'IN_NS_HOME was echoed AFTER the fixture redirected HOME[^\n]*\)\.not\.toBe\(scratchHome\)/m,
    )
    // The honesty note has to sit in the REPRODUCTION's own body, not only in a
    // rationale above it — a rationale can be edited and leave a claim standing
    // next to code that no longer earns it. Sliced out and searched on its own, so
    // moving the note elsewhere in the file fails here.
    const repro = sliceTest(SRC, 'unmodified install.sh with no RUN_DIR writes into the REAL state dir even when HOME is a scratch root')
    expect(repro, 'the reproduction test body could not be located').not.toBe('')
    expect(repro).toContain('IN_NS_HOME IS NOT THE MECHANISM, and is not claimed to be')
    // GETENT_HOME carries the mechanism instead, and says so in the same place.
    expect(repro).toContain('GETENT_HOME IS THE MECHANISM')
    // The coinciding-home branch is what stops the two values being implicitly
    // treated as independent evidence on a host where they are the same string.
    expect(SRC).toMatch(/^\s*if \(operatorAccount\(\)\.home === \(process\.env\.HOME \?\? ''\)\) \{/m)
  })

  test('the teardown rationale does not describe itself as merely conditional', () => {
    // The reviewer's objection in one line: the previous teardown was safe only as
    // long as nobody edited it. The file must not describe the marker gate as a
    // convention or a bit.
    expect(SRC).toContain('Structurally incapable of destruction, by construction rather than by discipline')
    expect(SRC, 'the worst case must be stated as leak-or-loud-failure').toContain(
      'a leaked empty dir or a loud throw',
    )
  })
})

describe('this file cannot recursively delete anything (R1)', () => {
  test('no code path in this file performs a RECURSIVE delete', () => {
    // The structural claim behind the marker gate, asserted rather than asserted-
    // in-prose. The teardown's safety rests on there being no recursive delete to
    // reach for: an `rmSync(dir, {recursive: true})` is one careless edit away,
    // and the previous version of this file contained exactly that line. If one
    // is ever added back, this fails instead of a developer discovering it the
    // way the operator's state dir was discovered.
    //
    // `mkdirSync(dir, { recursive: true })` is NOT a delete and is deliberately
    // allowed — creating a missing parent is not destruction. The audit is keyed
    // on the call being a REMOVE, matching `recursive: true` against the nearest
    // call on the same or a preceding line (a call may be formatted across lines).
    const DELETE_CALL = /\b(rmSync|rmdirSync|rm|unlinkSync|unlink|cpSync|copyFileSync|execSync|truncate|fchmod)\b/
    const src = readFileSync(resolve(DEPLOY_DIR, 'state-isolation.test.ts'), 'utf8')
    const lines = src.split('\n')
    // Every variable this file assigns from mkdtempSync — the only names a
    // recursive delete may target. Collected from the source rather than
    // hardcoded, so a new mkdtemp in a future test is covered automatically and a
    // rename cannot silently widen the exemption.
    const mkdtempVars = new Set(
      [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*mkdtempSync\(/g)].map((m) => m[1] ?? ''),
    )
    expect([...mkdtempVars].length, 'the exemption is only meaningful if mkdtempSync is actually used').toBeGreaterThan(0)
    const offenders: string[] = []
    lines.forEach((line, i) => {
      if (!/recursive:\s*true/.test(line)) return
      // Comments document the pattern, they do not use it — this very test's name
      // and the teardown's rationale both contain the string.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
      // A `mkdir` in that window means this is a directory CREATION.
      if (/\bmkdir(Sync)?\b/.test(window)) return
      if (!DELETE_CALL.test(window)) return
      // THE ONE EXEMPTION, and it is narrow on purpose. A dir made by
      // `mkdtempSync` is a fresh empty directory whose name only this process ever
      // learned, created in the test that deletes it. That is not the operator's
      // state dir under any reading, which is why the two refusal tests may clean
      // up with a recursive rm. The exemption is matched against the VARIABLE a
      // mkdtempSync call was assigned to, not against proximity — so
      // `rmSync(operatorState(), { recursive: true })` stays an offender, which is
      // the line that actually caused the incident.
      const target = /\brm(?:Sync)?\(\s*([A-Za-z_$][\w$]*)/.exec(window)?.[1]
      if (!(target && mkdtempVars.has(target))) offenders.push(`${i + 1}: ${line.trim()}`)
    })
    expect(
      offenders,
      `recursive delete in this file — use a point unlink plus a non-recursive rmdir, so ` +
        `unexpected content aborts loudly instead of being destroyed:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

describe('every deploy fixture resolves RUN_DIR inside its own tree', () => {
  // The audit criterion, as an executable claim rather than a review note: no
  // deploy test file may spawn a deploy script through a bare `...process.env`,
  // because that is the exact shape that reached the real state dir.
  const SPAWNERS = ['install.sh.test.ts', 'updater.sh.test.ts', 'run-hook.test.ts']

  test('no deploy fixture builds a spawn env from a bare process.env spread', () => {
    const offenders: string[] = []
    for (const f of SPAWNERS) {
      const lines = readFileSync(resolve(DEPLOY_DIR, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\.\.\.process\.env/.test(line)) return
        // Comments must not count: this very harness and the fixtures' own
        // rationale discuss the pattern in prose, and an audit that flagged its
        // own documentation would be noise. Only CODE is in scope.
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line)
        if (isComment) return
        // A `...process.env` INSIDE isolatedEnv(...) is the sanctioned form; a
        // bare one in a spawnSync env object is not. Proximity to `isolatedEnv`
        // is the discriminator, checked within a few lines either way.
        const window = lines.slice(Math.max(0, i - 6), i + 6).join('\n')
        if (window.includes('isolatedEnv(')) return
        offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, `bare \`...process.env\` spawn env — build it with isolatedEnv():\n${offenders.join('\n')}`).toEqual([])
  })

  test('no deploy fixture overrides RUN_DIR to a path outside its own tree', () => {
    // Static form of the same claim: every RUN_DIR literal a fixture writes must
    // be derived from a temp tree, never a literal home path.
    const offenders: string[] = []
    for (const f of SPAWNERS) {
      readFileSync(resolve(DEPLOY_DIR, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/RUN_DIR/.test(line)) return
          if (/\/(home|root)\//.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders, `RUN_DIR aimed at a home directory:\n${offenders.join('\n')}`).toEqual([])
  })

  test('dirname is imported where it is now used', () => {
    // A tiny wiring assertion, but the alternative was a module-level read of a
    // describe-scoped `let ROOT`, which silently wired one describe's root into
    // another's assertions. install.sh.test.ts derives the root from deployDir.
    const src = readFileSync(resolve(DEPLOY_DIR, 'install.sh.test.ts'), 'utf8')
    expect(src).toMatch(/import \{[^}]*\bdirname\b[^}]*\} from 'node:path'/)
    expect(src).toContain('isolatedEnv(dirname(deployDir)')
  })
})
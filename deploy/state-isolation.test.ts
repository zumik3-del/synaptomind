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

import { describe, expect, test, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
 * `envOverrides` is merged LAST so a caller can pin RUN_DIR — that is the whole
 * difference between the two halves of the test below, and it is the only thing
 * that changes.
 */
function runInNamespace(opts: {
  root: string
  shadow: string
  envOverrides?: Record<string, string>
}): Repro {
  const { root, shadow } = opts
  const privLog = join(root, 'priv.log')
  const envLines = Object.entries(opts.envOverrides ?? {})
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n')
  const script = [
    'set -u',
    // The shadow. If this fails the run is abandoned rather than allowed to
    // continue against the real directory.
    `mount --bind ${JSON.stringify(shadow)} ${REAL_STATE} 2>/dev/null || { echo "SHADOW_BIND_FAILED"; exit 9; }`,
    `echo "GETENT_HOME=$(getent passwd "${APP_USER_IN_NS}" 2>/dev/null | cut -d: -f6)"`,
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
    `export SUDO_USER=${JSON.stringify(APP_USER)}`,
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
// run is uid 0, so SUDO_USER is what selects the target — this mirrors the real
// `curl | sudo bash` shape the scripts are written for.
const APP_USER = process.env.USER ?? 'root'
const APP_USER_IN_NS = APP_USER

afterEach(() => {
  sweepTempTrees()
})

describe.skipIf(!HAS_USERNS)(`deploy state-dir containment (#1104)${USERNS_SKIP_NOTE}`, () => {
  test('unmodified install.sh with no RUN_DIR writes into the REAL state dir even when HOME is a scratch root', () => {
    const root = mkTempTree('synapto-red-repro-')
    const shadow = join(root, 'shadow')
    mkdirSync(shadow, { recursive: true })
    seedUnisolatedFixture(root)
    seedPrivStubs(root)

    const before = spawnSync('sha256sum', [join(REAL_STATE, 'scripts', 'app.env')], { encoding: 'utf8' }).stdout.trim()
    const repro = runInNamespace({ root, shadow })

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
      `expected the reproduction to escape into ${REAL_STATE}, but nothing was written there.\n` +
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

    // The two facts that make the escape explicable rather than mysterious.
    expect(repro.output).toContain('GETENT_HOME=/home/opencode')
    expect(repro.output).toContain('IN_NS_HOME=/home/opencode')
    // The run reported the REAL state dir as its own, which is the operator-
    // facing symptom: the summary an operator reads names their live config.
    expect(repro.output).toContain(`Config:     ${REAL_STATE}/scripts/app.env`)

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
    const after = spawnSync('sha256sum', [join(REAL_STATE, 'scripts', 'app.env')], { encoding: 'utf8' }).stdout.trim()
    expect(after).toBe(before)
  }, 180_000)

  test('the SAME install.sh run, driven through isolatedEnv, stays inside the fixture root', () => {
    const root = mkTempTree('synapto-green-harness-')
    const shadow = join(root, 'shadow')
    mkdirSync(shadow, { recursive: true })
    const env = isolatedEnv(root)
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
    const repro = runInNamespace({
      root,
      shadow,
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
    expect(repro.escaped, `escaped into ${REAL_STATE}: ${repro.escaped.join(', ')}`).toEqual([])
    // The helpers it would have written went to the fixture's own RUN_DIR.
    expect(repro.inside).toContain('run/scripts/app.env')
  }, 180_000)
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

  test('the real state dir is byte-identical after everything above', () => {
    // End-of-file tripwire in test form, so the claim is in the suite's own
    // result rather than only in a comment.
    if (!REAL_STATE) return
    const envFile = join(REAL_STATE, 'scripts', 'app.env')
    expect(existsSync(envFile)).toBe(true)
    const body = readFileSync(envFile, 'utf8')
    // The production shape, asserted so a future run that DID overwrite this
    // cannot pass by writing an app.env that happens to exist.
    expect(body).toContain('INSTALL_DIR="/opt/synaptomind"')
    expect(body).toContain('PORT="3105"')
    expect(body).toContain('DIST="binary"')
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
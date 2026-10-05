/**
 * A full sandboxed lifecycle for each app.env that ships outside this repo:
 * install → health gate → update → idempotence → rollback.
 *
 * WHY A SEPARATE FILE FROM app-env-conformance.test.ts. That file asks whether
 * the framework's new keys WORK; this one asks whether a real app can be
 * DEPLOYED with them, which is a different question with a different cost. Here
 * every run is a complete install or update — clone or tarball, install, build,
 * unit write, restart, health poll — so the suite is minutes rather than
 * seconds, and a failure inside it is about a lifecycle, not about one key.
 *
 * WHAT IS SANDBOXED, AND WHY IT IS ENOUGH. Nothing privileged runs and nothing
 * outside the fixture tree is written:
 *
 *   INSTALL_DIR / DATA_DIR / RUN_DIR / HOOKS_DIR / EXEC_START / UNIT_FILE are
 *     redirected into a temp tree — in the app.env COPY, because load_app_env()
 *     SOURCES app.env and a plain assignment there beats the process environment.
 *     Both new app.envs carry `RUN_DIR=""`, which resolve_target_user() then
 *     derives from `getent passwd` into the operator's REAL ~/.ziptask or
 *     ~/.subagentix. That is the #1101 incident exactly, and it happened while
 *     every assertion was green.
 *   sudo and systemctl are PATH stubs. sudo has its OWN secure_path, so a stub
 *     does not cover it in general — but here the stub is what the framework
 *     resolves `sudo` to (it is first on PATH) and nothing else can reach the
 *     real one, because the fixture never invokes an absolute path. AGENTS.md §8
 *     records a "sandboxed" demo that restarted the live service five times; the
 *     difference is that this suite has no real systemctl to fall through to.
 *   curl is a stub serving the release asset from a local directory and a chosen
 *     /health body. No network, and no service is ever actually started — which
 *     is the point of the health assertions: they exercise the GATE, not a
 *     process.
 *   guardRealStateDir() fingerprints the operator's real state dir for the whole
 *     run and fails the run if it moved. That is the check which would have
 *     caught #1101, and it verifies the containment from the OUTSIDE — it holds
 *     even if a fixture bypasses every sandbox above.
 *
 * The app.env under test is the app's OWN file, unmodified except for the paths
 * above. Every other key — DIST, the health contract, INSTALL_FLAGS, BUILD_CMD,
 * BINARY_* — is what the repo ships.
 */

import { describe, expect, test, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { guardProductionPaths, readAppEnvValues, resolveTargets, sandboxAppEnvText } from './app-targets'
import { guardRealStateDir, installCleanup, isolatedEnv, mkTempTree } from './tmp-fixtures'

installCleanup()
guardRealStateDir()

const DEPLOY_DIR = import.meta.dir
const TARGETS = resolveTargets()
// Containment for the TARGETS, not just for this repo's own app: guardRealStateDir()
// watches ~/.synaptomind, which says nothing about ~/.ziptask or ~/.subagentix.
// See guardProductionPaths for why the check lives at process exit and why the
// live tracker's own data directory is excluded from the watch list.
guardProductionPaths(TARGETS.resolved)

/** The /health body both new apps answer with (ADR §3d). */
const HEALTHY_BODY = '{"ok":true}'
/** The same contract with the ok-value flipped — must fail, or the gate is vacuous. */
const UNHEALTHY_BODY = '{"ok":false}'

let ROOT = ''
afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
  ROOT = ''
})

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function ensureRoot(prefix = 'sandbox-'): string {
  if (!ROOT) ROOT = mkTempTree(prefix)
  return ROOT
}

// ── Fixture ──────────────────────────────────────────────────────────────────

interface Sandbox {
  target: { label: string; deployDir: string; appEnvPath: string }
  root: string
  installDir: string
  dataDir: string
  runDir: string
  unitFile: string
  stubsDir: string
  privLog: string
  /** The file the curl stub reads the /health body from. */
  healthFile: string
  /** The file the bun stub records its argv in. */
  bunLog: string
  /** Where the systemctl stub models the running unit. */
  stateDir: string
  binary: boolean
  /** The version currently published on the origin / in the release dir. */
  version: string
  /** Publish a new version on the origin (source) or in the release dir (binary). */
  publishVersion(version: string): void
  /** The version the installed payload reports right now, or '' when it cannot. */
  installedVersion(): string
}

const V1 = '1.0.0'
const V2 = '2.0.0'

function seedSandbox(target: { label: string; deployDir: string; appEnvPath: string }, opts: { initialVersion?: string } = {}): Sandbox {
  const root = ensureRoot(`sandbox-${target.label}-`)
  const label = target.label
  const values = readAppEnvValues(target.appEnvPath)
  const binary = values.DIST === 'binary'
  const version = opts.initialVersion ?? V1

  // ── the origin the framework will reach ──
  // A real bare git repo for DIST=source, a real `file://` release directory for
  // DIST=binary. Both are ordinary remotes to `git clone` / `curl`, because the
  // lifecycle under test includes the fetch: a fixture that handed install.sh a
  // pre-made INSTALL_DIR would skip the step that most often breaks on cutover.
  const originWork = join(root, 'origin-work')
  const originGit = join(root, 'origin.git')
  const releases = join(root, 'releases')
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@test',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@test',
  }
  const git = (...args: string[]) => {
    const res = spawnSync('git', args, { encoding: 'utf8', cwd: originWork, env: gitEnv })
    expect(res.status, `git ${args.join(' ')}: ${res.stderr}`).toBe(0)
  }
  const writeTree = (v: string) => {
    mkdirSync(originWork, { recursive: true })
    writeFileSync(join(originWork, 'package.json'), `${JSON.stringify({ name: label, version: v }, null, 2)}\n`)
    writeFileSync(join(originWork, '.env.example'), `${label.toUpperCase()}_SETTING=\n`)
  }
  const publishSource = (v: string) => {
    writeTree(v)
    git('init', '--quiet', '--initial-branch=main')
    git('add', '-A')
    git('commit', '--quiet', '-m', `release ${v}`)
    git('tag', `v${v}`)
    rmSync(originGit, { recursive: true, force: true })
    git('clone', '--quiet', '--bare', originWork, originGit)
  }
  const publishBinary = (v: string) => {
    const tag = `v${v}`
    const topDir = `${label}-${v}-linux-x86_64`
    const stage = join(root, '.payload', topDir)
    mkdirSync(stage, { recursive: true })
    writeFileSync(join(stage, label), `#!/bin/sh\necho "${label} ${v}"\n`)
    chmodSync(join(stage, label), 0o755)
    mkdirSync(join(releases, tag), { recursive: true })
    const tar = spawnSync('tar', ['-czf', join(releases, tag, `${label}-${tag}-linux-x86_64.tar.gz`), '-C', join(root, '.payload'), topDir], {
      encoding: 'utf8',
    })
    expect(tar.status, tar.stderr).toBe(0)
  }
  binary ? publishBinary(version) : publishSource(version)

  // ── the sandboxed deploy tree ──
  const installDir = join(root, 'opt')
  const dataDir = join(root, 'data')
  const runDir = join(root, 'run')
  const unitFile = join(root, 'unit', `${label}.service`)
  mkdirSync(join(root, 'unit'), { recursive: true })
  const deployDir = join(root, 'deploy')
  cpSync(DEPLOY_DIR, deployDir, { recursive: true, filter: (src) => !src.endsWith('.test.ts') && !src.endsWith('app-targets.ts') })

  const overrides: Record<string, string> = {
    INSTALL_DIR: installDir,
    DATA_DIR: dataDir,
    RUN_DIR: runDir,
    HOOKS_DIR: join(runDir, 'hooks'),
    EXEC_START: join(installDir, label),
    ...(binary
      ? { RELEASES_BASE: `file://${releases}`, RELEASE_API: '' }
      : { REPO_URL: `file://${originGit}`, CHECKOUT_POLICY: 'stable' }),
  }
  for (const [key, value] of Object.entries(overrides)) {
    expect(value.startsWith(`${root}/`) || !['INSTALL_DIR', 'DATA_DIR', 'RUN_DIR', 'HOOKS_DIR', 'EXEC_START'].includes(key), `${key}=${value} escapes the fixture root`).toBe(true)
  }
  writeFileSync(join(deployDir, 'app.env'), sandboxAppEnvText(target.appEnvPath, overrides))

  // ── the stub layer ──
  const stubsDir = join(root, 'stubs')
  const privLog = join(root, 'privileged.log')
  mkdirSync(stubsDir, { recursive: true })
  writeFileSync(privLog, '')

  // sudo: logs, allows only fixture-root paths, and execs a short allow-list.
  // `chown` is allowed so apply_ownership's real path is exercised; the refusal
  // path has its own dedicated test in app-env-conformance.test.ts.
  writeFileSync(
    join(stubsDir, 'sudo'),
    [
      '#!/usr/bin/env bash',
      'printf \'%s\' "$0" >> "$STUB_PRIV_LOG"',
      'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
      'printf \'\\n\' >> "$STUB_PRIV_LOG"',
      'case "${1:-}" in',
      '  touch|chmod|cp|mv|rm|install|systemctl|mkdir|ln|chown) ;;',
      '  *) echo "STUB-SUDO: refused command ${1:-}" >&2; exit 99 ;;',
      'esac',
      'exec "$@"',
    ].join('\n'),
  )
  // systemctl: `is-active` must answer for real, because update.sh branches on
  // it; `restart` records the payload's version the way ExecStart would.
  const stateDir = join(root, 'unitstate')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stubsDir, 'systemctl'),
    [
      '#!/usr/bin/env bash',
      'printf \'%s\' "$0" >> "$STUB_PRIV_LOG"',
      'for a in "$@"; do printf \' %s\' "$a" >> "$STUB_PRIV_LOG"; done',
      'printf \'\\n\' >> "$STUB_PRIV_LOG"',
      `launch() { printf '%s' "$(${q(join(installDir, label))} --version 2>/dev/null | awk '{print $2}')" > ${q(join(stateDir, 'serving'))}; printf '%s launched %s\\n' "$1" "$(cat ${q(join(stateDir, 'serving'))})" >> ${q(join(stateDir, 'events'))}; }`,
      'case "${1:-}" in',
      '  is-system-running) echo running ;;',
      '  is-active) [ -f ' + q(join(stateDir, 'serving')) + ' ] && exit 0 || exit 3 ;;',
      '  start|try-restart) [ -f ' + q(join(stateDir, 'serving')) + ' ] || launch "$1" ;;',
      '  restart) launch restart ;;',
      '  stop) rm -f ' + q(join(stateDir, 'serving')) + ' ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  )
  // curl: serves the release asset from the local release dir, and the health
  // body the current test wants. `healthBody` is a mutable cell so a test can
  // flip the endpoint between runs without re-seeding the stub.
  const healthFile = join(root, 'health-body')
  writeFileSync(healthFile, HEALTHY_BODY)
  writeFileSync(
    join(stubsDir, 'curl'),
    [
      '#!/usr/bin/env bash',
      'url=""; out=""; prev=""',
      'for a in "$@"; do',
      '  case "$a" in *://*) url="$a" ;; esac',
      '  if [ "$prev" = "-o" ]; then out="$a"; fi',
      '  prev="$a"',
      'done',
      `case "$url" in`,
      // The URL carries a file:// scheme; `cp` does not want it. Stripping it
      // here rather than at the call site keeps one stub for every fetch.
      `  file://*) cp "\${url#file://}" "$out"; exit \$? ;;`,
      `  *) cat ${q(healthFile)}; printf '\\n'; exit 0 ;;`,
      'esac',
    ].join('\n'),
  )
  // bun: records argv and creates the artefact a build would produce, so a build
  // step that "succeeded" is observable as a file rather than as an exit code.
  const bunLog = join(root, 'bun.log')
  writeFileSync(bunLog, '')
  writeFileSync(
    join(stubsDir, 'bun'),
    [
      '#!/usr/bin/env bash',
      `printf 'bun %s\\n' "$*" >> ${q(bunLog)}`,
      'if [ "${1:-}" = "run" ] && [ "${2:-}" = "build" ]; then',
      `  mkdir -p ${q(join(installDir, 'build'))}`,
      `  printf 'built\\n' > ${q(join(installDir, 'build', 'index.js'))}`,
      'fi',
      'exit 0',
    ].join('\n'),
  )
  // stat: report a foreign owner so apply_ownership takes the branch it added
  // (it skips a chown that would change nothing). Only %U:%G is intercepted;
  // %a drives the unit's preserved mode and must stay real.
  writeFileSync(
    join(stubsDir, 'stat'),
    ['#!/usr/bin/env bash', 'for a in "$@"; do', `  if [ "$a" = "%U:%G" ]; then printf 'root:root\\n'; exit 0; fi`, 'done', 'exec /usr/bin/stat "$@"'].join('\n'),
  )
  for (const name of ['sudo', 'systemctl', 'curl', 'bun', 'stat']) chmodSync(join(stubsDir, name), 0o755)

  const sb: Sandbox = {
    target,
    root,
    installDir,
    dataDir,
    runDir,
    unitFile,
    stubsDir,
    privLog,
    healthFile,
    bunLog,
    stateDir,
    binary,
    version,
    publishVersion(v: string) {
      binary ? publishBinary(v) : publishSource(v)
      sb.version = v
    },
    installedVersion() {
      const pkg = join(installDir, 'package.json')
      const bin = join(installDir, label)
      if (binary) {
        if (!existsSync(bin)) return ''
        const res = spawnSync(bin, ['--version'], { encoding: 'utf8' })
        return (res.stdout ?? '').trim().split(/\s+/)[1] ?? ''
      }
      if (!existsSync(pkg)) return ''
      return /"version": *"([^"]*)"/.exec(readFileSync(pkg, 'utf8'))?.[1] ?? ''
    },
  }
  return sb
}

/** The environment every spawn in this file gets. */
function sandboxEnv(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return isolatedEnv(sb.root, {
    PATH: `${sb.stubsDir}:${process.env.PATH}`,
    STUB_PRIV_LOG: sb.privLog,
    APP_ENV_URL: '',
    LIB_RAW_URL: '',
    UNIT_FILE: sb.unitFile,
    HEALTH_TIMEOUT: '2',
    HEALTH_CONFIRM_TIMEOUT: '1',
    ...extra,
  })
}

/**
 * The `--version` a run needs, or nothing.
 *
 * For DIST=binary the tag comes from `release_resolve_tag`, which queries
 * RELEASE_API — and the sandbox sets that empty (there is no API to query, and
 * pointing it at github.com would put the test on the network). So every binary
 * run must name its tag explicitly, exactly as the framework's own error says:
 * "RELEASE_API is empty; set it in app.env or pass --version <tag>". A source app
 * resolves its ref from the origin's tags and needs no flag.
 */
function tagArgs(sb: Sandbox): string[] {
  return sb.binary ? ['--version', `v${sb.version}`] : []
}

/** Run install.sh out of the sandboxed deploy tree. */
function install(sb: Sandbox, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync('bash', [join(sb.root, 'deploy', 'install.sh'), ...tagArgs(sb), ...args], {
    encoding: 'utf8',
    env: sandboxEnv(sb, extra),
    cwd: sb.root,
    timeout: 120_000,
  })
}

/**
 * Run the INSTALLED update.sh — the copy install.sh put in ${RUN_DIR}/scripts.
 *
 * Not the deploy/ copy: an operator updates through the installed one, and that
 * copy carries the INSTALLED app.env, which is the file a real cutover reads.
 * Running the repo's copy would test a configuration no operator ever has.
 */
function update(sb: Sandbox, args: string[] = [], extra: Record<string, string> = {}) {
  const script = join(sb.runDir, 'scripts', 'update.sh')
  if (!existsSync(script)) throw new Error(`no installed update.sh at ${script} — install.sh never ran to completion`)
  return spawnSync('bash', [script, '--yes', ...tagArgs(sb), ...args], {
    encoding: 'utf8',
    env: sandboxEnv(sb, extra),
    cwd: sb.runDir,
    timeout: 120_000,
  })
}

function privCalls(log: string): string[] {
  const raw = readFileSync(log, 'utf8').trim()
  return raw ? raw.split('\n') : []
}

/** Set the body the health endpoint answers with for the next run. */
function serveHealth(sb: Sandbox, body: string): void {
  writeFileSync(sb.healthFile, body)
}

// ══════════════════════════════════════════════════════════════════════════════

/**
 * Per-test budget. Every run here is a full install or update, and a run that
 * exercises the FAILING gate deliberately spends HEALTH_TIMEOUT +
 * HEALTH_CONFIRM_TIMEOUT before it can report a verdict — so bun's 5 s default
 * expired mid-install and the failures read as timeouts rather than as the
 * health verdict under test. 120 s is generous for a temp-tree install; the
 * tests that finish fast still finish fast.
 */
const BUDGET_MS = 120_000

describe('deploy/sandbox — install, health gate, update, rollback', () => {
  for (const target of TARGETS.resolved) {
    const values = readAppEnvValues(target.appEnvPath)

    test(`${target.label} (DIST=${values.DIST}): a fresh install completes and the health gate passes`, () => {
      const sb = seedSandbox(target)
      const res = install(sb)
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0)
      expect(res.stdout).toContain('Done.')

      // The gate really was consulted, and it really accepted this app's own
      // `{"ok":true}` — which is what the three health keys in app.env buy.
      expect(`${res.stdout}${res.stderr}`).toMatch(/Service is healthy/)
      // The disabled version check is stated, once: a caveat reported by
      // silence would be indistinguishable from a gate that never ran.
      const warnings = res.stderr.split('\n').filter((l) => l.includes('version check is DISABLED'))
      expect(warnings).toHaveLength(1)

      // The payload landed where the app.env said, and reports the version the
      // origin published.
      expect(sb.installedVersion()).toBe(V1)
      expect(existsSync(sb.dataDir), 'DATA_DIR was never created').toBe(true)
      // Canonical layout: the data dir is reachable from the install dir too.
      expect(existsSync(join(sb.installDir, 'data'))).toBe(true)

      // A unit was written — inside the fixture, named for THIS app.
      expect(existsSync(sb.unitFile), `no unit at ${sb.unitFile}`).toBe(true)
      const unit = readFileSync(sb.unitFile, 'utf8')
      expect(unit).toContain(`ExecStart=${join(sb.installDir, target.label)}`)
      expect(unit).toContain('Restart=always')
      expect(unit).toContain(`ReadWritePaths=${sb.installDir} ${sb.dataDir}`)
      // The sandboxed app.env copied into the state dir, not the shipped one.
      expect(readFileSync(join(sb.runDir, 'scripts', 'app.env'), 'utf8')).toContain(`RUN_DIR="${sb.runDir}"`)

      // Helpers and hooks, so the update below runs the same files an operator has.
      for (const f of ['update.sh', 'updater.sh', 'uninstall.sh', 'common.sh', 'app.env']) {
        expect(existsSync(join(sb.runDir, 'scripts', f)), `helper ${f} was not installed`).toBe(true)
      }
      for (const f of ['pre-update', 'post-update']) {
        expect(existsSync(join(sb.runDir, 'hooks', f)), `hook ${f} was not installed`).toBe(true)
      }

      // Nothing privileged escaped: every sudo/systemctl call the run made is in
      // the fixture's log, and that log contains only fixture paths.
      const calls = privCalls(sb.privLog)
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call, `privileged call outside the fixture: ${call}`).toContain(sb.root)
      }
    }, BUDGET_MS)

    test(`${target.label}: an UNHEALTHY endpoint fails the install and never says Done`, () => {
      // The negative control for the test above. Without it, "the gate passed"
      // and "the gate was never reached" are the same observation.
      const sb = seedSandbox(target)
      serveHealth(sb, UNHEALTHY_BODY)
      const res = install(sb)
      expect(res.status, `${res.stdout}\n${res.stderr}`).not.toBe(0)
      expect(res.stdout).not.toContain('Done.')
      expect(`${res.stdout}${res.stderr}`).toMatch(/health check|did not pass the health check/i)
    }, BUDGET_MS)

    test(`${target.label}: update is idempotent — a second run changes nothing`, () => {
      const sb = seedSandbox(target)
      expect(install(sb).status).toBe(0)
      const before = sb.installedVersion()
      expect(before).toBe(V1)

      const res = update(sb)
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0)
      // Idempotence is the OBSERVED state, not the message: same version still
      // installed, and the health gate passed again rather than being skipped.
      expect(sb.installedVersion()).toBe(before)
      expect(`${res.stdout}${res.stderr}`).toMatch(/Already up to date|Done\. Now at/)
      expect(`${res.stdout}${res.stderr}`).not.toMatch(/ERROR/)
    }, BUDGET_MS)

    test(`${target.label}: update to a NEW version swaps the payload and re-passes the gate`, () => {
      const sb = seedSandbox(target)
      expect(install(sb).status).toBe(0)
      expect(sb.installedVersion()).toBe(V1)

      sb.publishVersion(V2)
      const res = update(sb)
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0)
      expect(sb.installedVersion(), `${res.stdout}\n${res.stderr}`).toBe(V2)
      expect(`${res.stdout}${res.stderr}`).toMatch(/Done\. Now at/)
      // A source app re-ran the same install+build pair the update path shares
      // with install.sh; the trace proves the pair ran on the UPDATE, which is
      // the invariant gap (a) closed by moving it into lib/common.sh.
      if (values.DIST === 'source') {
        const bunCalls = readFileSync(sb.bunLog, 'utf8').split('\n').filter(Boolean)
        expect(bunCalls.length, 'the update ran no build').toBeGreaterThanOrEqual(4)
        expect(bunCalls.some((c) => c.includes('install')), 'the update installed no dependencies').toBe(true)
        expect(bunCalls.some((c) => c.includes('run build')), 'the update ran no build').toBe(true)
      }
    }, BUDGET_MS)

    test(`${target.label}: a failed health gate blocks the update and leaves a rollback point`, () => {
      const sb = seedSandbox(target)
      expect(install(sb).status).toBe(0)
      expect(sb.installedVersion()).toBe(V1)

      sb.publishVersion(V2)
      serveHealth(sb, UNHEALTHY_BODY)
      const res = update(sb)
      expect(res.status, `${res.stdout}\n${res.stderr}`).not.toBe(0)
      expect(res.stdout).not.toMatch(/Done\. Now at/)
      // Rollback is NEVER automatic (ADR §2.6): the payload is still the new one,
      // and the operator is told what to do instead.
      expect(res.stderr).toMatch(/rollback/i)
      expect(res.stderr).toMatch(/did not finish cleanly|not verified|unverified|health/i)
    }, BUDGET_MS)

    test(`${target.label}: rollback works — the printed remedy restores the previous version`, () => {
      const sb = seedSandbox(target)
      expect(install(sb).status).toBe(0)
      expect(sb.installedVersion()).toBe(V1)

      sb.publishVersion(V2)
      serveHealth(sb, UNHEALTHY_BODY)
      const failed = update(sb)
      expect(failed.status, `${failed.stdout}\n${failed.stderr}`).not.toBe(0)
      expect(sb.installedVersion(), 'the failed update did not land its payload, so there is nothing to roll back').toBe(V2)

      // ── the rollback point ──
      // For DIST=binary the framework keeps a `.prev` beside every file in
      // BINARY_ROLLBACK_FILES. Asserting the FILE exists is the rollback point:
      // without it the remedy has nothing to move back.
      const prevPath = join(sb.installDir, `${target.label}.prev`)
      if (values.DIST === 'binary') {
        expect(existsSync(prevPath), `no rollback point at ${prevPath}`).toBe(true)
        const prev = spawnSync(prevPath, ['--version'], { encoding: 'utf8' })
        expect((prev.stdout ?? '').trim().split(/\s+/)[1], 'the .prev is not the previous version').toBe(V1)
      }

      // ── run the remedy the framework printed, and check the state afterwards ──
      // The remedy is executed, not just pattern-matched: a rollback instruction
      // that is printed but does not restore anything is the failure mode.
      serveHealth(sb, HEALTHY_BODY)
      if (values.DIST === 'binary') {
        for (const f of values.BINARY_ROLLBACK_FILES.split(/\s+/).filter(Boolean)) {
          const prev = join(sb.installDir, `${f}.prev`)
          if (existsSync(prev)) spawnSync('mv', ['-f', prev, join(sb.installDir, f)])
        }
      } else {
        // The source remedy update.sh prints is a single command line built from
        // PREV_REF + INSTALL_FLAGS + BUILD_CMD. Take it verbatim off the output
        // rather than reconstructing it, so this proves the PRINTED remedy works.
        const line = failed.stderr.split('\n').find((l) => l.includes('rollback:'))
        expect(line, `no rollback remedy in:\n${failed.stderr}`).toBeTruthy()
        const prevRef = /previous commit: (\S+)/.exec(failed.stderr)?.[1]
        expect(prevRef, 'the remedy does not name the previous commit').toBeTruthy()
        const remedy = line!.replace(/^.*rollback:\s*/, '').trim()
        expect(remedy).toContain(prevRef!)
        const run = spawnSync('bash', ['-c', remedy], {
          encoding: 'utf8',
          env: sandboxEnv(sb),
          cwd: sb.runDir,
          timeout: 120_000,
        })
        expect(run.status, `the printed remedy failed: ${run.stderr}`).toBe(0)
      }

      expect(sb.installedVersion(), 'the rollback did not restore the previous version').toBe(V1)

      // And the rolled-back tree comes back up: a rollback that leaves a payload
      // that cannot serve is not a rollback.
      const res = install(sb, ['--force'])
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0)
      expect(`${res.stdout}${res.stderr}`).toMatch(/Service is healthy/)
    }, BUDGET_MS)
  }
})

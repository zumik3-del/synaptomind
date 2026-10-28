import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, ENV_MAPPINGS } from './config'
import { loadFreshConfig } from './test/fresh-config'

/**
 * The config surface left behind by the pruning tasks.
 *
 * `autoLink.*` (#1937), `triage.*` (#1946) and the decay auto-archive pair
 * (#1943) lost their readers, so they are gone from `DEFAULTS`, the config type
 * and `ENV_MAPPINGS`. `placement.maxProposals` / `maxItemsPerEnqueue` went the
 * same way (#1946): the per-enqueue cap chain resolves
 * `placement.maxProposalsPerEnqueue` first, so those two aliases could never win.
 *
 * The last cleanup (#2201) dropped two knobs whose only reader was removed with
 * them: `slots.hardLimit` (the ceiling is derived from
 * `thoughts.hardLimitBufferPercent`) and `autoCluster.dryRun`
 * (`runAutoClusterJob` now takes an explicit `dryRun` per call).
 *
 * The RUNTIME object is a different matter: `deepMerge` copies the operator's
 * file keys verbatim, so on an instance whose config.json still carries a
 * removed block the merged object HAS the key — inert, read by nobody (the same
 * note the `api/` removal guards record). Unknown keys must keep loading
 * without an error; only the declared surface shrinks.
 */

/** Top-level sections and dotted paths that must not come back. */
const REMOVED_SECTIONS = ['autoLink', 'triage', 'ttl']
const REMOVED_PATHS = [
  'decay.archiveThreshold',
  'decay.archiveMinAgeDays',
  'placement.maxProposals',
  'placement.maxItemsPerEnqueue',
  'slots.hardLimit',
  'autoCluster.dryRun'
]
const REMOVED_ENV_VARS = [
  'SYNAPTOMIND_AUTO_LINK_MIN_SIMILARITY',
  'SYNAPTOMIND_AUTO_LINK_MAX_EDGES',
  'SYNAPTOMIND_AUTO_LINK_DRY_RUN',
  'SYNAPTOMIND_TRIAGE_ENABLED',
  'SYNAPTOMIND_TRIAGE_MAX_ITEMS_PER_RUN',
  'SYNAPTOMIND_TRIAGE_MAX_ARCHIVES_PER_RUN',
  'SYNAPTOMIND_TRIAGE_MAX_LINKS_PER_RUN',
  'SYNAPTOMIND_TRIAGE_REQUIRE_DRY_RUN_FIRST',
  'SYNAPTOMIND_TRIAGE_BACKFILL_ENABLED',
  'SYNAPTOMIND_ARCHIVE_THRESHOLD',
  'SYNAPTOMIND_ARCHIVE_MIN_AGE_DAYS',
  'SYNAPTOMIND_PLACEMENT_MAX_PROPOSALS',
  'SYNAPTOMIND_PLACEMENT_MAX_ITEMS_PER_ENQUEUE',
  'SYNAPTOMIND_ARCHIVED_TTL_DAYS',
  'SYNAPTOMIND_CLEANUP_INTERVAL_MS',
  'SYNAPTOMIND_SLOTS_HARD_LIMIT',
  'SYNAPTOMIND_AUTO_CLUSTER_DRY_RUN'
]

/** Read a dotted path out of an object tree (`undefined` when it is absent). */
function readPath(obj: unknown, path: string): unknown {
  let current: unknown = obj
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

let SCRATCH = ''

afterEach(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  SCRATCH = ''
})

function scratchDir(): string {
  SCRATCH = mkdtempSync(join(tmpdir(), 'synaptomind-config-removed-'))
  return SCRATCH
}

/** Ambient env minus the removed variables, so a case never inherits one. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const name of REMOVED_ENV_VARS) delete env[name]
  return env
}

/**
 * Load `src/config.ts` with `cwd`'s `config.json` (when it has one) and report
 * the resolved config plus the module's `DEFAULTS`. A failed load reports
 * `code !== 0` and prints no `RESOLVED=` line.
 */
async function loadConfig(cwd: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const file = join(cwd, 'config.json')
  const probe = await loadFreshConfig({
    env: { ...baseEnv(), ...env },
    configFile: existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined
  })
  if (probe.error !== undefined) {
    return { code: 1, out: `${probe.stderr}\n${probe.error}` }
  }
  return {
    code: 0,
    out:
      `RESOLVED=${JSON.stringify(probe.config)}\n` +
      `DEFAULTS=${JSON.stringify(probe.defaults)}\n` +
      probe.stderr
  }
}

function parsedLine(out: string, prefix: string): Record<string, unknown> | null {
  const line = out.split('\n').find(l => l.startsWith(prefix))
  return line ? (JSON.parse(line.slice(prefix.length)) as Record<string, unknown>) : null
}

// ── the declared surface ─────────────────────────────────────────────────────

describe('config surface — the removed keys are gone', () => {
  test('DEFAULTS carries none of the removed sections', () => {
    const defaults = DEFAULTS as unknown as Record<string, unknown>
    for (const section of REMOVED_SECTIONS) expect(Object.keys(defaults)).not.toContain(section)
  })

  test('DEFAULTS carries none of the removed paths', () => {
    for (const path of REMOVED_PATHS) expect(readPath(DEFAULTS, path)).toBeUndefined()
  })

  test('the config type is the contract: reading a removed path is a type error', () => {
    // `Extract` collapses to `never` while the member is absent, so this line
    // stops compiling the moment a removed key comes back — `bun run tsc
    // --noEmit` is the gate for the type half of the guarantee.
    const absent = 'autoLink' as const
    type RemovedMember = Extract<typeof absent, keyof typeof DEFAULTS>
    const REMOVED_IS_NOT_A_MEMBER: RemovedMember extends never ? true : false = true

    expect(REMOVED_IS_NOT_A_MEMBER).toBe(true)
  })

  test('no ENV_MAPPINGS entry targets a removed section or path', () => {
    const offending = ENV_MAPPINGS.map(m => m.path).filter(
      path =>
        REMOVED_SECTIONS.some(section => path === section || path.startsWith(`${section}.`)) ||
        REMOVED_PATHS.includes(path)
    )

    expect(offending).toEqual([])
  })

  test('no ENV_MAPPINGS entry declares a removed env variable', () => {
    const declared = ENV_MAPPINGS.map(m => m.env)

    for (const name of REMOVED_ENV_VARS) expect(declared).not.toContain(name)
  })
})

// ── the kept surface ─────────────────────────────────────────────────────────

describe('config surface — every mapping targets a real default', () => {
  test('retention-review defaults and environment mappings are declared', () => {
    expect(DEFAULTS.retentionReview).toEqual({ minAgeDays: 30, importanceFloor: 0.3, pageSize: 20 })
    expect(ENV_MAPPINGS.filter(mapping => mapping.path.startsWith('retentionReview.')).map(mapping => mapping.env)).toEqual([
      'SYNAPTOMIND_RETENTION_REVIEW_MIN_AGE_DAYS',
      'SYNAPTOMIND_RETENTION_REVIEW_IMPORTANCE_FLOOR',
      'SYNAPTOMIND_RETENTION_REVIEW_PAGE_SIZE'
    ])
    expect(REMOVED_SECTIONS).toContain('ttl')
  })
  test('each ENV_MAPPINGS path resolves in DEFAULTS to a value of the declared type', () => {
    const missing: string[] = []
    const mistyped: string[] = []

    for (const mapping of ENV_MAPPINGS) {
      const value = readPath(DEFAULTS, mapping.path)
      if (value === undefined) {
        missing.push(`${mapping.env} -> ${mapping.path}`)
        continue
      }
      const actual = Array.isArray(value) ? 'list' : typeof value === 'number' ? 'number' : typeof value
      const expected = mapping.type === 'bool' ? 'boolean' : mapping.type === 'string' ? 'string' : mapping.type === 'list' ? 'list' : 'number'
      if (actual !== expected) mistyped.push(`${mapping.env} -> ${mapping.path} (${actual}, expected ${expected})`)
    }

    expect({ missing, mistyped }).toEqual({ missing: [], mistyped: [] })
  })

  test('the kept placement and edge-detect knobs are still declared', () => {
    for (const path of [
      'placement.maxClusterSize',
      'placement.proposalTtlDays',
      'placement.maxPendingProposals',
      'placement.maxProposalsPerEnqueue',
      'edgeDetect.minSimilarity',
      'edgeDetect.topK',
      'edgeDetect.maxCandidates',
      'edgeDetect.maxProposals'
    ]) {
      expect(readPath(DEFAULTS, path)).toBeDefined()
    }
  })

})

// ── a legacy config.json ─────────────────────────────────────────────────────

describe('config load — a config.json carrying removed keys', () => {
  const LEGACY = {
    contentLanguage: 'en',
    autoLink: { minSimilarity: 0.5, maxEdgesPerRun: 7, dryRun: true },
    triage: { enabled: false, maxItemsPerRun: 3 },
    decay: { archiveThreshold: 0.42, archiveMinAgeDays: 5 },
    placement: { maxProposals: 2, maxItemsPerEnqueue: 1 },
    slots: { hardLimit: 900 },
    autoCluster: { dryRun: true }
  }

  test('loads without an error and leaves DEFAULTS untouched', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify(LEGACY))

    const res = await loadConfig(cwd)

    expect(res.code).toBe(0)
    const defaults = parsedLine(res.out, 'DEFAULTS=')
    expect(defaults).not.toBeNull()
    for (const section of REMOVED_SECTIONS) expect(Object.keys(defaults!)).not.toContain(section)
    for (const path of REMOVED_PATHS) expect(readPath(defaults, path)).toBeUndefined()
  })

  test('the removed env variables stay inert whatever the file carries', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify(LEGACY))
    const baseline = await loadConfig(cwd)
    const control = await loadConfig(cwd, { SYNAPTOMIND_CONTENT_LANGUAGE: 'ru' })

    const resolved = parsedLine(baseline.out, 'RESOLVED=')
    const resolvedControl = parsedLine(control.out, 'RESOLVED=')
    expect(resolved).not.toBeNull()
    expect(resolvedControl).not.toBeNull()

    expect(baseline.code).toBe(0)
    expect(control.code).toBe(0)
    // The env layer still works (control), and no removed variable has a
    // mapping left that could override anything below it.
    expect(resolvedControl!.contentLanguage).toBe('ru')
    const envs = new Set(ENV_MAPPINGS.map(m => m.env))
    for (const name of REMOVED_ENV_VARS) expect(envs.has(name)).toBe(false)
  })

  test('the removed knobs ride along as inert keys on the merged runtime object', async () => {
    // `deepMerge` copies operator keys verbatim, so a file that still carries
    // them produces a resolved object WITH the key. Nothing reads it: the
    // declared surface (DEFAULTS, the config type) has no member for it.
    const cwd = scratchDir()
    writeFileSync(
      join(cwd, 'config.json'),
      JSON.stringify({ slots: { hardLimit: 900 }, autoCluster: { dryRun: true } })
    )

    const res = await loadConfig(cwd)
    expect(res.code).toBe(0)
    const resolved = parsedLine(res.out, 'RESOLVED=')
    const defaults = parsedLine(res.out, 'DEFAULTS=')
    expect(resolved).not.toBeNull()
    expect(readPath(resolved, 'slots.hardLimit')).toBe(900)
    expect(readPath(resolved, 'autoCluster.dryRun')).toBe(true)
    for (const path of ['slots.hardLimit', 'autoCluster.dryRun']) expect(readPath(defaults, path)).toBeUndefined()
    // The surviving members of those two sections still resolve their defaults.
    expect(readPath(resolved, 'slots.defaultMaxChars')).toBe(DEFAULTS.slots.defaultMaxChars)
    expect(readPath(resolved, 'autoCluster.minMembers')).toBe(DEFAULTS.autoCluster.minMembers)
  })

  test('the removed knobs cannot be set from the environment', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ contentLanguage: 'en' }))

    const res = await loadConfig(cwd, {
      SYNAPTOMIND_SLOTS_HARD_LIMIT: '900',
      SYNAPTOMIND_AUTO_CLUSTER_DRY_RUN: 'true',
      // Positive control: a live mapping into the same section, so a no-op
      // result cannot be explained by the whole env layer being ignored.
      SYNAPTOMIND_AUTO_CLUSTER_MIN_MEMBERS: '7'
    })

    expect(res.code).toBe(0)
    const resolved = parsedLine(res.out, 'RESOLVED=')
    expect(resolved).not.toBeNull()
    expect(readPath(resolved, 'slots.hardLimit')).toBeUndefined()
    expect(readPath(resolved, 'autoCluster.dryRun')).toBeUndefined()
    expect(readPath(resolved, 'autoCluster.minMembers')).toBe(7)
  })

  test('a config.json without the removed blocks resolves the same defaults', async () => {
    const cwd = scratchDir()
    writeFileSync(join(cwd, 'config.json'), JSON.stringify({ contentLanguage: 'en' }))

    const res = await loadConfig(cwd)
    const controlled = await loadConfig(cwd, { SYNAPTOMIND_AUTO_LINK_DRY_RUN: 'true' })

    expect(res.code).toBe(0)
    expect(controlled.code).toBe(0)
    const a = parsedLine(res.out, 'RESOLVED=')
    const b = parsedLine(controlled.out, 'RESOLVED=')
    // The removed variable is not applied: the resolved placement/decay knobs
    // are identical (the removed keys are not on DEFAULTS at all).
    for (const path of REMOVED_PATHS) expect(readPath(b, path)).toBeUndefined()
    expect(readPath(a, 'placement.maxProposalsPerEnqueue')).toBe(readPath(b, 'placement.maxProposalsPerEnqueue'))
    expect(readPath(a, 'decay.rate')).toBe(readPath(b, 'decay.rate'))
  })
})

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { config, DEFAULTS, ENV_MAPPINGS } from '../config'
import { buildConfigDisplay } from './config-display.service'

/** Run `bun -e script` in a subprocess with optional env overrides. */
async function runInSubprocess(script: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawnSync(
    [process.execPath, '-e', script],
    { env: { ...process.env, ...env }, cwd: join(import.meta.dir, '..', '..') }
  )
  return proc.stdout.toString().trim()
}

const TRIAGE_PROBE = `
import { config } from './src/config';
console.log(
  config.triage.enabled + ','
  + config.triage.maxItemsPerRun + ','
  + config.triage.maxArchivesPerRun + ','
  + config.triage.maxLinksPerRun + ','
  + config.triage.requireDryRunFirst + ','
  + config.triage.backfillEnabled
);
`

// ── config defaults ───────────────────────────────────────────────────────────

describe('config defaults — triage', () => {
  test('triage.enabled defaults to true', () => {
    expect(DEFAULTS.triage.enabled).toBe(true)
    expect(config.triage.enabled).toBe(true)
  })

  test('triage.maxItemsPerRun defaults to 25', () => {
    expect(DEFAULTS.triage.maxItemsPerRun).toBe(25)
    expect(config.triage.maxItemsPerRun).toBe(25)
  })

  test('triage.maxArchivesPerRun defaults to 25', () => {
    expect(DEFAULTS.triage.maxArchivesPerRun).toBe(25)
    expect(config.triage.maxArchivesPerRun).toBe(25)
  })

  test('triage.maxLinksPerRun defaults to 20', () => {
    expect(DEFAULTS.triage.maxLinksPerRun).toBe(20)
    expect(config.triage.maxLinksPerRun).toBe(20)
  })

  test('triage.requireDryRunFirst defaults to true', () => {
    expect(DEFAULTS.triage.requireDryRunFirst).toBe(true)
    expect(config.triage.requireDryRunFirst).toBe(true)
  })

  test('triage.backfillEnabled defaults to true', () => {
    expect(DEFAULTS.triage.backfillEnabled).toBe(true)
    expect(config.triage.backfillEnabled).toBe(true)
  })
})

// ── env overrides (subprocess) ──────────────────────────────────────────────
// config is built at module-load time from process.env; a fresh subprocess is
// the only way to verify that env vars actually change the resolved value.

describe('env overrides — triage', () => {
  test('SYNAPTOMIND_TRIAGE_ENABLED overrides the default (true → false)', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_ENABLED: 'false'
    })
    expect(out).toBe('false,25,25,20,true,true')
  })

  test('SYNAPTOMIND_TRIAGE_MAX_ITEMS_PER_RUN overrides the default', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_MAX_ITEMS_PER_RUN: '10'
    })
    expect(out).toBe('true,10,25,20,true,true')
  })

  test('SYNAPTOMIND_TRIAGE_MAX_ARCHIVES_PER_RUN overrides the default', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_MAX_ARCHIVES_PER_RUN: '5'
    })
    expect(out).toBe('true,25,5,20,true,true')
  })

  test('SYNAPTOMIND_TRIAGE_MAX_LINKS_PER_RUN overrides the default', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_MAX_LINKS_PER_RUN: '50'
    })
    expect(out).toBe('true,25,25,50,true,true')
  })

  test('SYNAPTOMIND_TRIAGE_REQUIRE_DRY_RUN_FIRST overrides the default (true → false)', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_REQUIRE_DRY_RUN_FIRST: 'false'
    })
    expect(out).toBe('true,25,25,20,false,true')
  })

  test('SYNAPTOMIND_TRIAGE_BACKFILL_ENABLED overrides the default (true → false)', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_BACKFILL_ENABLED: 'false'
    })
    expect(out).toBe('true,25,25,20,true,false')
  })

  test('all six env overrides compose', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_ENABLED: 'false',
      SYNAPTOMIND_TRIAGE_MAX_ITEMS_PER_RUN: '10',
      SYNAPTOMIND_TRIAGE_MAX_ARCHIVES_PER_RUN: '5',
      SYNAPTOMIND_TRIAGE_MAX_LINKS_PER_RUN: '50',
      SYNAPTOMIND_TRIAGE_REQUIRE_DRY_RUN_FIRST: 'false',
      SYNAPTOMIND_TRIAGE_BACKFILL_ENABLED: 'false'
    })
    expect(out).toBe('false,10,5,50,false,false')
  })

  test('env var absent falls back to defaults', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE)
    expect(out).toBe('true,25,25,20,true,true')
  })

  test('invalid int env var falls back to default', async () => {
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_MAX_ITEMS_PER_RUN: 'not-a-number'
    })
    expect(out).toBe('true,25,25,20,true,true')
  })

  test('invalid bool env var resolves to false (not NaN), no fallback triggered', async () => {
    // parseValue bool: raw === 'true' — anything else is false, not NaN, so no
    // console.error and no default; the env value simply resolves to false.
    const out = await runInSubprocess(TRIAGE_PROBE, {
      SYNAPTOMIND_TRIAGE_ENABLED: 'yes'
    })
    expect(out).toBe('false,25,25,20,true,true')
  })
})

// ── ENV_MAPPINGS correctness ─────────────────────────────────────────────────

describe('ENV_MAPPINGS — triage', () => {
  const EXPECTED_MAPPINGS: Array<{ env: string; path: string; type: string }> = [
    { env: 'SYNAPTOMIND_TRIAGE_ENABLED', path: 'triage.enabled', type: 'bool' },
    { env: 'SYNAPTOMIND_TRIAGE_MAX_ITEMS_PER_RUN', path: 'triage.maxItemsPerRun', type: 'int' },
    { env: 'SYNAPTOMIND_TRIAGE_MAX_ARCHIVES_PER_RUN', path: 'triage.maxArchivesPerRun', type: 'int' },
    { env: 'SYNAPTOMIND_TRIAGE_MAX_LINKS_PER_RUN', path: 'triage.maxLinksPerRun', type: 'int' },
    { env: 'SYNAPTOMIND_TRIAGE_REQUIRE_DRY_RUN_FIRST', path: 'triage.requireDryRunFirst', type: 'bool' },
    { env: 'SYNAPTOMIND_TRIAGE_BACKFILL_ENABLED', path: 'triage.backfillEnabled', type: 'bool' },
  ]

  test('ENV_MAPPINGS contains all six triage entries with correct types', () => {
    for (const expected of EXPECTED_MAPPINGS) {
      const found = ENV_MAPPINGS.find(m => m.path === expected.path)
      expect(found).toBeDefined()
      expect(found!.env).toBe(expected.env)
      expect(found!.type).toBe(expected.type as 'string' | 'int' | 'float' | 'bool' | 'list')
    }
  })

  test('no extra triage entries exist beyond the six', () => {
    const triageMappings = ENV_MAPPINGS.filter(m => m.path.startsWith('triage.'))
    expect(triageMappings).toHaveLength(6)
  })
})

// ── buildConfigDisplay — triage section ──────────────────────────────────────

describe('buildConfigDisplay — Triage section', () => {
  test('renders the Triage section header', () => {
    const out = buildConfigDisplay()
    expect(out).toContain('--- Triage ---')
  })

  test('renders all six triage keys with default values', () => {
    const out = buildConfigDisplay()

    const lines = out.split('\n').filter(l => l.includes('triage.'))
    expect(lines.some(l => l.includes('triage.enabled = yes'))).toBe(true)
    expect(lines.some(l => l.includes('triage.maxItemsPerRun = 25'))).toBe(true)
    expect(lines.some(l => l.includes('triage.maxArchivesPerRun = 25'))).toBe(true)
    expect(lines.some(l => l.includes('triage.maxLinksPerRun = 20'))).toBe(true)
    expect(lines.some(l => l.includes('triage.requireDryRunFirst = yes'))).toBe(true)
    expect(lines.some(l => l.includes('triage.backfillEnabled = yes'))).toBe(true)
  })

  test('each triage key includes its env variable name', () => {
    const out = buildConfigDisplay()

    expect(out).toContain('triage.enabled = yes (SYNAPTOMIND_TRIAGE_ENABLED)')
    expect(out).toContain('triage.maxItemsPerRun = 25 (SYNAPTOMIND_TRIAGE_MAX_ITEMS_PER_RUN)')
    expect(out).toContain('triage.maxArchivesPerRun = 25 (SYNAPTOMIND_TRIAGE_MAX_ARCHIVES_PER_RUN)')
    expect(out).toContain('triage.maxLinksPerRun = 20 (SYNAPTOMIND_TRIAGE_MAX_LINKS_PER_RUN)')
    expect(out).toContain('triage.requireDryRunFirst = yes (SYNAPTOMIND_TRIAGE_REQUIRE_DRY_RUN_FIRST)')
    expect(out).toContain('triage.backfillEnabled = yes (SYNAPTOMIND_TRIAGE_BACKFILL_ENABLED)')
  })

  test('annotates when a triage value differs from the default', () => {
    const saved = { ...config.triage }
    config.triage = { ...saved, enabled: false, maxItemsPerRun: 10 }
    try {
      const out = buildConfigDisplay()
      const enabledLine = out.split('\n').find(l => l.includes('triage.enabled'))
      const itemsLine = out.split('\n').find(l => l.includes('triage.maxItemsPerRun'))

      expect(enabledLine).toContain('no')
      expect(enabledLine).toContain('[default: yes]')
      expect(itemsLine).toContain('10')
      expect(itemsLine).toContain('[default: 25]')
    } finally {
      config.triage = saved
    }
  })

  test('omits default annotation when triage values equal defaults', () => {
    const out = buildConfigDisplay()
    const enabledLine = out.split('\n').find(l => l.includes('triage.enabled'))
    expect(enabledLine).not.toContain('[default:')
  })
})

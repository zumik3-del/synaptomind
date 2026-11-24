import { describe, expect, test } from 'bun:test'
import { config, DEFAULTS, type Config } from '../config'
import { buildConfigDisplay } from './config-display.service'

// The renderer takes the config it describes: the loaded object is frozen, so every case that needs
// another value hands it a fixture instead of writing into the global.
const DEFAULT_SOFT_LIMIT = DEFAULTS.thoughts.softLimit

function withSections(overrides: Partial<Config>): Config {
  return { ...config, ...overrides }
}

describe('buildConfigDisplay redaction', () => {
  test('redacts every path-bearing setting and never prints the raw path', () => {
    const secrets = {
      dbPath: '/secret/data/synaptomind.db',
      cacheDir: '/secret/huggingface',
      instructionsFile: '/secret/mcp-instructions.md'
    }
    const out = buildConfigDisplay(
      withSections({
        db: { ...config.db, path: secrets.dbPath },
        embedder: { ...config.embedder, cacheDir: secrets.cacheDir },
        mcp: { ...config.mcp, instructionsFile: secrets.instructionsFile }
      })
    )

    for (const secret of Object.values(secrets)) expect(out).not.toContain(secret)
    expect(out).toContain('db.path = [redacted]')
    expect(out).toContain('embedder.cacheDir = [redacted]')
    expect(out).toContain('mcp.instructionsFile = [redacted]')
    expect(out.split('[redacted]').length - 1).toBe(3)
  })

  test('renders an empty path as "-" rather than [redacted]', () => {
    const out = buildConfigDisplay(
      withSections({
        db: { ...config.db, path: '' },
        embedder: { ...config.embedder, cacheDir: '' },
        mcp: { ...config.mcp, instructionsFile: '' }
      })
    )

    expect(out).toContain('db.path = -')
    expect(out).toContain('embedder.cacheDir = -')
    expect(out).toContain('mcp.instructionsFile = -')
    expect(out).not.toContain('db.path = [redacted]')
  })

  test('formats scalars and annotates a value that differs from the default', () => {
    const out = buildConfigDisplay(
      withSections({ thoughts: { ...config.thoughts, softLimit: DEFAULT_SOFT_LIMIT + 1 } })
    )

    expect(out).not.toContain('--- Verify ---')
    expect(out).toContain('--- Thoughts ---')
    expect(out).toContain(`thoughts.softLimit = ${DEFAULT_SOFT_LIMIT + 1}`)
    expect(out).toContain(`[default: ${DEFAULT_SOFT_LIMIT}]`)
  })

  test('omits the default annotation when the value equals the default', () => {
    const line = buildConfigDisplay(
      withSections({ thoughts: { ...config.thoughts, softLimit: DEFAULT_SOFT_LIMIT } })
    )
      .split('\n')
      .find(l => l.includes('thoughts.softLimit ='))

    expect(line).toBeDefined()
    expect(line).not.toContain('[default:')
  })
})

describe('buildConfigDisplay removed sections', () => {
  test('renders no Auto Link or Triage section', () => {
    const out = buildConfigDisplay()

    expect(out).not.toContain('--- Auto Link ---')
    expect(out).not.toContain('--- Triage ---')
    expect(out).not.toContain('autoLink.')
    expect(out).not.toContain('triage.')
  })

  test('renders no decay auto-archive knob and no placement section', () => {
    const out = buildConfigDisplay()

    expect(out).not.toContain('decay.archiveThreshold')
    expect(out).not.toContain('decay.archiveMinAgeDays')
    expect(out).not.toContain('--- Placement ---')
    expect(out).not.toContain('placement.')
    expect(out).not.toContain('edgeDetect.minSimilarity')
    expect(out).toContain('decay.rate')
    expect(out).toContain('edgeDetect.maxCandidates')
  })
  test('an inert section copied from a legacy config.json is not advertised', () => {
    const legacy = {
      ...config,
      autoLink: { minSimilarity: 0.5, maxEdgesPerRun: 7, dryRun: true },
      triage: { enabled: false }
    } as unknown as Config
    const out = buildConfigDisplay(legacy)

    expect(out).not.toContain('autoLink')
    expect(out).not.toContain('triage')
  })
})

describe('buildConfigDisplay Search section', () => {
  test('renders the Search section when env mapping exists for search.confidence.vectorFloor', () => {
    const out = buildConfigDisplay()
    expect(out).toContain('--- Search ---')
    expect(out).toContain('search.confidence.vectorFloor')
  })

  test('Search section shows the default floor value', () => {
    const out = buildConfigDisplay()
    const line = out.split('\n').find(l => l.includes('search.confidence.vectorFloor'))
    expect(line).toBeDefined()
    expect(line).toContain('0.9')
  })

  test('Search section annotates when the resolved value differs from the default', () => {
    const out = buildConfigDisplay(
      withSections({
        search: {
          confidence: { ...config.search.confidence, vectorFloor: 0.85 }
        }
      })
    )
    const line = out.split('\n').find(l => l.includes('search.confidence.vectorFloor'))
    expect(line).toContain('0.85')
    expect(line).toContain('[default: 0.9]')
  })
})

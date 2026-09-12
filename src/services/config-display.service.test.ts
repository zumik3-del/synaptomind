import { afterEach, describe, expect, test } from 'bun:test'
import { config, DEFAULTS } from '../config'
import { buildConfigDisplay } from './config-display.service'

// Regression coverage for task #165 (F11): config rendering moved into the
// service layer and must keep filesystem paths out of MCP output.
//
// Note: without a config.json the nested config sections are the same object
// references as DEFAULTS (shallow merge), so a test that wants config to differ
// from its default must replace the section object rather than mutate a key.
const DEFAULT_SOFT_LIMIT = DEFAULTS.thoughts.softLimit

const original = {
  db: config.db,
  mcp: config.mcp,
  embedder: config.embedder,
  thoughts: config.thoughts,
  verify: config.verify
}

afterEach(() => {
  config.db = original.db
  config.mcp = original.mcp
  config.embedder = original.embedder
  config.thoughts = original.thoughts
  config.verify = original.verify
})

describe('buildConfigDisplay redaction', () => {
  test('redacts every path-bearing setting and never prints the raw path', () => {
    const secrets = {
      dbPath: '/secret/data/synaptomind.db',
      logDbPath: '/secret/data/logs.db',
      cacheDir: '/secret/huggingface',
      instructionsFile: '/secret/mcp-instructions.md'
    }
    config.db = { ...config.db, path: secrets.dbPath }
    config.logDbPath = secrets.logDbPath
    config.embedder = { ...config.embedder, cacheDir: secrets.cacheDir }
    config.mcp = { ...config.mcp, instructionsFile: secrets.instructionsFile }

    const out = buildConfigDisplay()

    for (const secret of Object.values(secrets)) expect(out).not.toContain(secret)
    expect(out).toContain('db.path = [redacted]')
    expect(out).toContain('logDbPath = [redacted]')
    expect(out).toContain('embedder.cacheDir = [redacted]')
    expect(out).toContain('mcp.instructionsFile = [redacted]')
    // Exactly the four sensitive keys, nothing else.
    expect(out.split('[redacted]').length - 1).toBe(4)
  })

  test('renders an empty path as "-" rather than [redacted]', () => {
    config.db = { ...config.db, path: '' }
    config.logDbPath = ''
    config.embedder = { ...config.embedder, cacheDir: '' }
    config.mcp = { ...config.mcp, instructionsFile: '' }

    const out = buildConfigDisplay()

    expect(out).toContain('db.path = -')
    expect(out).toContain('logDbPath = -')
    expect(out).toContain('embedder.cacheDir = -')
    expect(out).toContain('mcp.instructionsFile = -')
    expect(out).not.toContain('db.path = [redacted]')
  })

  test('formats scalars and annotates a value that differs from the default', () => {
    config.verify = { ...config.verify, enabled: true }
    config.thoughts = { ...config.thoughts, softLimit: DEFAULT_SOFT_LIMIT + 1 }

    const out = buildConfigDisplay()

    expect(out).toContain('--- Verify ---')
    expect(out).toContain('--- Thoughts ---')
    expect(out).toContain('verify.enabled = yes')
    expect(out).toContain(`thoughts.softLimit = ${DEFAULT_SOFT_LIMIT + 1}`)
    expect(out).toContain(`[default: ${DEFAULT_SOFT_LIMIT}]`)
  })

  test('omits the default annotation when the value equals the default', () => {
    config.thoughts = { ...config.thoughts, softLimit: DEFAULT_SOFT_LIMIT }

    const line = buildConfigDisplay()
      .split('\n')
      .find(l => l.includes('thoughts.softLimit ='))

    expect(line).toBeDefined()
    expect(line).not.toContain('[default:')
  })
})

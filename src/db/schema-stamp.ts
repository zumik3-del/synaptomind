import { Database } from 'bun:sqlite'
import { BASELINE_TABLE_DDL, META_DDL } from './baseline-schema'

const SCHEMA_VERSION_KEY = 'schema_version'
const PRE_BASELINE_VERSION = 0
const EVIDENCE_LIMIT = 8
const INTEGER = /^\d+$/

/** Baseline object name to its baseline columns; a missing key means "not part of the baseline". */
type Fingerprint = Map<string, Set<string>>

let baseline: Fingerprint | null = null

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function schemaObjects(db: Database): { name: string; type: string }[] {
  const rows = db.prepare(`SELECT name, type FROM sqlite_master`).all() as {
    name: string
    type: string
  }[]
  return rows.filter(row => !row.name.startsWith('sqlite_'))
}

function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[]
  return rows.map(row => row.name)
}

// Rendered, never hand-listed: the scratch database runs exactly the DDL `init.ts` applies to a
// fresh file, so this fingerprint cannot rot when a baseline table or column changes.
function preBaselineFingerprint(): Fingerprint {
  if (baseline !== null) return baseline
  const scratch = new Database(':memory:')
  try {
    for (const ddl of [META_DDL, ...BASELINE_TABLE_DDL]) scratch.run(ddl)
    baseline = new Map(
      schemaObjects(scratch).map(
        object => [object.name, new Set(columnNames(scratch, object.name))] as const
      )
    )
    return baseline
  } finally {
    scratch.close(true)
  }
}

/**
 * Everything the database carries that a baseline-only file does not: an object no baseline DDL
 * creates (a table, index or trigger a migration added) or a column a migration added to a
 * baseline table. `PRAGMA table_info` runs only on baseline tables, so a vec0 table is never
 * opened before the extension is loaded.
 */
export function postBaselineEvidence(db: Database): string[] {
  const expected = preBaselineFingerprint()
  const found: { rank: number; label: string }[] = []
  for (const object of schemaObjects(db)) {
    const known = expected.get(object.name)
    if (known === undefined) {
      found.push({ rank: object.type === 'table' ? 0 : 2, label: object.name })
      continue
    }
    for (const column of columnNames(db, object.name)) {
      if (!known.has(column)) found.push({ rank: 1, label: `${object.name}.${column}` })
    }
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(entry => entry.label)
}

function describe(evidence: string[]): string {
  if (evidence.length === 0) return 'its schema carries nothing beyond the pre-baseline tables'
  const listed = evidence.slice(0, EVIDENCE_LIMIT).join(', ')
  const more = evidence.length > EVIDENCE_LIMIT ? `, +${evidence.length - EVIDENCE_LIMIT} more` : ''
  return `its schema already carries ${evidence.length} element(s) that only a migrated database has (${listed}${more})`
}

function refusalMessage(db: Database, evidence: string[], reason: string): string {
  const where = db.filename === ':memory:' ? 'the database' : db.filename
  return (
    `Refusing to open ${where}: ${reason}, and ${describe(evidence)}. ` +
    'Replaying the migration chain from version 0 would drop vec_thoughts (v002) and then fail on ' +
    'an element that already exists, so this boot changed nothing. Recovery: restore the pre-upgrade ' +
    'backup taken next to the database file (<db>.pre-v<N>.<timestamp>.bak), or write the newest ' +
    `applied migration number into _meta.${SCHEMA_VERSION_KEY} by hand, then restart. ` +
    'Nothing is repaired or replayed automatically.'
  )
}

/**
 * The migration version recorded in `_meta`, or 0 for a genuinely pre-baseline database (a fresh
 * file, or baseline tables only). Throws instead of guessing when the stamp is missing or
 * unparseable and the schema proves migrations have run: replaying the chain would drop
 * `vec_thoughts` and then die on an already-present column, bricking a readable database.
 */
export function readSchemaVersion(db: Database): number {
  const row = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(SCHEMA_VERSION_KEY) as
    | { value: string | null }
    | null
    | undefined

  if (row === null || row === undefined) {
    const evidence = postBaselineEvidence(db)
    if (evidence.length === 0) return PRE_BASELINE_VERSION
    throw new Error(refusalMessage(db, evidence, `_meta.${SCHEMA_VERSION_KEY} is missing`))
  }

  const raw = typeof row.value === 'string' ? row.value.trim() : ''
  if (!INTEGER.test(raw)) {
    throw new Error(
      refusalMessage(
        db,
        postBaselineEvidence(db),
        `_meta.${SCHEMA_VERSION_KEY} does not hold a migration number (found ${JSON.stringify(row.value)})`
      )
    )
  }
  return Number(raw)
}

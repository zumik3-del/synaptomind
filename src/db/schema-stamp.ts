import { Database } from 'bun:sqlite'
import { BASELINE_TABLE_DDL, META_DDL } from './baseline-schema'

const SCHEMA_VERSION_KEY = 'schema_version'
const PRE_BASELINE_VERSION = 0
const EVIDENCE_LIMIT = 8
const INTEGER = /^\d+$/

// A missing key means "not part of the baseline".
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

// `PRAGMA table_info` runs only on baseline tables, so a vec0 table is never opened before the extension is loaded.
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
    'Replaying the migration chain from version 0 would drop vec_thoughts (v002) and then fail ' +
    'on an element that already exists, so this boot changed nothing and replayed nothing; a ' +
    'later boot replays only the migrations the restored file still needs. Recovery: stop the ' +
    'unit first, with systemctl stop synaptomind, because the installed unit restarts the ' +
    'server automatically after an exit (up to five starts a minute, after which it stops ' +
    'retrying), so a running one reopens this file and rewrites its WAL while you copy over it. ' +
    'Two copies are then candidates, and the newest wins: the deploy-side copy ' +
    'the supported update path writes next to the database as ' +
    '<db>.backup/<basename>.<timestamp>-<pid>-<n>.bak (that directory keeps the newest ' +
    'BACKUP_KEEP copies, 5 by default, and the update run prints each copy as "Database backed ' +
    'up: <path>"), and the in-app migration snapshot <db>.pre-v<N>.<timestamp>.bak, written ' +
    'only when migrations were pending, so the newest pre-v snapshot can be several upgrades ' +
    'old; every write after the copy you restore is lost. Then restore the pre-upgrade backup ' +
    'over the database file, with cp -p <backup> <db> followed by rm -f <db>-wal <db>-shm as ' +
    'docs/DEPLOY.md prescribes, and write nothing by hand: the restored file is at the version ' +
    'it was taken at, so read the number from its own ' +
    `_meta.${SCHEMA_VERSION_KEY} row only to see which migrations the next boot will still replay. ` +
    'Never copy the <N> out of a backup filename: in a migration snapshot it names the version ' +
    'the upgrading boot was moving to, not the one the snapshot was taken at. A ' +
    '<db>.pre-v<N>.rebuild.<timestamp>.bak is a vector-index snapshot taken at the current ' +
    'version, not a migration one, and its own ' +
    `_meta.${SCHEMA_VERSION_KEY} row holds that same number. Keeping the current file instead of ` +
    'restoring a snapshot is a separate step with its own condition: write the number into ' +
    `_meta.${SCHEMA_VERSION_KEY} by hand only when a copy of this file that still carries its stamp ` +
    'row supplies it, then restart. Never take the number from the migration sources ' +
    '(src/db/migrations) or derive it from the elements above: a migration may add nothing ' +
    'visible (v047 drops an index and rewrites rows), so those elements only bound how far the ' +
    'chain reached, and a database at v047 looks no newer than one at v046. With no such copy ' +
    'the number is not recoverable from this database, so do not guess one, since a wrong ' +
    'number either replays the chain over a migrated schema or skips migrations the file still ' +
    'needs. With neither a stamped copy nor any backup, the thoughts in this file are intact ' +
    'and must not be deleted or re-initialised: look for a copy first in the <db>.backup ' +
    'directory next to the database file (resolving a symlinked <db> to the file it points ' +
    'at), and for any copy taken before the upgrade, then ask before you remove or overwrite ' +
    'anything.'
  )
}

// Throws instead of guessing: replaying the chain would drop `vec_thoughts` and brick a readable database.
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

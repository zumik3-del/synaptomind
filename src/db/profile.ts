import type { Database } from 'bun:sqlite'
import { getThoughtTagsBatch } from './tags'
import { rowToThought, type Thought } from './thoughts'

export interface ProfileTagCount {
  name: string
  count: number
}

export interface ProfileStats {
  profile_thoughts: number
  top_tags: ProfileTagCount[]
  last_summary_run: string | null
}

export function getProfileThoughts(db: Database): Thought[] {
  const rows = db
    .prepare(`
    SELECT t.*, p.name as project_name
    FROM thoughts t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.is_profile = 1 AND t.status != 'archived'
    ORDER BY t.created_at DESC
  `)
    .all() as Record<string, unknown>[]
  const tagMap = getThoughtTagsBatch(db, rows.map(r => r.id as string))
  return rows.map(r => ({ ...rowToThought(r), tags: tagMap.get(r.id as string) ?? [] }))
}

export function getProfileStats(db: Database): ProfileStats {
  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM thoughts WHERE is_profile = 1 AND status != 'archived'`)
    .get() as { count: number }
  const topTags = db
    .prepare(`
    SELECT tg.name, COUNT(*) as count
    FROM thought_tags tt
    INNER JOIN tags tg ON tg.id = tt.tag_id
    INNER JOIN thoughts t ON t.id = tt.thought_id
    WHERE t.is_profile = 1 AND t.status != 'archived'
    GROUP BY tg.name
    ORDER BY count DESC
    LIMIT 5
  `)
    .all() as ProfileTagCount[]
  const lastRun = db.prepare(`SELECT value FROM _meta WHERE key = 'last_profile_summary_run'`).get() as
    | { value: string }
    | undefined
  return {
    profile_thoughts: countRow.count,
    top_tags: topTags,
    last_summary_run: lastRun?.value ?? null
  }
}

export function setLastSummaryRun(db: Database, iso: string): void {
  db.prepare(
    `INSERT INTO _meta (key, value) VALUES ('last_profile_summary_run', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(iso)
}

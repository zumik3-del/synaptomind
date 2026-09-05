import type { Database } from 'bun:sqlite'

// ── Time helpers ─────────────────────────────────────────────────────────────

export function windowStart(windowSecs: number): string {
  return new Date(Date.now() - windowSecs * 1000).toISOString()
}

export function isOlderThanDays(isoString: string, days: number): boolean {
  const ageMs = Date.now() - new Date(isoString).getTime()
  return ageMs > days * 86400000
}

// ── Telemetry grounding tools ────────────────────────────────────────────────

export const GROUNDING_TOOLS = [
  'search_thoughts',
  'get_thought',
  'get_thought_timeline',
  'recall_clusters',
  'get_context',
  'get_thought_graph',
  'list_projects',
  'get_chain',
  'get_frontier',
  'get_slots',
  'list_smart_notes',
  'eval_smart_notes',
  'get_profile'
]

// ── Job run recording (_meta table) ──────────────────────────────────────────

export function recordJobRun(db: Database, key: string, result: unknown): void {
  db.prepare(
    `INSERT INTO _meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(`${key}_run`, new Date().toISOString())
  db.prepare(
    `INSERT INTO _meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(`${key}_result`, JSON.stringify(result))
}

export function getLastJobRun<T = unknown>(db: Database, key: string): { last_run: string | null; result: T | null } {
  const run = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(`${key}_run`) as
    | { value: string }
    | undefined
  const raw = db.prepare(`SELECT value FROM _meta WHERE key = ?`).get(`${key}_result`) as
    | { value: string }
    | undefined
  let result: T | null = null
  if (raw) {
    try {
      result = JSON.parse(raw.value) as T
    } catch {
      // corrupt stored JSON
    }
  }
  return { last_run: run?.value ?? null, result }
}

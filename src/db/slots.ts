import type { Database } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'

export interface SlotRow {
  id: string
  name: string
  scope: 'project' | 'global'
  scope_id: string | null
  content: string
  max_chars: number
  updated_at: string
}

export function getSlotRow(db: Database, name: string, scope: 'project' | 'global', scopeId: string | null): SlotRow | undefined {
  const row = db
    .prepare(`SELECT * FROM slots WHERE name = ? AND scope = ? AND COALESCE(scope_id, '') = COALESCE(?, '')`)
    .get(name, scope, scopeId) as SlotRow | undefined | null
  return row ?? undefined
}

export interface UpsertSlotInput {
  name: string
  scope: 'project' | 'global'
  scope_id: string | null
  content: string
  max_chars: number
}

export function upsertSlot(db: Database, input: UpsertSlotInput): SlotRow {
  const existing = getSlotRow(db, input.name, input.scope, input.scope_id)
  if (existing) {
    db.prepare(`UPDATE slots SET content = ?, max_chars = ?, updated_at = ? WHERE id = ?`).run(
      input.content,
      input.max_chars,
      new Date().toISOString(),
      existing.id
    )
  } else {
    db.prepare(
      `INSERT INTO slots (id, name, scope, scope_id, content, max_chars, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(uuidv7(), input.name, input.scope, input.scope_id, input.content, input.max_chars, new Date().toISOString())
  }
  const row = getSlotRow(db, input.name, input.scope, input.scope_id)
  if (!row) throw new Error(`slot upsert failed: ${input.name}/${input.scope}`)
  return row
}

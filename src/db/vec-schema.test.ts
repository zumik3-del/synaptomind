import { expect, test } from 'bun:test'
import { VEC_SCOPE_GLOBAL, VEC_SCOPE_UNASSIGNED, scopeSql, vecTableDdl } from './vec-schema'

test('the vec DDL is rendered with the configured dimensions and the scope partition', () => {
  const ddl = vecTableDdl(384)

  expect(ddl).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS vec_thoughts USING vec0(')
  expect(ddl).toContain('embedding FLOAT[384] distance_metric=cosine')
  expect(ddl).toContain('scope     TEXT PARTITION KEY')
})

test('the rebuild form renders without IF NOT EXISTS, so a stale table cannot survive', () => {
  const ddl = vecTableDdl(1024, false)

  expect(ddl).toContain('CREATE VIRTUAL TABLE vec_thoughts USING vec0(')
  expect(ddl).not.toContain('IF NOT EXISTS')
  expect(ddl).toContain('embedding FLOAT[1024]')
})

test('scopeSql renders the three scope cases against the alias it is given', () => {
  const sql = scopeSql('t')

  expect(sql).toBe(
    "CASE WHEN t.is_global = 1 THEN '__global__' " +
      "WHEN t.project_id IS NULL THEN '__unassigned__' " +
      'ELSE t.project_id END'
  )
  expect(sql).toContain(VEC_SCOPE_GLOBAL)
  expect(sql).toContain(VEC_SCOPE_UNASSIGNED)
  expect(scopeSql('NEW')).toContain('WHEN NEW.is_global = 1')
})

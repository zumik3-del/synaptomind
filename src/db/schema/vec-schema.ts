// The single owner of the `vec_thoughts` DDL: a second copy would let a dimension rebuild recreate
// the table without `scope`, and every scoped query would then fail.
export const VEC_SCOPE_GLOBAL = '__global__'
export const VEC_SCOPE_UNASSIGNED = '__unassigned__'

export function vecTableDdl(dimensions: number, ifNotExists = true): string {
  return `CREATE VIRTUAL TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}vec_thoughts USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}] distance_metric=cosine,
        scope     TEXT PARTITION KEY
      )`
}

// `alias` must name the `thoughts` row, and the read path widens every project scope with
// `IN (?, '__global__')`, so both sentinels are coupled to the queries.
export function scopeSql(alias: string): string {
  return (
    `CASE WHEN ${alias}.is_global = 1 THEN '${VEC_SCOPE_GLOBAL}' ` +
    `WHEN ${alias}.project_id IS NULL THEN '${VEC_SCOPE_UNASSIGNED}' ` +
    `ELSE ${alias}.project_id END`
  )
}

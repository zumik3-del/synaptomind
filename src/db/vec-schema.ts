/**
 * Single owner of the `vec_thoughts` DDL: v002 (fresh installs), v048 (the scope
 * rebuild) and the boot-time dimension rebuild all render it from here. A second
 * copy would let a dimension change recreate the table without `scope` and every
 * scoped query would then fail (ADR 2026-11-12, audit F5).
 */

/** Partition of the thoughts that must stay visible from every project. */
export const VEC_SCOPE_GLOBAL = '__global__'
/** Partition of a thought with no project; not a project id, so it can collide with none. */
export const VEC_SCOPE_UNASSIGNED = '__unassigned__'

export function vecTableDdl(dimensions: number, ifNotExists = true): string {
  return `CREATE VIRTUAL TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}vec_thoughts USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}] distance_metric=cosine,
        scope     TEXT PARTITION KEY
      )`
}

/**
 * The one definition of a thought's vector partition. `alias` must name the
 * `thoughts` row; the read path adds `'__global__'` to every project scope via
 * `IN (?, '__global__')`.
 */
export function scopeSql(alias: string): string {
  return (
    `CASE WHEN ${alias}.is_global = 1 THEN '${VEC_SCOPE_GLOBAL}' ` +
    `WHEN ${alias}.project_id IS NULL THEN '${VEC_SCOPE_UNASSIGNED}' ` +
    `ELSE ${alias}.project_id END`
  )
}

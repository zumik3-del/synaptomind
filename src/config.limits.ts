// SQLite reads a negative `LIMIT` as "no limit", and the bind must be an integer, so every LIMIT a
// caller can influence goes through this guard. Imports nothing on purpose: the db LIMIT binds and
// the slots reader both use it, and neither may pull the config module in.
export function clampPrimerCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored < 1 ? 1 : floored
}

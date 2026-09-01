export function toBit(val?: boolean): number {
  return val ? 1 : 0
}

export function placeholders(ids: readonly string[]): string {
  return ids.map(() => '?').join(', ')
}

export function sqlIn(values: readonly unknown[]): string {
  return values.map(() => '?').join(',')
}

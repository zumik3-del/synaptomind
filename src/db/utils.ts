export function toBit(val?: boolean): number {
  return val ? 1 : 0
}

export function sqlIn(values: readonly unknown[]): string {
  return values.map(() => '?').join(',')
}

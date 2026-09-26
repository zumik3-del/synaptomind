// ── Time helpers ─────────────────────────────────────────────────────────────

export function windowStart(windowSecs: number): string {
  return new Date(Date.now() - windowSecs * 1000).toISOString()
}

export function isOlderThanDays(isoString: string, days: number): boolean {
  const ageMs = Date.now() - new Date(isoString).getTime()
  return ageMs > days * 86400000
}

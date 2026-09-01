export function normalizeRepoKey(input: string): string {
  if (!input) return ''
  const s = input.trim()

  const sshMatch = s.match(/^git@([^:]+):(.+)$/)
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase()
    const path = stripGit(sshMatch[2]).toLowerCase()
    return `https://${host}/${path}`
  }

  const scpMatch = s.match(/^([a-z0-9.-]+):(.+)$/i)
  if (scpMatch && !s.includes('://')) {
    const host = scpMatch[1].toLowerCase()
    const path = stripGit(scpMatch[2]).toLowerCase()
    return `https://${host}/${path}`
  }

  if (s.includes('://')) {
    try {
      const u = new URL(s)
      const host = u.hostname.toLowerCase()
      const path = stripGit(u.pathname).toLowerCase().replace(/^\//, '').replace(/\/$/, '')
      return `https://${host}/${path}`
    } catch {
      // fall through
    }
  }

  const normalized = stripGit(s).replace(/\/+$/, '')
  return `https://local${normalized}`
}

function stripGit(p: string): string {
  return p.replace(/\.git$/i, '').replace(/\/+$/, '')
}

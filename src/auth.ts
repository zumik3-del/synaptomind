let validTokens: string[] | null = null

export function getValidTokens(): string[] {
  if (validTokens) return validTokens

  const secret = process.env.SYNAPTOMIND_SECRET || ''
  const serviceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN || secret
  validTokens = [secret, serviceToken].filter(Boolean)

  if (validTokens.length === 0) {
    const token = crypto.randomUUID()
    console.error(`[synaptomind] No SYNAPTOMIND_SECRET or SYNAPTOMIND_SERVICE_TOKEN set.`)
    console.error(`[synaptomind] Generated token: ${token}`)
    console.error(`[synaptomind] Use: Authorization: Bearer ${token}`)
    validTokens.push(token)
  }

  return validTokens
}

export function checkBearerAuth(auth: string | undefined): boolean {
  if (!auth) return false
  const tokens = getValidTokens()
  return tokens.some(t => auth === `Bearer ${t}`)
}

/**
 * Environment variables the process reads directly, outside `ENV_MAPPINGS`. They are runtime
 * switches, secrets and test seams rather than settings: they are read where they are used, so they
 * cannot be part of the resolved config object. They are declared here once, so the docs and
 * `memory_status action=config` can name them and show their effective values.
 *
 * Imports nothing on purpose: the logging, embedder and runtime modules import this table.
 */

export type RawEnvKind = 'flag' | 'positive-int' | 'path' | 'file' | 'secret' | 'secret-list'

export interface RawEnvEntry {
  env: string
  kind: RawEnvKind
  /** The value the reader falls back to when the variable is unset or unusable. */
  fallback?: number
  description: string
}

export const RAW_ENV: readonly RawEnvEntry[] = [
  {
    env: 'SYNAPTOMIND_DEBUG',
    kind: 'flag',
    description: 'verbose debug logging (src/logging/log.ts)'
  },
  {
    env: 'SYNAPTOMIND_CONFIG',
    kind: 'file',
    description: 'config.json this process loads (src/config.ts)'
  },
  {
    env: 'SYNAPTOMIND_VEC0_PATH',
    kind: 'path',
    description: 'vec0 extension path override (src/runtime-mode.ts)'
  },
  {
    env: 'EMBEDDER_START_TIMEOUT_MS',
    kind: 'positive-int',
    fallback: 300_000,
    description:
      'deadline for the embedder child to report ready (src/embedder/embedder-supervisor.ts)'
  },
  {
    env: 'EMBEDDER_BACKOFF_BASE_MS',
    kind: 'positive-int',
    fallback: 1_000,
    description: 'base restart backoff for the embedder child (src/embedder/embedder-supervisor.ts)'
  },
  {
    env: 'SYNAPTOMIND_SECRET',
    kind: 'secret',
    description: 'single-user bearer token; inert when users are configured (src/auth.ts)'
  },
  {
    env: 'SYNAPTOMIND_ALLOW_INSECURE',
    kind: 'flag',
    description: 'disables auth for local development; single-user only (src/auth.ts)'
  },
  {
    env: 'SYNAPTOMIND_USER_TOKEN_<ID>',
    kind: 'secret-list',
    description: 'plaintext token per configured user id (src/config.ts)'
  }
]

export function rawEnvEntry(env: string): RawEnvEntry {
  const entry = RAW_ENV.find(candidate => candidate.env === env)
  if (entry === undefined) throw new Error(`[config] ${env} is not declared in RAW_ENV`)
  return entry
}

export function rawEnvFallbackNumber(env: string): number {
  const fallback = rawEnvEntry(env).fallback
  if (fallback === undefined) throw new Error(`[config] ${env} declares no numeric fallback`)
  return fallback
}

/** The value the reading module would use, with secrets and paths reduced to presence. */
export function rawEnvEffective(entry: RawEnvEntry, env: NodeJS.ProcessEnv = process.env): string {
  switch (entry.kind) {
    case 'flag':
      return env[entry.env] === 'true' ? 'yes' : 'no'
    case 'positive-int': {
      const raw = env[entry.env]?.trim() ?? ''
      const value = raw === '' ? Number.NaN : Number(raw)
      if (Number.isFinite(value) && value > 0) return String(value)
      return `${entry.fallback ?? ''} (default)`
    }
    case 'path':
    case 'file':
    case 'secret':
      return (env[entry.env] ?? '').trim() === '' ? '-' : '[set]'
    case 'secret-list': {
      const prefix = entry.env.replace('<ID>', '')
      const ids = Object.keys(env)
        .filter(key => key.startsWith(prefix) && (env[key] ?? '') !== '')
        .map(key => key.slice(prefix.length))
        .sort()
      return ids.length === 0 ? '-' : ids.join(', ')
    }
  }
}

import { closeDb, initDb, openDatabase } from '../db/init'
import { clearRegistry, getDb, register, registry } from '../db/container'
import { config } from '../config'
import { clearHealthProbeCache, probeDatabase } from '../services/health.service'

export interface OpsHealthCheckOptions {
  user?: string
  all?: boolean
}

export interface OpsHealthCheckUserResult {
  userId: string
  status: 'ok' | 'degraded'
  error?: string
}

export interface OpsHealthCheckResult {
  users: OpsHealthCheckUserResult[]
  aggregate: 'ok' | 'degraded'
}

export async function runOpsHealthCheck(opts: OpsHealthCheckOptions = {}): Promise<OpsHealthCheckResult> {
  clearRegistry()
  clearHealthProbeCache()

  const users = Array.isArray(config.users) ? config.users : []

  if (users.length > 0) {
    for (const u of users as Array<{ id: string; dbPath: string }>) {
      try {
        const db = openDatabase({ dbPath: u.dbPath, runMigrations: false })
        register(u.id, db)
      } catch {
        // Unavailable user DBs are simply not registered; reported as absent.
      }
    }
  } else {
    try {
      initDb()
    } catch {
      // ignore; probed below
    }
  }

  let targets: Array<[string, ReturnType<typeof getDb>]> = []
  if (registry.size > 0) {
    targets = [...registry.entries()]
  } else {
    try {
      targets = [['default', getDb()]]
    } catch {
      targets = []
    }
  }

  if (opts.user && opts.user !== 'all') {
    targets = targets.filter(([id]) => id === opts.user)
  }

  const results: OpsHealthCheckUserResult[] = targets.map(([userId, db]) => {
    const probe = probeDatabase(db)
    return {
      userId,
      status: probe.status,
      ...(probe.error ? { error: probe.error } : {})
    }
  })

  // If a specific user was requested but not found, report it as degraded.
  if (opts.user && opts.user !== 'all' && results.length === 0) {
    results.push({ userId: opts.user, status: 'degraded', error: 'not registered' })
  }

  const aggregate: 'ok' | 'degraded' =
    results.length > 0 && results.every(r => r.status === 'ok') ? 'ok' : 'degraded'

  // Tear down connections we opened.
  if (registry.size > 0) {
    for (const [, db] of targets) {
      try {
        db.close(true)
      } catch {
        // ignore
      }
    }
  } else {
    try {
      closeDb()
    } catch {
      // ignore
    }
  }
  clearRegistry()

  return { users: results, aggregate }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const args = argv.slice(2)
  if (args[0] !== 'ops') {
    console.error('Usage: synaptomind ops health-check [--user <id>|all]')
    process.exitCode = 1
    return
  }
  if (args[1] !== 'health-check') {
    console.error('Usage: synaptomind ops health-check [--user <id>|all]')
    process.exitCode = 1
    return
  }

  let user: string | undefined
  let all = false
  for (let i = 2; i < args.length; i++) {
    const a = args[i]
    if (a === '--user') {
      user = args[++i]
      if (user === 'all') all = true
    } else if (a === 'all') {
      all = true
    }
  }
  if (all) user = 'all'

  const result = await runOpsHealthCheck({ user, all })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.aggregate === 'ok' ? 0 : 1
}

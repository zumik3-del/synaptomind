import { Database } from 'bun:sqlite'
import { config } from '../config'
import { vec0Path } from '../runtime-mode'
import { runHealthCheckService, type HealthReport } from '../services/health-check.service'

export interface OpsHealthCheckOptions {
  user?: string
}

export interface OpsHealthCheckUserResult {
  userId: string
  status: 'ok' | 'degraded'
  error?: string
  report?: HealthReport
}

export interface OpsHealthCheckResult {
  users: OpsHealthCheckUserResult[]
  aggregate: 'ok' | 'degraded'
}

export async function runOpsHealthCheck(
  opts: OpsHealthCheckOptions = {}
): Promise<OpsHealthCheckResult> {
  const configured = config.users?.length
    ? config.users.map(user => ({ userId: user.id, path: user.dbPath }))
    : [{ userId: 'default', path: config.db.path }]
  const selected =
    opts.user && opts.user !== 'all'
      ? configured.filter(target => target.userId === opts.user)
      : configured

  const results: OpsHealthCheckUserResult[] = selected.map(({ userId, path }) => {
    let db: Database | undefined
    try {
      // Read-only opening refuses missing files and never bootstraps or migrates.
      db = new Database(path, { readonly: true })
      db.loadExtension(vec0Path())
      const report = runHealthCheckService({}, db)
      return {
        userId,
        status: report.summary.critical || report.summary.warning ? 'degraded' : 'ok',
        report
      }
    } catch (error) {
      return { userId, status: 'degraded', error: String(error) }
    } finally {
      db?.close()
    }
  })
  if (selected.length === 0 && opts.user && opts.user !== 'all') {
    results.push({ userId: opts.user, status: 'degraded', error: 'not configured' })
  }
  return {
    users: results,
    aggregate:
      results.length > 0 && results.every(result => result.status === 'ok') ? 'ok' : 'degraded'
  }
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
  for (let i = 2; i < args.length; i++) {
    const a = args[i]
    if (a === '--user') {
      user = args[++i]
    } else if (a === 'all') {
      user = 'all'
    }
  }

  const result = await runOpsHealthCheck({ user })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.aggregate === 'ok' ? 0 : 1
}

import { clearRegistry, closeDb, listUserDatabases } from './db'
import { startEmbedderProcess, stopEmbedderProcess } from './embedder/client'
import { closeLogging, insertLog } from './logging'
import type { ProcessLogFn } from './process-handlers'
import { startDecayJob, stopDecayJob } from './services/decay.service'
import {
  startPlacementRetentionJob,
  stopPlacementRetentionJob
} from './services/placement-retention.service'

export interface LifecycleSteps {
  startEmbedder: () => void
  stopEmbedder: () => Promise<void>
  startBackgroundJobs: () => void
  stopBackgroundJobs: () => Promise<void>
  closeDatabases: () => void
  closeLogger: () => void
}

export interface LifecycleConfig {
  ownsBackgroundJobs: boolean
  embedderEnabled: boolean
  log?: ProcessLogFn
  steps?: Partial<LifecycleSteps>
}

export interface Lifecycle {
  start: () => void
  stop: (beforeExit?: () => void | Promise<void>) => Promise<void>
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const DEFAULT_STEPS: LifecycleSteps = {
  startEmbedder: () => {
    startEmbedderProcess().catch(err => {
      insertLog('error', 'embedder', 'Failed to start the embedder', { error: describe(err) })
    })
  },
  stopEmbedder: () => stopEmbedderProcess(),
  startBackgroundJobs: () => {
    startDecayJob()
    startPlacementRetentionJob()
  },
  stopBackgroundJobs: async () => {
    await stopDecayJob()
    await stopPlacementRetentionJob()
  },
  closeDatabases: () => {
    for (const { userId, db } of listUserDatabases()) {
      try {
        db.close(true)
      } catch (err) {
        insertLog('warning', 'lifecycle', 'Failed to close a user database', {
          userId,
          error: describe(err)
        })
      }
    }
    clearRegistry()
    closeDb()
  },
  closeLogger: () => closeLogging()
}

const DELEGATED_NOTICE =
  'stdio mode: background jobs delegated to the shared server; embedding requests run in an ' +
  'on-demand local child that loads the model per session (no queue, no user databases) — ' +
  'set SYNAPTOMIND_MCP_STDIO_STANDALONE=true or pass --stdio-standalone to run the scheduled ' +
  'jobs locally'

export function createLifecycle(config: LifecycleConfig): Lifecycle {
  const log = config.log ?? insertLog
  const steps: LifecycleSteps = { ...DEFAULT_STEPS, ...config.steps }
  let started = false
  let stopping: Promise<void> | null = null

  function start(): void {
    if (started) return
    started = true
    if (!config.ownsBackgroundJobs) {
      log('info', 'lifecycle', DELEGATED_NOTICE)
      return
    }
    if (config.embedderEnabled) steps.startEmbedder()
    else log('info', 'lifecycle', 'embedder disabled (--no-embedder or embedder.enabled=false)')
    steps.startBackgroundJobs()
  }

  async function runStop(beforeExit?: () => void | Promise<void>): Promise<void> {
    log('info', 'lifecycle', 'shutting down...')
    let firstError: unknown
    let failed = false
    async function attempt(name: string, run: () => void | Promise<void>): Promise<void> {
      try {
        await run()
      } catch (err) {
        if (!failed) {
          failed = true
          firstError = err
        }
        log('error', 'lifecycle', `Shutdown step failed: ${name}`, {
          step: name,
          error: describe(err)
        })
      }
    }
    await attempt('stopBackgroundJobs', () => steps.stopBackgroundJobs())
    await attempt('stopEmbedder', () => steps.stopEmbedder())
    if (beforeExit) await attempt('beforeExit', beforeExit)
    await attempt('closeDatabases', () => steps.closeDatabases())
    steps.closeLogger()
    if (failed) throw firstError
  }

  function stop(beforeExit?: () => void | Promise<void>): Promise<void> {
    if (!stopping) stopping = runStop(beforeExit)
    return stopping
  }

  return { start, stop }
}

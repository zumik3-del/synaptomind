// Background git↔project sync (issue #226).
//
// Mirrors startDecayJob/startDreamerJob: a single coarse tick scan checks every
// project flagged git_auto_sync and pulls its public repo's commits into
// git_commits. Idempotent re-indexing (UNIQUE(repo, hash)) means re-running is
// safe; the embedder child process drains pending_git_embeddings asynchronously.
//
// Per-project cadence is honoured via git_sync_interval_ms (default 6h) without
// spawning one timer per project.

import { listProjects } from '../db/projects'
import { getDb } from '../db'
import { insertLog } from '../logging'
import { indexGitCommits, indexGitCommitsFromRemote } from './git_commits.service'
import { createIntervalJob } from './jobs'
import { isRemoteUrl } from './utils'

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
const TICK_MS = 60 * 1000

const lastRun = new Map<string, number>()

async function runGitSync(): Promise<void> {
  const d = getDb()
  let projects: ReturnType<typeof listProjects> = []
  try {
    projects = listProjects(d).filter(p => p.git_auto_sync && p.git_repo_url)
  } catch (err) {
    insertLog('error', 'git-sync', `listProjects failed: ${(err as Error).message}`, {})
    return
  }
  const now = Date.now()
  for (const p of projects) {
    const repoUrl = p.git_repo_url
    if (!repoUrl) continue
    const interval = p.git_sync_interval_ms && p.git_sync_interval_ms > 0 ? p.git_sync_interval_ms : DEFAULT_INTERVAL_MS
    const last = lastRun.get(p.id) ?? 0
    if (now - last < interval) continue
    lastRun.set(p.id, now)
    try {
      if (isRemoteUrl(repoUrl)) {
        await indexGitCommitsFromRemote(repoUrl, p.id, undefined)
      } else {
        await indexGitCommits({ repo_path: repoUrl, project_id: p.id })
      }
      insertLog('info', 'git-sync', `synced project ${p.name}`, { project_id: p.id, repo: repoUrl })
    } catch (err) {
      insertLog('warning', 'git-sync', `sync failed for ${p.name}: ${(err as Error).message}`, {
        project_id: p.id,
        repo: repoUrl
      })
    }
  }
}

const job = createIntervalJob({
  name: 'git-sync',
  intervalMs: TICK_MS,
  onError: (err) => insertLog('error', 'git-sync', 'Git sync job failed', { error: String(err) })
}, () => { void runGitSync() })

export function startGitSyncJob(): void {
  void runGitSync()
  job.start()
}

export function stopGitSyncJob(): void { job.stop() }

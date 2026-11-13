import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { getDb } from '../context/container'
import { createTestDb, seedThought } from '../test/helpers'

const realLog = await import('../logging/log')
type InsertLogFn = typeof realLog.insertLog
type LogLevel = Parameters<InsertLogFn>[0]
type LogMetadata = Parameters<InsertLogFn>[3]

interface LogCall {
  level: LogLevel
  type: string
  message: string
  metadata: LogMetadata
}

const calls: LogCall[] = []

mock.module('../logging/log', () => ({
  ...realLog,
  insertLog: (
    level: LogLevel,
    type: string,
    message: string,
    metadata?: Record<string, unknown>
  ): void => {
    calls.push({ level, type, message, metadata })
  }
}))

const { createProject, deleteProject, resolveDefaultProjectId } = await import('./projects')
const { closeDb } = await import('./init')

const OLDER = '2026-01-01T00:00:00.000Z'
const NEWER = '2026-01-02T00:00:00.000Z'

function seedCollision(projectId: string, content: string): string {
  seedThought({ content, project_id: resolveDefaultProjectId(getDb()), created_at: OLDER })
  return seedThought({ content, project_id: projectId, created_at: NEWER })
}

function projectLogs(): LogCall[] {
  return calls.filter(call => call.type === 'project')
}

beforeEach(() => {
  createTestDb()
  calls.length = 0
})

afterEach(() => {
  calls.length = 0
  closeDb()
})

test('one info line carries the deleted project id and every archived id', () => {
  const project = createProject(getDb(), { name: 'Doomed' })
  const first = seedCollision(project.id, 'first body')
  const second = seedCollision(project.id, 'second body')

  deleteProject(getDb(), project.id)

  expect(projectLogs()).toHaveLength(1)
  const [line] = projectLogs()
  expect(line?.level).toBe('info')
  expect(line?.message).toContain(project.id)
  expect(line?.metadata?.project_id).toBe(project.id)
  expect(line?.metadata?.archived_count).toBe(2)
  expect(line?.metadata?.archived_ids).toEqual(expect.arrayContaining([first, second]))
  expect(line?.metadata?.archived_ids).toHaveLength(2)
})

test('a deletion that archives nothing logs no line', () => {
  const witness = createProject(getDb(), { name: 'Witness' })
  seedCollision(witness.id, 'witness body')
  deleteProject(getDb(), witness.id)
  expect(projectLogs()).toHaveLength(1)
  calls.length = 0

  const project = createProject(getDb(), { name: 'Clean' })
  seedThought({ content: 'unique body', project_id: project.id, created_at: NEWER })

  deleteProject(getDb(), project.id)

  expect(calls).toHaveLength(0)
})

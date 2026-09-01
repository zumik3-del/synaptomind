import { config } from '../config'
import { createIntervalJob } from './jobs'
import { awakenReady } from './smart_notes.service'

// Evaluates all smart notes and promotes the ready ones to active (issue #210).
export function runDreamerJob(): void {
  const awakened = awakenReady()
  if (awakened.length > 0) {
    console.log(`[dreamer] awakened ${awakened.length} thought(s):`)
    for (const note of awakened) {
      console.log(`[dreamer]   note=${note.note_id} thought=${note.thought_id} hit=${note.condition_hit}`)
    }
  }
}

const job = createIntervalJob({
  name: 'dreamer',
  intervalMs: config.smartNotes.evalIntervalMs,
  guard: () => config.smartNotes.autoPromote,
  onError: (err) => console.error('[dreamer] job error:', err)
}, runDreamerJob)

export function startDreamerJob(): void { job.start() }
export function stopDreamerJob(): void { job.stop() }

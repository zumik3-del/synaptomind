import { getDb } from '../db'
import { getProfileStats, getProfileThoughts, type ProfileStats, setLastSummaryRun } from '../db/profile'
import { createThought, deleteThought, type Thought } from '../db/thoughts'

export function getProfileService(): { stats: ProfileStats; thoughts: Thought[] } {
  const d = getDb()
  return { stats: getProfileStats(d), thoughts: getProfileThoughts(d) }
}

export function getProfileThoughtsService(): Thought[] {
  return getProfileThoughts(getDb())
}

export function getProfileStatsService(): ProfileStats {
  return getProfileStats(getDb())
}

const SUBTAG_PREFIX = '@profile-'
const BULLET_MAX = 400

export interface ProfileSummaryGroup {
  topic: string
  thought_id: string
  members: number
}

export interface ProfileSummaryResult {
  created: ProfileSummaryGroup[]
  removed: number
  stats: ProfileStats
}

function summaryTopic(tags: Thought['tags']): string | null {
  const sub = tags.map(t => t.name).find(n => n.toLowerCase().startsWith(SUBTAG_PREFIX))
  return sub ? sub.slice(SUBTAG_PREFIX.length) : null
}

/**
 * Regenerate persona summaries from is_profile thoughts (issue #200).
 *
 * Groups profile thoughts by their `@profile-*` sub-tag (`@profile` alone →
 * "general"), concatenates contents per group (no LLM — plain aggregation per
 * the issue's "не требуется" list), and replaces the previous auto-generated
 * summaries so repeated runs stay idempotent.
 *
 * Every topic group produces a summary — including singletons (#221): the
 * common setup is one thought per @profile-* topic, and skipping those left
 * the persona slot permanently empty while last_summary_run kept updating,
 * masking the problem.
 */
export function summarizeProfile(): ProfileSummaryResult {
  const d = getDb()
  const sources = getProfileThoughts(d).filter(t => t.source !== 'profile-summary')

  const groups = new Map<string, Thought[]>()
  for (const t of sources) {
    const key = summaryTopic(t.tags) ?? 'general'
    const list = groups.get(key)
    if (list) list.push(t)
    else groups.set(key, [t])
  }

  const run = d.transaction(() => {
    const previous = d.prepare(`SELECT id FROM thoughts WHERE source = 'profile-summary'`).all() as { id: string }[]
    for (const row of previous) deleteThought(d, row.id)
    const removed = previous.length

    const created: ProfileSummaryGroup[] = []
    for (const [topic, members] of groups) {
      const bullets = members
        .map(m => {
          const text = m.content.replace(/\s+/g, ' ').trim()
          return `- ${text.length > BULLET_MAX ? `${text.slice(0, BULLET_MAX)}…` : text}`
        })
        .join('\n')
      const content =
        `User profile — ${topic}\n` + `Aggregated from ${members.length} profile thought(s).\n\n${bullets}`
      const tags = ['@profile', '@profile-summary']
      if (topic !== 'general') tags.push(`${SUBTAG_PREFIX}${topic}`)
      const summary = createThought(d, {
        content,
        status: 'active',
        source: 'profile-summary',
        is_profile: true,
        tags
      })
      created.push({ topic, thought_id: summary.id, members: members.length })
    }

    setLastSummaryRun(d, new Date().toISOString())
    return { created, removed }
  })

  const { created, removed } = run()
  return { created, removed, stats: getProfileStats(d) }
}

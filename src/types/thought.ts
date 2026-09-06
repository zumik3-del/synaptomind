export type ThoughtStatus = 'draft' | 'active' | 'archived'

const VALID_STATUSES = ['draft', 'active', 'archived'] as const

export function isThoughtStatus(value: string | undefined): value is ThoughtStatus {
  return (VALID_STATUSES as readonly string[]).includes(value ?? '')
}

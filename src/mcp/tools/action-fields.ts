import type { ActionArgs } from './action-tool'

export type ActionFieldMap = Record<string, string[]>

export function allActionFields(fields: ActionFieldMap): ReadonlySet<string> {
  return new Set(Object.values(fields).flat())
}

export function validateActionFields(
  action: string,
  args: ActionArgs,
  fields: ActionFieldMap,
  all: ReadonlySet<string>
): void {
  const allowed = new Set(fields[action] ?? [])
  const irrelevant = Object.keys(args).filter(key => all.has(key) && !allowed.has(key))
  if (irrelevant.length)
    throw new Error(`${irrelevant.join(', ')} is not applicable to ${action} action`)
}

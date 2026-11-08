import type { ActionArgs } from './action-tool'

/**
 * The arguments each action of a multiplexed tool accepts, keyed by action.
 *
 * The advertised input schema is a superset shared by every action (the MCP SDK
 * cannot advertise a discriminated union), so this table is what tells a field
 * meant for a sibling action apart from an accepted one.
 */
export type ActionFieldMap = Record<string, string[]>

/** Every field some action declares: the superset a cross-action check tests against. */
export function allActionFields(fields: ActionFieldMap): ReadonlySet<string> {
  return new Set(Object.values(fields).flat())
}

/**
 * Reject arguments that belong to a different action of the same tool.
 *
 * A key is reported only when some action declares it (`all`) and the called
 * action does not — an unknown or retired key keeps its own handling (the
 * tombstone `z.never` inputs) instead of being reported here.
 */
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

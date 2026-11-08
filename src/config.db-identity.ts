import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'

interface DatabaseIdentity {
  path: string
  inode?: string
}

// Resolve components in filesystem order: normalizing before resolving a symlink
// would give the wrong answer for `symlink/..`. Missing components are allowed,
// but dangling symlinks and all errors other than ENOENT fail closed.
function databaseIdentity(path: string): DatabaseIdentity {
  let resolved = parse(path).root
  for (const component of path.slice(resolved.length).split('/')) {
    if (!component || component === '.') continue
    if (component === '..') {
      resolved = dirname(resolved)
      continue
    }
    const next = join(resolved, component)
    try {
      const entry = lstatSync(next)
      resolved = entry.isSymbolicLink() ? realpathSync(next) : next
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A dangling symlink is not a missing component: it cannot be safely resolved.
      try {
        lstatSync(next)
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') {
          resolved = next
          continue
        }
        throw missing
      }
      throw error
    }
  }
  try {
    const stat = statSync(resolved, { bigint: true })
    return { path: resolved, inode: `${stat.dev}:${stat.ino}` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { path: resolved }
  }
}

// This is a startup snapshot, not a filesystem lock. Operators must prevent
// untrusted changes to database files and parent directories after validation;
// use trusted, non-writable directories and restart after path changes.
export function assertDistinctDatabasePaths(paths: string[]): void {
  const identities: DatabaseIdentity[] = []
  for (const path of paths) {
    let identity: DatabaseIdentity
    try {
      identity = databaseIdentity(path)
    } catch {
      throw new Error('[config] cannot safely resolve user dbPath')
    }
    for (const previous of identities) {
      if (
        identity.path === previous.path ||
        (identity.inode !== undefined && identity.inode === previous.inode)
      ) {
        throw new Error('[config] duplicate user dbPath')
      }
      if (
        identity.path.startsWith(`${previous.path}/`) ||
        previous.path.startsWith(`${identity.path}/`)
      ) {
        throw new Error('[config] overlapping user dbPath')
      }
    }
    identities.push(identity)
  }
}

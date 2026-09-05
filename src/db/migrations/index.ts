import type { Database } from 'bun:sqlite'

import v002 from './v002-vec-thoughts'
import v003 from './v003-projects'
import v004 from './v004-is-cluster'
import v006 from './v006-tags'
import v009 from './v009-pending-embeddings'
import v010 from './v010-pending-embeddings-error'
import v012 from './v012-edges-target-index'
import v013 from './v013-drop-tags-column'
import v014 from './v014-edge-dedup'
import v015 from './v015-indexes'
import v016 from './v016-thought-importance'
import v017 from './v017-drop-search-logs'
import v018 from './v018-primers'
import v019 from './v019-thought-verify'
import v020 from './v020-smart-notes'
import v021 from './v021-is-profile'
import v022 from './v022-slots'
import v023 from './v023-git-commits'
import v025 from './v025-timestamp-normalize'
import v026 from './v026-rebuild-pending-tables'
import v027 from './v027-git-project-columns'
import v028 from './v028-fts5'
import v029 from './v029-thought-url-links'
import v030 from './v030-thought-entities'
import v031 from './v031-thoughts-status-index'
import v032 from './v032-local-path'
import v033 from './v033-content-hash'
import v034 from './v034-remove-git'

export interface Migration {
  version: number
  apply: (db: Database, opts: { isMemory: boolean; dimensions: number }) => void
}

export const MIGRATIONS: Migration[] = [
  v002,
  v003,
  v004,
  v006,
  v009,
  v010,
  v012,
  v013,
  v014,
  v015,
  v016,
  v017,
  v018,
  v019,
  v020,
  v021,
  v022,
  v023,
  v025,
  v026,
  v027,
  v028,
  v029,
  v030,
  v031,
  v032,
  v033,
  v034
].sort((a, b) => a.version - b.version)

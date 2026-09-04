import { readFileSync } from 'fs'
import { resolve } from 'path'

const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../package.json'), 'utf-8')
) as { version: string }

export const VERSION = pkg.version

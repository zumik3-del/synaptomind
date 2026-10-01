// Inlined at build time by the import attribute, so a compiled binary needs no
// package.json on disk: `readFileSync(resolve(import.meta.dir, '../package.json'))`
// resolves into /$bunfs in a `bun build --compile` bundle. ADR 0001 §2.5/§2.6.
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version

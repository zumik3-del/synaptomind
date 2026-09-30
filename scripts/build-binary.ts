/**
 * Compile the self-contained release executable (ADR 0001 §2.1, §3.1 App slice).
 *
 * `bun build --compile` cannot take plugins from the CLI and transformers needs
 * `sharp` aliased to a truthy stub (ADR §7.2), so the build goes through the
 * `Bun.build` JS API. Payload staging (vec0.so, lib/libonnxruntime.so.1, the
 * seed examples, tar) belongs to the release job, not here.
 *
 * Usage: bun run build:binary
 */
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const OUTFILE = join(ROOT, 'dist', 'synaptomind')
const SHARP_STUB = join(import.meta.dir, 'stubs', 'sharp-stub.ts')

mkdirSync(dirname(OUTFILE), { recursive: true })

const result = await Bun.build({
  entrypoints: [join(ROOT, 'src', 'index.ts')],
  plugins: [
    {
      name: 'stub-sharp',
      setup(build) {
        build.onResolve({ filter: /^sharp$/ }, () => ({ path: SHARP_STUB }))
      }
    }
  ],
  compile: { outfile: OUTFILE }
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error(`build failed: ${result.logs.length} error(s)`)
}

const { size } = statSync(OUTFILE)
console.log(`built ${OUTFILE} (${(size / 1024 / 1024).toFixed(1)} MB)`)

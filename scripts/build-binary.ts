/**
 * Compile the self-contained release executable (ADR 0001 §2.1, §3.1 App slice).
 *
 * `bun build --compile` cannot take plugins from the CLI and transformers needs
 * `sharp` aliased to a truthy stub (ADR §7.2), so the build goes through the
 * `Bun.build` JS API. Payload staging (vec0.so, lib/libonnxruntime.so.1, the
 * seed examples, tar) belongs to the release job, not here.
 *
 * `transformersOnnxPlugin` rewrites transformers 4.3+'s dynamic
 * `requireFromHere("onnxruntime-node")` into a static import; without it the
 * artifact's embedder cannot find onnxruntime-node inside the bundle. The build
 * asserts the plugin's `onLoad` actually ran, so a hook Bun never invoked fails
 * here instead of shipping an artifact with a dead embedder.
 *
 * Usage: bun run build:binary
 */
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type TransformersOnnxPlugin, transformersOnnxPlugin } from './transformers-onnx-plugin'

const ROOT = resolve(import.meta.dir, '..')
const OUTFILE = join(ROOT, 'dist', 'synaptomind')
const SHARP_STUB = join(import.meta.dir, 'stubs', 'sharp-stub.ts')
const TRANSFORMERS_NODE_BACKEND = Bun.resolveSync('@huggingface/transformers', ROOT)

mkdirSync(dirname(OUTFILE), { recursive: true })

// Captured from the registration itself: the guard test reads that call out of the `plugins: [`
// block, so it cannot be hoisted into a local first.
let onnxPlugin: TransformersOnnxPlugin | undefined

const result = await Bun.build({
  entrypoints: [join(ROOT, 'src', 'index.ts')],
  plugins: [
    {
      name: 'stub-sharp',
      setup(build) {
        build.onResolve({ filter: /^sharp$/ }, () => ({ path: SHARP_STUB }))
      }
    },
    (onnxPlugin = transformersOnnxPlugin(TRANSFORMERS_NODE_BACKEND))
  ],
  compile: { outfile: OUTFILE }
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error(`build failed: ${result.logs.length} error(s)`)
}

if (!onnxPlugin?.onLoadCount()) {
  throw new Error(
    'Bun never ran the transformers-onnx-static-import onLoad hook for ' +
      `${TRANSFORMERS_NODE_BACKEND}: the artifact still carries ` +
      'requireFromHere("onnxruntime-node"), which cannot resolve from /$bunfs/root/synaptomind, ' +
      'so the embedder child would start dead. Update scripts/transformers-onnx-plugin.ts or ' +
      'pin @huggingface/transformers in package.json.'
  )
}

const { size } = statSync(OUTFILE)
console.log(`built ${OUTFILE} (${(size / 1024 / 1024).toFixed(1)} MB)`)

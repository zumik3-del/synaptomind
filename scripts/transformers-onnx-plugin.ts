/**
 * Build-time remedy for `@huggingface/transformers` 4.3+, which loads its node backend through
 * `createRequire(import.meta.url)` + `requireFromHere("onnxruntime-node")` instead of 4.2.0's
 * `import * as ONNX_NODE from "onnxruntime-node"`.
 *
 * In a compiled artifact `import.meta.url` is `/$bunfs/root/synaptomind`, where no `node_modules`
 * exists, so the runtime CJS lookup throws `Cannot find package 'onnxruntime-node'` and the
 * embedder child dies on import (task #2683). Rewriting that one line into a static import is what
 * makes Bun bundle onnxruntime-node's JS and its `onnxruntime_binding.node` into the executable.
 *
 * The build stays fail-closed twice over: a backend left in any shape this file cannot resolve
 * aborts before compilation, and the caller checks `onLoadCount()` after `Bun.build` so a hook Bun
 * never ran cannot pass as green.
 */
import { readFileSync } from 'node:fs'

const NODE_BACKEND = /[/\\]transformers\.node\.mjs$/
const DYNAMIC_REQUIRE =
  /^(?:var|let|const) ([A-Za-z_$][\w$]*) = requireFromHere\(["']onnxruntime-node["']\);?$/m
const STATIC_IMPORT = /^import \* as [A-Za-z_$][\w$]* from ["']onnxruntime-node["'];?$/m
const RESIDUAL_REQUIRE = /requireFromHere\(\s*['"]onnxruntime-node['"]\s*\)/

/** The plugin plus the evidence that Bun actually routed the node backend through `onLoad`. */
export interface TransformersOnnxPlugin extends Bun.BunPlugin {
  /** `onLoad` invocations so far; 0 after a build means the rewrite never happened. */
  onLoadCount(): number
}

function deadEmbedder(path: string, reason: string): Error {
  return new Error(
    `${path} ${reason}: the compiled binary would start with a dead embedder. Update ` +
      'scripts/transformers-onnx-plugin.ts or pin @huggingface/transformers in package.json.'
  )
}

/** Rewritten source, or null when the backend already uses the static import. */
function rewritable(path: string, source: string): string | null {
  if (STATIC_IMPORT.test(source)) {
    if (RESIDUAL_REQUIRE.test(source)) {
      throw deadEmbedder(
        path,
        'mixes a static import with a requireFromHere("onnxruntime-node") call the rewrite does ' +
          'not model, so the call would survive into the bundle'
      )
    }
    return null
  }
  const dynamic = DYNAMIC_REQUIRE.exec(source)
  if (dynamic) {
    const rewritten = source.replace(
      DYNAMIC_REQUIRE,
      `import * as ${dynamic[1]} from 'onnxruntime-node';`
    )
    if (RESIDUAL_REQUIRE.test(rewritten)) {
      throw deadEmbedder(
        path,
        'still calls requireFromHere("onnxruntime-node") after the rewrite: a second or ' +
          'differently shaped occurrence that String.replace cannot repair in one pass'
      )
    }
    return rewritten
  }
  throw deadEmbedder(
    path,
    'loads onnxruntime-node in no shape this build can repair (neither a dynamic ' +
      'requireFromHere("onnxruntime-node") nor a static import)'
  )
}

/**
 * @param backendPath the installed `dist/transformers.node.mjs`, resolved by the caller. Read
 * eagerly so an unrecognized shape fails the build before anything is compiled.
 */
export function transformersOnnxPlugin(backendPath: string): TransformersOnnxPlugin {
  if (!NODE_BACKEND.test(backendPath)) {
    throw new Error(
      `@huggingface/transformers resolves to ${backendPath}, not its node backend ` +
        '(dist/transformers.node.mjs), so the onnxruntime-node remedy no longer covers what the ' +
        'bundle loads: the compiled binary would start with a dead embedder. Update ' +
        'scripts/transformers-onnx-plugin.ts or pin @huggingface/transformers in package.json.'
    )
  }
  rewritable(backendPath, readFileSync(backendPath, 'utf8'))
  let onLoadRuns = 0
  return {
    name: 'transformers-onnx-static-import',
    onLoadCount: () => onLoadRuns,
    setup(build) {
      build.onLoad({ filter: NODE_BACKEND }, args => {
        onLoadRuns += 1
        const contents = rewritable(args.path, readFileSync(args.path, 'utf8'))
        return contents === null ? undefined : { contents, loader: 'js' }
      })
    }
  }
}

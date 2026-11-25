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
 * A backend matching neither shape aborts the build: a binary that boots with a dead embedder
 * must not be producible.
 */
import { readFileSync } from 'node:fs'

const NODE_BACKEND = /[/\\]transformers\.node\.mjs$/
const DYNAMIC_REQUIRE =
  /^(?:var|let|const) ([A-Za-z_$][\w$]*) = requireFromHere\(["']onnxruntime-node["']\);?$/m
const STATIC_IMPORT = /^import \* as [A-Za-z_$][\w$]* from ["']onnxruntime-node["'];?$/m

/** Rewritten source, or null when the backend already uses the static import. */
function rewritable(path: string, source: string): string | null {
  const dynamic = DYNAMIC_REQUIRE.exec(source)
  if (dynamic) {
    return source.replace(DYNAMIC_REQUIRE, `import * as ${dynamic[1]} from 'onnxruntime-node';`)
  }
  if (STATIC_IMPORT.test(source)) return null
  throw new Error(
    `${path} loads onnxruntime-node in no shape this build can repair (neither a dynamic ` +
      'requireFromHere("onnxruntime-node") nor a static import): the compiled binary would start ' +
      'with a dead embedder. Update scripts/transformers-onnx-plugin.ts or pin ' +
      '@huggingface/transformers in package.json.'
  )
}

/**
 * @param backendPath the installed `dist/transformers.node.mjs`, resolved by the caller. Read
 * eagerly so an unrecognized shape fails the build before anything is compiled.
 */
export function transformersOnnxPlugin(backendPath: string): Bun.BunPlugin {
  if (!NODE_BACKEND.test(backendPath)) {
    throw new Error(
      `@huggingface/transformers resolves to ${backendPath}, not its node backend ` +
        '(dist/transformers.node.mjs), so the onnxruntime-node remedy no longer covers what the ' +
        'bundle loads: the compiled binary would start with a dead embedder. Update ' +
        'scripts/transformers-onnx-plugin.ts or pin @huggingface/transformers in package.json.'
    )
  }
  rewritable(backendPath, readFileSync(backendPath, 'utf8'))
  return {
    name: 'transformers-onnx-static-import',
    setup(build) {
      build.onLoad({ filter: NODE_BACKEND }, args => {
        const contents = rewritable(args.path, readFileSync(args.path, 'utf8'))
        return contents === null ? undefined : { contents, loader: 'js' }
      })
    }
  }
}

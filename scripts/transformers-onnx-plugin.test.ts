import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Regression coverage for #2683: `@huggingface/transformers` 4.3 loads its node
// backend through `createRequire(import.meta.url)`, which cannot resolve inside
// the compiled artifact (`/$bunfs/root/synaptomind`), so 0.26.5 shipped a binary
// whose embedder died on import. The plugin rewrites that one line into a static
// import; these cases drive it against the INSTALLED backend so a dependency
// bump fails here instead of in a 112 MB artifact nobody builds per commit.
//
// Fixtures must be named `.../dist/transformers.node.mjs`: both the onLoad filter
// and the path guard are keyed on that filename.
//
// Gate: this file sits in `scripts/`, so the sharded `bun run test` (which globs
// `src/**/*.test.ts`) does not run it — `bun test` does, i.e. `bun run test:all`
// and CI's blocking "Test: bun test" step.
//
// TRANSFORMERS_ONNX_PLUGIN points the same cases at a deliberately broken copy of
// the plugin — the mutation hook used to prove each case can go red.

const REPO_ROOT = join(import.meta.dir, '..')
const PLUGIN_PATH =
  process.env.TRANSFORMERS_ONNX_PLUGIN ?? join(import.meta.dir, 'transformers-onnx-plugin.ts')
const TRANSFORMERS = '@huggingface/transformers'
const NODE_BACKEND = 'dist/transformers.node.mjs'

const DYNAMIC_REQUIRE =
  /^(?:var|let|const) ([A-Za-z_$][\w$]*) = requireFromHere\(["']onnxruntime-node["']\);?$/m
const STATIC_IMPORT = /^import \* as ([A-Za-z_$][\w$]*) from ["']onnxruntime-node["'];?$/m

type OnLoadResult = { contents: string; loader: string } | undefined
type OnLoadCallback = (args: { path: string }) => OnLoadResult | Promise<OnLoadResult>

interface PluginBuilderLike {
  onLoad(options: { filter: RegExp }, callback: OnLoadCallback): void
}

interface PluginModule {
  transformersOnnxPlugin(backendPath: string): {
    name: string
    setup(build: PluginBuilderLike): void
  }
}

const { transformersOnnxPlugin } = (await import(PLUGIN_PATH)) as unknown as PluginModule

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function installedBackend(): string {
  try {
    return Bun.resolveSync(TRANSFORMERS, REPO_ROOT)
  } catch (error) {
    throw new Error(
      `${TRANSFORMERS} is not installed under ${REPO_ROOT} — run \`bun install\`: ${error}`
    )
  }
}

/** Writes a fixture node backend under `<tmp>/node_modules/@huggingface/transformers/dist/`. */
function writeNodeBackend(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-transformers-'))
  tempDirs.push(dir)
  const path = join(dir, 'node_modules', TRANSFORMERS, NODE_BACKEND)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
  return path
}

/** The hook `setup()` registers, captured through a stand-in builder. */
function captureOnLoad(backendPath: string): { filter: RegExp; load: OnLoadCallback } {
  const plugin = transformersOnnxPlugin(backendPath)
  let captured: { filter: RegExp; load: OnLoadCallback } | undefined
  plugin.setup({
    onLoad(options, callback) {
      captured = { filter: options.filter, load: callback }
    }
  })
  if (!captured) throw new Error(`plugin ${plugin.name} registered no onLoad hook`)
  return captured
}

function thrownBy(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw, got none')
}

describe('installed transformers node backend', () => {
  test('is rewritten into a static onnxruntime-node import the bundle can resolve', async () => {
    const backend = installedBackend()
    const source = readFileSync(backend, 'utf8')
    const { filter, load } = captureOnLoad(backend)
    expect(filter.test(backend)).toBe(true)

    const result = await load({ path: backend })
    if (STATIC_IMPORT.test(source)) {
      expect(result).toBeUndefined()
      return
    }
    const dynamic = DYNAMIC_REQUIRE.exec(source)
    if (!dynamic) {
      throw new Error(
        `${backend} (${TRANSFORMERS}) loads onnxruntime-node in no shape the build can repair: ` +
          'the compiled artifact would start with a dead embedder.'
      )
    }
    if (result === undefined) {
      throw new Error(
        `${backend} (${TRANSFORMERS}) still loads onnxruntime-node through ` +
          `requireFromHere("onnxruntime-node") and the build's onLoad hook returned no ` +
          'replacement: the compiled artifact would start with a dead embedder, because ' +
          'createRequire cannot resolve onnxruntime-node from /$bunfs/root/synaptomind.'
      )
    }
    expect(result.loader).toBe('js')
    expect(result.contents).toContain(`import * as ${dynamic[1]} from 'onnxruntime-node';`)
    expect(result.contents).not.toMatch(/requireFromHere\(\s*["']onnxruntime-node["']\s*\)/)
  })

  test('the onLoad filter covers the node backend and nothing else in dist/', () => {
    const backend = installedBackend()
    const { filter } = captureOnLoad(backend)
    const dist = dirname(backend)
    expect(filter.test(backend)).toBe(true)
    for (const sibling of ['transformers.mjs', 'transformers.web.js', 'transformers.node.cjs']) {
      expect(filter.test(join(dist, sibling))).toBe(false)
    }
  })
})

describe('fixture backends', () => {
  test('a 4.2.0-style static import is left untouched', async () => {
    const backend = writeNodeBackend(
      'import * as ONNX_NODE from "onnxruntime-node";\nexport default ONNX_NODE;\n'
    )
    const { load } = captureOnLoad(backend)
    expect(await load({ path: backend })).toBeUndefined()
  })

  test('an unrecognized onnxruntime-node load shape aborts before compilation', () => {
    const backend = writeNodeBackend('var ort = await import("onnxruntime-node");\n')
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('onnxruntime-node')
    expect(message).toContain('dead embedder')
    expect(message).toContain('@huggingface/transformers')
  })

  test('a renamed onnxruntime-node package aborts instead of shipping', () => {
    const backend = writeNodeBackend('var ort = requireFromHere("onnxruntime-node-mutated");\n')
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('dead embedder')
  })

  test('a backend without any onnxruntime-node reference aborts', () => {
    const backend = writeNodeBackend('export const nothing = 1\n')
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('dead embedder')
  })

  test('refuses a transformers entry that is not the node backend', () => {
    const web = join(dirname(installedBackend()), 'transformers.web.js')
    const { message } = thrownBy(() => transformersOnnxPlugin(web))
    expect(message).toContain('not its node backend')
    expect(message).toContain('dead embedder')
  })
})

describe('build wiring', () => {
  const BUILD = readFileSync(join(import.meta.dir, 'build-binary.ts'), 'utf8')

  test('build-binary.ts registers the plugin against the resolved transformers entry', () => {
    expect(BUILD).toContain('plugins: [')
    const plugins = BUILD.slice(BUILD.indexOf('plugins: ['), BUILD.indexOf('compile:'))
    const call = /transformersOnnxPlugin\(([^()]*)\)/.exec(plugins)
    if (!call) throw new Error('build-binary.ts no longer registers transformersOnnxPlugin')
    const identifier = call[1].trim()
    expect(identifier).toMatch(/^[A-Za-z_$][\w$]*$/)
    const resolved = new RegExp(
      `(?:const|let|var)\\s+${identifier}\\s*=\\s*Bun\\.resolveSync\\(\\s*['"]@huggingface/transformers['"]\\s*,\\s*ROOT\\s*\\)`
    )
    expect(BUILD).toMatch(resolved)
  })
})

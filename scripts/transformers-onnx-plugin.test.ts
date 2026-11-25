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
// #2687 closed the two silent paths this file used to share, and the cases below
// pin them: the build aborts when the plugin's onLoad never runs (proven by
// stubbing `Bun.build`, so no artifact is compiled), and a backend the rewrite
// cannot finish — mixed static + dynamic, or an occurrence `String.replace`
// leaves behind — aborts instead of being skipped. #2690 pins the wrapped callee
// (`(0, requireFromHere)(...)`, and spaced/newline-wrapped variants) the residual
// check now catches, and that a comment merely naming the package still skips.
//
// Fixtures must be named `.../dist/transformers.node.mjs`: both the onLoad filter
// and the path guard are keyed on that filename.
//
// Gate: this file sits in `scripts/`, so the sharded `bun run test` (which globs
// `src/**/*.test.ts`) does not run it — `bun test` does, i.e. `bun run test:all`
// and CI's blocking "Test: bun test" step.
//
// Two mutation hooks, used only to prove a case can go red:
// TRANSFORMERS_ONNX_PLUGIN points the plugin cases at a copy of the plugin (e.g.
// `git show <pre-fix-rev>:scripts/transformers-onnx-plugin.ts > /tmp/pre-fix.ts`),
// BUILD_BINARY_SCRIPT points the build-wiring cases at an edited copy of the build
// script — it must stay in `scripts/` for its relative imports to resolve.

const REPO_ROOT = join(import.meta.dir, '..')
const PLUGIN_PATH =
  process.env.TRANSFORMERS_ONNX_PLUGIN ?? join(import.meta.dir, 'transformers-onnx-plugin.ts')
const BUILD_PATH = process.env.BUILD_BINARY_SCRIPT ?? join(import.meta.dir, 'build-binary.ts')
const TRANSFORMERS = '@huggingface/transformers'
const NODE_BACKEND = 'dist/transformers.node.mjs'

const DYNAMIC_REQUIRE =
  /^(?:var|let|const) ([A-Za-z_$][\w$]*) = requireFromHere\(["']onnxruntime-node["']\);?$/m
const STATIC_IMPORT = /^import \* as ([A-Za-z_$][\w$]*) from ["']onnxruntime-node["'];?$/m
const RESIDUAL_REQUIRE = /requireFromHere\(\s*["']onnxruntime-node["']\s*\)/

/** A backend in the 4.3 shape: one dynamic require the plugin must rewrite. */
const DYNAMIC_BACKEND = 'var ort = requireFromHere("onnxruntime-node");\nexport default ort;\n'
/** A backend in the 4.2 shape: already a static import, nothing to rewrite. */
const STATIC_BACKEND = 'import * as ort from "onnxruntime-node";\nexport default ort;\n'

/** What the stubbed `Bun.build` prints, so a case can prove the stub took over. */
const STUB_MARK = '[guard-test] Bun.build stubbed'

type OnLoadResult = { contents: string; loader: string } | undefined
type OnLoadCallback = (args: { path: string }) => OnLoadResult | Promise<OnLoadResult>

/** The plugin surface this file drives: Bun's plugin contract plus the build guard's counter. */
type Plugin = Bun.BunPlugin & { onLoadCount(): number }

interface PluginModule {
  transformersOnnxPlugin(backendPath: string): Plugin
}

const { transformersOnnxPlugin } = (await import(PLUGIN_PATH)) as unknown as PluginModule

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

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
  const path = join(
    tempDir('synaptomind-transformers-'),
    'node_modules',
    TRANSFORMERS,
    NODE_BACKEND
  )
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
  return path
}

/** The hook `setup()` registers, captured through a stand-in builder. */
function setupHook(plugin: Plugin): { filter: RegExp; load: OnLoadCallback } {
  let captured: { filter: RegExp; load: OnLoadCallback } | undefined
  const builder = {
    onLoad(options: { filter: RegExp }, callback: OnLoadCallback) {
      captured = { filter: options.filter, load: callback }
    }
  } as unknown as Bun.PluginBuilder
  plugin.setup(builder)
  if (!captured) throw new Error(`plugin ${plugin.name} registered no onLoad hook`)
  return captured
}

function captureOnLoad(backendPath: string): { filter: RegExp; load: OnLoadCallback } {
  return setupHook(transformersOnnxPlugin(backendPath))
}

function thrownBy(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw, got none')
}

/**
 * A tmp project a real `Bun.build` can resolve: a stub `onnxruntime-node` package plus a node
 * backend in the 4.3 shape. `importing` pulls the backend in, `plain` pulls nothing.
 */
function writeBuildableProject(): { backend: string; importing: string; plain: string } {
  const root = tempDir('synaptomind-transformers-build-')
  const write = (relative: string, contents: string): string => {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    return path
  }
  const ort = join('node_modules', 'onnxruntime-node')
  write(
    join(ort, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-node', version: '0.0.0', type: 'module', main: 'index.js' })
  )
  write(join(ort, 'index.js'), "export const ORT_SENTINEL = 'ort-sentinel'\n")
  const backend = write(join('node_modules', TRANSFORMERS, NODE_BACKEND), DYNAMIC_BACKEND)
  const specifier = `./${['node_modules', TRANSFORMERS, NODE_BACKEND].join('/')}`
  return {
    backend,
    importing: write('importing.ts', `export { default as ort } from '${specifier}'\n`),
    plain: write('plain.ts', 'export const nothing = 1\n')
  }
}

/** A preload module that replaces `Bun.build` with a no-op, i.e. a build that runs no hook. */
function writeBuildStub(): string {
  const dir = tempDir('synaptomind-transformers-stub-')
  const path = join(dir, 'stub-build.ts')
  writeFileSync(
    path,
    [
      'const stub = (async () => ({ success: true, logs: [], outputs: [] })) as unknown as',
      '  typeof Bun.build',
      'Bun.build = stub',
      "if (Bun.build !== stub) throw new Error('Bun.build stub did not take')",
      `console.error('${STUB_MARK}')`,
      ''
    ].join('\n')
  )
  return path
}

/**
 * `source` with line and block comments blanked out (newlines kept), quoted strings left intact.
 * Regex literals are not modelled — the build script's `plugins: [` block holds only `/^sharp$/`,
 * which survives; a regex containing a quote would need this scanner widened first.
 */
function stripComments(source: string): string {
  let out = ''
  let index = 0
  let quote: string | undefined
  while (index < source.length) {
    const char = source[index]
    if (quote) {
      out += char
      if (char === '\\') {
        out += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      const stop = close === -1 ? source.length : close + 2
      out += source.slice(index, stop).replace(/[^\n]/g, '')
      index = stop
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** The `plugins: [...]` block of the build script with its comments removed. */
function pluginsBlock(source: string): string {
  const code = stripComments(source)
  const start = code.indexOf('plugins: [')
  const end = code.indexOf('compile:', start + 1)
  if (start === -1 || end === -1) {
    throw new Error('build-binary.ts no longer has a `plugins: [...]` block before `compile:`')
  }
  return code.slice(start, end)
}

/**
 * One array element that is exactly `transformersOnnxPlugin(<identifier>)`, optionally assigned to a
 * holder. Anchored to the whole element so a short-circuited call (`false && ...`), a string
 * literal or a comment cannot pass as a registration.
 */
const REGISTRATION =
  /^[ \t]*\(?[ \t]*(?:([A-Za-z_$][\w$]*)[ \t]*=[ \t]*)?transformersOnnxPlugin\([ \t]*([A-Za-z_$][\w$]*)[ \t]*\)[ \t]*\)?[ \t]*,?[ \t]*$/m

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
    expect(result.contents).not.toMatch(RESIDUAL_REQUIRE)
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
    const backend = writeNodeBackend(STATIC_BACKEND)
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

  test('a static backend with comment-only mentions of onnxruntime-node skips cleanly', async () => {
    // The 4.3.2 backend really carries `// onnxruntime-web/onnxruntime-node` (line 120); the 4.2.0
    // shape has the same comment around a static import. Neither comment may look like a residual
    // call, or widening the check to a bare substring would abort a healthy backend.
    const backend = writeNodeBackend(
      [
        'const env = {',
        '  backends: {',
        '    // onnxruntime-web/onnxruntime-node',
        '    onnx: {}',
        '  }',
        '};',
        '// 4.3 reaches onnxruntime-node through requireFromHere; 4.2.0 imports it statically',
        STATIC_BACKEND.trim(),
        ''
      ].join('\n')
    )
    const plugin = transformersOnnxPlugin(backend)
    expect(await setupHook(plugin).load({ path: backend })).toBeUndefined()
    expect(plugin.onLoadCount()).toBe(1)
  })

  test('refuses a transformers entry that is not the node backend', () => {
    const web = join(dirname(installedBackend()), 'transformers.web.js')
    const { message } = thrownBy(() => transformersOnnxPlugin(web))
    expect(message).toContain('not its node backend')
    expect(message).toContain('dead embedder')
  })
})

describe('backends the rewrite cannot finish', () => {
  test('a mixed static import and dynamic require aborts instead of skipping the rewrite', () => {
    const backend = writeNodeBackend(
      `${STATIC_BACKEND}var ort2 = requireFromHere("onnxruntime-node");\n`
    )
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('mixes a static import')
    expect(message).toContain('dead embedder')
  })

  test('a reformatted dynamic call beside a static import aborts too', () => {
    const backend = writeNodeBackend(
      `${STATIC_BACKEND}var ort2 = requireFromHere( "onnxruntime-node" );\n`
    )
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('mixes a static import')
  })

  test('a second occurrence the single rewrite leaves behind aborts', () => {
    const backend = writeNodeBackend(
      `${DYNAMIC_BACKEND}var ort2 = requireFromHere("onnxruntime-node");\n`
    )
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('after the rewrite')
    expect(message).toContain('dead embedder')
  })

  test('a wrapped call beside a static import aborts instead of skipping the rewrite', () => {
    const backend = writeNodeBackend(
      `${STATIC_BACKEND}var ort2 = (0, requireFromHere)("onnxruntime-node");\n`
    )
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('mixes a static import')
    expect(message).toContain('dead embedder')
  })

  test('a spaced and newline-wrapped call beside a static import aborts too', () => {
    const backend = writeNodeBackend(
      `${STATIC_BACKEND}var ort2 = ( 0 , requireFromHere )\n  (\n    'onnxruntime-node'\n  );\n`
    )
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('mixes a static import')
  })

  test('a wrapped second occurrence the single rewrite leaves behind aborts', () => {
    const backend = writeNodeBackend(
      `${DYNAMIC_BACKEND}var ort2 = (0, requireFromHere)("onnxruntime-node");\n`
    )
    const { message } = thrownBy(() => transformersOnnxPlugin(backend))
    expect(message).toContain('after the rewrite')
    expect(message).toContain('dead embedder')
  })
})

describe('onLoad accounting', () => {
  test('counts the hook runs and nothing before the first one', async () => {
    const backend = writeNodeBackend(DYNAMIC_BACKEND)
    const plugin = transformersOnnxPlugin(backend)
    expect(plugin.onLoadCount()).toBe(0)

    await setupHook(plugin).load({ path: backend })
    expect(plugin.onLoadCount()).toBe(1)
  })

  test('a real Bun.build runs the hook once and bundles what the rewrite produced', async () => {
    const project = writeBuildableProject()
    const plugin = transformersOnnxPlugin(project.backend)
    expect(plugin.onLoadCount()).toBe(0)

    const result = await Bun.build({
      entrypoints: [project.importing],
      plugins: [plugin],
      target: 'bun'
    })
    if (!result.success) throw new Error(`fixture build failed: ${result.logs.join('; ')}`)
    expect(plugin.onLoadCount()).toBe(1)

    const output = (await result.outputs[0].text()).toString()
    expect(output).toContain('ort-sentinel')
    expect(output).not.toMatch(RESIDUAL_REQUIRE)
  })

  test('stays at 0 when the build never loads the node backend', async () => {
    const project = writeBuildableProject()
    const plugin = transformersOnnxPlugin(project.backend)

    const result = await Bun.build({
      entrypoints: [project.plain],
      plugins: [plugin],
      target: 'bun'
    })
    expect(result.success).toBe(true)
    expect(plugin.onLoadCount()).toBe(0)
  })
})

describe('compiled build guard', () => {
  test('the build aborts when Bun never routes the node backend through the hook', () => {
    // `build-binary.ts` creates its `dist/` directory before `Bun.build`; the stub stops there, so
    // nothing is compiled and no artifact is written.
    const run = Bun.spawnSync({
      cmd: [process.execPath, '--preload', writeBuildStub(), BUILD_PATH],
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const stderr = run.stderr.toString()
    expect(stderr).toContain(STUB_MARK)
    expect(run.exitCode).toBe(1)
    expect(stderr).toContain('never ran the transformers-onnx-static-import onLoad hook')
  })
})

describe('build wiring', () => {
  const BUILD = readFileSync(BUILD_PATH, 'utf8')

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

  test('a commented-out or neutralised registration is not accepted as wired', () => {
    const registration = REGISTRATION.exec(pluginsBlock(BUILD))
    if (!registration) {
      throw new Error(
        'build-binary.ts has no unconditional `transformersOnnxPlugin(<backend>)` element in its ' +
          '`plugins: [` block: a commented-out, short-circuited or otherwise neutralised ' +
          'registration would let the build compile with a dead embedder'
      )
    }
  })
})

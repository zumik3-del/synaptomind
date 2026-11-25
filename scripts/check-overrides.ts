#!/usr/bin/env bun
// Fails when an `overrides` entry forces a version outside an installed consumer's declared range.
// Renovate reads the manifest, not the consumers: #275 forced fast-uri 4.2.4 under ajv's ^3.0.1.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const ROOT = dirname(import.meta.dir)
const NODE_MODULES = join(ROOT, 'node_modules')
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

type DepField = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'

const DEP_FIELDS: DepField[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
]

interface Override {
  name: string
  forced: string
  scope: string | null
}

interface Declaration {
  consumer: string
  field: DepField
  range: string
  dir: string
}

type Manifest = { name?: string; version?: string } & Partial<
  Record<DepField, Record<string, string>>
>

type Exception = { override: string; consumer: string; reason: string; seen?: boolean }

/**
 * The only sanctioned deviations, each printed as ALLOWED on every run. An entry
 * that no longer matches a violation is reported STALE, so the list cannot rot.
 */
const EXCEPTIONS: Exception[] = [
  {
    override: 'fast-uri',
    consumer: 'ajv',
    reason:
      'verified against ajv 8.20.0: ajv compiles the $ref schemas @commitlint/config-validator loads and the commit-msg hook validates as before (manual check, #275)'
  }
]

const NON_SEMVER: [RegExp, string][] = [
  [/^\*$/, 'wildcard'],
  [/^[xX](?:\.(?:\*|[xX]))*$/, 'wildcard'],
  [/^(?:latest|next|canary|beta|alpha|rc|stable)$/i, 'dist-tag'],
  [/^workspace:/, 'workspace protocol'],
  [/^(?:file|link|portal):/, 'local-path protocol'],
  [/^(?:git\+|git:|github:|gitlab:|bitbucket:)/, 'git protocol'],
  [/^https?:/, 'url'],
  [/^npm:/, 'npm alias'],
  [/^(?:jsr|bun|catalog):/, 'non-npm protocol']
]

function nonSemverReason(value: string): string | null {
  for (const [pattern, reason] of NON_SEMVER) {
    if (pattern.test(value)) return reason
  }
  return null
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
  } catch {
    return null
  }
}

function isDirectory(dir: string, name: string): boolean {
  const full = join(dir, name)
  if (existsSync(full) && statSync(full).isDirectory()) return true
  return false
}

function collectPackages(nodeModules: string, out: string[] = []): string[] {
  if (!existsSync(nodeModules)) return out
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(full, { withFileTypes: true })) {
        if (scoped.name.startsWith('.')) continue
        if (isDirectory(full, scoped.name)) addPackage(join(full, scoped.name), out)
      }
      continue
    }
    if (isDirectory(nodeModules, entry.name)) addPackage(full, out)
  }
  return out
}

function addPackage(dir: string, out: string[]): void {
  if (!existsSync(join(dir, 'package.json'))) return
  out.push(dir)
  collectPackages(join(dir, 'node_modules'), out)
}

/** Flattens both override shapes: `"pkg": "1.2.3"` and `"pkg": { ".": "1.2.3", "sub": "2.0.0" }`. */
function flattenOverrides(section: Record<string, unknown> | undefined): Override[] {
  const flat: Override[] = []
  for (const [name, raw] of Object.entries(section ?? {})) {
    if (typeof raw === 'string') {
      flat.push({ name, forced: raw, scope: null })
      continue
    }
    if (raw === null || typeof raw !== 'object') continue
    for (const [sub, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      if (sub === '.') flat.push({ name, forced: value, scope: null })
      else flat.push({ name: sub, forced: value, scope: name })
    }
  }
  return flat
}

function toRepoPath(dir: string): string {
  return relative(ROOT, dir).split(sep).join('/')
}

function inside(dir: string, parent: string): boolean {
  return dir === parent || dir.startsWith(parent + sep)
}

function evaluates(version: string, range: string): boolean | null {
  try {
    return Bun.semver.satisfies(version, range)
  } catch {
    return null
  }
}

const rootManifest = readManifest(ROOT)
if (!rootManifest) {
  console.error(`ERROR: cannot read ${join(ROOT, 'package.json')}`)
  process.exit(1)
}

if (!existsSync(NODE_MODULES)) {
  console.error('ERROR: node_modules is missing — run `bun install` before this check')
  process.exit(1)
}

const overrides = flattenOverrides(rootManifest.overrides as Record<string, unknown> | undefined)
const watched = new Set(overrides.map(o => o.name))

const declarations = new Map<string, Declaration[]>()
let packageCount = 0
for (const dir of collectPackages(NODE_MODULES)) {
  const manifest = readManifest(dir)
  if (!manifest?.name || !manifest.version) continue
  packageCount++
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (!watched.has(dep) || typeof range !== 'string') continue
      const list = declarations.get(dep) ?? []
      list.push({ consumer: manifest.name, field, range, dir })
      declarations.set(dep, list)
    }
  }
}

const failures: string[] = []
const allowed: string[] = []
const skips: string[] = []
let checked = 0

for (const override of overrides) {
  const forcedReason = nonSemverReason(override.forced)
  if (forcedReason || !EXACT_VERSION.test(override.forced)) {
    skips.push(
      `SKIP ${override.name} ${override.forced} — forced value is not an exact version (${forcedReason ?? 'range'})`
    )
    continue
  }

  const consumers = declarations.get(override.name) ?? []
  let examined = 0
  for (const declaration of consumers) {
    if (override.scope) {
      const scopeDir = join(NODE_MODULES, ...override.scope.split('/'))
      if (!inside(declaration.dir, scopeDir)) continue
    }
    examined++
    const where =
      `${override.name} ${override.forced} > ${declaration.consumer} declares ` +
      `${declaration.range} (${declaration.field}) at ${toRepoPath(declaration.dir)}`
    const rangeReason = nonSemverReason(declaration.range)
    if (rangeReason) {
      skips.push(`SKIP ${where} — range is not semver (${rangeReason})`)
      continue
    }
    // A package's own devDependencies are never installed, so the override is
    // never substituted there and there is no range to honour.
    if (declaration.field === 'devDependencies') {
      skips.push(`SKIP ${where} — devDependencies of an installed package are never installed`)
      continue
    }
    const satisfied = evaluates(override.forced, declaration.range)
    if (satisfied === null) {
      skips.push(`SKIP ${where} — range could not be parsed`)
      continue
    }
    checked++
    const exception = EXCEPTIONS.find(
      e => e.override === override.name && e.consumer === declaration.consumer
    )
    if (satisfied) {
      if (exception) exception.seen = true
      continue
    }
    if (exception) {
      exception.seen = true
      allowed.push(`ALLOWED ${where} — ${exception.reason}`)
      continue
    }
    failures.push(`FAIL ${where}`)
  }

  if (examined === 0) {
    const scope = override.scope ? ` under ${override.scope}` : ''
    skips.push(
      `SKIP ${override.name} ${override.forced} — no installed package${scope} declares it`
    )
  }
}

for (const exception of EXCEPTIONS) {
  if (!exception.seen) {
    console.log(
      `STALE exception ${exception.override} vs ${exception.consumer} — no violation matched it; remove the entry`
    )
  }
}

for (const line of skips.sort()) console.log(line)
for (const line of allowed.sort()) console.log(line)

if (failures.length > 0) {
  for (const line of failures.sort()) console.error(line)
  console.error(
    `${failures.length} override(s) force a version outside a consumer's declared range — ` +
      'widen the override to a range the consumers accept, or add a justified EXCEPTIONS entry'
  )
  process.exit(1)
}

console.log(
  `OK: ${overrides.length} overrides vs ${checked} consumer declarations in ${packageCount} ` +
    `installed packages — ${allowed.length} allowed, ${skips.length} skipped`
)

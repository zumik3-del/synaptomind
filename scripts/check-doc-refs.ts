#!/usr/bin/env bun
/**
 * Doc-reference lint (audit M7).
 *
 * Agent-facing docs and the MCP guide once pointed at `ai-workdir/…`, a
 * gitignored scratch directory (`.gitignore`) that does not exist in a checkout,
 * so every such pointer was dead. Long-form design documents live in the
 * artifacts repository `authelia/artifacts` under `synaptomind/adr/…`.
 *
 * Scans text files under `src/` and `docs/` and exits non-zero when any
 * `ai-workdir/` reference survives. Cheap and offline: no network, no tracker.
 *
 * Run: `bun run lint:docs`
 */
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

process.chdir(dirname(import.meta.dir));

const ROOTS = ["src", "docs"];
const FORBIDDEN = "ai-workdir/";
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".sh",
  ".yml",
  ".yaml",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const offences: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const dot = file.lastIndexOf(".");
    if (dot < 0 || !TEXT_EXTENSIONS.has(file.slice(dot))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(FORBIDDEN)) {
        offences.push(`${file}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
}

if (offences.length > 0) {
  console.error(
    `ERROR: dead "${FORBIDDEN}" reference(s) in ${ROOTS.join(", ")} — design docs live in authelia/artifacts (synaptomind/adr/…):`,
  );
  for (const offence of offences) console.error(`  ${offence}`);
  process.exit(1);
}

console.log(`OK: no "${FORBIDDEN}" references in ${ROOTS.join(", ")}`);

#!/usr/bin/env bun

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

const REPO = "zumik3-del/synaptomind";

process.chdir(dirname(import.meta.dir));

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

// ── Read current package.json version ────────────────────────────────────────
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
if (!version) {
  console.error("ERROR: No \"version\" field in package.json");
  process.exit(1);
}

// ── Gather tags ──────────────────────────────────────────────────────────────
const tags = git("tag --list --sort=creatordate").split("\n").filter(Boolean);

if (tags.length < 1) {
  console.error("ERROR: Need at least 1 tag to generate changelog.");
  process.exit(1);
}

function formatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Build the section for `tag` out of the commits in `range`.
 *
 * No `--first-parent` here on purpose: releases land on the target branch via
 * MERGE COMMITS, so the dev-side commits sit on the merge's SECOND parent and a
 * first-parent walk would silently drop them. `--no-merges` still keeps merge
 * commits themselves out of the listing.
 */
function buildSection(tag: string, range: string): string {
  const output = git(
    `log ${range} --no-merges --pretty=format:'%h|%H|%ad|%s' --date=short`,
  );
  if (!output) return "";

  let section = `\n## ${tag}\n\n`;
  let first = true;

  for (const line of output.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 4) continue;

    const [shortHash, fullHash, date, ...rest] = parts;
    const subject = rest.join("|");

    // Exclude version-bump and changelog-update subjects from listings.
    if (/^(chore|docs):\s*(bump version|update CHANGELOG)/i.test(subject)) continue;

    if (first) {
      section += `> ${formatDate(date)}\n\n`;
      first = false;
    }

    section += `- [\`${shortHash}\`](https://github.com/${REPO}/commit/${fullHash}): ${subject}\n`;
  }

  if (first) return ""; // no meaningful entries
  return section;
}

// ── Read the existing changelog as released history ──────────────────────────
// Released sections are a historical record: they were produced by the subject
// heuristic of their time and cannot be reproduced from today's git state, so
// they are copied over verbatim and never rebuilt. Only the pending (leading)
// section is generated.
const HEADING_RE = /^##[ \t]+/;

/** Split `content` into its preamble and its `## ` sections, in file order. */
function splitSections(content: string): { preamble: string; sections: string[] } {
  const fallback = { preamble: "# Changelog\n", sections: [] as string[] };
  if (!content.length) return fallback;

  const lines = content.split("\n");
  const firstHeading = lines.findIndex((line) => HEADING_RE.test(line));
  if (firstHeading === -1) return fallback;

  const preamble = lines.slice(0, firstHeading).join("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines.slice(firstHeading)) {
    if (HEADING_RE.test(line) && current.length) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) sections.push(current.join("\n"));

  return { preamble, sections };
}

/** Section heading of `section` (its first line), used to identify sections. */
function headingOf(section: string): string {
  return section.split("\n")[0].trim();
}

/**
 * Compare two semver-ish versions (numeric parts first, then the prerelease
 * part, where a version without a prerelease outranks one with it). Enough to
 * tell whether `a` is older than `b`; build metadata is ignored.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, ...pre] = v.replace(/^v/, "").split("-");
    return {
      nums: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre: pre.join("-"),
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

const existing = (() => {
  try {
    return readFileSync("CHANGELOG.md", "utf8");
  } catch {
    return "";
  }
})();

const latestTag = tags[tags.length - 1];
const taggedVersion = latestTag.replace(/^v/, "");
const currentVersionHeading = `## v${version}`;
const compare = compareVersions(version, taggedVersion);
// Only a version AHEAD of the latest tag is pending. A version at or behind it
// is already released: regenerating it would rebuild a published section from a
// range that contains newer commits.
const isPending = compare > 0;

// Refuse to run behind the latest tag: that is the state in which the old
// implementation silently rewrote published history.
if (compare < 0) {
  console.error(
    `ERROR: package.json version ${version} is older than the latest tag ${latestTag}.`,
  );
  console.error(
    "       Release versions only move forward; refusing to regenerate CHANGELOG.md.",
  );
  process.exit(1);
}

// Released sections, newest-first and verbatim.
const { preamble, sections } = splitSections(existing);
const hasCurrentVersionSection = sections.some(
  (section) => headingOf(section) === currentVersionHeading,
);

let md = "# Changelog\n";

if (isPending) {
  // Pending (unreleased) section: the version was bumped but not yet tagged, so
  // the range starts at the latest tag. Any stale section of the same version
  // is dropped — it is about to be regenerated below. With no new commits yet,
  // still show the header so the version appears at the top of the file
  // (release.sh prints it).
  md +=
    buildSection(`v${version}`, `${latestTag}..HEAD`) ||
    `\n${currentVersionHeading}\n\n> (no unreleased commits)\n`;
  md += sections
    .filter((section) => headingOf(section) !== currentVersionHeading)
    .map((section) => `\n${section}`)
    .join("");
} else {
  // The version is already tagged: its section in the file is the released
  // record, copied over untouched (never rebuilt, never duplicated).
  if (!hasCurrentVersionSection) {
    // Released section missing from the file (e.g. a fresh tag): emit the
    // header so the version is not silently absent, but never invent entries.
    md += `\n${currentVersionHeading}\n`;
  }
  md += sections.map((section) => `\n${section}`).join("");
}

// Oldest-tag fallback: with a single tag there is no tag pair to build a range
// from, so emit the initial-release stub unless the file already carries it.
if (tags.length === 1) {
  const oldestTag = tags[0];
  const alreadyPresent = sections.some(
    (section) => section.split("\n")[0].trim() === `## ${oldestTag}`,
  );
  if (!alreadyPresent) {
    const oldestDate = git(`log -1 --format='%ad' --date=short ${oldestTag}`);
    md += `\n## ${oldestTag}\n\n> ${formatDate(oldestDate)}\n\n- Initial release\n`;
  }
}

if (!preamble.includes("# Changelog")) {
  console.warn("WARN: existing CHANGELOG.md has no top-level \"# Changelog\" heading.");
}
/** Report the outcome; `!isPending` means no section was regenerated. */
function report(outcome: string): void {
  console.log(outcome);
  if (!isPending) {
    console.log(`v${version} is already released (tag ${latestTag}); preserved verbatim.`);
  }
}

if (md === existing) {
  report("Changelog unchanged, skipping commit.");
} else {
  writeFileSync("CHANGELOG.md", md);
  report("CHANGELOG.md updated.");
}

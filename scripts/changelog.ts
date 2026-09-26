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
 * Walk commits in range using --first-parent --no-merges so that squash-merged
 * duplicates (the original dev commit + its PR squash on main) collapse into a
 * single entry. This is the right choice because the new release flow lands on
 * main via squash-merge: the first-parent chain follows the merge commit's
 * parent on the target branch (main), skipping the side-branch squashes.
 */
function buildSection(tag: string, range: string): string {
  const output = git(
    `log ${range} --first-parent --no-merges --pretty=format:'%h|%H|%ad|%s' --date=short`,
  );
  if (!output) return "";

  let section = `\n## ${tag}\n\n`;
  const lines = output.split("\n");
  let first = true;

  for (const line of lines) {
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

let md = "# Changelog\n";

// Pending (unreleased) section — emitted whenever the working tree has a
// package.json version that differs from the latest tag (i.e. the version
// has been bumped but not yet tagged). After the tag is pushed, HEAD == tag
// and the versions match again, so the pending section disappears naturally.
const latestTag = tags[tags.length - 1];
const taggedVersion = latestTag.replace(/^v/, "");
const isPending = version !== taggedVersion;
if (isPending) {
  const pending = buildSection(`v${version}`, `${latestTag}..HEAD`);
  if (pending) {
    md += pending;
  } else {
    // No new commits yet — still show the section header so the pending
    // version appears at the top of the file (release.sh prints next steps).
    md += `\n## v${version}\n\n> (no unreleased commits)\n`;
  }
}

// Released sections: walk backwards through consecutive tag pairs.
// Start at tags.length - 1 so the latest tag always gets its own section.
for (let i = tags.length - 1; i >= 0; i--) {
  const tag = tags[i];
  const prevTag = tags[i - 1];
  if (!prevTag) continue; // oldest tag has no predecessor — handled by fallback
  const section = buildSection(tag, `${prevTag}..${tag}`);
  if (section) md += section;
}

// Oldest-tag fallback (only when there is exactly 1 tag).
if (tags.length === 1) {
  const oldestTag = tags[0];
  const oldestDate = git(`log -1 --format='%ad' --date=short ${oldestTag}`);
  md += `\n## ${oldestTag}\n\n> ${formatDate(oldestDate)}\n\n- Initial release\n`;
}

writeFileSync("CHANGELOG.md", md);

const afterPorcelain = git("status --porcelain");
if (!afterPorcelain.length) {
  console.log("Changelog unchanged, skipping commit.");
  process.exit(0);
}

console.log("CHANGELOG.md updated.");

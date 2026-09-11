#!/usr/bin/env bun

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { dirname } from "path";

const REPO = "zumik3-del/synaptomind";

process.chdir(dirname(import.meta.dir));

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

const porcelain = git("status --porcelain");
if (porcelain.length) {
  console.error("\nERROR: Git sandbox has local changes. Please commit before updating changelog.\n");
  process.exit(1);
}

const tags = git("tag --list --sort=creatordate").split("\n");

if (tags.length < 2) {
  console.error("\nERROR: Need at least 2 tags to generate changelog.\n");
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

let md = "# Changelog\n";

for (let i = tags.length - 1; i >= 1; i--) {
  const tag = tags[i];
  const prevTag = tags[i - 1];

  const output = git(
    `log ${prevTag}..${tag} --no-merges --pretty=format:'%h|%H|%ad|%s' --date=short`,
  );
  if (!output) continue;

  let section = `\n## ${tag}\n\n`;
  const lines = output.split("\n");
  let first = true;

  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length < 4) continue;

    const [shortHash, fullHash, date] = parts;
    const subject = parts.slice(3).join("|");

    if (/\b(CHANGELOG|Version)\b/.test(subject)) continue;

    if (first) {
      section += `> ${formatDate(date)}\n\n`;
      first = false;
    }

    section += `- [\`${shortHash}\`](https://github.com/${REPO}/commit/${fullHash}): ${subject}\n`;
  }

  if (first) continue;
  md += section;
}

const oldestTag = tags[0];
const oldestDate = git(`log -1 --format='%ad' --date=short ${oldestTag}`);
md += `\n## ${oldestTag}\n\n> ${formatDate(oldestDate)}\n\n- Initial release\n`;

writeFileSync("CHANGELOG.md", md);

const afterPorcelain = git("status --porcelain");
if (!afterPorcelain.length) {
  console.log("Changelog unchanged, skipping commit.");
  process.exit(0);
}

execSync("git add CHANGELOG.md && git commit --no-verify -m 'docs: update CHANGELOG.md' && git push", {
  stdio: "inherit",
});
console.log("CHANGELOG.md updated and committed.");

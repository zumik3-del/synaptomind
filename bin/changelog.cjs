#!/usr/bin/env node

var fs = require('fs');
var Path = require('path');
var cp = require('child_process');

var repo = 'zumik3-del/synaptomind';
process.chdir(Path.dirname(__dirname));

var porcelain = cp.execSync('git status --porcelain', { encoding: 'utf8' }).trim();
if (porcelain.length) {
	console.error("\nERROR: Git sandbox has local changes. Please commit before updating changelog.\n");
	process.exit(1);
}

// tags are sorted by tag creation time (oldest first); emit sections
// newest -> oldest. version:refname would put a bare "0.6.0" before
// "0.6.0-alpha.0", scattering prereleases around the stable section.
// Chronological ordering also keeps chained ranges disjoint: a commit
// reachable from an older tag never reappears in a newer section.
var tags = cp.execSync('git tag --list --sort=creatordate', { encoding: 'utf8' }).trim().split(/\n/);

var md = '# Changelog\n';

if (tags.length < 2) {
	console.error("\nERROR: Need at least 2 tags to generate changelog.\n");
	process.exit(1);
}

// For tag[i] the commit range is tags[i-1]..tag[i] (commits since the
// previous, older tag). Sections with no commits are skipped entirely.
for (var i = tags.length - 1; i >= 1; i--) {
	var tag = tags[i];
	var prevTag = tags[i - 1];

	var cmd = "git log " + prevTag + ".." + tag + " --no-merges --pretty=format:'%h|%H|%ad|%s' --date=short";
	var output = cp.execSync(cmd, { encoding: 'utf8' }).trim();
	if (!output) continue;

	var section = '\n## ' + tag + '\n\n';
	var lines = output.split('\n');
	var first = true;

	lines.forEach(function(line) {
		var parts = line.split('|');
		if (parts.length < 4) return;
		var shortHash = parts[0];
		var fullHash = parts[1];
		var date = parts[2];
		var subject = parts.slice(3).join('|');

		if (subject.match(/\b(CHANGELOG|Version)\b/)) return;

		if (first) {
			section += '> ' + formatDate(date) + '\n\n';
			first = false;
		}

		section += '- [`' + shortHash + '`](https://github.com/' + repo + '/commit/' + fullHash + '): ' + subject + '\n';
	});

	// skip sections where every commit was filtered out
	if (first) continue;
	md += section;
}

var oldestTag = tags[0];
md += '\n## ' + oldestTag + '\n\n> ' + formatDate(cp.execSync("git log -1 --format='%ad' --date=short " + oldestTag, { encoding: 'utf8' }).trim()) + '\n\n- Initial release\n';

fs.writeFileSync('CHANGELOG.md', md);

porcelain = cp.execSync('git status --porcelain', { encoding: 'utf8' }).trim();
if (!porcelain.length) {
	console.log("Changelog unchanged, skipping commit.");
	process.exit(0);
}

cp.execSync('git add CHANGELOG.md && git commit --no-verify -m "docs: update CHANGELOG.md" && git push', { stdio: 'inherit' });
console.log("CHANGELOG.md updated and committed.");

function formatDate(dateStr) {
	var d = new Date(dateStr + 'T00:00:00');
	var months = ['January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];
	return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

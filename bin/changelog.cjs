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

var tags = cp.execSync('git tag --list --sort=version:refname', { encoding: 'utf8' }).trim().split(/\n/).reverse();

var md = '# Changelog\n';

if (tags.length < 2) {
	console.error("\nERROR: Need at least 2 tags to generate changelog.\n");
	process.exit(1);
}

var lastTag = tags[0];

for (var i = 1; i < tags.length; i++) {
	var tag = tags[i];
	var prevTag = tags[i - 1];

	md += '\n## ' + tag + '\n\n';

	var cmd = "git log " + prevTag + ".." + tag + " --no-merges --pretty=format:'%h|%H|%ad|%s' --date=short";
	var output = cp.execSync(cmd, { encoding: 'utf8' }).trim();
	if (!output) continue;

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
			md += '> ' + formatDate(date) + '\n\n';
			first = false;
		}

		md += '- [`' + shortHash + '`](https://github.com/' + repo + '/commit/' + fullHash + '): ' + subject + '\n';
	});
}

md += '\n## ' + lastTag + '\n\n> ' + formatDate(cp.execSync("git log -1 --format='%ad' --date=short " + lastTag, { encoding: 'utf8' }).trim()) + '\n\n- Initial release\n';

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

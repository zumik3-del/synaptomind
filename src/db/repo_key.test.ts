import { expect, test } from "bun:test";
import { normalizeRepoKey } from "./repo_key";

test("normalizeRepoKey canonicalizes https url variants to one key", () => {
	const variants = [
		"https://github.com/user/repo",
		"https://github.com/user/repo.git",
		"https://github.com/user/repo/",
		"http://github.com/user/repo",
		"HTTPS://GITHUB.COM/USER/REPO.GIT",
	];
	const keys = variants.map(normalizeRepoKey);
	for (const k of keys)
		expect(k).toBe("https://github.com/user/repo");
});

test("normalizeRepoKey handles ssh and scp-style urls", () => {
	expect(normalizeRepoKey("git@github.com:user/repo.git")).toBe(
		"https://github.com/user/repo",
	);
	expect(normalizeRepoKey("github.com:user/repo")).toBe(
		"https://github.com/user/repo",
	);
});

test("normalizeRepoKey forces https scheme and lowercases host/owner/repo", () => {
	expect(normalizeRepoKey("git@GitHub.com:Owner/Repo.git")).toBe(
		"https://github.com/owner/repo",
	);
});

test("normalizeRepoKey handles local paths", () => {
	expect(normalizeRepoKey("/data/wiki/")).toBe("https://local/data/wiki");
	expect(normalizeRepoKey("/data/wiki/.git")).toBe("https://local/data/wiki");
});

test("normalizeRepoKey returns empty for empty input", () => {
	expect(normalizeRepoKey("")).toBe("");
});

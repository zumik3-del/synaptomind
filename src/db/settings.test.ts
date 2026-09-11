import { afterEach, beforeEach, expect, test } from "bun:test";
import { config, DEFAULTS } from "../config";
import { createTestDb } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import { getThoughtLimits, getThoughtLimitsDB, setThoughtLimits } from "./settings";

beforeEach(createTestDb);
afterEach(closeDb);

function writeMeta(key: string, value: string): void {
	getDb()
		.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`)
		.run(key, value);
}

test("getThoughtLimitsDB returns config defaults with derived hard limit", () => {
	expect(getThoughtLimitsDB(getDb())).toEqual({
		softLimit: 600,
		hardLimit: 720,
		hardLimitBufferPercent: 20,
	});
});

test("getThoughtLimits uses the configured soft limit and buffer", () => {
	const { softLimit, hardLimitBufferPercent } = config.thoughts;
	expect(getThoughtLimits()).toEqual({
		softLimit,
		hardLimit: Math.round(softLimit * (1 + hardLimitBufferPercent / 100)),
		hardLimitBufferPercent,
	});
});

test("setThoughtLimits persists a custom percent and derives the hard limit", () => {
	expect(setThoughtLimits(100, 50)).toEqual({
		softLimit: 100,
		hardLimit: 150,
		hardLimitBufferPercent: 50,
	});
	// The values must survive a subsequent read from the same DB.
	expect(getThoughtLimitsDB(getDb())).toEqual({
		softLimit: 100,
		hardLimit: 150,
		hardLimitBufferPercent: 50,
	});
});

test("derived hard limit rounds to the nearest integer", () => {
	// 33 * 1.1 = 36.3 -> 36 (round down)
	expect(setThoughtLimits(33, 10).hardLimit).toBe(36);
	// 10 * 1.05 = 10.5 -> 11 (half rounds up)
	expect(setThoughtLimits(10, 5).hardLimit).toBe(11);
});

test("falls back to config default for malformed or non-positive soft limit meta", () => {
	const { softLimit, hardLimitBufferPercent } = config.thoughts;
	const expectedHard = Math.round(softLimit * (1 + hardLimitBufferPercent / 100));
	for (const bad of ["abc", "", "NaN", "0", "-5"]) {
		writeMeta("thought_soft_limit", bad);
		expect(getThoughtLimitsDB(getDb())).toEqual({
			softLimit,
			hardLimit: expectedHard,
			hardLimitBufferPercent,
		});
	}
});

test("falls back to config default for malformed or non-positive buffer percent meta", () => {
	const { softLimit, hardLimitBufferPercent } = config.thoughts;
	const expectedHard = Math.round(softLimit * (1 + hardLimitBufferPercent / 100));
	for (const bad of ["abc", "", "NaN", "0", "-20"]) {
		writeMeta("thought_hard_limit_buffer_percent", bad);
		expect(getThoughtLimitsDB(getDb())).toEqual({
			softLimit,
			hardLimit: expectedHard,
			hardLimitBufferPercent,
		});
	}
});

test("never produces a NaN hard limit when both meta values are invalid", () => {
	writeMeta("thought_soft_limit", "not-a-number");
	writeMeta("thought_hard_limit_buffer_percent", "also-bad");

	const limits = getThoughtLimitsDB(getDb());
	expect(Number.isNaN(limits.hardLimit)).toBe(false);
	expect(limits).toEqual({
		softLimit: config.thoughts.softLimit,
		hardLimit: Math.round(
			config.thoughts.softLimit * (1 + config.thoughts.hardLimitBufferPercent / 100),
		),
		hardLimitBufferPercent: config.thoughts.hardLimitBufferPercent,
	});
});

test("migrates a legacy absolute hard limit into an equivalent buffer percent", () => {
	writeMeta("thought_soft_limit", "500");
	writeMeta("thought_hard_limit", "1000");
	expect(getThoughtLimitsDB(getDb())).toEqual({
		softLimit: 500,
		hardLimit: 1000,
		hardLimitBufferPercent: 100,
	});
});

test("legacy hard-limit migration rounds the buffer up so the ceiling never drops", () => {
	writeMeta("thought_soft_limit", "700");
	writeMeta("thought_hard_limit", "800");
	const limits = getThoughtLimitsDB(getDb());
	expect(limits.hardLimitBufferPercent).toBe(15);
	expect(limits.hardLimit).toBe(805);
	expect(limits.hardLimit).toBeGreaterThanOrEqual(800);
});

test("ignores a legacy hard limit that does not exceed the soft limit", () => {
	writeMeta("thought_soft_limit", "500");
	writeMeta("thought_hard_limit", "400");
	expect(getThoughtLimitsDB(getDb())).toEqual({
		softLimit: 500,
		hardLimit: 600,
		hardLimitBufferPercent: 20,
	});
});

test("a stored buffer percent takes precedence over the legacy hard limit", () => {
	writeMeta("thought_soft_limit", "500");
	writeMeta("thought_hard_limit", "1000");
	writeMeta("thought_hard_limit_buffer_percent", "30");
	expect(getThoughtLimitsDB(getDb())).toEqual({
		softLimit: 500,
		hardLimit: 650,
		hardLimitBufferPercent: 30,
	});
});

test("invalid configured soft limit and buffer fall back to defaults", () => {
	const originalSoft = config.thoughts.softLimit;
	const originalBuffer = config.thoughts.hardLimitBufferPercent;
	try {
		config.thoughts.softLimit = 0;
		config.thoughts.hardLimitBufferPercent = -5;
		expect(getThoughtLimitsDB(getDb())).toEqual({
			softLimit: DEFAULTS.thoughts.softLimit,
			hardLimit: Math.round(
				DEFAULTS.thoughts.softLimit * (1 + DEFAULTS.thoughts.hardLimitBufferPercent / 100),
			),
			hardLimitBufferPercent: DEFAULTS.thoughts.hardLimitBufferPercent,
		});
	} finally {
		config.thoughts.softLimit = originalSoft;
		config.thoughts.hardLimitBufferPercent = originalBuffer;
	}
});

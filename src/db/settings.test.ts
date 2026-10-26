import { afterEach, beforeEach, expect, test } from "bun:test";
import { config, DEFAULTS } from "../config";
import { createTestDb } from "../test/helpers";
import { getDb } from "./container";
import { closeDb } from "./init";
import { getThoughtLimits, getThoughtLimitsDB } from "./settings";

beforeEach(createTestDb);
afterEach(closeDb);

function writeMeta(key: string, value: string): void {
	getDb()
		.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`)
		.run(key, value);
}

function configuredLimits(): { softLimit: number; hardLimit: number; hardLimitBufferPercent: number } {
	const { softLimit, hardLimitBufferPercent } = config.thoughts;
	return {
		softLimit,
		hardLimit: Math.round(softLimit * (1 + hardLimitBufferPercent / 100)),
		hardLimitBufferPercent,
	};
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
	expect(getThoughtLimits(getDb())).toEqual({
		softLimit,
		hardLimit: Math.round(softLimit * (1 + hardLimitBufferPercent / 100)),
		hardLimitBufferPercent,
	});
});

test("derived hard limit rounds to the nearest integer", () => {
	const { softLimit: originalSoft, hardLimitBufferPercent: originalBuffer } = config.thoughts;
	try {
		// 33 * 1.1 = 36.3 -> 36 (round down)
		config.thoughts.softLimit = 33;
		config.thoughts.hardLimitBufferPercent = 10;
		expect(getThoughtLimitsDB(getDb()).hardLimit).toBe(36);
		// 10 * 1.05 = 10.5 -> 11 (half rounds up)
		config.thoughts.softLimit = 10;
		config.thoughts.hardLimitBufferPercent = 5;
		expect(getThoughtLimitsDB(getDb()).hardLimit).toBe(11);
	} finally {
		config.thoughts.softLimit = originalSoft;
		config.thoughts.hardLimitBufferPercent = originalBuffer;
	}
});

// The `_meta` runtime overrides (`thought_soft_limit`,
// `thought_hard_limit_buffer_percent` and the legacy absolute
// `thought_hard_limit`) had no production writer; task #2201 removed the
// resolution branch, so a stored value must be inert.
test("stored _meta limit values are ignored — config is the only source", () => {
	writeMeta("thought_soft_limit", "100");
	writeMeta("thought_hard_limit_buffer_percent", "50");
	writeMeta("thought_hard_limit", "5000");

	expect(getThoughtLimitsDB(getDb())).toEqual(configuredLimits());
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

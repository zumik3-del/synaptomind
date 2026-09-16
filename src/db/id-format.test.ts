import { describe, expect, test } from "bun:test";

/**
 * Verifies that Bun.randomUUIDv7() produces valid time-ordered v7 UUIDs.
 *
 * Background: the codebase migrated from the `uuid` package (v7) to native
 * `Bun.randomUUIDv7()`. These assertions capture the shape and monotonicity
 * the rest of the suite depends on — without them, a silent downgrade to
 * crypto.randomUUID() (v4) would go undetected.
 */
describe("Bun.randomUUIDv7 shape + monotonicity", () => {
	test("produces 36-char strings", () => {
		const id = Bun.randomUUIDv7();
		expect(id).toBeTypeOf("string");
		expect(id.length).toBe(36);
	});

	test("matches v7 UUID regex", () => {
		// v7: version digit at pos 14 is '7', variant bits at pos 19 are 10xx (8/B/C/D)
		const v7Re = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		for (let i = 0; i < 20; i++) {
			const id = Bun.randomUUIDv7();
			expect(id, `iteration ${i}`).toMatch(v7Re);
		}
	});

	test("is monotonically increasing across rapid calls", () => {
		const ids = Array.from({ length: 50 }, () => Bun.randomUUIDv7());
		for (let i = 1; i < ids.length; i++) {
			expect(ids[i]! > ids[i - 1]!, `ids[${i}] > ids[${i - 1}]`).toBe(true);
		}
	});

	test("is lexicographically comparable (time-first layout)", () => {
		// v7 layout: unix_ts_ms (36 bits) | rand_a (12 bits) | rand_b (62 bits)
		// Lexicographic order == temporal order for same-version UUIDs.
		const ids = Array.from({ length: 10 }, () => Bun.randomUUIDv7());
		const sorted = [...ids].sort();
		expect(ids).toEqual(sorted);
	});
});

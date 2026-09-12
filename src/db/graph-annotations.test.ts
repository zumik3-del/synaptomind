import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, seedEdge, seedThought } from "../test/helpers";
import { getDb } from "./container";
import { createEdge } from "./edges";
import { annotateGraphStanding } from "./graph-annotations";
import { closeDb } from "./init";

beforeEach(createTestDb);
afterEach(closeDb);

describe("annotateGraphStanding", () => {
	test("returns an empty map when no ids are requested", () => {
		expect(annotateGraphStanding(getDb(), []).size).toBe(0);
	});

	test("defaults every requested id to current with empty arrays", () => {
		const a = seedThought({ content: "plain thought" });
		const map = annotateGraphStanding(getDb(), [a, "missing-id"]);
		expect(map.get(a)).toEqual({
			standing: "current",
			superseded_by: [],
			contradicted_by: [],
		});
		expect(map.get("missing-id")).toEqual({
			standing: "current",
			superseded_by: [],
			contradicted_by: [],
		});
	});

	test("marks the target of a replaces edge as superseded, not the source", () => {
		const oldThought = seedThought({ content: "v1" });
		const newThought = seedThought({ content: "v2" });
		createEdge(getDb(), newThought, oldThought, "replaces");

		const map = annotateGraphStanding(getDb(), [oldThought, newThought]);
		expect(map.get(oldThought)!.standing).toBe("superseded");
		expect(map.get(oldThought)!.superseded_by).toEqual([newThought]);
		expect(map.get(oldThought)!.contradicted_by).toEqual([]);
		expect(map.get(newThought)!.standing).toBe("current");
	});

	test("marks both endpoints of a contradicts edge as contradicted", () => {
		const a = seedThought({ content: "claim a" });
		const b = seedThought({ content: "claim b" });
		createEdge(getDb(), a, b, "contradicts");

		const map = annotateGraphStanding(getDb(), [a, b]);
		expect(map.get(a)!.standing).toBe("contradicted");
		expect(map.get(a)!.contradicted_by).toEqual([b]);
		expect(map.get(b)!.standing).toBe("contradicted");
		expect(map.get(b)!.contradicted_by).toEqual([a]);
	});

	test("superseded wins over contradicted while both lists stay populated", () => {
		const a = seedThought({ content: "old and contested" });
		const b = seedThought({ content: "replacement" });
		const c = seedThought({ content: "rival claim" });
		// b replaces a; a contradicts c (different pairs, so both edges coexist)
		createEdge(getDb(), b, a, "replaces");
		createEdge(getDb(), a, c, "contradicts");

		const info = annotateGraphStanding(getDb(), [a]).get(a)!;
		expect(info.standing).toBe("superseded");
		expect(info.superseded_by).toEqual([b]);
		expect(info.contradicted_by).toEqual([c]);
	});

	test("ignores a corrupt contradicts self-loop row", () => {
		const a = seedThought({ content: "self conflict" });
		seedEdge(a, a, "contradicts"); // raw insert bypasses createEdge's self-loop ban
		const info = annotateGraphStanding(getDb(), [a]).get(a)!;
		expect(info.standing).toBe("current");
		expect(info.contradicted_by).toEqual([]);
	});

	test("runs a constant number of queries regardless of id count (no N+1)", () => {
		const db = getDb();
		const ids = Array.from({ length: 25 }, (_, i) =>
			seedThought({ content: `bulk thought ${i}` }),
		);

		let prepareCalls = 0;
		const counting = new Proxy(db, {
			get(target, prop) {
				if (prop === "prepare") {
					return (...args: unknown[]) => {
						prepareCalls++;
						return (target.prepare as (...a: unknown[]) => unknown)(...args);
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Database;

		const map = annotateGraphStanding(counting, ids);
		expect(map.size).toBe(ids.length);
		// one query for incoming `replaces`, one for `contradicts` (either direction)
		expect(prepareCalls).toBe(2);
	});
});

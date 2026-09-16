import { describe, expect, test } from "bun:test";
import { ValidationError, EmbedderNotReadyError, EmbedderOverloadedError, NotFoundError } from "../errors";
import { errorHandler } from "./error-handler";

function makeContext() {
	const req = new Request("http://localhost/");
	const c = {
		req,
		json: (body: unknown, status?: number) => {
			const resp = new Response(JSON.stringify(body), {
				status: status ?? 200,
				headers: { "content-type": "application/json" },
			});
			return resp;
		},
	} as unknown as import("hono").Context;
	return c;
}

describe("errorHandler", () => {
	test("EmbedderNotReadyError maps to 503 with search-unavailable body", () => {
		const c = makeContext();
		const res = errorHandler(new EmbedderNotReadyError(), c) as Response;
		expect(res.status).toBe(503);
		return res.json().then((body) => {
			expect(body).toEqual({ error: "Search unavailable: model is still loading." });
		});
	});

	test("EmbedderOverloadedError maps to 503 via statusCode", () => {
		const c = makeContext();
		const res = errorHandler(new EmbedderOverloadedError(), c) as Response;
		expect(res.status).toBe(503);
		return res.json().then((body) => {
			expect(body).toEqual({ error: "Embedder is overloaded; try again later" });
		});
	});

	test("NotFoundError maps to 404 with message body", () => {
		const c = makeContext();
		const res = errorHandler(new NotFoundError("missing"), c) as Response;
		expect(res.status).toBe(404);
		return res.json().then((body) => {
			expect(body).toEqual({ error: "missing" });
		});
	});

	test("ValidationError maps to 400 with message body", () => {
		const c = makeContext();
		const res = errorHandler(new ValidationError("bad input"), c) as Response;
		expect(res.status).toBe(400);
		return res.json().then((body) => {
			expect(body).toEqual({ error: "bad input" });
		});
	});

	test("plain Error maps to 500 with generic body", () => {
		const c = makeContext();
		const res = errorHandler(new Error("boom"), c) as Response;
		expect(res.status).toBe(500);
		return res.json().then((body) => {
			expect(body).toEqual({ error: "Internal server error" });
		});
	});
});

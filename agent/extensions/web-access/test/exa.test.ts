import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { fetchExaContents, searchExa } from "../exa.ts";

const originalKey = process.env.EXA_API_KEY;
const SearchRequestBody = Schema.Struct({
	numResults: Schema.Finite,
	includeDomains: Schema.Array(Schema.String),
	excludeDomains: Schema.Array(Schema.String),
	startPublishedDate: Schema.String,
	contents: Schema.Struct({
		text: Schema.Struct({ maxCharacters: Schema.Finite }),
	}),
});

function runWithFetch<A, E>(
	effect: Effect.Effect<A, E>,
	fetch: typeof globalThis.fetch,
): Promise<A> {
	return Effect.runPromise(
		effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
	);
}

beforeEach(() => {
	process.env.EXA_API_KEY = "test-exa-key";
});

afterEach(() => {
	if (originalKey === undefined) delete process.env.EXA_API_KEY;
	else process.env.EXA_API_KEY = originalKey;
});

test("default search uses Exa answer with citations", async () => {
	let request: { url: string; init: RequestInit } | undefined;
	const result = await runWithFetch(
		searchExa("a focused question"),
		async (url, init = {}) => {
			request = { url: String(url), init };
			return Response.json({
				answer: "Grounded answer",
				citations: [{ title: "Example", url: "https://example.com" }],
			});
		},
	);

	assert.ok(request);
	assert.equal(request.url, "https://api.exa.ai/answer");
	assert.equal(
		new Headers(request.init.headers).get("x-api-key"),
		"test-exa-key",
	);
	if (typeof request.init.body !== "string") {
		throw new Error("Expected a JSON request body");
	}
	assert.deepEqual(
		Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(request.init.body),
		{
			query: "a focused question",
			text: true,
		},
	);
	assert.equal(result.answer, "Grounded answer");
	assert.deepEqual(result.sources, [
		{ title: "Example", url: "https://example.com", snippet: "" },
	]);
});

test("an explicit result count uses Exa search even when it is five", async () => {
	let endpoint: string | undefined;
	await runWithFetch(searchExa("query", { numResults: 5 }), async (url) => {
		endpoint = String(url);
		return Response.json({ results: [] });
	});
	assert.equal(endpoint, "https://api.exa.ai/search");
});

test("filtered search uses Exa search and bounds inline content", async () => {
	let body: typeof SearchRequestBody.Type | undefined;
	const result = await runWithFetch(
		searchExa("query", {
			numResults: 7,
			includeContent: true,
			recencyFilter: "week",
			domainFilter: ["example.com", "-ads.example.com"],
		}).pipe(Effect.provide(TestClock.layer())),
		async (_url, init) => {
			if (typeof init?.body !== "string") {
				throw new Error("Expected a JSON request body");
			}
			body = Schema.decodeUnknownSync(Schema.fromJsonString(SearchRequestBody))(
				init.body,
			);
			return Response.json({
				results: [
					{
						title: "Result",
						url: "https://example.com/result",
						highlights: ["Relevant evidence"],
						text: "x".repeat(25_000),
					},
				],
			});
		},
	);

	assert.ok(body);
	assert.equal(body.numResults, 7);
	assert.deepEqual(body.includeDomains, ["example.com"]);
	assert.deepEqual(body.excludeDomains, ["ads.example.com"]);
	assert.equal(body.startPublishedDate, "1969-12-25T00:00:00.000Z");
	assert.deepEqual(body.contents.text, { maxCharacters: 20_000 });
	assert.match(result.answer, /Relevant evidence/);
	assert.equal(result.content[0].content.length, 20_000);
});

test("contents preserves per-URL failures", async () => {
	const result = await runWithFetch(
		fetchExaContents(["https://bad.example", "https://good.example"]),
		async () =>
			Response.json({
				results: [
					{
						title: "Good",
						url: "https://good.example",
						text: "Readable content",
					},
				],
				statuses: [
					{
						id: "https://bad.example",
						status: "error",
						error: { tag: "SOURCE_NOT_AVAILABLE" },
					},
				],
			}),
	);

	assert.equal(result[0].error, "SOURCE_NOT_AVAILABLE");
	assert.equal(result[1].content, "Readable content");
	assert.equal(result[1].error, null);
});

test("Effect interruption aborts an in-flight Exa request", async () => {
	let requestSignal: AbortSignal | null | undefined;
	let started: (() => void) | undefined;
	const requestStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		requestSignal = init?.signal;
		started?.();
		return new Promise<Response>(() => {});
	};

	const controller = new AbortController();
	const pending = Effect.runPromise(
		searchExa("query").pipe(
			Effect.provideService(FetchHttpClient.Fetch, fetch),
		),
		{ signal: controller.signal },
	);
	await requestStarted;
	controller.abort();

	await assert.rejects(pending);
	assert.equal(requestSignal?.aborted, true);
});

test("missing Exa key fails clearly", async () => {
	delete process.env.EXA_API_KEY;
	await assert.rejects(
		() =>
			runWithFetch(searchExa("query"), async () =>
				Response.json({ answer: "unused" }),
			),
		/EXA_API_KEY is required/,
	);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { fetchExaContents, searchExa } from "../exa.ts";

const testConfig = ConfigProvider.fromUnknown({ EXA_API_KEY: "test-exa-key" });
const SearchRequestBody = Schema.Struct({
	numResults: Schema.Finite,
	includeDomains: Schema.Array(Schema.String),
	excludeDomains: Schema.Array(Schema.String),
	startPublishedDate: Schema.String,
	contents: Schema.Struct({
		text: Schema.Struct({ maxCharacters: Schema.Finite }),
	}),
});

const run = <A, E>(effect: Effect.Effect<A, E>, provider = testConfig) =>
	Effect.runPromise(
		Effect.provideService(effect, ConfigProvider.ConfigProvider, provider),
	);

function withFetch<A, E>(
	effect: Effect.Effect<A, E>,
	fetch: typeof globalThis.fetch,
): Effect.Effect<A, E> {
	return effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
}

test("default search uses Exa answer with citations", () =>
	run(
		Effect.gen(function* () {
			let request: { url: string; init: RequestInit } | undefined;
			const result = yield* withFetch(
				searchExa("a focused question"),
				(url, init = {}) => {
					request = { url: String(url), init };
					return Promise.resolve(
						Response.json({
							answer: "Grounded answer",
							citations: [{ title: "Example", url: "https://example.com" }],
						}),
					);
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
				yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
					request.init.body,
				),
				{ query: "a focused question", text: true },
			);
			assert.equal(result.answer, "Grounded answer");
			assert.deepEqual(result.sources, [
				{ title: "Example", url: "https://example.com", snippet: "" },
			]);
		}),
	));

test("an explicit result count uses Exa search even when it is five", () =>
	run(
		Effect.gen(function* () {
			let endpoint: string | undefined;
			yield* withFetch(searchExa("query", { numResults: 5 }), (url) => {
				endpoint = String(url);
				return Promise.resolve(Response.json({ results: [] }));
			});
			assert.equal(endpoint, "https://api.exa.ai/search");
		}),
	));

test("filtered search uses Exa search and bounds inline content", () =>
	run(
		Effect.gen(function* () {
			let body: typeof SearchRequestBody.Type | undefined;
			const result = yield* withFetch(
				searchExa("query", {
					numResults: 7,
					includeContent: true,
					recencyFilter: "week",
					domainFilter: ["example.com", "-ads.example.com"],
				}).pipe(Effect.provide(TestClock.layer())),
				(_url, init) => {
					if (typeof init?.body !== "string") {
						throw new Error("Expected a JSON request body");
					}
					body = Schema.decodeUnknownSync(
						Schema.fromJsonString(SearchRequestBody),
					)(init.body);
					return Promise.resolve(
						Response.json({
							results: [
								{
									title: "Result",
									url: "https://example.com/result",
									highlights: ["Relevant evidence"],
									text: "x".repeat(25_000),
								},
							],
						}),
					);
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
		}),
	));

test("contents preserves per-URL failures", () =>
	run(
		Effect.gen(function* () {
			const result = yield* withFetch(
				fetchExaContents(["https://bad.example", "https://good.example"]),
				() =>
					Promise.resolve(
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
					),
			);

			assert.equal(result[0].error, "SOURCE_NOT_AVAILABLE");
			assert.equal(result[1].content, "Readable content");
			assert.equal(result[1].error, null);
		}),
	));

test("Effect interruption aborts an in-flight Exa request", () =>
	run(
		Effect.gen(function* () {
			let requestSignal: AbortSignal | null | undefined;
			const requestStarted = yield* Deferred.make<void>();
			const fetch: typeof globalThis.fetch = (_url, init) => {
				requestSignal = init?.signal;
				Deferred.doneUnsafe(requestStarted, Effect.void);
				return Promise.withResolvers<Response>().promise;
			};

			const fiber = yield* Effect.forkChild(
				withFetch(searchExa("query"), fetch),
			);
			yield* Deferred.await(requestStarted);
			yield* Fiber.interrupt(fiber);
			assert.equal(requestSignal?.aborted, true);
		}),
	));

test("missing Exa key fails clearly", () =>
	run(
		Effect.gen(function* () {
			const error = yield* withFetch(searchExa("query"), () =>
				Promise.resolve(Response.json({ answer: "unused" })),
			).pipe(Effect.flip);
			assert.match(String(error), /EXA_API_KEY is required/);
		}),
		ConfigProvider.fromUnknown({}),
	));

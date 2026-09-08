import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { usageView } from "./usage-fixture.ts";

for (const missing of [false, true]) {
	test(`footer and session_usage retain free delegate tokens with ${missing ? "missing input" : "reported zero cost"}`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const parent = SessionManager.inMemory(process.cwd());
				parent.appendMessage({
					role: "assistant",
					content: [],
					stopReason: "stop",
					api: "test",
					provider: "test",
					model: "test",
					timestamp: 1,
					usage: {
						input: 10,
						output: 5,
						cacheRead: 30,
						cacheWrite: 0,
						totalTokens: 45,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				});
				const view = usageView(parent, () => ({
					input: missing ? null : 100,
					output: 50,
					cacheRead: 200,
					cacheWrite: 0,
					totalTokens: 350,
					cost: 0,
				}));
				const result = yield* Effect.promise(view.query);
				assert.deepEqual(result.details, {
					parent: {
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 30,
						cacheWriteTokens: 0,
						totalTokens: 45,
						usd: 0,
					},
					delegates: {
						inputTokens: missing ? null : 100,
						outputTokens: 50,
						cacheReadTokens: 200,
						cacheWriteTokens: 0,
						totalTokens: 350,
						usd: 0,
					},
					total: {
						inputTokens: missing ? null : 110,
						outputTokens: 55,
						cacheReadTokens: 230,
						cacheWriteTokens: 0,
						totalTokens: 395,
						usd: 0,
					},
				});
				assert.equal(
					stripVTControlCharacters(view.render())
						.split("\n")[1]
						?.split(" · ")[0],
					"USD 0.000",
				);
				assert.match(view.render(), /10\.0%\/1\.0k/);
				assert.equal(parent.getEntries().length, 1);
				view.dispose();
			}),
		));
}

test("unknown delegate cost stays unavailable in footer and session_usage", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const parent = SessionManager.inMemory(process.cwd());
			parent.appendMessage({
				role: "assistant",
				content: [],
				stopReason: "stop",
				api: "test",
				provider: "test",
				model: "test",
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const view = usageView(
				parent,
				() => ({
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: null,
				}),
				"kimi-coding",
			);
			const result = yield* Effect.promise(view.query);
			assert.deepEqual(result.details, {
				parent: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 0,
					usd: 0,
				},
				delegates: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 15,
					usd: null,
				},
				total: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 15,
					usd: null,
				},
			});
			assert.equal(
				stripVTControlCharacters(view.render()).split("\n")[1]?.split(" · ")[0],
				"USD ? (sub)",
			);
			assert.doesNotMatch(view.render(), /\$0/);
			view.dispose();
		}),
	));

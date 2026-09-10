import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { sessionReportedUsage } from "../accounting.ts";
import { usageView } from "./usage-fixture.ts";

function sessionWithUsage(cost: number) {
	const session = SessionManager.inMemory(process.cwd());
	session.appendMessage({
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
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
	});
	return session;
}

test("footer and session_usage report only session usage", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const session = sessionWithUsage(0.1236);
			const view = usageView(session);
			const result = yield* Effect.promise(view.query);
			assert.deepEqual(result.details, {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 30,
				cacheWriteTokens: 0,
				totalTokens: 45,
				usd: 0.124,
			});
			assert.equal(
				result.content.find((part) => part.type === "text")?.text,
				'{"inputTokens":10,"outputTokens":5,"cacheReadTokens":30,"cacheWriteTokens":0,"totalTokens":45,"usd":0.124}',
			);
			assert.equal(
				stripVTControlCharacters(view.render()).split("\n")[1]?.split(" · ")[0],
				"USD 0.124",
			);
			assert.match(view.render(), /10\.0%\/1\.0k/);
			view.dispose();
		}),
	));

test("missing session usage remains unavailable", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const session = SessionManager.inMemory(process.cwd());
			const view = usageView(session, "kimi-coding");
			const result = yield* Effect.promise(view.query);
			assert.deepEqual(result.details, {
				inputTokens: null,
				outputTokens: null,
				cacheReadTokens: null,
				cacheWriteTokens: null,
				totalTokens: null,
				usd: null,
			});
			assert.match(view.render(), /USD \? \(sub\)/);
			assert.doesNotMatch(view.render(), /\$0/);
			view.dispose();
		}),
	));

test("preserves zero usage and invalidates only malformed fields", () => {
	assert.equal(sessionReportedUsage(sessionWithUsage(0).getEntries()).cost, 0);
	const session = SessionManager.inMemory(process.cwd());
	session.appendMessage({
		role: "assistant",
		content: [],
		stopReason: "stop",
		api: "test",
		provider: "test",
		model: "test",
		timestamp: 1,
		usage: {
			input: Number.NaN,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	assert.deepEqual(sessionReportedUsage(session.getEntries()), {
		input: null,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	});
});

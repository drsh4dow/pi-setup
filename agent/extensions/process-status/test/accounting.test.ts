import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { sessionReportedUsage } from "../accounting.ts";
import { querySessionUsage } from "./session-usage-fixture.ts";

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

test("session_usage reports only session usage", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const result = yield* Effect.promise(() =>
				querySessionUsage(sessionWithUsage(0.1236)),
			);
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
		}),
	));

test("missing session usage remains unavailable", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const result = yield* Effect.promise(() =>
				querySessionUsage(SessionManager.inMemory(process.cwd())),
			);
			assert.deepEqual(result.details, {
				inputTokens: null,
				outputTokens: null,
				cacheReadTokens: null,
				cacheWriteTokens: null,
				totalTokens: null,
				usd: null,
			});
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

import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { eventually } from "./eventually.ts";
import { context, harness } from "./manager-fixture.ts";

function failedAssistant(
	stopReason: "error" | "aborted",
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "test",
		model: "test",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [],
		stopReason,
		errorMessage,
	};
}

test("a successful retry replaces the failed assistant outcome before idle settlement", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { manager, sessions } = harness();
			try {
				const job = manager.spawn({ task: "retry", ctx: context });
				yield* eventually(() => sessions.length === 1);
				sessions[0].emit({
					type: "message_end",
					message: failedAssistant("error", "temporary failure"),
				});
				sessions[0].emit({
					type: "auto_retry_start",
					attempt: 1,
					maxAttempts: 3,
					delayMs: 0,
					errorMessage: "temporary failure",
				});
				sessions[0].emitAssistant("recovered successfully", 15, "stop");
				sessions[0].emit({ type: "auto_retry_end", success: true, attempt: 1 });
				sessions[0].finishWithoutResponse();
				const [result] = yield* manager.wait([job.id]);
				assert.equal(result.status, "done");
				assert.equal(result.output, "recovered successfully");
				assert.equal(result.error, undefined);
			} finally {
				yield* manager.shutdown();
			}
		}),
	));

for (const stopReason of ["error", "aborted"] as const) {
	test(`a terminal assistant ${stopReason} retains its terminal status`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const { manager, sessions } = harness();
				try {
					const job = manager.spawn({ task: "fail", ctx: context });
					yield* eventually(() => sessions.length === 1);
					sessions[0].emitAssistant("earlier response", 15);
					sessions[0].emit({
						type: "message_end",
						message: failedAssistant(stopReason, "terminal failure"),
					});
					sessions[0].finishWithoutResponse();
					const [result] = yield* manager.wait([job.id]);
					assert.equal(
						result.status,
						stopReason === "aborted" ? "cancelled" : "error",
					);
					assert.equal(result.error, "terminal failure");
				} finally {
					yield* manager.shutdown();
				}
			}),
		));
}

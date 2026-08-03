import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import extension, {
	compactionBoundary,
	createDenseHandoff,
	DENSE_HANDOFF_INSTRUCTIONS,
} from "../index.ts";

function loadExtension() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	extension({
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI);
	return { handlers, sent };
}

const usage = {
	input: 100,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 110,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const turn = {
	type: "turn_end",
	turnIndex: 1,
	message: {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		provider: "test",
		model: "model",
		stopReason: "stop",
		usage,
		timestamp: 1,
	},
	toolResults: [],
};

test("uses the earlier 90% or 200k boundary", () => {
	assert.equal(compactionBoundary(128_000), 115_200);
	assert.equal(compactionBoundary(272_000), 200_000);
});

test("compacts once per crossing and queues one hidden continuation", () => {
	const { handlers, sent } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	let tokens = 200_000;
	const context = {
		compact(options: Record<string, unknown>) {
			compactCalls.push(options);
		},
		getContextUsage: () => ({
			tokens,
			contextWindow: 272_000,
			percent: (tokens / 272_000) * 100,
		}),
	} as unknown as ExtensionContext;
	const onTurnEnd = handlers.get("turn_end");
	assert.ok(onTurnEnd);

	handlers.get("session_start")?.({}, context);
	onTurnEnd(turn, context);
	onTurnEnd(turn, context);
	assert.equal(compactCalls.length, 1);
	(compactCalls[0]?.onComplete as (() => void) | undefined)?.();
	assert.deepEqual(sent, [
		{
			message: {
				customType: "compaction-continuation",
				content:
					"Continue from the dense handoff. Choose and execute the best next action. If the task is complete, report the outcome without inventing more work.",
				display: false,
			},
			options: { triggerTurn: true },
		},
	]);

	tokens = 40_000;
	onTurnEnd(turn, context);
	tokens = 200_000;
	onTurnEnd(turn, context);
	assert.equal(compactCalls.length, 2);
});

test("leaves overflow recovery and fixed threshold compaction to the intended paths", () => {
	const { handlers } = loadExtension();
	let compactCalls = 0;
	const context = {
		model: { provider: "test", id: "model" },
		compact() {
			compactCalls += 1;
		},
		getContextUsage: () => ({
			tokens: 210_000,
			contextWindow: 272_000,
			percent: 77,
		}),
	} as unknown as ExtensionContext;
	handlers.get("turn_end")?.(
		{
			...turn,
			message: {
				...turn.message,
				stopReason: "error",
				errorMessage: "This request exceeds the context window",
				usage: { ...usage, input: 300_000, totalTokens: 300_010 },
			},
		},
		context,
	);
	assert.equal(compactCalls, 0);
	handlers.get("turn_end")?.(
		{
			...turn,
			message: {
				...turn.message,
				provider: "previous-provider",
				stopReason: "error",
				errorMessage: "This request exceeds the context window",
				usage: { ...usage, input: 300_000, totalTokens: 300_010 },
			},
		},
		context,
	);
	assert.equal(compactCalls, 1);
	assert.deepEqual(
		handlers.get("session_before_compact")?.({ reason: "threshold" }, context),
		{ cancel: true },
	);
});

test("writes an active-model handoff and preserves prior file details", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const calls: unknown[][] = [];
			const summarize = ((...args: unknown[]) => {
				calls.push(args);
				return Promise.resolve({ text: "handoff", usage });
			}) as typeof import("@earendil-works/pi-coding-agent").generateSummaryWithUsage;
			const event = {
				customInstructions: "focus on the parser",
				preparation: {
					messagesToSummarize: [
						{ role: "user", content: "history", timestamp: 1 },
					],
					turnPrefixMessages: [
						{ role: "user", content: "turn prefix", timestamp: 2 },
					],
					settings: { reserveTokens: 16_384 },
					previousSummary: "previous",
					fileOps: {
						read: new Set(["new-read.ts"]),
						written: new Set<string>(),
						edited: new Set(["new-write.ts"]),
					},
					firstKeptEntryId: "kept",
					tokensBefore: 200_000,
				},
				branchEntries: [
					{
						type: "compaction",
						details: {
							readFiles: ["old-read.ts", "new-write.ts"],
							modifiedFiles: ["old-write.ts"],
						},
					},
				],
				signal: new AbortController().signal,
			} as unknown as SessionBeforeCompactEvent;
			const context = {
				model: { id: "model", provider: "test" },
				modelRegistry: {
					getApiKeyAndHeaders: () =>
						Promise.resolve({ ok: true, apiKey: "key" }),
				},
				thinkingLevel: "high",
			} as unknown as ExtensionContext;
			const result = yield* Effect.promise(() =>
				Promise.resolve(createDenseHandoff(event, context, summarize)),
			);
			assert.equal((calls[0]?.[0] as unknown[] | undefined)?.length, 2);
			assert.equal(calls[0]?.[2], 16_384);
			assert.match(String(calls[0]?.[6]), /same agent resume immediately/);
			assert.match(String(calls[0]?.[6]), /focus on the parser/);
			assert.equal(calls[0]?.[7], "previous");
			assert.ok(DENSE_HANDOFF_INSTRUCTIONS.includes("## Suggested Skills"));
			assert.deepEqual(result?.compaction.details, {
				readFiles: ["new-read.ts", "old-read.ts"],
				modifiedFiles: ["new-write.ts", "old-write.ts"],
			});
		}),
	));

test("falls back to Pi when custom handoff generation fails", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const summarize = (() =>
				Promise.reject(
					new Error("provider unavailable"),
				)) as typeof import("@earendil-works/pi-coding-agent").generateSummaryWithUsage;
			const result = yield* Effect.promise(() =>
				Promise.resolve(
					createDenseHandoff(
						{
							preparation: {
								messagesToSummarize: [],
								turnPrefixMessages: [],
								settings: { reserveTokens: 16_384 },
								fileOps: {
									read: new Set<string>(),
									written: new Set<string>(),
									edited: new Set<string>(),
								},
							},
							branchEntries: [],
							signal: new AbortController().signal,
						} as unknown as SessionBeforeCompactEvent,
						{
							model: { id: "model", provider: "test" },
							modelRegistry: {
								getApiKeyAndHeaders: () => Promise.resolve({ ok: true }),
							},
						} as unknown as ExtensionContext,
						summarize,
					),
				),
			);
			assert.equal(result, undefined);
		}),
	));

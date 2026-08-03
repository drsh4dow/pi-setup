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

test("uses the earlier 85% or 250k boundary", () => {
	assert.equal(compactionBoundary(128_000), 108_800);
	assert.equal(compactionBoundary(272_000), 231_200);
	assert.equal(compactionBoundary(1_000_000), 250_000);
});

test("queues one continuation that reconciles stale tail state and the terminal gate", () => {
	const { handlers, sent } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	let tokens = 250_000;
	const context = {
		model: { provider: "openai-codex", id: "model" },
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
	(compactCalls[0]?.onComplete as ((result: unknown) => void) | undefined)?.({
		details: {
			readFiles: [],
			modifiedFiles: [],
			handoffContractVersion: 1,
			summaryScope: "prefix-before-retained-tail",
		},
	});
	assert.equal(sent.length, 1);
	const continuation = String(
		(sent[0]?.message as { content?: unknown } | undefined)?.content,
	);
	assert.match(continuation, /newer retained tail first/i);
	assert.match(continuation, /reload the active controller/i);
	assert.match(continuation, /recover bounded canonical state/i);
	assert.match(continuation, /reconcile the mutation lease before mutation/i);
	assert.match(continuation, /rerun the liveness gate/i);
	assert.match(continuation, /invocation-level completion gate/i);
	assert.doesNotMatch(continuation, /if the task is complete/i);

	tokens = 40_000;
	onTurnEnd(turn, context);
	tokens = 235_000;
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
			tokens: 250_000,
			contextWindow: 272_000,
			percent: 92,
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

test("writes a prefix-scoped Resume Contract with fresh branches and continuous economics", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const calls: unknown[][] = [];
			const summarize = ((...args: unknown[]) => {
				calls.push(args);
				return Promise.resolve({
					text: `handoff

## Resume Contract
- **Active controller skill:** hacker-method/SKILL.md
- **Active branches (reload):** credential-archaeology.md
- **Canonical authority:** workspace next-action
- **Mutation lease:** resume-lease-2
- **Economics interval:** last closed interval endpoint usage-41; open work tag archaeology at snapshot 7.0; latest usage snapshot 7.5
- **Invocation-level completion gate:** canonical may_stop
- **Latest next-action:** resume_mutation_lease; may_stop false`,
					usage,
				});
			}) as typeof import("@earendil-works/pi-coding-agent").generateSummaryWithUsage;
			const event = {
				reason: "manual",
				customInstructions: "focus on the parser",
				preparation: {
					messagesToSummarize: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									name: "read",
									arguments: { path: "new-read.ts" },
								},
								{
									type: "toolCall",
									name: "edit",
									arguments: { path: "new-write.ts" },
								},
							],
							timestamp: 1,
						},
					],
					turnPrefixMessages: [
						{ role: "user", content: "turn prefix", timestamp: 2 },
					],
					settings: { reserveTokens: 16_384 },
					previousSummary: "previous",
					fileOps: {
						read: new Set(["old-native-read.ts", "new-read.ts"]),
						written: new Set<string>(),
						edited: new Set(["new-write.ts"]),
					},
					firstKeptEntryId: "kept",
					tokensBefore: 240_000,
				},
				branchEntries: [
					{
						type: "compaction",
						details: {
							readFiles: ["old-read.ts"],
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
			const instructions = String(calls[0]?.[6]);
			assert.match(instructions, /## Resume Contract/);
			assert.match(instructions, /Active controller skill/);
			assert.match(instructions, /Active branches.*reload/i);
			assert.match(instructions, /Canonical authority/);
			assert.match(instructions, /Mutation lease/);
			assert.match(instructions, /last closed interval endpoint/i);
			assert.match(instructions, /open work tag and start snapshot/i);
			assert.match(instructions, /latest usage snapshot/i);
			assert.match(instructions, /Invocation-level completion gate/);
			assert.match(instructions, /Latest next-action/);
			assert.match(instructions, /focus on the parser/);
			assert.equal(calls[0]?.[7], "previous");
			assert.equal(
				DENSE_HANDOFF_INSTRUCTIONS.includes("## Suggested Skills"),
				false,
			);
			const summary = result?.compaction.summary ?? "";
			assert.match(summary, /## Resume Contract/);
			assert.match(summary, /credential-archaeology\.md/);
			assert.match(summary, /resume-lease-2/);
			assert.match(summary, /usage-41/);
			assert.match(summary, /resume_mutation_lease/);
			assert.match(summary, /prefix before retained tail entry `kept`/i);
			assert.deepEqual(result?.compaction.details, {
				readFiles: ["new-read.ts"],
				modifiedFiles: ["new-write.ts", "old-write.ts"],
				handoffContractVersion: 1,
				summaryScope: "prefix-before-retained-tail",
				redactionCount: 0,
				summarizerProvider: "test",
				summarizerModel: "model",
				summarizedMessageCount: 2,
				reason: "manual",
			});
		}),
	));

test("redacts sensitive summary lines and file paths but preserves stable IDs", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const summarize = (() =>
				Promise.resolve({
					text: `Account: stable-lab-7
Authorization: Bearer secret-token-value
Owner: person@example.com
Phone: +1 415-555-0199
Credential store: /home/person/.pi/agent/auth.json
-----BEGIN PRIVATE KEY-----
supersecretbase64
-----END PRIVATE KEY-----`,
					usage,
				})) as typeof import("@earendil-works/pi-coding-agent").generateSummaryWithUsage;
			const result = yield* Effect.promise(() =>
				Promise.resolve(
					createDenseHandoff(
						{
							reason: "manual",
							preparation: {
								messagesToSummarize: [
									{
										role: "assistant",
										content: [
											{
												type: "toolCall",
												name: "read",
												arguments: {
													path: "/home/person/.pi/agent/auth.json",
												},
											},
											{
												type: "toolCall",
												name: "edit",
												arguments: { path: ".env.local" },
											},
										],
										timestamp: 1,
									},
								],
								turnPrefixMessages: [],
								settings: { reserveTokens: 16_384 },
								fileOps: {
									read: new Set<string>(),
									written: new Set<string>(),
									edited: new Set<string>(),
								},
								firstKeptEntryId: "kept",
								tokensBefore: 240_000,
							},
							branchEntries: [],
							signal: new AbortController().signal,
						} as unknown as SessionBeforeCompactEvent,
						{
							model: { id: "model", provider: "test" },
							modelRegistry: {
								getApiKeyAndHeaders: () =>
									Promise.resolve({ ok: true, apiKey: "key" }),
							},
						} as unknown as ExtensionContext,
						summarize,
					),
				),
			);
			const summary = result?.compaction.summary ?? "";
			assert.match(summary, /stable-lab-7/);
			for (const sensitive of [
				"secret-token-value",
				"person@example.com",
				"415-555-0199",
				"auth.json",
				"PRIVATE KEY",
				"supersecretbase64",
				".env.local",
			]) {
				assert.equal(summary.includes(sensitive), false, sensitive);
			}
			const details = result?.compaction.details;
			assert.ok(details);
			assert.deepEqual(details.readFiles, []);
			assert.deepEqual(details.modifiedFiles, []);
			assert.ok(details.redactionCount >= 7);
		}),
	));

test("uses recovery-safe continuation after native fallback", () => {
	const { handlers, sent } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	const context = {
		compact(options: Record<string, unknown>) {
			compactCalls.push(options);
		},
		getContextUsage: () => ({
			tokens: 250_000,
			contextWindow: 272_000,
			percent: 92,
		}),
	} as unknown as ExtensionContext;
	handlers.get("session_start")?.({}, context);
	handlers.get("turn_end")?.(turn, context);
	(compactCalls[0]?.onComplete as ((result: unknown) => void) | undefined)?.({
		details: { readFiles: [], modifiedFiles: [] },
	});
	const continuation = String(
		(sent[0]?.message as { content?: unknown } | undefined)?.content,
	);
	assert.match(continuation, /native compaction/i);
	assert.match(continuation, /recover bounded canonical state/i);
	assert.match(continuation, /reconcile the mutation lease before mutation/i);
	assert.match(continuation, /invocation-level completion gate/i);
	assert.doesNotMatch(continuation, /dense handoff/i);
});

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

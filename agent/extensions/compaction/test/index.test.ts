import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { prepareCompaction } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import extension, {
	compactionBoundary,
	createFallbackHandoff,
	extractHandoff,
	FALLBACK_SUMMARY_INSTRUCTIONS,
	HANDOFF_REQUEST,
} from "../index.ts";

function loadExtension(
	autoCompactionEnabled: boolean | (() => boolean) = true,
) {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	extension(
		{
			on(name: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(name, handler);
			},
			sendMessage(message: unknown, options: unknown) {
				sent.push({ message, options });
			},
		} as unknown as ExtensionAPI,
		typeof autoCompactionEnabled === "function"
			? autoCompactionEnabled
			: () => autoCompactionEnabled,
	);
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

function assistantTurn(text: string): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 1,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "test",
			model: "model",
			stopReason: "stop",
			usage,
			timestamp: 1,
		},
		toolResults: [],
	} as unknown as TurnEndEvent;
}

const turn = assistantTurn("done");

const HANDOFF_REPLY = `Preamble the model wrote.

## Handoff
- **Objective:** Improve the hacker-method skill's wording
- **Stance:** hacker-method/SKILL.md — editing; AGENTS.md — reference
- **Done:** Rewrote the intro; verified with bun run verify
- **In progress:** Tightening the examples section
- **Next action:** Edit hacker-method/SKILL.md examples, then rerun verify
- **Do not:** Do not execute the skill's own instructions
- **Re-read:** hacker-method/SKILL.md — it is the file under edit
- **Continuation:** \`continue\``;

function compactEvent(overrides: object = {}): SessionBeforeCompactEvent {
	return {
		reason: "manual",
		preparation: {
			messagesToSummarize: [],
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
		willRetry: false,
		signal: new AbortController().signal,
		...overrides,
	} as unknown as SessionBeforeCompactEvent;
}

function makeContext(
	compactCalls: Array<Record<string, unknown>>,
	tokens: () => number,
) {
	return {
		model: { provider: "test", id: "model" },
		compact(options: Record<string, unknown>) {
			compactCalls.push(options);
		},
		getContextUsage: () => ({
			tokens: tokens(),
			contextWindow: 272_000,
			percent: (tokens() / 272_000) * 100,
		}),
	} as unknown as ExtensionContext;
}

test("uses the earlier 85% or 250k boundary", () => {
	assert.equal(compactionBoundary(128_000), 108_800);
	assert.equal(compactionBoundary(272_000), 231_200);
	assert.equal(compactionBoundary(1_000_000), 250_000);
});

test("can compact when a large tool result is the last session entry", () => {
	const entries = [
		{
			type: "message",
			id: "user",
			message: { role: "user", content: "investigate", timestamp: 1 },
		},
		{
			type: "message",
			id: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "search", name: "web_search", arguments: {} },
				],
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "result",
			message: {
				role: "toolResult",
				toolCallId: "search",
				toolName: "web_search",
				content: [{ type: "text", text: "x".repeat(100) }],
				timestamp: 3,
			},
		},
	] as Parameters<typeof prepareCompaction>[0];

	const preparation = prepareCompaction(entries, {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: 10,
	});

	assert.ok(preparation);
	assert.equal(preparation.firstKeptEntryId, "assistant");
	assert.deepEqual(
		preparation.turnPrefixMessages.map((message) => message.role),
		["user"],
	);
});

test("does not compact automatically when auto-compaction is disabled", () => {
	const { handlers, sent } = loadExtension(false);
	const compactCalls: Array<Record<string, unknown>> = [];
	const context = makeContext(compactCalls, () => 250_000);

	handlers.get("session_start")?.({}, context);
	handlers.get("turn_end")?.(turn, context);
	assert.equal(compactCalls.length, 0);
	assert.equal(sent.length, 0);
});

test("abandons a pending handoff request when auto-compaction is disabled", () => {
	let enabled = true;
	const { handlers, sent } = loadExtension(() => enabled);
	const compactCalls: Array<Record<string, unknown>> = [];
	const context = makeContext(compactCalls, () => 250_000);
	handlers.get("session_start")?.({}, context);

	handlers.get("turn_end")?.(turn, context);
	assert.equal(sent.length, 1);

	enabled = false;
	handlers.get("turn_end")?.(assistantTurn(HANDOFF_REPLY), context);
	assert.equal(compactCalls.length, 0);

	// Re-enabling re-arms: the next boundary crossing sends a fresh request.
	enabled = true;
	handlers.get("turn_end")?.(turn, context);
	assert.equal(sent.length, 2);
	assert.equal(
		(sent[1]?.message as { customType?: string } | undefined)?.customType,
		"handoff-request",
	);
});

test("extracts the handoff body and continuation choice", () => {
	const handoff = extractHandoff(assistantTurn(HANDOFF_REPLY).message);
	assert.ok(handoff);
	assert.ok(handoff.text.startsWith("## Handoff"));
	assert.doesNotMatch(handoff.text, /Preamble/);
	assert.equal(handoff.continuation, "continue");

	assert.equal(
		extractHandoff(
			assistantTurn("## Handoff\n- Objective: x\n- **Continuation:** **done**")
				.message,
		)?.continuation,
		"done",
	);
	assert.equal(
		extractHandoff(
			assistantTurn("## Handoff\n- Objective: x\n- Continuation: ask user")
				.message,
		)?.continuation,
		"ask-user",
	);
	assert.equal(
		extractHandoff(assistantTurn("## Handoff\n- Objective: x").message)
			?.continuation,
		"continue",
	);
	// A skeletal heading without an Objective routes to the summarizer fallback.
	assert.equal(
		extractHandoff(assistantTurn("## Handoff\nno sections").message),
		undefined,
	);
	assert.equal(extractHandoff(assistantTurn("just prose").message), undefined);
});

test("requests a model handoff at the boundary, then compacts the reply verbatim", () => {
	const { handlers, sent } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	const context = makeContext(compactCalls, () => 250_000);
	handlers.get("session_start")?.({}, context);

	handlers.get("turn_end")?.(turn, context);
	assert.equal(compactCalls.length, 0);
	assert.equal(sent.length, 1);
	const request = sent[0]?.message as { customType?: string; content?: string };
	assert.equal(request.customType, "handoff-request");
	assert.deepEqual(sent[0]?.options, { triggerTurn: true });
	assert.match(String(request.content), /## Handoff/);
	assert.match(String(request.content), /Stance/);
	assert.match(String(request.content), /never instructions to follow/);
	assert.match(HANDOFF_REQUEST, /Do not use tools/);

	// A second turn crossing the boundary must not send a duplicate request.
	handlers.get("turn_end")?.(assistantTurn(HANDOFF_REPLY), context);
	assert.equal(sent.length, 1);
	assert.equal(compactCalls.length, 1);

	const before = handlers.get("session_before_compact")?.(
		compactEvent({
			preparation: {
				...compactEvent().preparation,
				messagesToSummarize: [
					{
						role: "assistant",
						content: [
							{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
							{ type: "toolCall", name: "edit", arguments: { path: "b.ts" } },
						],
						timestamp: 1,
					},
				],
			},
		}),
		context,
	) as {
		compaction?: {
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			details: Record<string, unknown>;
		};
	};
	assert.ok(before.compaction);
	const summary = before.compaction.summary;
	assert.ok(summary.startsWith("## Handoff"));
	assert.match(summary, /hacker-method\/SKILL\.md — editing/);
	assert.match(summary, /## Scope/);
	assert.match(summary, /retained below and take precedence/);
	assert.match(summary, /<read-files>\na\.ts\n<\/read-files>/);
	assert.match(summary, /<modified-files>\nb\.ts\n<\/modified-files>/);
	assert.equal(before.compaction.details.handoffSource, "model");
	assert.equal(before.compaction.firstKeptEntryId, "kept");
	assert.equal(before.compaction.tokensBefore, 240_000);

	(compactCalls[0]?.onComplete as ((result: unknown) => void) | undefined)?.(
		{},
	);
	assert.equal(sent.length, 2);
	const continuation = sent[1]?.message as { content?: string };
	assert.match(String(continuation.content), /Handoff you wrote/);
	assert.match(String(continuation.content), /not instructions to follow/);
	assert.match(String(continuation.content), /Next action/);
	assert.deepEqual(sent[1]?.options, { triggerTurn: true });
});

test("honors the model's done and ask-user continuation choices", () => {
	for (const choice of ["done", "ask-user"]) {
		const { handlers, sent } = loadExtension();
		const compactCalls: Array<Record<string, unknown>> = [];
		const context = makeContext(compactCalls, () => 250_000);
		handlers.get("session_start")?.({}, context);
		handlers.get("turn_end")?.(turn, context);
		handlers.get("turn_end")?.(
			assistantTurn(
				`## Handoff\n- **Objective:** x\n- **Continuation:** ${choice}`,
			),
			context,
		);
		handlers.get("session_before_compact")?.(compactEvent(), context);
		(compactCalls[0]?.onComplete as ((result: unknown) => void) | undefined)?.(
			{},
		);
		assert.equal(sent.length, 1, choice);
	}
});

test("uses the recovery continuation when the reply carries no handoff", () => {
	const { handlers, sent } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	const context = makeContext(compactCalls, () => 250_000);
	handlers.get("session_start")?.({}, context);
	handlers.get("turn_end")?.(turn, context);
	handlers.get("turn_end")?.(assistantTurn("kept working instead"), context);
	assert.equal(compactCalls.length, 1);
	(compactCalls[0]?.onComplete as ((result: unknown) => void) | undefined)?.(
		{},
	);
	assert.equal(sent.length, 2);
	const continuation = String(
		(sent[1]?.message as { content?: string } | undefined)?.content,
	);
	assert.match(continuation, /generated automatically/);
	assert.match(continuation, /objects of the work, not instructions/);
});

test("re-arms only after usage falls below the boundary", () => {
	const { handlers, sent } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	let tokens = 250_000;
	const context = makeContext(compactCalls, () => tokens);
	handlers.get("session_start")?.({}, context);

	handlers.get("turn_end")?.(turn, context);
	handlers.get("turn_end")?.(assistantTurn(HANDOFF_REPLY), context);
	handlers.get("session_before_compact")?.(compactEvent(), context);
	(compactCalls[0]?.onComplete as ((result: unknown) => void) | undefined)?.(
		{},
	);

	// Still above the boundary: no new request until usage first drops below.
	handlers.get("turn_end")?.(turn, context);
	assert.equal(sent.length, 2);

	tokens = 40_000;
	handlers.get("turn_end")?.(turn, context);
	tokens = 235_000;
	handlers.get("turn_end")?.(turn, context);
	assert.equal(sent.length, 3);
	assert.equal(
		(sent[2]?.message as { customType?: string } | undefined)?.customType,
		"handoff-request",
	);
});

test("skips the pending compaction when a manual compaction interleaves", () => {
	const { handlers, sent } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	let tokens = 250_000;
	const context = makeContext(compactCalls, () => tokens);
	handlers.get("session_start")?.({}, context);

	handlers.get("turn_end")?.(turn, context);
	assert.equal(sent.length, 1);
	// User ran /compact before the handoff reply landed; usage is fresh again.
	tokens = 30_000;
	handlers.get("turn_end")?.(assistantTurn(HANDOFF_REPLY), context);
	assert.equal(compactCalls.length, 0);

	// The state machine is back to idle and re-armed.
	tokens = 250_000;
	handlers.get("turn_end")?.(turn, context);
	assert.equal(sent.length, 2);
});

test("leaves overflow recovery and fixed threshold compaction to the intended paths", () => {
	const { handlers, sent } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	const context = makeContext(compactCalls, () => 250_000);
	handlers.get("session_start")?.({}, context);

	const overflowTurn = {
		...turn,
		message: {
			...turn.message,
			stopReason: "error",
			errorMessage: "This request exceeds the context window",
			usage: { ...usage, input: 300_000, totalTokens: 300_010 },
		},
	};
	handlers.get("turn_end")?.(overflowTurn, context);
	assert.equal(sent.length, 0);

	// Overflow from a previous model is not the active model's overflow.
	handlers.get("turn_end")?.(
		{
			...overflowTurn,
			message: { ...overflowTurn.message, provider: "previous-provider" },
		},
		context,
	);
	assert.equal(sent.length, 1);

	// The handoff turn itself overflowing hands control to native recovery.
	handlers.get("turn_end")?.(overflowTurn, context);
	assert.equal(compactCalls.length, 0);

	assert.deepEqual(
		handlers.get("session_before_compact")?.({ reason: "threshold" }, context),
		{ cancel: true },
	);
});

test("redacts sensitive lines and file paths from the model handoff", () => {
	const { handlers } = loadExtension();
	const compactCalls: Array<Record<string, unknown>> = [];
	const context = makeContext(compactCalls, () => 250_000);
	handlers.get("session_start")?.({}, context);
	handlers.get("turn_end")?.(turn, context);
	handlers.get("turn_end")?.(
		assistantTurn(`## Handoff
- **Objective:** Account stable-lab-7 setup
- Authorization: Bearer secret-token-value
- Owner: person@example.com
- Credential store: /home/person/.pi/agent/auth.json
- **Continuation:** continue`),
		context,
	);
	const before = handlers.get("session_before_compact")?.(
		compactEvent({
			preparation: {
				...compactEvent().preparation,
				messagesToSummarize: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "edit",
								arguments: { path: ".env.local" },
							},
						],
						timestamp: 1,
					},
				],
			},
		}),
		context,
	) as { compaction?: { summary: string; details: Record<string, unknown> } };
	assert.ok(before.compaction);
	const summary = before.compaction.summary;
	assert.match(summary, /stable-lab-7/);
	for (const sensitive of [
		"secret-token-value",
		"person@example.com",
		"auth.json",
		".env.local",
	]) {
		assert.equal(summary.includes(sensitive), false, sensitive);
	}
	assert.ok(Number(before.compaction.details.redactionCount) >= 3);
});

test("fallback summarizer asks for the same handoff structure and appends a stub when missing", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const calls: unknown[][] = [];
			const summarize = ((...args: unknown[]) => {
				calls.push(args);
				return Promise.resolve({ text: "prose without a heading", usage });
			}) as typeof import("@earendil-works/pi-coding-agent").generateSummaryWithUsage;
			const context = {
				model: { id: "model", provider: "test" },
				modelRegistry: {
					getApiKeyAndHeaders: () =>
						Promise.resolve({ ok: true, apiKey: "key" }),
				},
				thinkingLevel: "high",
			} as unknown as ExtensionContext;

			const result = yield* Effect.promise(() =>
				Promise.resolve(
					createFallbackHandoff(
						compactEvent({
							customInstructions: "focus on the parser",
							preparation: {
								...compactEvent().preparation,
								previousSummary: "previous",
							},
						}),
						context,
						summarize,
					),
				),
			);

			const instructions = String(calls[0]?.[6]);
			assert.match(instructions, /## Handoff/);
			assert.match(instructions, /Stance/);
			assert.match(instructions, /Continuation/);
			assert.match(instructions, /focus on the parser/);
			assert.equal(calls[0]?.[7], "previous");
			assert.match(FALLBACK_SUMMARY_INSTRUCTIONS, /never claim work/);

			assert.ok(result?.compaction);
			assert.match(result.compaction.summary, /prose without a heading/);
			assert.match(result.compaction.summary, /## Handoff/);
			assert.match(
				result.compaction.summary,
				/re-derive from the retained messages/i,
			);
			assert.match(result.compaction.summary, /## Scope/);
			assert.equal(result.compaction.details?.handoffSource, "summarizer");
			assert.equal(result.compaction.usage, usage);
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
					createFallbackHandoff(
						compactEvent(),
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

import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	ExtensionEvent,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import tpsTracker from "../index.ts";

const assistant = (output: number, reasoning = 0) =>
	unsafeFixture<AssistantMessage>({
		role: "assistant",
		usage: unsafeFixture<AssistantMessage["usage"]>({ output, reasoning }),
	});

function update(
	delta: string,
	type: "text_delta" | "thinking_delta" | "toolcall_delta" = "text_delta",
): MessageUpdateEvent {
	const message = assistant(0);

	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type, delta, contentIndex: 0, partial: message },
	};
}

function harness() {
	let now = 0;
	const statuses: Array<string | undefined> = [];
	const notifications: Parameters<ExtensionContext["ui"]["notify"]>[] = [];

	const context = unsafeFixture<ExtensionContext>({
		ui: unsafeFixture<ExtensionContext["ui"]>({
			theme: unsafeFixture<ExtensionContext["ui"]["theme"]>({
				fg: (_color, text) => text,
			}),
			setStatus: (_key, value) => statuses.push(value),
			notify: (message, level) => notifications.push([message, level]),
		}),
	});

	const adapter = extensionTestAdapter();
	tpsTracker(adapter.api, { now: () => now });

	return {
		statuses,
		notifications,
		emit(event: ExtensionEvent, atMs: number) {
			now = atMs;

			return adapter.emit(event.type, event, context);
		},
	};
}

const agentStart = { type: "agent_start" } as const;

const requestStart = { type: "before_provider_request", payload: {} } as const;

const agentEnd = { type: "agent_end", messages: [] } satisfies ExtensionEvent;

for (const firstOutputMs of [1_000, 9_998]) {
	test(`includes hidden reasoning time with first output at ${firstOutputMs}ms`, async () => {
		const { emit, statuses, notifications } = harness();
		await emit(agentStart, 0);
		await emit(requestStart, 0);
		await emit(update("a".repeat(200)), firstOutputMs);
		const receiving = `receiving · first output ${(firstOutputMs / 1000).toFixed(1)}s`;
		assert.equal(statuses.at(-1), receiving);
		await emit(update("b".repeat(200)), firstOutputMs + 1);
		assert.equal(statuses.at(-1), receiving);

		await emit({ type: "message_end", message: assistant(1_000, 900) }, 10_000);
		assert.equal(
			statuses.at(-1),
			"response complete · 100.0 effective output tok/s",
		);
		await emit(agentEnd, 10_000);
		assert.equal(statuses.at(-1), "done · 100.0 effective output tok/s");
		assert.deepEqual(notifications, [
			[
				"✓ 100.0 effective output tok/s  1000 reported output tokens in 10.0s of requests",
				"info",
			],
		]);
	});
}

test("weights request rates by duration and excludes tool execution time", async () => {
	const { emit, statuses, notifications } = harness();
	await emit(agentStart, 0);
	await emit(requestStart, 1_000);
	await emit(update("Thinking", "thinking_delta"), 2_000);
	await emit({ type: "message_end", message: assistant(100) }, 3_000);

	// Tools execute between requests, not inside either timing window.
	await emit(requestStart, 63_000);
	assert.equal(statuses.at(-1), "⏱ waiting for output...");
	await emit(update('{"command":"ls"}', "toolcall_delta"), 65_000);
	assert.equal(statuses.at(-1), "receiving · first output 2.0s");
	await emit({ type: "message_end", message: assistant(200) }, 71_000);
	await emit(agentEnd, 72_000);
	assert.equal(statuses.at(-1), "done · 30.0 effective output tok/s");
	assert.deepEqual(notifications, [
		[
			"✓ 30.0 effective output tok/s  300 reported output tokens in 10.0s of requests",
			"info",
		],
	]);

	await emit(agentStart, 80_000);
	await emit(requestStart, 80_000);
	await emit({ type: "message_end", message: assistant(10) }, 82_000);
	await emit(agentEnd, 82_000);
	assert.equal(statuses.at(-1), "done · 5.0 effective output tok/s");
});

test("does not publish a rate for a sub-second request", async () => {
	const { emit, statuses, notifications } = harness();
	await emit(agentStart, 0);
	await emit(requestStart, 0);
	await emit(update("Answer"), 24);
	await emit({ type: "message_end", message: assistant(40) }, 25);
	await emit(agentEnd, 25);
	assert.equal(statuses.at(-1), "done · N/A");
	assert.deepEqual(notifications, [
		["✓ N/A  40 reported output tokens in 0.0s of requests", "info"],
	]);
});

test("does not substitute visible text estimates for unreported usage after abort", async () => {
	const { emit, statuses } = harness();
	await emit(agentStart, 0);
	await emit(requestStart, 0);
	await emit(update("partial answer"), 2_000);
	await emit(
		{
			type: "message_end",
			message: { ...assistant(0), stopReason: "aborted" },
		},
		3_000,
	);
	assert.equal(statuses.at(-1), "output rate unavailable");
	await emit(agentEnd, 3_000);
	assert.equal(statuses.at(-1), "done · N/A");

	await emit(agentStart, 4_000);
	await emit(requestStart, 5_000);
	await emit({ type: "message_end", message: assistant(100) }, 7_000);
	await emit(agentEnd, 7_000);
	assert.equal(statuses.at(-1), "done · 50.0 effective output tok/s");
});

test("requires a measured request and ignores empty output deltas", async () => {
	const { emit, statuses } = harness();
	await emit(agentStart, 0);
	await emit(update("unmeasured output"), 1_000);
	await emit({ type: "message_end", message: assistant(100) }, 2_000);
	assert.equal(statuses.at(-1), "output rate unavailable");
	await emit(agentEnd, 2_000);
	assert.equal(statuses.at(-1), "done · N/A");

	await emit(agentStart, 3_000);
	await emit(requestStart, 3_000);
	await emit(update(""), 4_000);
	assert.equal(statuses.at(-1), "⏱ waiting for output...");
	await emit(update("answer"), 5_000);
	assert.equal(statuses.at(-1), "receiving · first output 2.0s");
});

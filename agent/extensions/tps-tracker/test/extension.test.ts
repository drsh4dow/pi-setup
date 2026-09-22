import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import tpsTracker from "../index.ts";

const assistant = (output: number) =>
	unsafeFixture<AssistantMessage>({
		role: "assistant",
		usage: unsafeFixture<AssistantMessage["usage"]>({ output }),
	});

const update = (output: number, delta: string): MessageUpdateEvent =>
	unsafeFixture<MessageUpdateEvent>({
		type: "message_update",
		message: assistant(output),
		assistantMessageEvent: {
			type: "text_delta",
			delta,
			contentIndex: 0,
			partial: assistant(output),
		},
	});

test("reports live and completed throughput from assistant stream timing", async () => {
	let now = 0;
	const statuses: Array<string | undefined> = [];
	const notifications: Parameters<ExtensionContext["ui"]["notify"]>[] = [];

	const context = unsafeFixture<ExtensionContext>({
		hasUI: true,
		model: undefined,
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

	await adapter.emit("agent_start", { type: "agent_start" }, context);
	assert.equal(statuses.at(-1), "⏱ generating...");

	await adapter.emit(
		"message_start",
		{ type: "message_start", message: assistant(0) },
		context,
	);
	now = 500;
	await adapter.emit("message_update", update(0, "12345678"), context);
	now = 1_500;
	await adapter.emit("message_update", update(20, "12345678"), context);
	assert.equal(statuses.at(-1), "20 tok/s (20 tok / 1.0s)");

	now = 2_500;
	await adapter.emit(
		"message_end",
		unsafeFixture<MessageEndEvent>({
			type: "message_end",
			message: assistant(40),
		}),
		context,
	);
	await adapter.emit("agent_end", { type: "agent_end", messages: [] }, context);
	assert.deepEqual(notifications, [
		["✓ 20 tok/s  40 tokens in 2.0s streaming", "info"],
	]);
	assert.equal(statuses.at(-1), "done – 20 tok/s");
});

test("preserves positive throughput when a short stream rounds to 0.0s", async () => {
	let now = 0;
	const statuses: Array<string | undefined> = [];
	const notifications: Parameters<ExtensionContext["ui"]["notify"]>[] = [];

	const context = unsafeFixture<ExtensionContext>({
		hasUI: true,
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

	await adapter.emit("agent_start", { type: "agent_start" }, context);
	await adapter.emit(
		"message_start",
		{ type: "message_start", message: assistant(0) },
		context,
	);
	now = 500;
	await adapter.emit("message_update", update(0, "12345678"), context);
	now = 525;
	await adapter.emit(
		"message_end",
		{ type: "message_end", message: assistant(40) },
		context,
	);
	await adapter.emit("agent_end", { type: "agent_end", messages: [] }, context);
	assert.equal(statuses.at(-1), "done – 1600 tok/s");
	assert.deepEqual(notifications, [
		["✓ 1600 tok/s  40 tokens in 0.0s streaming", "info"],
	]);
});

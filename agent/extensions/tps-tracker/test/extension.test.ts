import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
	boundaryValue,
	extensionTestAdapter,
	testContext,
} from "../../test/adapter.ts";
import tpsTracker from "../index.ts";

const assistant = (output: number) =>
	boundaryValue<MessageStartEvent["message"]>({
		role: "assistant",
		usage: { output },
	});

const update = (output: number, delta: string): MessageUpdateEvent =>
	boundaryValue<MessageUpdateEvent>({
		type: "message_update",
		message: assistant(output),
		assistantMessageEvent: { type: "text_delta", delta },
	});

test("reports live and completed throughput from assistant stream timing", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			let now = 0;
			const statuses: string[] = [];
			const notifications: Array<[string, string]> = [];
			const context = testContext({
				hasUI: true,
				model: undefined,
				ui: boundaryValue<ExtensionContext["ui"]>({
					theme: { fg: (_color: string, text: string) => text },
					setStatus: (_key: string, value: string) => statuses.push(value),
					notify: (message: string, level: string) =>
						notifications.push([message, level]),
				}),
			});
			const adapter = extensionTestAdapter();
			tpsTracker(adapter.api, { now: () => now });

			yield* Effect.promise(() =>
				adapter.emit("agent_start", { type: "agent_start" }, context),
			);
			assert.equal(statuses.at(-1), "⏱ generating...");

			yield* Effect.promise(() =>
				adapter.emit(
					"message_start",
					{ type: "message_start", message: assistant(0) },
					context,
				),
			);
			now = 500;
			yield* Effect.promise(() =>
				adapter.emit("message_update", update(0, "12345678"), context),
			);
			now = 1_500;
			yield* Effect.promise(() =>
				adapter.emit("message_update", update(20, "12345678"), context),
			);
			assert.equal(statuses.at(-1), "20 tok/s (20 tok / 1.0s)");

			now = 2_500;
			yield* Effect.promise(() =>
				adapter.emit(
					"message_end",
					boundaryValue<MessageEndEvent>({
						type: "message_end",
						message: assistant(40),
					}),
					context,
				),
			);
			yield* Effect.promise(() =>
				adapter.emit("agent_end", { type: "agent_end", messages: [] }, context),
			);
			assert.deepEqual(notifications, [
				["✓ 20 tok/s  40 tokens in 2.0s streaming", "info"],
			]);
			assert.equal(statuses.at(-1), "done — 20 tok/s");
		}),
	));

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
	boundaryValue,
	extensionTestAdapter,
	testContext,
} from "../../test/adapter.ts";
import { createSessionTimer } from "../index.ts";

test("reports deterministic run and session time and stops each ticker", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			let now = 0;
			let tick: (() => void) | undefined;
			let stops = 0;
			const statuses: string[] = [];
			const context = testContext({
				hasUI: true,
				model: undefined,
				ui: boundaryValue<ExtensionContext["ui"]>({
					theme: { fg: (_color: string, text: string) => text },
					setStatus: (_key: string, value: string) => statuses.push(value),
				}),
			});
			const adapter = extensionTestAdapter();
			createSessionTimer({
				now: () => now,
				everySecond: (callback) => {
					tick = callback;
					return () => {
						stops += 1;
					};
				},
			})(adapter.api);

			yield* Effect.promise(() =>
				adapter.emit("agent_start", { type: "agent_start" }, context),
			);
			now = 1_500;
			tick?.();
			assert.equal(statuses.at(-1), "⏱ 2s");
			yield* Effect.promise(() =>
				adapter.emit("agent_end", { type: "agent_end", messages: [] }, context),
			);
			assert.equal(statuses.at(-1), "⏱ 2s (session 2s)");
			assert.equal(stops, 1);

			now = 2_000;
			yield* Effect.promise(() =>
				adapter.emit("agent_start", { type: "agent_start" }, context),
			);
			now = 62_000;
			yield* Effect.promise(() =>
				adapter.emit("agent_end", { type: "agent_end", messages: [] }, context),
			);
			assert.equal(statuses.at(-1), "⏱ 1m0s (session 1m2s)");
			assert.equal(stops, 2);
		}),
	));

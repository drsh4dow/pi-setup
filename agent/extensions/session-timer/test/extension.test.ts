import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import sessionTimer from "../index.ts";

test("reports deterministic run and session time and stops each ticker", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			let now = 0;
			let tick: (() => void) | undefined;
			let stops = 0;
			const statuses: string[] = [];
			const context = unsafeFixture<ExtensionContext>({
				hasUI: true,
				mode: "tui",
				model: undefined,
				ui: unsafeFixture<ExtensionContext["ui"]>({
					theme: { fg: (_color: string, text: string) => text },
					setStatus: (_key: string, value: string) => statuses.push(value),
				}),
			});
			const adapter = extensionTestAdapter();
			sessionTimer(adapter.api, {
				now: () => now,
				everySecond: (callback) => {
					tick = callback;
					return () => {
						stops += 1;
					};
				},
			});

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

for (const mode of ["tui", "rpc", "json", "print"] as const) {
	test(`timer releases shutdown resources idempotently in ${mode}`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const adapter = extensionTestAdapter();
				const ticks = new Set<() => void>();
				let stops = 0;
				const statuses: Array<string | undefined> = [];
				const context = unsafeFixture<ExtensionContext>({
					mode,
					hasUI: mode === "tui" || mode === "rpc",
					ui: {
						theme: { fg: (_: string, text: string) => text },
						setStatus: (_: string, value: string | undefined) =>
							statuses.push(value),
					},
				});
				sessionTimer(adapter.api, {
					now: () => 1000,
					everySecond: (tick) => {
						ticks.add(tick);
						return () => {
							stops++;
							ticks.delete(tick);
						};
					},
				});
				yield* Effect.promise(() =>
					adapter.emit("agent_start", { type: "agent_start" }, context),
				);
				assert.equal(ticks.size, mode === "tui" ? 1 : 0);
				for (let n = 0; n < 2; n++)
					yield* Effect.promise(() =>
						adapter.emit(
							"session_shutdown",
							{ type: "session_shutdown", reason: "reload" },
							context,
						),
					);
				assert.equal(ticks.size, 0);
				assert.equal(stops, mode === "tui" ? 1 : 0);
				const writes = statuses.length;
				for (const tick of ticks) tick();
				assert.equal(statuses.length, writes);
				assert.equal(statuses.at(-1), undefined);
			}),
		));
}

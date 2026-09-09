import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Fiber } from "effect";
import type { DelegateSnapshot } from "../contract.ts";
import { eventually } from "./eventually.ts";
import { context, harness } from "./manager-fixture.ts";

test("background completion is delivered without a parent wait", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const delivered: DelegateSnapshot[] = [];
			const { manager, sessions } = harness((snapshot) =>
				delivered.push(snapshot),
			);
			try {
				const job = manager.spawn({
					task: "background",
					background: true,
					ctx: context,
				});
				yield* eventually(() => sessions.length === 1);
				sessions[0].finish("automatic result");
				yield* eventually(() => delivered.length === 1);
				assert.equal(delivered[0].id, job.id);
				assert.equal(delivered[0].output, "automatic result");
			} finally {
				yield* manager.shutdown();
			}
		}),
	));

test("blocking completion can be cancelled while the child is running", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { manager, sessions } = harness();
			const job = manager.spawn({ task: "blocking", ctx: context });
			yield* eventually(() => sessions.length === 1);
			const blocking = yield* manager.wait([job.id]).pipe(Effect.forkChild);
			const [cancelled] = yield* manager.cancel([job.id]);
			assert.equal(cancelled.status, "cancelled");
			assert.equal((yield* Fiber.join(blocking))[0].status, "cancelled");
			yield* manager.shutdown();
		}),
	));

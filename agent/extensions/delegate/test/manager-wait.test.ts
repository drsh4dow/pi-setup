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
				const job = manager.spawn({ task: "background", ctx: context });
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

test("lifecycle observation resolves when a running child is cancelled", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { manager, sessions } = harness();
			const job = manager.spawn({ task: "observed", ctx: context });
			yield* eventually(() => sessions.length === 1);
			const observed = yield* manager.wait([job.id]).pipe(Effect.forkChild);
			const [cancelled] = yield* manager.cancel([job.id]);
			assert.equal(cancelled.status, "cancelled");
			assert.equal((yield* Fiber.join(observed))[0].status, "cancelled");
			yield* manager.shutdown();
		}),
	));

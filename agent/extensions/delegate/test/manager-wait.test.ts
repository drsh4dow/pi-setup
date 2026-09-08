import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Deferred, Effect, Fiber } from "effect";
import type { DelegateSnapshot } from "../contract.ts";
import { eventually, yieldImmediate } from "./eventually.ts";
import { context, harness } from "./manager-fixture.ts";

function failureMessage<A, E, R>(effect: Effect.Effect<A, E, R>) {
	return effect.pipe(
		Effect.exit,
		Effect.map((exit) => {
			if (exit._tag === "Success") assert.fail("expected Effect to fail");
			return String(Cause.squash(exit.cause));
		}),
	);
}

test("wait admission is atomic, bounded per child, and releases capacity", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { manager, sessions } = harness();
			const first = manager.spawn({ task: "first", ctx: context });
			const second = manager.spawn({ task: "second", ctx: context });
			yield* eventually(() => sessions.length === 2);
			const waits = yield* Effect.forEach(Array.from({ length: 4 }), () =>
				Effect.forkChild(manager.wait([first.id])),
			);
			yield* yieldImmediate;
			const refused = yield* failureMessage(
				manager.wait([first.id, second.id]),
			);
			assert.match(refused, /4 pending waits/);
			sessions[0].finish("done");
			yield* Effect.forEach(waits, Fiber.join);
			const available = yield* Effect.forkChild(
				manager.wait([first.id, second.id]),
			);
			sessions[1].finish("done");
			yield* Fiber.join(available);
			yield* manager.shutdown();
		}),
	));

test("next wait returns the fast child and preserves the slow child's delivery", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const delivered: DelegateSnapshot[] = [];
			const { manager, sessions } = harness((snapshot) =>
				delivered.push(snapshot),
			);
			try {
				const slow = manager.spawn({
					task: "slow",
					background: true,
					ctx: context,
				});
				const fast = manager.spawn({
					task: "fast",
					background: true,
					ctx: context,
				});
				yield* eventually(() => sessions.length === 2);
				let returned = false;
				const waiting = yield* manager
					.wait([slow.id, fast.id], undefined, "next")
					.pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								returned = true;
							}),
						),
						Effect.forkChild,
					);
				yield* yieldImmediate;
				sessions[1].finish("fast result");
				yield* eventually(() => returned);
				const results = yield* Fiber.join(waiting);
				assert.deepEqual(
					results.map((result) => result.id),
					[fast.id],
				);
				assert.equal(results[0].output, "fast result");
				assert.equal(manager.list([slow.id])[0].status, "running");
				assert.equal(sessions[0].abortCalls, 0);
				assert.equal(delivered.length, 0);
				sessions[0].finish("slow result");
				yield* eventually(() => delivered.length === 1);
				assert.equal(delivered[0].id, slow.id);
			} finally {
				yield* manager.shutdown();
			}
		}),
	));

test("next wait releases delivery for a sibling that settles in the same turn", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const delivered: DelegateSnapshot[] = [];
			const { manager, sessions } = harness((snapshot) =>
				delivered.push(snapshot),
			);
			try {
				const jobs = ["first", "second"].map((task) =>
					manager.spawn({ task, background: true, ctx: context }),
				);
				yield* eventually(() => sessions.length === 2);
				const waiting = yield* Effect.forkChild(
					manager.wait(
						jobs.map((job) => job.id),
						undefined,
						"next",
					),
				);
				yield* yieldImmediate;
				for (const child of sessions) child.finish("done");
				const returned = yield* Fiber.join(waiting);
				yield* eventually(() => delivered.length === 1);
				assert.equal(returned.length, 1);
				assert.notEqual(returned[0].id, delivered[0].id);
				assert.deepEqual(
					new Set([...returned, ...delivered].map((job) => job.id)),
					new Set(jobs.map((job) => job.id)),
				);
			} finally {
				yield* manager.shutdown();
			}
		}),
	));

test("next wait returns settled failures and leaves other settled results available", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { manager, sessions } = harness();
			try {
				const failed = manager.spawn({ task: "failed", ctx: context });
				const done = manager.spawn({ task: "done", ctx: context });
				yield* eventually(() => sessions.length === 2);
				sessions[0].rejectPrompt(new Error("fixture failure"));
				sessions[1].finish("done");
				yield* manager.wait([failed.id, done.id]);
				const results = yield* manager.wait(
					[failed.id, done.id, failed.id],
					undefined,
					"next",
				);
				assert.equal(results.length, 1);
				assert.equal(results[0].id, failed.id);
				assert.equal(results[0].status, "error");
				const rest = yield* manager.wait([done.id], undefined, "next");
				assert.equal(rest[0].id, done.id);
				assert.match(
					yield* failureMessage(manager.wait([], undefined, "next")),
					/at least one/,
				);
				assert.match(
					yield* failureMessage(
						manager.wait([done.id, "missing"], undefined, "next"),
					),
					/Unknown delegate/,
				);
			} finally {
				yield* manager.shutdown();
			}
		}),
	));

test("aborting a next wait restores all background deliveries without stopping children", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const delivered: DelegateSnapshot[] = [];
			const { manager, sessions } = harness((snapshot) =>
				delivered.push(snapshot),
			);
			try {
				const jobs = ["first", "second"].map((task) =>
					manager.spawn({ task, background: true, ctx: context }),
				);
				yield* eventually(() => sessions.length === 2);
				// Caller-owned cancellation is the behavior under test, including its reason.
				// @effect-diagnostics-next-line abortControllerInEffect:off
				const controller = new AbortController();
				const waiting = yield* Effect.forkChild(
					manager.wait(
						jobs.map((job) => job.id),
						controller.signal,
						"next",
					),
				);
				yield* yieldImmediate;
				controller.abort(new Error("stop next wait"));
				assert.match(
					yield* failureMessage(Fiber.join(waiting)),
					/stop next wait/,
				);
				assert.ok(manager.list().every((job) => job.status === "running"));
				for (const child of sessions) child.finish("done");
				yield* eventually(() => delivered.length === 2);
				assert.deepEqual(
					new Set(delivered.map((job) => job.id)),
					new Set(jobs.map((job) => job.id)),
				);
			} finally {
				yield* manager.shutdown();
			}
		}),
	));

test("interrupted waits leave children running and explicit cancel stops them", () => {
	const controller = new AbortController();
	return Effect.runPromise(
		Effect.gen(function* () {
			const { manager, sessions } = harness();
			const job = manager.spawn({ task: "long", ctx: context });
			yield* eventually(() => sessions.length === 1);
			const waiting = yield* Effect.forkChild(
				manager.wait([job.id], controller.signal),
			);
			controller.abort(new Error("stop waiting"));
			const interrupted = yield* failureMessage(Fiber.join(waiting));
			assert.match(interrupted, /stop waiting/);
			assert.equal(manager.list([job.id])[0].status, "running");

			const [cancelled] = yield* manager.cancel([job.id]);
			assert.equal(cancelled.status, "cancelled");
			yield* manager.shutdown();
		}),
	);
});

test("an interrupted background wait restores delivery for the same run", () => {
	const controller = new AbortController();
	return Effect.runPromise(
		Effect.gen(function* () {
			const delivered: DelegateSnapshot[] = [];
			const { manager, sessions } = harness((snapshot) =>
				delivered.push(snapshot),
			);
			const job = manager.spawn({
				task: "background",
				background: true,
				ctx: context,
			});
			yield* eventually(() => sessions.length === 1);
			const waiting = yield* Effect.forkChild(
				manager.wait([job.id], controller.signal),
			);
			controller.abort(new Error("stop waiting"));
			sessions[0].finish("raced result");

			const interrupted = yield* failureMessage(Fiber.join(waiting));
			assert.match(interrupted, /stop waiting/);
			yield* eventually(() => delivered.length === 1);
			assert.equal(delivered[0].output, "raced result");
			assert.equal(manager.list([job.id])[0].status, "done");
			yield* manager.shutdown();
		}),
	);
});

test("a successful concurrent wait prevents an aborted wait from restoring delivery", () => {
	const controller = new AbortController();
	return Effect.runPromise(
		Effect.gen(function* () {
			const delivered: DelegateSnapshot[] = [];
			const { manager, sessions } = harness((snapshot) =>
				delivered.push(snapshot),
			);
			const job = manager.spawn({
				task: "background",
				background: true,
				ctx: context,
			});
			yield* eventually(() => sessions.length === 1);
			const aborted = yield* Effect.forkChild(
				manager.wait([job.id], controller.signal),
			);
			const successful = yield* manager.wait([job.id]).pipe(Effect.forkChild);
			yield* yieldImmediate;
			controller.abort(new Error("stop one wait"));
			sessions[0].finish("result");

			const interrupted = yield* failureMessage(Fiber.join(aborted));
			assert.match(interrupted, /stop one wait/);
			yield* Fiber.join(successful);
			assert.equal(delivered.length, 0);
			yield* manager.shutdown();
		}),
	);
});

test("cancel consumption wins over an aborted concurrent wait", () => {
	const controller = new AbortController();
	return Effect.runPromise(
		Effect.gen(function* () {
			const delivered: DelegateSnapshot[] = [];
			const { manager, sessions } = harness((snapshot) =>
				delivered.push(snapshot),
			);
			const job = manager.spawn({
				task: "background",
				background: true,
				ctx: context,
			});
			yield* eventually(() => sessions.length === 1);
			const abortGate = yield* Deferred.make<void>();
			sessions[0].abortGate = abortGate;
			const waiting = yield* Effect.forkChild(
				manager.wait([job.id], controller.signal),
			);
			const cancelling = yield* manager.cancel([job.id]).pipe(Effect.forkChild);
			controller.abort(new Error("stop waiting"));
			yield* Deferred.succeed(abortGate, undefined);

			const interrupted = yield* failureMessage(Fiber.join(waiting));
			assert.match(interrupted, /stop waiting/);
			const [cancelled] = yield* Fiber.join(cancelling);
			assert.equal(cancelled.status, "cancelled");
			assert.equal(delivered.length, 0);
			yield* manager.shutdown();
		}),
	);
});

test("cancellation waits for an existing child to be disposed", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const disposalGate = yield* Deferred.make<void>();
			let disposalStarted = false;
			const { manager, sessions } = harness(undefined, () => {
				disposalStarted = true;
				return Deferred.await(disposalGate);
			});
			const job = manager.spawn({ task: "cancel and dispose", ctx: context });
			yield* eventually(() => sessions.length === 1);

			let settled = false;
			const cancelling = yield* manager
				.cancel([job.id])
				.pipe(
					Effect.ensuring(Effect.sync(() => (settled = true))),
					Effect.forkChild,
				);
			yield* eventually(() => disposalStarted);
			assert.equal(settled, false);
			yield* Deferred.succeed(disposalGate, undefined);
			assert.equal((yield* Fiber.join(cancelling))[0].status, "cancelled");
			yield* manager.shutdown();
		}),
	));

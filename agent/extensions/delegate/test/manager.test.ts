// biome-ignore-all format: Effect test boundaries stay compact to keep the conversion deletion-first.
import assert from "node:assert/strict";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("fs");
const { readFile } = process.getBuiltinModule("fs/promises");

import { tmpdir } from "node:os";

const { join } = process.getBuiltinModule("path");

import test from "node:test";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cause, Deferred, Effect, Fiber } from "effect";

import {
	type DelegateSnapshot,
	MAX_CHILD_OUTPUT_BYTES,
	MAX_EXECUTION_TOKENS,
} from "../contract.ts";
import { DelegateManager } from "../manager.ts";
import type { ChildSession } from "../runtime.ts";
import { deferredPromise, eventually, yieldImmediate } from "./eventually.ts";
import { context, FakeChild, harness } from "./manager-fixture.ts";

function failureMessage<A, E, R>(effect: Effect.Effect<A, E, R>) {
	return effect.pipe(Effect.exit, Effect.map((exit) => {
		if (exit._tag === "Success") assert.fail("expected Effect to fail");
		return String(Cause.squash(exit.cause));
	}));
}

test("wait admission is atomic, bounded per child, and releases capacity", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const first = manager.spawn({ task: "first", ctx: context });
	const second = manager.spawn({ task: "second", ctx: context });
	yield* eventually(() => sessions.length === 2);
	const waits = yield* Effect.all(
		Array.from({ length: 4 }, () => Effect.forkChild(manager.wait([first.id]))),
	);
	yield* yieldImmediate;
	const refused = yield* failureMessage(manager.wait([first.id, second.id]));
	assert.match(refused, /4 pending waits/);
	sessions[0].finish("done");
	yield* Effect.all(waits.map(Fiber.join));
	const available = yield* Effect.forkChild(manager.wait([first.id, second.id]));
	sessions[1].finish("done");
	yield* Fiber.join(available);
	yield* manager.shutdown();
})));

test("per-run model override resolves strictly or fails the spawn", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const overrideContext = {
		...context,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "test" && id === "other" ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
		},
	} as unknown as ExtensionContext;
	const job = manager.spawn({ task: "override", model: " test/other ", ctx: overrideContext });
	assert.equal(job.requestedModel, "test/other");
	assert.equal(job.fallbackReason, undefined);
	assert.throws(
		() => manager.spawn({ task: "bad", model: "test/missing", ctx: overrideContext }),
		/Requested delegate model "test\/missing" was not found in the model registry/,
	);
	yield* eventually(() => sessions.length === 1);
	sessions[0].finish("done");
	yield* manager.wait([job.id]);
	yield* manager.shutdown();
})));

test("project delegate config survives an external child cwd", () => Effect.runPromise(Effect.gen(function* () {
	const cwd = mkdtempSync(join(tmpdir(), "pi-delegate-project-"));
	const childCwd = mkdtempSync(join(tmpdir(), "pi-delegate-child-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "delegate.json"), '{"model":"test/project"}', "utf8");
	const { manager, sessions } = harness();
	const projectContext = {
		...context,
		cwd,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "test" && id === "project" ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
		},
	} as unknown as ExtensionContext;

	try {
		const job = manager.spawn({
			task: "project model",
			cwd: childCwd,
			ctx: projectContext,
		});
		assert.equal(job.requestedModel, "test/project");
		assert.equal(job.model, "test/project");
		yield* eventually(() => sessions.length === 1);
		sessions[0].finish("done");
		yield* manager.wait([job.id]);
	} finally {
		yield* manager.shutdown();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(childCwd, { recursive: true, force: true });
	}
})));

test("starts every run immediately without aggregate scheduling", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const jobs = Array.from({ length: 40 }, (_, index) =>
		manager.spawn({ task: `parallel task ${index}`, ctx: context }),
	);
	yield* eventually(() => sessions.length === jobs.length);
	assert.ok(manager.list().every((snapshot) => snapshot.status === "running"));

	yield* manager.cancel(jobs.map((job) => job.id));
	yield* manager.shutdown();
})));

test("the universal ceiling owns a child created after settlement", (t) => Effect.runPromise(Effect.gen(function* () {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const creation = yield* Deferred.make<ChildSession>();
	const manager = new DelegateManager({
		createSession: () => deferredPromise(creation),
		shutdownSession(child) {
			(child as unknown as FakeChild).disposeNow();
			return Promise.resolve();
		},
	});
	const job = manager.spawn({ task: "creation hangs", ctx: context });
	yield* yieldImmediate;

	t.mock.timers.tick(60 * 60_000);
	const [failed] = yield* manager.wait([job.id]);
	assert.equal(failed.status, "error");
	assert.match(failed.error ?? "", /60 minutes of wall time/);

	const child = new FakeChild();
	yield* Deferred.succeed(creation, child as unknown as ChildSession);
	yield* yieldImmediate;
	yield* yieldImmediate;
	assert.equal(child.disposed, true);
	assert.deepEqual(child.prompts, []);
	yield* manager.shutdown();
})));

test("a stalled provider runs until the universal ceiling", (t) => Effect.runPromise(Effect.gen(function* () {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "provider stalls", ctx: context });
	yield* yieldImmediate;
	assert.equal(sessions.length, 1);

	t.mock.timers.tick(59 * 60_000);
	assert.equal(manager.list([job.id])[0].status, "running");
	t.mock.timers.tick(60_000);
	yield* yieldImmediate;
	const [failed] = yield* manager.wait([job.id]);
	assert.equal(failed.status, "error");
	assert.match(failed.error ?? "", /60 minutes of wall time/);
	yield* eventually(() => sessions[0].disposed);
	yield* manager.shutdown();
})));

test("prompt completion without an assistant response is an error", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({
		task: "empty provider response",
		ctx: context,
	});
	yield* eventually(() => sessions.length === 1);
	sessions[0].finishWithoutResponse();

	const [failed] = yield* manager.wait([job.id]);
	assert.equal(failed.status, "error");
	assert.match(failed.error ?? "", /without an assistant response.*Retry/);
	yield* manager.shutdown();
})));

test("all effort modes stop at the same sixty-minute ceiling", (t) => Effect.runPromise(Effect.gen(function* () {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const { manager, sessions } = harness();
	const jobs = [
		manager.spawn({ task: "bounded fast task", ctx: context }),
		manager.spawn({
			task: "bounded thorough task",
			effort: "thorough",
			ctx: context,
		}),
	];
	yield* yieldImmediate;
	for (const session of sessions) session.emitAssistantStart();

	t.mock.timers.tick(59 * 60_000);
	assert.equal(
		manager
			.list(jobs.map((job) => job.id))
			.every((job) => job.status === "running"),
		true,
	);
	t.mock.timers.tick(60_000);
	yield* yieldImmediate;
	const stopped = yield* manager.wait(jobs.map((job) => job.id));
	assert.equal(
		stopped.every((job) => job.status === "error"),
		true,
	);
	assert.equal(
		stopped.every((job) => /60 minutes of wall time/.test(job.error ?? "")),
		true,
	);
	yield* yieldImmediate;
	assert.equal(
		sessions.every((session) => session.disposed),
		true,
	);
	yield* manager.shutdown();
})));

test("all effort modes stop at sixty million reported tokens", () => Effect.runPromise(Effect.gen(function* () {
	const requests = [
		{ task: "fast token-heavy task", ctx: context },
		{
			task: "thorough token-heavy task",
			effort: "thorough",
			ctx: context,
		},
	] as const;

	for (const request of requests) {
		const { manager, sessions } = harness();
		const job = manager.spawn(request);
		yield* eventually(() => sessions.length === 1);

		sessions[0].emitAssistant("checkpoint", 59_999_999);
		assert.equal(manager.list([job.id])[0].status, "running");
		assert.equal(sessions[0].steeringStarted.length, 0);

		sessions[0].emitAssistant("hard checkpoint", 1);
		const [stopped] = yield* manager.wait([job.id]);
		assert.equal(stopped.status, "error");
		assert.equal(stopped.output, "hard checkpoint");
		assert.equal(stopped.childUsage.totalTokens, 60_000_000);
		assert.match(stopped.error ?? "", /60,000,000 reported tokens/);
		yield* eventually(() => sessions[0].disposed);
		yield* manager.shutdown();
	}
})));

test("a ceiling event delivered during subscription cannot revive a stopped run", () => Effect.runPromise(Effect.gen(function* () {
	class EventDuringSubscribeChild extends FakeChild {
		override subscribe(listener: (event: AgentSessionEvent) => void) {
			const unsubscribe = super.subscribe(listener);
			this.emitAssistant("ceiling checkpoint", MAX_EXECUTION_TOKENS);
			return unsubscribe;
		}
	}

	const child = new EventDuringSubscribeChild();
	const manager = new DelegateManager({
		createSession: () => Promise.resolve(child as unknown as ChildSession),
		shutdownSession() {
			child.disposeNow();
			return Promise.resolve();
		},
	});
	const job = manager.spawn({ task: "subscription race", ctx: context });

	const [failed] = yield* manager.wait([job.id]);
	assert.equal(failed.status, "error");
	assert.match(failed.error ?? "", /60,000,000 reported tokens/);
	yield* yieldImmediate;
	assert.deepEqual(child.prompts, []);
	yield* eventually(() => child.disposed);
	yield* manager.shutdown();
})));

test("cancellation releases prompts that ignore child abort", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const jobs = Array.from({ length: 4 }, (_, index) =>
		manager.spawn({ task: `stuck prompt ${index}`, ctx: context }),
	);
	yield* eventually(() => sessions.length === 4);
	for (const session of sessions) session.abortLeavesRunning = true;
	yield* manager.cancel(jobs.map((job) => job.id));

	const later = manager.spawn({ task: "later", ctx: context });
	yield* eventually(() => sessions.length === 5);
	assert.equal(manager.list([later.id])[0].status, "running");
	sessions[4].finish("done");
	yield* manager.wait([later.id]);
	yield* manager.shutdown();
})));

test("teardown timeout falls back to local disposal and diagnoses", (t) => Effect.runPromise(Effect.gen(function* () {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const diagnostics: string[] = [];
	const originalLog = console.log;
	console.log = (...values: unknown[]) =>
		diagnostics.push(values.map(String).join(" "));
	const teardown = yield* Deferred.make<void>();
	const { manager, sessions } = harness(undefined, () =>
		Deferred.await(teardown),
	);
	const job = manager.spawn({ task: "teardown hangs", ctx: context });
	yield* yieldImmediate;
	assert.equal(sessions.length, 1);

	try {
		const cancelling = yield* manager.cancel([job.id]).pipe(Effect.forkChild);
		yield* yieldImmediate;
		t.mock.timers.tick(16_000);
		const [cancelled] = yield* Fiber.join(cancelling);
		assert.equal(cancelled.status, "cancelled");
		assert.equal(sessions[0].disposed, true);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0], /delegate-1.*timed out after 16000ms/);
	} finally {
		console.log = originalLog;
	}
	yield* manager.shutdown();
})));

test("teardown rejection falls back to local disposal and diagnoses", () => Effect.runPromise(Effect.gen(function* () {
	const diagnostics: string[] = [];
	const originalLog = console.log;
	console.log = (...values: unknown[]) =>
		diagnostics.push(values.map(String).join(" "));
	const { manager, sessions } = harness(undefined, () =>
		Effect.die(new Error("shutdown transport failed")),
	);
	const job = manager.spawn({ task: "teardown rejects", ctx: context });
	yield* eventually(() => sessions.length === 1);

	try {
		const [cancelled] = yield* manager.cancel([job.id]);
		assert.equal(cancelled.status, "cancelled");
		assert.equal(sessions[0].disposed, true);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0], /delegate-1.*shutdown transport failed/);
	} finally {
		console.log = originalLog;
	}
	yield* manager.shutdown();
})));

test("rejected child prompt settles, remains inspectable, and releases capacity", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const failed = manager.spawn({ task: "transport fails", ctx: context });
	yield* eventually(() => sessions.at(0)?.prompts.length === 1);
	sessions[0].emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "partial activity" }],
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { total: 0.0123 },
			},
		},
	} as AgentSessionEvent);
	assert.deepEqual(manager.sessionUsage(), { tokens: 3, cost: 0.0123 });
	sessions[0].rejectPrompt(new Error("prompt transport rejected"));

	const [snapshot] = yield* manager.wait([failed.id]);
	assert.equal(snapshot.status, "error");
	assert.equal(snapshot.error, "prompt transport rejected");
	assert.equal(snapshot.output, "partial activity");
	assert.equal(manager.list([failed.id])[0].error, "prompt transport rejected");
	yield* eventually(() => sessions[0].disposed);

	const next = manager.spawn({ task: "capacity is free", ctx: context });
	yield* eventually(() => sessions.at(1)?.prompts.length === 1);
	assert.equal(manager.list([next.id])[0].status, "running");
	sessions[1].finish("done");
	yield* manager.wait([next.id]);
	yield* manager.shutdown();
})));

test("interrupted waits leave children running and explicit cancel stops them", () => {
	const controller = new AbortController();
	return Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "long", ctx: context });
	yield* eventually(() => sessions.length === 1);
	const waiting = yield* Effect.forkChild(manager.wait([job.id], controller.signal));
	controller.abort(new Error("stop waiting"));
	const interrupted = yield* failureMessage(Fiber.join(waiting));
	assert.match(interrupted, /stop waiting/);
	assert.equal(manager.list([job.id])[0].status, "running");

	const [cancelled] = yield* manager.cancel([job.id]);
	assert.equal(cancelled.status, "cancelled");
	yield* manager.shutdown();
	}));
});

test("an interrupted background wait restores delivery for the same run", () => {
	const controller = new AbortController();
	return Effect.runPromise(Effect.gen(function* () {
	const delivered: DelegateSnapshot[] = [];
	const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
	const job = manager.spawn({
		task: "background",
		background: true,
		ctx: context,
	});
	yield* eventually(() => sessions.length === 1);
	const waiting = yield* Effect.forkChild(manager.wait([job.id], controller.signal));
	controller.abort(new Error("stop waiting"));
	sessions[0].finish("raced result");

	const interrupted = yield* failureMessage(Fiber.join(waiting));
	assert.match(interrupted, /stop waiting/);
	yield* eventually(() => delivered.length === 1);
	assert.equal(delivered[0].output, "raced result");
	assert.equal(manager.list([job.id])[0].status, "done");
	yield* manager.shutdown();
	}));
});

test("a successful concurrent wait prevents an aborted wait from restoring delivery", () => {
	const controller = new AbortController();
	return Effect.runPromise(Effect.gen(function* () {
	const delivered: DelegateSnapshot[] = [];
	const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
	const job = manager.spawn({
		task: "background",
		background: true,
		ctx: context,
	});
	yield* eventually(() => sessions.length === 1);
	const aborted = yield* Effect.forkChild(manager.wait([job.id], controller.signal));
	const successful = yield* manager.wait([job.id]).pipe(Effect.forkChild);
	yield* yieldImmediate;
	controller.abort(new Error("stop one wait"));
	sessions[0].finish("result");

	const interrupted = yield* failureMessage(Fiber.join(aborted));
	assert.match(interrupted, /stop one wait/);
	yield* Fiber.join(successful);
	assert.equal(delivered.length, 0);
	yield* manager.shutdown();
	}));
});

test("cancel consumption wins over an aborted concurrent wait", () => {
	const controller = new AbortController();
	return Effect.runPromise(Effect.gen(function* () {
	const delivered: DelegateSnapshot[] = [];
	const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
	const job = manager.spawn({
		task: "background",
		background: true,
		ctx: context,
	});
	yield* eventually(() => sessions.length === 1);
	const abortGate = yield* Deferred.make<void>();
	sessions[0].abortGate = abortGate;
	const waiting = yield* Effect.forkChild(manager.wait([job.id], controller.signal));
	const cancelling = yield* manager.cancel([job.id]).pipe(Effect.forkChild);
	controller.abort(new Error("stop waiting"));
	yield* Deferred.succeed(abortGate, undefined);

	const interrupted = yield* failureMessage(Fiber.join(waiting));
	assert.match(interrupted, /stop waiting/);
	const [cancelled] = yield* Fiber.join(cancelling);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(delivered.length, 0);
	yield* manager.shutdown();
	}));
});

test("shutdown wins once child settlement races an owned stop", () => Effect.runPromise(Effect.gen(function* () {
	const delivered: DelegateSnapshot[] = [];
	const terminalNotifications: DelegateSnapshot[] = [];
	let disposals = 0;
	const { manager, sessions } = harness(
		(snapshot) => delivered.push(snapshot),
		() => Effect.sync(() => {
			disposals++;
		}),
	);
	manager.subscribe((snapshot) => {
		if (snapshot.status !== "running") terminalNotifications.push(snapshot);
	});
	const job = manager.spawn({
		task: "settle during shutdown",
		background: true,
		ctx: context,
	});
	yield* eventually(() => sessions.length === 1);
	const abortGate = yield* Deferred.make<void>();
	sessions[0].abortGate = abortGate;

	const shutdown = yield* manager.shutdown().pipe(Effect.forkChild);
	yield* eventually(() => sessions[0].abortCalls === 1);
	sessions[0].finish("too late");
	yield* Deferred.succeed(abortGate, undefined);
	yield* Fiber.join(shutdown);

	const [snapshot] = manager.list([job.id]);
	assert.equal(snapshot.status, "cancelled");
	assert.equal(snapshot.output, "too late");
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0].status, "cancelled");
	assert.equal(terminalNotifications.length, 1);
	assert.equal(terminalNotifications[0].status, "cancelled");
	assert.equal(disposals, 1);
})));

test("concurrent shutdown joins gated child disposal", () => Effect.runPromise(Effect.gen(function* () {
	const disposalGate = yield* Deferred.make<void>();
	let disposalStarted = false;
	const { manager, sessions } = harness(undefined, () => {
		disposalStarted = true;
		return Deferred.await(disposalGate);
	});
	manager.spawn({ task: "shutdown twice", ctx: context });
	yield* eventually(() => sessions.length === 1);

	let firstSettled = false;
	let secondSettled = false;
	const first = yield* manager.shutdown().pipe(
		Effect.ensuring(Effect.sync(() => (firstSettled = true))), Effect.forkChild,
	);
	const second = yield* manager.shutdown().pipe(
		Effect.ensuring(Effect.sync(() => (secondSettled = true))), Effect.forkChild,
	);
	yield* eventually(() => disposalStarted);
	assert.equal(firstSettled, false);
	assert.equal(secondSettled, false);
	yield* Deferred.succeed(disposalGate, undefined);
	yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
	assert.equal(firstSettled, true);
	assert.equal(secondSettled, true);
	yield* manager.shutdown();
})));

test("concurrent cancellation joins the in-progress stop", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "cancel twice", ctx: context });
	yield* eventually(() => sessions.length === 1);
	const abortGate = yield* Deferred.make<void>();
	sessions[0].abortGate = abortGate;
	const first = yield* manager.cancel([job.id]).pipe(Effect.forkChild);
	const second = yield* manager.cancel([job.id]).pipe(Effect.forkChild);
	yield* Deferred.succeed(abortGate, undefined);

	assert.equal((yield* Fiber.join(first))[0].status, "cancelled");
	assert.equal((yield* Fiber.join(second))[0].status, "cancelled");
	yield* manager.shutdown();
})));

test("an interrupted cancel does not poison the shared stop", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "interrupted cancel", ctx: context });
	yield* eventually(() => sessions.length === 1);
	const abortGate = yield* Deferred.make<void>();
	sessions[0].abortGate = abortGate;
	const first = yield* manager.cancel([job.id]).pipe(Effect.forkChild);
	yield* eventually(() => sessions[0].abortCalls === 1);
	yield* Fiber.interrupt(first);
	const second = yield* manager.cancel([job.id]).pipe(Effect.forkChild);
	yield* Deferred.succeed(abortGate, undefined);
	assert.equal((yield* Fiber.join(second))[0].status, "cancelled");
	yield* manager.shutdown();
})));

test("cancellation waits for an existing child to be disposed", () => Effect.runPromise(Effect.gen(function* () {
	const disposalGate = yield* Deferred.make<void>();
	let disposalStarted = false;
	const { manager, sessions } = harness(undefined, () => {
		disposalStarted = true;
		return Deferred.await(disposalGate);
	});
	const job = manager.spawn({ task: "cancel and dispose", ctx: context });
	yield* eventually(() => sessions.length === 1);

	let settled = false;
	const cancelling = yield* manager.cancel([job.id]).pipe(
		Effect.ensuring(Effect.sync(() => (settled = true))), Effect.forkChild,
	);
	yield* eventually(() => disposalStarted);
	assert.equal(settled, false);
	yield* Deferred.succeed(disposalGate, undefined);
	assert.equal((yield* Fiber.join(cancelling))[0].status, "cancelled");
	yield* manager.shutdown();
})));

test("an uncooperative cancelled child is disposed", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "stuck", ctx: context });
	yield* eventually(() => sessions.length === 1);
	sessions[0].abortLeavesRunning = true;

	const [cancelled] = yield* manager.cancel([job.id]);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(sessions[0].disposed, true);
	yield* manager.shutdown();
})));

test("send steers only a running child", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const running = manager.spawn({ task: "running", ctx: context });
	yield* eventually(() => sessions.length === 1);

	yield* manager.send(running.id, "focus here");
	assert.deepEqual(sessions[0].steering, ["focus here"]);
	sessions[0].finish("done");
	yield* manager.wait([running.id]);
	const rejected = yield* failureMessage(manager.send(running.id, "late"));
	assert.match(rejected, /send requires a running child/);
	yield* manager.shutdown();
})));

test("cancellation settles all gated sends", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "gated steering", ctx: context });
	yield* eventually(() => sessions.length === 1);
	sessions[0].steerGate = yield* Deferred.make<void>();
	const sends = yield* Effect.all(
		Array.from({ length: 8 }, (_, index) => manager.send(job.id, `message ${index}`).pipe(Effect.exit, Effect.forkChild)),
	);
	yield* eventually(() => sessions[0].steeringStarted.length === 1);

	yield* manager.cancel([job.id]);
	const results = yield* Effect.all(sends.map(Fiber.join));
	assert.equal(
		results.every((result) => result._tag === "Failure"),
		true,
	);
	assert.deepEqual(sessions[0].steeringStarted, ["message 0"]);
	yield* manager.shutdown();
})));

test("stalled steering remains owned until the universal ceiling", (t) => Effect.runPromise(Effect.gen(function* () {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "timed steering", ctx: context });
	yield* yieldImmediate;
	sessions[0].emitAssistantStart();
	sessions[0].steerGate = yield* Deferred.make<void>();
	const sending = yield* Effect.forkChild(manager.send(job.id, "stalled"));
	yield* yieldImmediate;

	t.mock.timers.tick(59 * 60_000);
	assert.equal(manager.list([job.id])[0].status, "running");
	t.mock.timers.tick(60_000);
	const interrupted = yield* failureMessage(Fiber.join(sending));
	assert.match(interrupted, /60 minutes of wall time/);
	const [stopped] = yield* manager.wait([job.id]);
	assert.equal(stopped.status, "error");
	yield* manager.shutdown();
})));

test("queued sends do not reach a settled child", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "initial", ctx: context });
	yield* eventually(() => sessions.length === 1);
	const steerGate = yield* Deferred.make<void>();
	sessions[0].steerGate = steerGate;
	const first = yield* manager.send(job.id, "first").pipe(Effect.forkChild);
	yield* eventually(() => sessions[0].steeringStarted.length === 1);
	const stale = yield* manager.send(job.id, "stale").pipe(Effect.forkChild);
	yield* yieldImmediate;
	sessions[0].finish("done");
	yield* manager.wait([job.id]);
	yield* Deferred.succeed(steerGate, undefined);

	const firstError = yield* failureMessage(Fiber.join(first));
	assert.match(firstError, /ownership ended/);
	const staleError = yield* failureMessage(Fiber.join(stale));
	assert.match(staleError, /settled before the queued message/);
	assert.deepEqual(sessions[0].steering, ["first"]);
	yield* manager.shutdown();
})));

test("pending sends are capped", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "running", ctx: context });
	yield* eventually(() => sessions.length === 1);
	const steerGate = yield* Deferred.make<void>();
	sessions[0].steerGate = steerGate;
	const sends = yield* Effect.all(
		Array.from({ length: 8 }, (_, index) => Effect.forkChild(manager.send(job.id, `message ${index}`))),
	);
	yield* yieldImmediate;
	const overflow = yield* failureMessage(manager.send(job.id, "overflow"));
	assert.match(overflow, /8 pending messages/);
	yield* Deferred.succeed(steerGate, undefined);
	yield* Effect.all(sends.map(Fiber.join));
	sessions[0].finish("done");
	yield* manager.wait([job.id]);
	yield* manager.shutdown();
})));

test("output format guides without enforcing the final response", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({
		task: "collect evidence",
		outputFormat: "Return JSON with a findings array.",
		ctx: context,
	});
	yield* eventually(() => sessions.length === 1);
	assert.match(sessions[0].prompts[0], /Preferred output format \(advisory\)/);
	assert.match(sessions[0].prompts[0], /Return JSON with a findings array/);
	assert.match(sessions[0].prompts[0], /correct and complete information/);

	sessions[0].finish("The useful evidence does not fit that shape.");
	const [result] = yield* manager.wait([job.id]);
	assert.equal(result.status, "done");
	assert.equal(result.output, "The useful evidence does not fit that shape.");
	yield* manager.shutdown();
})));

test("archives complete oversized child output until parent shutdown", () => Effect.runPromise(Effect.gen(function* () {
	const { manager, sessions } = harness();
	const job = manager.spawn({
		task: "Return a large report.",
		ctx: context,
	});
	yield* eventually(() => sessions.length === 1);
	const report = "é".repeat(MAX_CHILD_OUTPUT_BYTES);
	sessions[0].finish(report);

	const [result] = yield* manager.wait([job.id]);
	assert.equal(result.outputTruncated, true);
	const outputFile = result.fullOutputFile;
	assert.ok(outputFile);
	assert.match(result.output, /full output saved to:/);
	assert.equal(
		yield* Effect.promise(() => readFile(outputFile, "utf8")),
		report,
	);

	const savedOutput = outputFile;
	yield* manager.shutdown();
	const missing = yield* Effect.tryPromise(() =>
		readFile(savedOutput, "utf8"),
	).pipe(Effect.flip);
	assert.equal((missing.cause as { code?: string }).code, "ENOENT");
})));

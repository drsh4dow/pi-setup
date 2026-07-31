import assert from "node:assert/strict";

const { readFile } = process.getBuiltinModule("fs/promises");

import test from "node:test";
import type {
	AgentSessionEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

const runEffect = Effect.runPromise;

import { type DelegateSnapshot, MAX_CHILD_OUTPUT_BYTES } from "../contract.ts";
import { DelegateManager, type DelegateRequest } from "../manager.ts";
import type { ChildSession } from "../runtime.ts";
import { eventually } from "./eventually.ts";

const context = {
	cwd: process.cwd(),
	model: { provider: "test", id: "model" },
	modelRegistry: {
		find: () => undefined,
		hasConfiguredAuth: () => true,
	},
} as unknown as ExtensionContext;

class FakeChild {
	readonly model = { provider: "test", id: "child" };
	readonly prompts: string[] = [];
	readonly steering: string[] = [];
	readonly steeringStarted: string[] = [];
	isStreaming = false;
	disposed = false;
	abortLeavesRunning: boolean = false;
	abortGate?: Promise<void>;
	steerGate?: Promise<void>;
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	private promptResolve?: () => void;
	private promptReject?: (error: Error) => void;

	prompt(text: string) {
		this.prompts.push(text);
		this.isStreaming = true;
		return new Promise<void>((resolve, reject) => {
			this.promptResolve = resolve;
			this.promptReject = reject;
		});
	}

	async steer(text: string) {
		this.steeringStarted.push(text);
		await this.steerGate;
		this.steering.push(text);
	}

	async abort() {
		await this.abortGate;
		if (this.abortLeavesRunning) return;
		this.isStreaming = false;
		this.promptResolve?.();
		this.promptResolve = undefined;
	}

	disposeNow() {
		this.disposed = true;
		this.isStreaming = false;
		this.promptResolve?.();
		this.promptResolve = undefined;
	}

	dispose() {
		this.disposeNow();
	}

	rejectPrompt(error: Error) {
		this.isStreaming = false;
		this.promptReject?.(error);
		this.promptResolve = undefined;
		this.promptReject = undefined;
	}

	emitAssistantStart() {
		this.emit({
			type: "message_start",
			message: { role: "assistant", content: [] },
		} as unknown as AgentSessionEvent);
	}

	emitAssistant(
		output: string,
		totalTokens: number,
		stopReason: "stop" | "toolUse" = "toolUse",
	) {
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: output }],
				stopReason,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens,
					cost: { total: 0.001 },
				},
			},
		} as AgentSessionEvent);
	}

	finishWithoutResponse() {
		this.isStreaming = false;
		this.promptResolve?.();
		this.promptResolve = undefined;
		this.promptReject = undefined;
	}

	finish(output: string, totalTokens = 15) {
		this.emitAssistant(output, totalTokens, "stop");
		this.isStreaming = false;
		this.promptResolve?.();
		this.promptResolve = undefined;
		this.promptReject = undefined;
	}

	subscribe(listener: (event: AgentSessionEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent) {
		for (const listener of this.listeners) listener(event);
	}
}

function harness(
	onSettled?: (snapshot: DelegateSnapshot) => void,
	beforeShutdown?: (child: FakeChild) => Promise<void>,
) {
	const sessions: FakeChild[] = [];
	const shutdown: FakeChild[] = [];
	const requests: DelegateRequest[] = [];
	const manager = new DelegateManager({
		onSettled,
		async createSession(request) {
			requests.push(request);
			const child = new FakeChild();
			setImmediate(() => sessions.push(child));
			return child as unknown as ChildSession;
		},
		async shutdownSession(child) {
			const fake = child as unknown as FakeChild;
			await beforeShutdown?.(fake);
			fake.disposeNow();
			shutdown.push(fake);
		},
	});
	return { manager, sessions, shutdown, requests };
}

test("wait admission is atomic, bounded per child, and releases capacity", async () => {
	const { manager, sessions } = harness();
	const first = manager.spawn({ task: "first", ctx: context });
	const second = manager.spawn({ task: "second", ctx: context });
	await runEffect(eventually(() => sessions.length === 2));
	const waits = Array.from({ length: 4 }, () =>
		runEffect(manager.wait([first.id])),
	);
	await assert.rejects(
		runEffect(manager.wait([first.id, second.id])),
		/4 pending waits/,
	);
	sessions[0].finish("done");
	await Promise.all(waits);
	const available = runEffect(manager.wait([first.id, second.id]));
	sessions[1].finish("done");
	await available;
	await runEffect(manager.shutdown());
});

test("starts every run immediately without aggregate scheduling", async () => {
	const { manager, sessions } = harness();
	const jobs = Array.from({ length: 40 }, (_, index) =>
		manager.spawn({ task: `parallel task ${index}`, ctx: context }),
	);
	await runEffect(eventually(() => sessions.length === jobs.length));
	assert.ok(manager.list().every((snapshot) => snapshot.status === "running"));

	await runEffect(manager.cancel(jobs.map((job) => job.id)));
	await runEffect(manager.shutdown());
});

test("the universal ceiling owns a child created after settlement", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let resolveCreation!: (child: ChildSession) => void;
	const manager = new DelegateManager({
		createSession() {
			return new Promise<ChildSession>((resolve) => {
				resolveCreation = resolve;
			});
		},
		async shutdownSession(child) {
			(child as unknown as FakeChild).disposeNow();
		},
	});
	const job = manager.spawn({ task: "creation hangs", ctx: context });
	await new Promise<void>((resolve) => setImmediate(resolve));

	t.mock.timers.tick(60 * 60_000);
	const [failed] = await runEffect(manager.wait([job.id]));
	assert.equal(failed.status, "error");
	assert.match(failed.error ?? "", /60 minutes of wall time/);

	const child = new FakeChild();
	resolveCreation(child as unknown as ChildSession);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(child.disposed, true);
	assert.deepEqual(child.prompts, []);
	await runEffect(manager.shutdown());
});

test("a stalled provider runs until the universal ceiling", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "provider stalls", ctx: context });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sessions.length, 1);

	t.mock.timers.tick(59 * 60_000);
	assert.equal(manager.list([job.id])[0].status, "running");
	t.mock.timers.tick(60_000);
	const [failed] = await runEffect(manager.wait([job.id]));
	assert.equal(failed.status, "error");
	assert.match(failed.error ?? "", /60 minutes of wall time/);
	await runEffect(eventually(() => sessions[0].disposed));
	await runEffect(manager.shutdown());
});

test("prompt completion without an assistant response is an error", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "empty provider response", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));
	sessions[0].finishWithoutResponse();

	const [failed] = await runEffect(manager.wait([job.id]));
	assert.equal(failed.status, "error");
	assert.match(failed.error ?? "", /without an assistant response.*Retry/);
	await runEffect(manager.shutdown());
});

test("all effort modes stop at the same sixty-minute ceiling", async (t) => {
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
	await new Promise<void>((resolve) => setImmediate(resolve));
	for (const session of sessions) session.emitAssistantStart();

	t.mock.timers.tick(59 * 60_000);
	assert.equal(
		manager
			.list(jobs.map((job) => job.id))
			.every((job) => job.status === "running"),
		true,
	);
	t.mock.timers.tick(60_000);
	const stopped = await runEffect(manager.wait(jobs.map((job) => job.id)));
	assert.equal(
		stopped.every((job) => job.status === "error"),
		true,
	);
	assert.equal(
		stopped.every((job) => /60 minutes of wall time/.test(job.error ?? "")),
		true,
	);
	assert.equal(
		sessions.every((session) => session.disposed),
		true,
	);
	await runEffect(manager.shutdown());
});

test("all effort modes stop at sixty million reported tokens", async () => {
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
		await runEffect(eventually(() => sessions.length === 1));

		sessions[0].emitAssistant("checkpoint", 59_999_999);
		assert.equal(manager.list([job.id])[0].status, "running");
		assert.equal(sessions[0].steeringStarted.length, 0);

		sessions[0].emitAssistant("hard checkpoint", 1);
		const [stopped] = await runEffect(manager.wait([job.id]));
		assert.equal(stopped.status, "error");
		assert.equal(stopped.output, "hard checkpoint");
		assert.equal(stopped.childUsage.totalTokens, 60_000_000);
		assert.match(stopped.error ?? "", /60,000,000 reported tokens/);
		assert.equal(sessions[0].disposed, true);
		await runEffect(manager.shutdown());
	}
});

test("cancellation releases prompts that ignore child abort", async () => {
	const { manager, sessions } = harness();
	const jobs = Array.from({ length: 4 }, (_, index) =>
		manager.spawn({ task: `stuck prompt ${index}`, ctx: context }),
	);
	await runEffect(eventually(() => sessions.length === 4));
	for (const session of sessions) session.abortLeavesRunning = true;
	await runEffect(manager.cancel(jobs.map((job) => job.id)));

	const later = manager.spawn({ task: "later", ctx: context });
	await runEffect(eventually(() => sessions.length === 5));
	assert.equal(manager.list([later.id])[0].status, "running");
	sessions[4].finish("done");
	await runEffect(manager.wait([later.id]));
	await runEffect(manager.shutdown());
});

test("teardown timeout falls back to local disposal and diagnoses", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const diagnostics: string[] = [];
	const originalLog = console.log;
	console.log = (...values: unknown[]) =>
		diagnostics.push(values.map(String).join(" "));
	const { manager, sessions } = harness(
		undefined,
		() => new Promise<void>(() => {}),
	);
	const job = manager.spawn({ task: "teardown hangs", ctx: context });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sessions.length, 1);

	try {
		const cancelling = runEffect(manager.cancel([job.id]));
		await new Promise<void>((resolve) => setImmediate(resolve));
		t.mock.timers.tick(16_000);
		const [cancelled] = await cancelling;
		assert.equal(cancelled.status, "cancelled");
		assert.equal(sessions[0].disposed, true);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0], /delegate-1.*timed out after 16000ms/);
	} finally {
		console.log = originalLog;
	}
	await runEffect(manager.shutdown());
});

test("teardown rejection falls back to local disposal and diagnoses", async () => {
	const diagnostics: string[] = [];
	const originalLog = console.log;
	console.log = (...values: unknown[]) =>
		diagnostics.push(values.map(String).join(" "));
	const { manager, sessions } = harness(undefined, async () => {
		throw new Error("shutdown transport failed");
	});
	const job = manager.spawn({ task: "teardown rejects", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));

	try {
		const [cancelled] = await runEffect(manager.cancel([job.id]));
		assert.equal(cancelled.status, "cancelled");
		assert.equal(sessions[0].disposed, true);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0], /delegate-1.*shutdown transport failed/);
	} finally {
		console.log = originalLog;
	}
	await runEffect(manager.shutdown());
});

test("rejected child prompt settles, remains inspectable, and releases capacity", async () => {
	const { manager, sessions } = harness();
	const failed = manager.spawn({ task: "transport fails", ctx: context });
	await runEffect(eventually(() => sessions.at(0)?.prompts.length === 1));
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

	const [snapshot] = await runEffect(manager.wait([failed.id]));
	assert.equal(snapshot.status, "error");
	assert.equal(snapshot.error, "prompt transport rejected");
	assert.equal(snapshot.output, "partial activity");
	assert.equal(manager.list([failed.id])[0].error, "prompt transport rejected");
	await runEffect(eventually(() => sessions[0].disposed));

	const next = manager.spawn({ task: "capacity is free", ctx: context });
	await runEffect(eventually(() => sessions.at(1)?.prompts.length === 1));
	assert.equal(manager.list([next.id])[0].status, "running");
	sessions[1].finish("done");
	await runEffect(manager.wait([next.id]));
	await runEffect(manager.shutdown());
});

test("interrupted waits leave children running and explicit cancel stops them", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "long", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));
	const controller = new AbortController();
	const waiting = runEffect(manager.wait([job.id], controller.signal));
	controller.abort(new Error("stop waiting"));
	await assert.rejects(waiting, /stop waiting/);
	assert.equal(manager.list([job.id])[0].status, "running");

	const [cancelled] = await runEffect(manager.cancel([job.id]));
	assert.equal(cancelled.status, "cancelled");
	await runEffect(manager.shutdown());
});

test("an interrupted background wait restores delivery for the same run", async () => {
	const delivered: DelegateSnapshot[] = [];
	const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
	const job = manager.spawn({
		task: "background",
		background: true,
		ctx: context,
	});
	await runEffect(eventually(() => sessions.length === 1));
	const controller = new AbortController();
	const waiting = runEffect(manager.wait([job.id], controller.signal));
	controller.abort(new Error("stop waiting"));
	sessions[0].finish("raced result");

	await assert.rejects(waiting, /stop waiting/);
	await runEffect(eventually(() => delivered.length === 1));
	assert.equal(delivered[0].output, "raced result");
	assert.equal(manager.list([job.id])[0].status, "done");
	await runEffect(manager.shutdown());
});

test("a successful concurrent wait prevents an aborted wait from restoring delivery", async () => {
	const delivered: DelegateSnapshot[] = [];
	const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
	const job = manager.spawn({
		task: "background",
		background: true,
		ctx: context,
	});
	await runEffect(eventually(() => sessions.length === 1));
	const controller = new AbortController();
	const aborted = runEffect(manager.wait([job.id], controller.signal));
	const successful = runEffect(manager.wait([job.id]));
	controller.abort(new Error("stop one wait"));
	sessions[0].finish("result");

	await assert.rejects(aborted, /stop one wait/);
	await successful;
	assert.equal(delivered.length, 0);
	await runEffect(manager.shutdown());
});

test("cancel consumption wins over an aborted concurrent wait", async () => {
	const delivered: DelegateSnapshot[] = [];
	const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
	const job = manager.spawn({
		task: "background",
		background: true,
		ctx: context,
	});
	await runEffect(eventually(() => sessions.length === 1));
	let releaseAbort!: () => void;
	sessions[0].abortGate = new Promise<void>((resolve) => {
		releaseAbort = resolve;
	});
	const controller = new AbortController();
	const waiting = runEffect(manager.wait([job.id], controller.signal));
	const cancelling = runEffect(manager.cancel([job.id]));
	controller.abort(new Error("stop waiting"));
	releaseAbort();

	await assert.rejects(waiting, /stop waiting/);
	const [cancelled] = await cancelling;
	assert.equal(cancelled.status, "cancelled");
	assert.equal(delivered.length, 0);
	await runEffect(manager.shutdown());
});

test("concurrent shutdown joins gated child disposal", async () => {
	let releaseDisposal!: () => void;
	const disposalGate = new Promise<void>((resolve) => {
		releaseDisposal = resolve;
	});
	let disposalStarted = false;
	const { manager, sessions } = harness(undefined, async () => {
		disposalStarted = true;
		await disposalGate;
	});
	manager.spawn({ task: "shutdown twice", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));

	let firstSettled = false;
	let secondSettled = false;
	const first = runEffect(manager.shutdown()).finally(() => {
		firstSettled = true;
	});
	const second = runEffect(manager.shutdown()).finally(() => {
		secondSettled = true;
	});
	await runEffect(eventually(() => disposalStarted));
	assert.equal(firstSettled, false);
	assert.equal(secondSettled, false);
	releaseDisposal();
	await Promise.all([first, second]);
	assert.equal(firstSettled, true);
	assert.equal(secondSettled, true);
	await runEffect(manager.shutdown());
});

test("concurrent cancellation joins the in-progress stop", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "cancel twice", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));
	let releaseAbort!: () => void;
	sessions[0].abortGate = new Promise<void>((resolve) => {
		releaseAbort = resolve;
	});
	const first = runEffect(manager.cancel([job.id]));
	const second = runEffect(manager.cancel([job.id]));
	releaseAbort();

	assert.equal((await first)[0].status, "cancelled");
	assert.equal((await second)[0].status, "cancelled");
	await runEffect(manager.shutdown());
});

test("cancellation waits for an existing child to be disposed", async () => {
	let releaseDisposal!: () => void;
	const disposalGate = new Promise<void>((resolve) => {
		releaseDisposal = resolve;
	});
	let disposalStarted = false;
	const { manager, sessions } = harness(undefined, async () => {
		disposalStarted = true;
		await disposalGate;
	});
	const job = manager.spawn({ task: "cancel and dispose", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));

	let settled = false;
	const cancelling = runEffect(manager.cancel([job.id])).finally(() => {
		settled = true;
	});
	await runEffect(eventually(() => disposalStarted));
	assert.equal(settled, false);
	releaseDisposal();
	assert.equal((await cancelling)[0].status, "cancelled");
	await runEffect(manager.shutdown());
});

test("an uncooperative cancelled child is disposed", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "stuck", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));
	sessions[0].abortLeavesRunning = true;

	const [cancelled] = await runEffect(manager.cancel([job.id]));
	assert.equal(cancelled.status, "cancelled");
	assert.equal(sessions[0].disposed, true);
	await runEffect(manager.shutdown());
});

test("send steers only a running child", async () => {
	const { manager, sessions } = harness();
	const running = manager.spawn({ task: "running", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));

	await runEffect(manager.send(running.id, "focus here"));
	assert.deepEqual(sessions[0].steering, ["focus here"]);
	sessions[0].finish("done");
	await runEffect(manager.wait([running.id]));
	await assert.rejects(
		runEffect(manager.send(running.id, "late")),
		/send requires a running child/,
	);
	await runEffect(manager.shutdown());
});

test("cancellation settles all gated sends", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "gated steering", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));
	sessions[0].steerGate = new Promise<void>(() => {});
	const sends = Array.from({ length: 8 }, (_, index) =>
		runEffect(manager.send(job.id, `message ${index}`)),
	);
	const settled = Promise.allSettled(sends);
	await runEffect(eventually(() => sessions[0].steeringStarted.length === 1));

	await runEffect(manager.cancel([job.id]));
	const results = await settled;
	assert.equal(
		results.every((result) => result.status === "rejected"),
		true,
	);
	assert.deepEqual(sessions[0].steeringStarted, ["message 0"]);
	await runEffect(manager.shutdown());
});

test("stalled steering remains owned until the universal ceiling", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "timed steering", ctx: context });
	await new Promise<void>((resolve) => setImmediate(resolve));
	sessions[0].emitAssistantStart();
	sessions[0].steerGate = new Promise<void>(() => {});
	const sending = runEffect(manager.send(job.id, "stalled"));
	await new Promise<void>((resolve) => setImmediate(resolve));

	t.mock.timers.tick(59 * 60_000);
	assert.equal(manager.list([job.id])[0].status, "running");
	t.mock.timers.tick(60_000);
	await assert.rejects(sending, /60 minutes of wall time/);
	const [stopped] = await runEffect(manager.wait([job.id]));
	assert.equal(stopped.status, "error");
	await runEffect(manager.shutdown());
});

test("queued sends do not reach a settled child", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "initial", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));
	let releaseSteer!: () => void;
	sessions[0].steerGate = new Promise<void>((resolve) => {
		releaseSteer = resolve;
	});
	const first = runEffect(manager.send(job.id, "first"));
	await runEffect(eventually(() => sessions[0].steeringStarted.length === 1));
	const stale = runEffect(manager.send(job.id, "stale"));
	sessions[0].finish("done");
	await runEffect(manager.wait([job.id]));
	releaseSteer();

	await assert.rejects(first, /ownership ended/);
	await assert.rejects(stale, /settled before the queued message/);
	assert.deepEqual(sessions[0].steering, ["first"]);
	await runEffect(manager.shutdown());
});

test("pending sends are capped", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "running", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));
	let releaseSteer!: () => void;
	sessions[0].steerGate = new Promise<void>((resolve) => {
		releaseSteer = resolve;
	});
	const sends = Array.from({ length: 8 }, (_, index) =>
		runEffect(manager.send(job.id, `message ${index}`)),
	);
	await assert.rejects(
		runEffect(manager.send(job.id, "overflow")),
		/8 pending messages/,
	);
	releaseSteer();
	await Promise.all(sends);
	sessions[0].finish("done");
	await runEffect(manager.wait([job.id]));
	await runEffect(manager.shutdown());
});

test("output format guides without enforcing the final response", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({
		task: "collect evidence",
		outputFormat: "Return JSON with a findings array.",
		ctx: context,
	});
	await runEffect(eventually(() => sessions.length === 1));
	assert.match(sessions[0].prompts[0], /Preferred output format \(advisory\)/);
	assert.match(sessions[0].prompts[0], /Return JSON with a findings array/);
	assert.match(sessions[0].prompts[0], /correct and complete information/);

	sessions[0].finish("The useful evidence does not fit that shape.");
	const [result] = await runEffect(manager.wait([job.id]));
	assert.equal(result.status, "done");
	assert.equal(result.output, "The useful evidence does not fit that shape.");
	await runEffect(manager.shutdown());
});

test("archives complete oversized child output until parent shutdown", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "Return a large report.", ctx: context });
	await runEffect(eventually(() => sessions.length === 1));
	const report = "é".repeat(MAX_CHILD_OUTPUT_BYTES);
	sessions[0].finish(report);

	const [result] = await runEffect(manager.wait([job.id]));
	assert.equal(result.outputTruncated, true);
	assert.ok(result.fullOutputFile);
	assert.match(result.output, /full output saved to:/);
	assert.equal(await readFile(result.fullOutputFile, "utf8"), report);

	const savedOutput = result.fullOutputFile;
	await runEffect(manager.shutdown());
	await assert.rejects(readFile(savedOutput, "utf8"), { code: "ENOENT" });
});

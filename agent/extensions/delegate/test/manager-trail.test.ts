import assert from "node:assert/strict";

import test from "node:test";
import type {
	AgentSessionEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { DelegateSnapshot } from "../contract.ts";
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

test("trail interleaves bounded messages with tool calls", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "inspect trail", ctx: context });
	await eventually(() => sessions.length === 1);
	sessions[0].emit({
		type: "message_end",
		message: { role: "user", content: "inspect trail" },
	} as AgentSessionEvent);
	sessions[0].emit({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "read",
		args: { path: "src/a.ts" },
	} as AgentSessionEvent);
	assert.deepEqual(manager.trail(job.id), [
		'Tool: read {"path":"src/a.ts"} · running',
	]);
	sessions[0].emit({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "read",
		result: { content: [{ type: "text", text: "no such file" }] },
		isError: true,
	} as AgentSessionEvent);
	assert.deepEqual(manager.trail(job.id), [
		'Tool: read {"path":"src/a.ts"} · error: no such file',
	]);
	assert.equal(manager.list([job.id])[0].progress, "tool: read · error");
	assert.doesNotMatch(manager.list([job.id])[0].progress ?? "", /src|no such/);
	assert.equal(manager.list([job.id])[0].toolCalls, 1);
	assert.equal(manager.list([job.id])[0].failedToolCalls, 1);

	sessions[0].emit({
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "reading the source" }],
		},
		assistantMessageEvent: { type: "text_delta", delta: "source" },
	} as AgentSessionEvent);
	assert.equal(
		manager.trail(job.id).at(-1),
		"Assistant (writing)\n\nreading the source",
	);
	assert.equal(
		manager.list([job.id])[0].progress,
		"writing: reading the source",
	);

	sessions[0].emitAssistant("first finding", 10);
	sessions[0].emit({
		type: "message_end",
		message: { role: "user", content: "focus on the tests" },
	} as AgentSessionEvent);
	assert.deepEqual(manager.trail(job.id), [
		'Tool: read {"path":"src/a.ts"} · error: no such file',
		"Assistant\n\nfirst finding",
		"User\n\nfocus on the tests",
	]);

	const longMessage = `begin-${"é".repeat(3_000)}-end`;
	sessions[0].emitAssistant(longMessage, 20);
	const bounded = manager.trail(job.id).at(-1) ?? "";
	assert.ok(Buffer.byteLength(bounded) <= 4 * 1024 + 32);
	assert.match(bounded, /^Assistant\n\nbegin-/);
	assert.match(bounded, /\[message truncated\]/);
	assert.match(bounded, /-end$/);
	assert.doesNotMatch(bounded, /�/);

	for (let index = 0; index < 5; index++) {
		sessions[0].emitAssistant(`message ${index}`, 30 + index);
	}
	const trail = manager.trail(job.id);
	assert.equal(trail.length, 7);
	assert.match(trail[0], /^Tool: read/);
	assert.match(trail[1], /^Assistant\n\nbegin-/);
	assert.equal(trail.at(-1), "Assistant\n\nmessage 4");

	sessions[0].finish("final answer");
	await manager.wait([job.id]);
	assert.equal(manager.trail(job.id).at(-1), "Assistant\n\nfinal answer");
	await manager.shutdown();
});

test("a tool storm cannot evict the child's last stated intent", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "grind", ctx: context });
	await eventually(() => sessions.length === 1);
	sessions[0].emitAssistant("patching the tokenizer now", 10);
	for (let index = 0; index < 20; index++) {
		sessions[0].emit({
			type: "tool_execution_start",
			toolCallId: `call-${index}`,
			toolName: "edit",
			args: { path: `src/${index}.ts` },
		} as AgentSessionEvent);
		sessions[0].emit({
			type: "tool_execution_end",
			toolCallId: `call-${index}`,
			toolName: "edit",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		} as AgentSessionEvent);
	}
	const trail = manager.trail(job.id);
	assert.equal(trail.length, 13);
	assert.equal(trail[0], "Assistant\n\npatching the tokenizer now");
	assert.equal(trail[1], 'Tool: edit {"path":"src/8.ts"} · done');
	assert.equal(trail.at(-1), 'Tool: edit {"path":"src/19.ts"} · done');

	await manager.cancel([job.id]);
	const [snapshot] = manager.list([job.id]);
	assert.match(snapshot.checkpoint ?? "", /patching the tokenizer now/);
	assert.match(snapshot.checkpoint ?? "", /src\/19\.ts/);
	await manager.shutdown();
});

test("trail bounds oversized tool arguments", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "bound args", ctx: context });
	await eventually(() => sessions.length === 1);
	sessions[0].emit({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "write",
		args: { path: "src/a.ts", content: "é".repeat(4_000) },
	} as AgentSessionEvent);
	const [entry] = manager.trail(job.id);
	assert.ok(Buffer.byteLength(entry) <= 120 + 32);
	assert.match(entry, /^Tool: write \{"path":"src\/a\.ts"/);
	assert.match(entry, /… · running$/);
	assert.doesNotMatch(entry, /�/);
	await manager.shutdown();
});

test("only unconsumed background runs trigger automatic delivery", async () => {
	const delivered: DelegateSnapshot[] = [];
	const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
	const automatic = manager.spawn({
		task: "automatic",
		background: true,
		ctx: context,
	});
	await eventually(() => sessions.length === 1);
	sessions[0].finish("delivered");
	await eventually(() => delivered.length === 1);
	assert.equal(delivered[0].id, automatic.id);

	const consumed = manager.spawn({
		task: "consumed",
		background: true,
		ctx: context,
	});
	const waiting = manager.wait([consumed.id]);
	await eventually(() => sessions.length === 2);
	sessions[1].finish("waited");
	await waiting;
	assert.equal(delivered.length, 1);

	const cancelled = manager.spawn({
		task: "cancelled",
		background: true,
		ctx: context,
	});
	await eventually(() => sessions.length === 3);
	await manager.cancel([cancelled.id]);
	assert.equal(delivered.length, 1);
	await manager.shutdown();
});

test("shutdown owns a child created just before its deadline", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	let resolveCreation!: (child: ChildSession) => void;
	let releaseDisposal!: () => void;
	const disposalGate = new Promise<void>((resolve) => {
		releaseDisposal = resolve;
	});
	let creations = 0;
	let disposals = 0;
	const manager = new DelegateManager({
		createSession() {
			creations++;
			return new Promise<ChildSession>((resolve) => {
				resolveCreation = resolve;
			});
		},
		async shutdownSession(child) {
			disposals++;
			await disposalGate;
			(child as unknown as FakeChild).disposeNow();
		},
	});
	manager.spawn({ task: "late child", ctx: context });
	await new Promise<void>((resolve) => setImmediate(resolve));

	let firstSettled = false;
	let secondSettled = false;
	const firstShutdown = manager.shutdown().finally(() => {
		firstSettled = true;
	});
	const joinedShutdown = manager.shutdown().finally(() => {
		secondSettled = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	t.mock.timers.tick(4_999);
	const child = new FakeChild();
	resolveCreation(child as unknown as ChildSession);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(disposals, 1);
	assert.deepEqual(child.prompts, []);
	assert.equal(firstSettled, false);
	assert.equal(secondSettled, false);
	t.mock.timers.tick(1);
	await Promise.all([firstShutdown, joinedShutdown]);
	assert.equal(firstSettled, true);
	assert.equal(secondSettled, true);

	releaseDisposal();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(child.disposed, true);
	assert.equal(disposals, 1);
	assert.equal(creations, 1);
});

test("shutdown bounds an uncooperative existing child", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	let releaseDisposal!: () => void;
	const disposalGate = new Promise<void>((resolve) => {
		releaseDisposal = resolve;
	});
	let creations = 0;
	let disposals = 0;
	const sessions: FakeChild[] = [];
	const manager = new DelegateManager({
		async createSession() {
			creations++;
			const child = new FakeChild();
			sessions.push(child);
			return child as unknown as ChildSession;
		},
		async shutdownSession(child) {
			disposals++;
			await disposalGate;
			(child as unknown as FakeChild).disposeNow();
		},
	});
	manager.spawn({ task: "never settles", ctx: context });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sessions[0].prompts.length, 1);
	sessions[0].abortGate = new Promise<void>(() => {});

	let firstSettled = false;
	let secondSettled = false;
	const firstShutdown = manager.shutdown().finally(() => {
		firstSettled = true;
	});
	const joinedShutdown = manager.shutdown().finally(() => {
		secondSettled = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	t.mock.timers.tick(4_999);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(firstSettled, false);
	assert.equal(secondSettled, false);
	assert.equal(disposals, 0);

	t.mock.timers.tick(1);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(firstSettled, true);
	assert.equal(secondSettled, true);
	assert.equal(disposals, 1);
	assert.equal(creations, 1);

	releaseDisposal();
	await Promise.all([firstShutdown, joinedShutdown]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sessions[0].disposed, true);
	assert.equal(disposals, 1);
	assert.equal(creations, 1);
});

test("shutdown returns at its deadline and owns a child arriving later", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	let resolveCreation!: (child: ChildSession) => void;
	let creations = 0;
	let disposals = 0;
	const manager = new DelegateManager({
		createSession() {
			creations++;
			return new Promise<ChildSession>((resolve) => {
				resolveCreation = resolve;
			});
		},
		async shutdownSession(child) {
			disposals++;
			(child as unknown as FakeChild).disposeNow();
		},
	});
	manager.spawn({ task: "late child", ctx: context });
	await new Promise<void>((resolve) => setImmediate(resolve));

	let settled = false;
	const firstShutdown = manager.shutdown().finally(() => {
		settled = true;
	});
	const joinedShutdown = manager.shutdown();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	t.mock.timers.tick(4_999);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	await Promise.all([firstShutdown, joinedShutdown]);
	assert.equal(settled, true);

	const child = new FakeChild();
	resolveCreation(child as unknown as ChildSession);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(child.disposed, true);
	assert.equal(disposals, 1);
	assert.deepEqual(child.prompts, []);
	assert.equal(creations, 1);
});

test("cancelling during session creation disposes late arrivals", async () => {
	let resolveCreation!: (child: ChildSession) => void;
	const created = new Promise<ChildSession>((resolve) => {
		resolveCreation = resolve;
	});
	const child = new FakeChild();
	const manager = new DelegateManager({
		createSession: async () => created,
		async shutdownSession(session) {
			(session as unknown as FakeChild).disposed = true;
		},
	});
	const job = manager.spawn({ task: "slow startup", ctx: context });
	const [result] = await manager.cancel([job.id]);
	assert.equal(result.status, "cancelled");

	resolveCreation(child as unknown as ChildSession);
	await eventually(() => child.disposed);
	await manager.shutdown();
});

test("settled sessions are disposed and list keeps active children first", async () => {
	const { manager, sessions } = harness();
	const jobs: DelegateSnapshot[] = [];
	for (let index = 0; index < 3; index++) {
		const job = manager.spawn({ task: `task ${index}`, ctx: context });
		jobs.push(job);
		await eventually(() => sessions.length === index + 1);
		sessions[index].finish(`done ${index}`);
		await manager.wait([job.id]);
		await eventually(() => sessions[index].disposed);
	}

	const active = manager.spawn({ task: "active", ctx: context });
	await eventually(() => sessions.length === 4);
	assert.deepEqual(
		manager.list().map((snapshot) => snapshot.id),
		[active.id, jobs[2].id, jobs[1].id, jobs[0].id],
	);
	await manager.shutdown();
});

test("settled sessions and usage remain for the parent session", async () => {
	const { manager, sessions } = harness();
	for (let index = 0; index < 65; index++) {
		const job = manager.spawn({ task: `task ${index}`, ctx: context });
		await eventually(() => sessions.length === index + 1);
		sessions[index].emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: {
					input: 1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { total: 0.01 },
				},
			},
		} as AgentSessionEvent);
		sessions[index].finish("done");
		await manager.wait([job.id]);
	}

	assert.equal(manager.list().length, 65);
	assert.equal(manager.sessionUsage().tokens, 65 * 16);
	assert.ok(Math.abs(manager.sessionUsage().cost - 65 * 0.011) < 1e-10);
	await manager.shutdown();
});

test("an abnormal settle hands back the child's last activity", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "long build", ctx: context });
	await eventually(() => sessions.length === 1);
	sessions[0].emitAssistant("inspected the parser", 10);
	sessions[0].emit({
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "now wiring the lexer into parse()" }],
		},
	} as AgentSessionEvent);

	const [cancelled] = await manager.cancel([job.id]);
	assert.match(cancelled.checkpoint ?? "", /inspected the parser/);
	assert.match(cancelled.checkpoint ?? "", /wiring the lexer/);
	assert.equal(cancelled.progress, undefined);
	await manager.shutdown();
});

test("a completed run reports no checkpoint", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "quick read", ctx: context });
	await eventually(() => sessions.length === 1);
	sessions[0].finish("answer");
	const [done] = await manager.wait([job.id]);
	assert.equal(done.checkpoint, undefined);
	assert.equal(done.progress, undefined);
	await manager.shutdown();
});

test("the checkpoint keeps the newest messages within its bound", async () => {
	const { manager, sessions } = harness();
	const job = manager.spawn({ task: "chatty", ctx: context });
	await eventually(() => sessions.length === 1);
	for (let index = 0; index < 6; index++) {
		sessions[0].emitAssistant(`${"padding ".repeat(300)} step ${index}`, 10);
	}
	const [cancelled] = await manager.cancel([job.id]);
	const checkpoint = cancelled.checkpoint ?? "";
	assert.ok(Buffer.byteLength(checkpoint) <= 4 * 1024);
	assert.match(checkpoint, /step 5/);
	assert.doesNotMatch(checkpoint, /step 0/);
	await manager.shutdown();
});

test("a child runs in the requested directory and rejects a missing one", async () => {
	const { manager, requests, sessions } = harness();
	manager.spawn({ task: "isolated", cwd: "agent/extensions", ctx: context });
	await eventually(() => sessions.length === 1);
	assert.equal(requests[0].cwd, `${process.cwd()}/agent/extensions`);

	assert.throws(
		() => manager.spawn({ task: "nowhere", cwd: "no/such/dir", ctx: context }),
		/cwd is not a directory/,
	);
	await manager.shutdown();
});

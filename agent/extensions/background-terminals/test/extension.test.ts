// biome-ignore-all format: Effect test boundaries stay compact to keep the conversion deletion-first.
import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { processIsGone } from "../../test/process.ts";
import extension, { BackgroundTerminalDelivery } from "../index.ts";
import {
	MAX_RUNNING_PER_OWNER,
	MAX_TRACKED,
	type TerminalSnapshot,
} from "../manager.ts";

const noEvents = {
	emit() {},
	on() {
		return () => {};
	},
};

const fromPromise = <A>(value: A | PromiseLike<A>) => Effect.promise(() => Promise.resolve(value));
const eventually = Effect.fn("eventually")(function* (condition: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (yield* fromPromise(condition())) return;
		yield* Effect.sleep(25);
	}
	throw new Error("condition not met within 5 seconds");
});

function registeredExtension(
	sendMessage?: (message: unknown, options: unknown) => void,
) {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	extension({
		events: noEvents,
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		...(sendMessage ? { sendMessage } : {}),
	} as unknown as ExtensionAPI);
	return { tools, handlers };
}

function registeredTools() {
	const { tools, handlers } = registeredExtension();
	handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		{
			cwd: process.cwd(),
			hasUI: false,
			isIdle: () => false,
		} as ExtensionContext,
	);
	return tools as unknown as Array<{
		execute: (...args: unknown[]) => Promise<unknown>;
	}>;
}

test("registers four parallel tools and lifecycle hooks", () => {
	const { tools, handlers } = registeredExtension();
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["bg_start", "bg_status", "bg_list", "bg_kill"],
	);
	assert.ok(tools.every((tool) => tool.executionMode === "parallel"));
	assert.ok(
		handlers.has("session_start") &&
			handlers.has("agent_end") &&
			handlers.has("agent_settled") &&
			handlers.has("session_shutdown"),
	);
});

test("child terminals die with the child and stay out of the parent's list", () => Effect.runPromise(Effect.gen(function* () {
	const { tools: parentTools, handlers: parentHandlers } =
		registeredExtension(() => {});
	const { tools: childTools, handlers: childHandlers } =
		registeredExtension(() => {});
	const parentContext = {
		cwd: process.cwd(),
		hasUI: true,
		isIdle: () => false,
		ui: { setStatus() {} },
	} as unknown as ExtensionContext;
	const childContext = {
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	} as ExtensionContext;
	yield* fromPromise(parentHandlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		parentContext,
	));
	yield* fromPromise(childHandlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		childContext,
	));
	const start = childTools[0] as unknown as {
		execute: (...args: unknown[]) => Promise<{
			details: { id: string; pid: number };
		}>;
	};
	const list = parentTools[2] as unknown as {
		execute: (...args: unknown[]) => Promise<{
			details: { terminals: Array<{ id: string; state: string }> };
		}>;
	};
	const [status, kill] = [parentTools[1], parentTools[3]] as unknown as {
		execute: (...args: unknown[]) => Promise<unknown>;
	}[];
	const started = yield* fromPromise(start.execute(
		"1",
		{ command: "sleep 30", title: "child server" },
		undefined,
		undefined,
		childContext,
	));
	try {
		assert.deepEqual((yield* fromPromise(list.execute("2", {}))).details.terminals, []);
		yield* fromPromise(assert.rejects(
			status.execute("3", { id: started.details.id }),
			/Unknown terminal id/,
		));
		yield* fromPromise(assert.rejects(
			kill.execute("4", { ids: [started.details.id] }, undefined),
			/Unknown terminal id/,
		));
		assert.equal(processIsGone(started.details.pid), false);

		yield* fromPromise(childHandlers.get("agent_end")?.(
			{ type: "agent_end", messages: [] },
			childContext,
		));
		yield* fromPromise(childHandlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			childContext,
		));
		assert.ok(processIsGone(started.details.pid));
		const listed = yield* fromPromise(list.execute("5", {}));
		assert.deepEqual(listed.details.terminals, []);
	} finally {
		yield* fromPromise(parentHandlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			parentContext,
		));
	}
})));

test("a saturated child cannot exhaust the parent's terminal slots", () => Effect.runPromise(Effect.gen(function* () {
	const { tools: parentTools, handlers: parentHandlers } =
		registeredExtension(() => {});
	const { tools: childTools, handlers: childHandlers } =
		registeredExtension(() => {});
	const context = {
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	} as ExtensionContext;
	yield* fromPromise(parentHandlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		context,
	));
	yield* fromPromise(childHandlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		context,
	));
	const childStart = childTools[0] as unknown as {
		execute: (...args: unknown[]) => Promise<unknown>;
	};
	const parentStart = parentTools[0] as unknown as {
		execute: (...args: unknown[]) => Promise<{ details: { id: string } }>;
	};
	try {
		for (let index = 0; index < MAX_RUNNING_PER_OWNER; index++) {
			yield* fromPromise(childStart.execute(
				`child-${index}`,
				{ command: "sleep 30", title: `child ${index}` },
				undefined,
				undefined,
				context,
			));
		}
		yield* fromPromise(assert.rejects(
			childStart.execute(
				"child-overflow",
				{ command: "sleep 30", title: "child overflow" },
				undefined,
				undefined,
				context,
			),
			new RegExp(
				`Max ${MAX_RUNNING_PER_OWNER} background terminals can run concurrently per session; this session is running ${MAX_RUNNING_PER_OWNER}\\.`,
			),
		));
		const parentTerminal = yield* fromPromise(parentStart.execute(
			"parent-1",
			{ command: "sleep 30", title: "parent work" },
			undefined,
			undefined,
			context,
		));
		assert.ok(parentTerminal.details.id);
	} finally {
		yield* fromPromise(childHandlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			context,
		));
		yield* fromPromise(parentHandlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			context,
		));
	}
})));

test("no-UI runs stop terminals before release and can start another run", () => Effect.runPromise(Effect.gen(function* () {
	const { tools, handlers } = registeredExtension();
	const context = {
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	} as ExtensionContext;
	yield* fromPromise(handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		context,
	));
	const start = tools[0] as unknown as {
		execute: (...args: unknown[]) => Promise<{
			details: { id: string; pid: number };
		}>;
	};
	const first = yield* fromPromise(start.execute(
		"1",
		{ command: "sleep 30", title: "first" },
		undefined,
		undefined,
		context,
	));
	try {
		assert.ok(first.details.pid);
		yield* fromPromise(handlers.get("agent_end")?.(
			{ type: "agent_end", messages: [] },
			context,
		));
		assert.ok(processIsGone(first.details.pid));
		const second = yield* fromPromise(start.execute(
			"2",
			{ command: "true", title: "second" },
			undefined,
			undefined,
			context,
		));
		assert.ok(second.details.pid);
		assert.notEqual(second.details.id, first.details.id);
	} finally {
		yield* fromPromise(handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			context,
		));
	}
})));

test("session shutdown clears status, kills processes, and permits restart", () => Effect.runPromise(Effect.gen(function* () {
	const { tools, handlers } = registeredExtension();
	const statuses: Array<string | undefined> = [];
	const context = {
		cwd: process.cwd(),
		hasUI: true,
		isIdle: () => false,
		ui: {
			setStatus(_id: string, status?: string) {
				statuses.push(status);
			},
		},
	} as unknown as ExtensionContext;
	const start = tools[0] as unknown as {
		execute: (...args: unknown[]) => Promise<{
			details: { pid: number };
		}>;
	};
	yield* fromPromise(handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		context,
	));
	const first = yield* fromPromise(start.execute(
		"1",
		{ command: "sleep 30", title: "session one" },
		undefined,
		undefined,
		context,
	));
	yield* fromPromise(handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "new" },
		context,
	));
	assert.ok(processIsGone(first.details.pid));
	assert.equal(statuses.at(-1), undefined);
	yield* fromPromise(handlers.get("session_start")?.(
		{ type: "session_start", reason: "new" },
		context,
	));
	const second = yield* fromPromise(start.execute(
		"2",
		{ command: "true", title: "session two" },
		undefined,
		undefined,
		context,
	));
	assert.ok(second.details.pid);
	yield* fromPromise(handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "quit" },
		context,
	));
})));

test("successful completions are passive while failures trigger a turn", () => Effect.runPromise(Effect.gen(function* () {
	const deliveries: Array<{ options: { triggerTurn: boolean } }> = [];
	const { tools, handlers } = registeredExtension((_message, options) => {
		deliveries.push({ options: options as { triggerTurn: boolean } });
	});
	const context = {
		cwd: process.cwd(),
		hasUI: true,
		isIdle: () => true,
		ui: { setStatus() {} },
	} as unknown as ExtensionContext;
	yield* fromPromise(handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		context,
	));
	const [start, status] = tools as unknown as Array<{
		execute: (...args: unknown[]) => Promise<unknown>;
	}>;
	assert.ok(start);
	assert.ok(status);
	try {
		const silent = (yield* fromPromise(start.execute(
			"1",
			{ command: "true", title: "silent success" },
			undefined,
			undefined,
			context,
		))) as { details: { id: string } };
		yield* eventually(() => status.execute("status-1", { id: silent.details.id }).then(
			(result) => (result as { content: [{ text: string }] }).content[0].text.includes("[done]"),
		));
		assert.equal(deliveries.length, 0);
		yield* fromPromise(start.execute(
			"2",
			{ command: "printf ok", title: "success" },
			undefined,
			undefined,
			context,
		));
		yield* eventually(() => deliveries.length === 1);
		assert.equal(deliveries[0].options.triggerTurn, false);
		yield* fromPromise(start.execute(
			"3",
			{ command: "false", title: "failure" },
			undefined,
			undefined,
			context,
		));
		yield* eventually(() => deliveries.length === 2);
		assert.equal(deliveries[1].options.triggerTurn, true);
	} finally {
		yield* fromPromise(handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			context,
		));
	}
})));

test("completion delivery pauses without dropping results and closed delivery stays closed", () => Effect.runPromise(Effect.gen(function* () {
	const messages: unknown[] = [];
	let idle = false;
	const delivery = new BackgroundTerminalDelivery({
		sendMessage(message: unknown) {
			messages.push(message);
		},
	} as ExtensionAPI);
	delivery.setContext({ isIdle: () => idle } as ExtensionContext);
	const snapshot = {
		id: "bt-1",
		title: "x",
		command: "true",
		cwd: "/",
		state: "done",
		createdAt: 0,
		settledAt: 1,
		exitCode: 0,
		stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
		stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
	} as const;
	delivery.enqueue(snapshot);
	delivery.consume([snapshot.id]);
	yield* delivery.flush;
	assert.equal(messages.length, 0);

	delivery.setPaused(true);
	idle = true;
	delivery.enqueue(snapshot);
	yield* delivery.flush;
	assert.equal(messages.length, 0);
	delivery.setPaused(false);
	yield* Effect.yieldNow;
	assert.equal(messages.length, 1);

	idle = false;
	delivery.enqueue(snapshot);
	delivery.clear();
	yield* delivery.flush;
	assert.equal(messages.length, 1);
})));

test("bounds complete delivery batches with worst-case metadata", () => Effect.runPromise(Effect.gen(function* () {
	const messages: Array<{
		content: string;
		details: { ids: string[] };
	}> = [];
	const delivery = new BackgroundTerminalDelivery({
		sendMessage(message: unknown) {
			messages.push(message as { content: string; details: { ids: string[] } });
		},
	} as ExtensionAPI);
	delivery.setContext({ isIdle: () => false } as ExtensionContext);
	for (let index = 0; index < MAX_TRACKED; index++)
		delivery.enqueue({
			id: `bt-${index}`,
			title: "x".repeat(80),
			command: "true",
			cwd: `/${"w".repeat(4_094)}`,
			state: "failed",
			createdAt: 0,
			error: "e".repeat(4_096),
			stdout: {
				text: "é".repeat(20_000),
				totalBytes: 40_000,
				truncatedBytes: 0,
			},
			stderr: {
				text: "é".repeat(20_000),
				totalBytes: 40_000,
				truncatedBytes: 0,
			},
		} as TerminalSnapshot);
	yield* delivery.flush;
	assert.ok(messages.length > 1);
	assert.ok(
		messages.every(
			(message) => Buffer.byteLength(message.content) <= 256 * 1024,
		),
	);
	assert.deepEqual(
		messages.flatMap((message) => message.details.ids),
		Array.from({ length: MAX_TRACKED }, (_, index) => `bt-${index}`),
	);
	assert.ok(messages.every((message) => !message.content.includes("�")));
})));

test("retries completion delivery three times and exposes final failure", () => Effect.runPromise(Effect.gen(function* () {
	let attempts = 0;
	let idle = false;
	const diagnostics: string[] = [];
	const delivery = new BackgroundTerminalDelivery(
		{
			sendMessage() {
				attempts++;
				throw new Error("\u001b[31m\nunavailable\u202e");
			},
		} as unknown as ExtensionAPI,
		(message) => diagnostics.push(message),
	);
	try {
		delivery.setContext({ isIdle: () => idle } as ExtensionContext);
		delivery.enqueue({
			id: "bt-retry",
			title: "retry",
			command: "false",
			cwd: "/",
			state: "failed",
			createdAt: 0,
			exitCode: 1,
			stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
			stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
		});
		idle = true;
		yield* delivery.flush;
		yield* Effect.sleep(700);
		assert.equal(attempts, 3);
		assert.match(delivery.problem ?? "", /bt-retry/);
		assert.equal(diagnostics.length, 1);
		assert.ok(!diagnostics[0].includes("\u001b"));
		assert.ok(!diagnostics[0].includes("\u202e"));
		assert.ok(!diagnostics[0].includes("\n"));
	} finally {
		delivery.clear();
	}
})));

test("sanitizes displayed data and list details omit process output", () => Effect.runPromise(Effect.gen(function* () {
	const [start, status, list, kill] = registeredTools();
	const ctx = { cwd: process.cwd() };
	const started = (yield* fromPromise(start.execute(
		"1",
		{
			command: `node -e 'process.stdout.write(String.fromCharCode(128) + "bad")'`,
			title: "\u001b[31mred\u202e\u200b",
		},
		undefined,
		undefined,
		ctx,
	))) as { details: { id: string }; content: [{ text: string }] };
	assert.ok(!started.content[0].text.includes("\u001b"));
	assert.ok(!started.content[0].text.includes("\u202e"));
	assert.ok(!started.content[0].text.includes("\u200b"));
	// Poll rather than sleep: a fixed delay races the child process exit on a
	// loaded machine and reports [running] instead of [done].
	let result!: {
		details: Record<string, unknown>;
		content: [{ text: string }];
	};
	for (let attempt = 0; attempt < 200; attempt++) {
		result = (yield* fromPromise(status.execute("2", {
			id: started.details.id,
		}))) as typeof result;
		if (/\[done\]/.test(result.content[0].text)) break;
		yield* Effect.sleep(25);
	}
	assert.doesNotMatch(result.content[0].text, /[\u0080-\u009f]/u);
	assert.match(
		result.content[0].text,
		/^bt-\d+ \[done\][\s\S]*command: node -e/,
	);
	assert.ok(!("stdout" in result.details));
	assert.ok(!("stderr" in result.details));
	const listed = (yield* fromPromise(list.execute("3", {}))) as {
		details: { terminals: Array<Record<string, unknown>> };
	};
	assert.ok(!("stdout" in listed.details.terminals[0]));
	assert.ok(!("stderr" in listed.details.terminals[0]));
	for (const [tool, params] of [
		[status, { id: "bad\n\u202eid" }],
		[kill, { ids: ["bad\n\u202eid"] }],
	] as const) {
		yield* fromPromise(assert.rejects(tool.execute("4", params), (error: Error) => {
			assert.ok(!error.message.includes("\n"));
			assert.ok(!error.message.includes("\u202e"));
			return true;
		}));
	}
	yield* fromPromise(assert.rejects(
		start.execute(
			"5",
			{ command: "true", title: "bad cwd", working_dir: "bad\n\u202edir" },
			undefined,
			undefined,
			ctx,
		),
		(error: Error) => {
			assert.ok(!error.message.includes("\n"));
			assert.ok(!error.message.includes("\u202e"));
			return true;
		},
	));
})));

test("pre-aborted bg_kill still starts termination", () => Effect.runPromise(Effect.gen(function* () {
	const tools = registeredTools();
	const started = (yield* fromPromise(tools[0].execute(
		"1",
		{ command: "sleep 30", title: "pre-abort" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	))) as { details: { id: string } };
	const controller = new AbortController();
	controller.abort();
	yield* fromPromise(assert.rejects(
		tools[3].execute("2", { ids: [started.details.id] }, controller.signal),
		/termination continues/,
	));
	yield* eventually(() => tools[1].execute("3", { id: started.details.id }).then(
		(status) => (status as { content: [{ text: string }] }).content[0].text.includes("[killed]"),
	));
})));

test("aborted bg_kill wait does not cancel termination", () => Effect.runPromise(Effect.gen(function* () {
	const tools = registeredTools();
	const start = tools[0];
	const kill = tools[3];
	const status = tools[1];
	const ctx = { cwd: process.cwd() };
	const started = (yield* fromPromise(start.execute(
		"1",
		{ command: "trap '' TERM; sleep 30 & echo child:$!; wait", title: "abort" },
		undefined,
		undefined,
		ctx,
	))) as { details: { id: string } };
	const id = started.details.id;
	yield* eventually(() => status.execute("ready", { id }).then(
		(result) => (result as { content: [{ text: string }] }).content[0].text.includes("child:"),
	));
	yield* Effect.sleep(100);
	const controller = new AbortController();
	const waiting = kill.execute("2", { ids: [id] }, controller.signal);
	yield* Effect.sleep(25);
	controller.abort();
	yield* fromPromise(assert.rejects(waiting, /termination continues/));
	yield* eventually(() => status.execute("3", { id }).then(
		(result) => (result as { content: [{ text: string }] }).content[0].text.includes("[killed]"),
	));
})));

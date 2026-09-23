import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Effect } from "effect";
import { processIsGone } from "../../test/process.ts";
import { BackgroundTerminalDelivery } from "../delivery.ts";
import { MAX_RUNNING_PER_OWNER, MAX_TRACKED } from "../manager.ts";
import {
	type DeliveryMessage,
	type DeliveryOptions,
	registeredExtension,
	testContext,
} from "./registration.ts";

const sleep = (ms: number) => Effect.runPromise(Effect.sleep(ms));

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

async function eventually(condition: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (await condition()) return;
		await sleep(25);
	}

	throw new Error("condition not met within 5 seconds");
}

async function registeredTools(t: TestContext) {
	const { tools, handlers } = registeredExtension();

	const context = testContext({
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	});

	t.after(() => handlers.get("session_shutdown")?.({}, context));
	await handlers.get("session_start")?.({}, context);

	return tools;
}

test("child terminals die with the child and stay out of the parent's list", async () => {
	const { tools: parentTools, handlers: parentHandlers } =
		registeredExtension();

	const { tools: childTools, handlers: childHandlers } = registeredExtension();

	const parentContext = testContext({
		cwd: process.cwd(),
		hasUI: true,
		isIdle: () => false,
		ui: { setStatus() {} },
	});

	const childContext = testContext({
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	});

	await parentHandlers.get("session_start")?.({}, parentContext);
	await childHandlers.get("session_start")?.({}, childContext);
	assert.ok(childTools.every((tool) => tool.executionMode === "parallel"));

	const [start] = childTools;
	const [, status, list, kill] = parentTools;

	try {
		const started = await start.execute(
			"1",
			{ command: "sleep 30", title: "child server" },
			undefined,
			undefined,
			childContext,
		);

		assert.deepEqual((await list.execute("2", {})).details.terminals, []);
		await assert.rejects(
			status.execute("3", { id: started.details.id }),
			/Unknown terminal id/,
		);
		await assert.rejects(
			kill.execute("4", { ids: [started.details.id] }),
			/Unknown terminal id/,
		);
		assert.equal(processIsGone(started.details.pid), false);

		await childHandlers.get("session_shutdown")?.({}, childContext);
		assert.ok(processIsGone(started.details.pid));
		assert.deepEqual((await list.execute("5", {})).details.terminals, []);
	} finally {
		await parentHandlers.get("session_shutdown")?.({}, parentContext);
	}
});

test("parent shutdown awaits a child shutdown already escalating", {
	skip: process.platform === "win32",
}, async () => {
	const { handlers: parentHandlers } = registeredExtension();
	const { tools: childTools, handlers: childHandlers } = registeredExtension();

	const context = testContext({
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	});

	await parentHandlers.get("session_start")?.({}, context);
	await childHandlers.get("session_start")?.({}, context);
	const [start, status] = childTools;
	let childShutdown: Promise<void> | undefined;

	try {
		const stubbornProgram =
			'process.on("SIGTERM", () => {}); setImmediate(() => console.log("ready")); setInterval(() => {}, 1_000);';

		const started = await start.execute(
			"start-stubborn-child",
			{
				command: `exec ${shellQuote(process.execPath)} -e ${shellQuote(stubbornProgram)}`,
				title: "stubborn child",
			},
			undefined,
			undefined,
			context,
		);

		await eventually(
			async () =>
				(await status.execute("ready", { id: started.details.id })).details
					.stdoutBytes > 0,
		);
		childShutdown = childHandlers.get("session_shutdown")?.({}, context);
		await sleep(100);
		assert.equal(processIsGone(started.details.pid), false);
		await parentHandlers.get("session_shutdown")?.({}, context);
		assert.ok(processIsGone(started.details.pid));
	} finally {
		await parentHandlers.get("session_shutdown")?.({}, context);
		await childShutdown;
	}
});

test("child completions cannot evict a parent's retained result", async () => {
	const { tools: parentTools, handlers: parentHandlers } =
		registeredExtension();

	const { tools: childTools, handlers: childHandlers } = registeredExtension();

	const context = testContext({
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	});

	await parentHandlers.get("session_start")?.({}, context);
	await childHandlers.get("session_start")?.({}, context);
	const [parentStart, parentStatus] = parentTools;
	const [childStart, childStatus] = childTools;

	try {
		const parent = await parentStart.execute(
			"parent",
			{ command: "printf parent-result", title: "parent result" },
			undefined,
			undefined,
			context,
		);

		await eventually(async () =>
			(
				await parentStatus.execute("parent-ready", { id: parent.details.id })
			).content[0].text.includes("[done]"),
		);

		for (let index = 0; index < MAX_TRACKED; index++) {
			const child = await childStart.execute(
				`child-${index}`,
				{ command: "true", title: `child ${index}` },
				undefined,
				undefined,
				context,
			);

			await eventually(async () =>
				(
					await childStatus.execute(`child-ready-${index}`, {
						id: child.details.id,
					})
				).content[0].text.includes("[done]"),
			);
		}

		const retained = await parentStatus.execute("parent-retained", {
			id: parent.details.id,
		});

		assert.match(retained.content[0].text, /parent-result/);
	} finally {
		await childHandlers.get("session_shutdown")?.({}, context);
		await parentHandlers.get("session_shutdown")?.({}, context);
	}
});

test("a saturated child cannot exhaust the parent's terminal slots", async () => {
	const { tools: parentTools, handlers: parentHandlers } =
		registeredExtension();

	const { tools: childTools, handlers: childHandlers } = registeredExtension();

	const context = testContext({
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	});

	await parentHandlers.get("session_start")?.({}, context);
	await childHandlers.get("session_start")?.({}, context);
	const [childStart] = childTools;
	const [parentStart] = parentTools;

	try {
		for (let index = 0; index < MAX_RUNNING_PER_OWNER; index++) {
			await childStart.execute(
				`child-${index}`,
				{ command: "sleep 30", title: `child ${index}` },
				undefined,
				undefined,
				context,
			);
		}

		await assert.rejects(
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
		);

		const parentTerminal = await parentStart.execute(
			"parent-1",
			{ command: "sleep 30", title: "parent work" },
			undefined,
			undefined,
			context,
		);

		assert.ok(parentTerminal.details.id);
	} finally {
		await childHandlers.get("session_shutdown")?.({}, context);
		await parentHandlers.get("session_shutdown")?.({}, context);
	}
});

test("headless terminals survive agent end and stop at session shutdown", async () => {
	const { tools, handlers } = registeredExtension();

	const context = testContext({
		cwd: process.cwd(),
		hasUI: false,
		isIdle: () => false,
	});

	await handlers.get("session_start")?.({}, context);
	const [start] = tools;

	const first = await start.execute(
		"1",
		{ command: "sleep 30", title: "first" },
		undefined,
		undefined,
		context,
	);

	try {
		await handlers.get("agent_end")?.(
			{ type: "agent_end", messages: [] },
			context,
		);
		assert.equal(processIsGone(first.details.pid), false);

		const second = await start.execute(
			"2",
			{ command: "true", title: "second" },
			undefined,
			undefined,
			context,
		);

		assert.ok(second.details.pid);
		assert.notEqual(second.details.id, first.details.id);
	} finally {
		await handlers.get("session_shutdown")?.({}, context);
	}

	assert.ok(processIsGone(first.details.pid));
});

test("session shutdown kills processes and permits restart", async (t) => {
	const { tools, handlers } = registeredExtension();

	const context = testContext({
		cwd: process.cwd(),
		hasUI: true,
		isIdle: () => false,
	});

	t.after(() => handlers.get("session_shutdown")?.({}, context));
	const [start] = tools;
	await handlers.get("session_start")?.({}, context);

	const first = await start.execute(
		"1",
		{ command: "sleep 30", title: "session one" },
		undefined,
		undefined,
		context,
	);

	await handlers.get("session_shutdown")?.({ reason: "new" }, context);
	assert.ok(processIsGone(first.details.pid));
	await handlers.get("session_start")?.({ reason: "new" }, context);

	const second = await start.execute(
		"2",
		{ command: "true", title: "session two" },
		undefined,
		undefined,
		context,
	);

	assert.ok(second.details.pid);
});

for (const { command, state, exitCode } of [
	{ command: "true", state: "done", exitCode: 0 },
	{ command: "exit 23", state: "failed", exitCode: 23 },
]) {
	test(`natural completion wakes only its owner with real exit ${exitCode}: ${command}`, async () => {
		const deliveries: Array<{
			message: DeliveryMessage;
			options: DeliveryOptions;
		}> = [];

		const foreignMessages: unknown[] = [];

		const foreign = registeredExtension((message) =>
			foreignMessages.push(message),
		);

		const owner = registeredExtension((message, options) =>
			deliveries.push({ message, options }),
		);

		const context = testContext({
			cwd: process.cwd(),
			hasUI: false,
			isIdle: () => true,
		});

		await foreign.handlers.get("session_start")?.({}, context);
		await owner.handlers.get("session_start")?.({}, context);

		try {
			const [start] = owner.tools;
			await start.execute(
				"start",
				{ command, title: "natural completion" },
				undefined,
				undefined,
				context,
			);
			await eventually(() => deliveries.length === 1);
			assert.deepEqual(deliveries[0].options, {
				deliverAs: "steer",
				triggerTurn: true,
			});
			const message = deliveries[0].message;
			assert.equal(message.customType, "background-terminal-results");
			assert.ok(
				message.content.includes(
					`[${state}] natural completion · exit ${exitCode}`,
				),
			);
			assert.deepEqual(foreignMessages, []);
			await owner.handlers.get("agent_settled")?.({}, context);
			assert.equal(deliveries.length, 1);
		} finally {
			await owner.handlers.get("session_shutdown")?.({}, context);
			await foreign.handlers.get("session_shutdown")?.({}, context);
		}
	});
}

test("completion delivers while busy, never repeats, and closed delivery stays closed", async () => {
	const messages: unknown[] = [];

	const delivery = new BackgroundTerminalDelivery({
		sendMessage: (message) => {
			messages.push(message);
		},
	});

	delivery.setContext(testContext({ isIdle: () => false }));

	const snapshot = {
		id: "bt-1",
		title: "x",
		command: "true",
		cwd: "/",
		state: "done",
		createdAt: 0,
		settledAt: 1,
		result: { kind: "success" },
		stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
		stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
	} as const;

	delivery.enqueue(snapshot);
	assert.equal(
		messages.length,
		1,
		"completion steers into a busy session immediately",
	);
	await Effect.runPromise(delivery.flush);
	assert.equal(messages.length, 1, "delivered results are not sent again");
	delivery.clear();
	delivery.enqueue(snapshot);
	await Effect.runPromise(delivery.flush);
	assert.equal(
		messages.length,
		1,
		"closed delivery discarded the queued result",
	);
	delivery.setContext(testContext({ isIdle: () => false }));
	delivery.enqueue(snapshot);
	assert.equal(messages.length, 2, "new context reopens delivery");
	delivery.clear();
});

test("retries mixed-attempt delivery items independently", async () => {
	let attempts = 0;
	let idle = false;
	const diagnostics: string[] = [];

	const delivery = new BackgroundTerminalDelivery(
		{
			sendMessage() {
				attempts++;
				throw new Error("\u001b[31m\nunavailable\u202e");
			},
		},
		(message) => diagnostics.push(message),
	);

	try {
		delivery.setContext(testContext({ isIdle: () => idle }));

		const snapshot = {
			id: "bt-retry",
			title: "retry",
			command: "false",
			cwd: "/",
			state: "failed",
			createdAt: 0,
			settledAt: 1,
			result: {
				kind: "process-failure",
				exit: { kind: "signal", signal: "SIGTERM" },
			},
			stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
			stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
		} as const;

		delivery.enqueue(snapshot);
		idle = true;
		await Effect.runPromise(delivery.flush);
		await sleep(150);
		delivery.enqueue({ ...snapshot, id: "bt-late" });
		await sleep(700);
		assert.equal(attempts, 5);
		assert.match(delivery.problem ?? "", /bt-retry.*bt-late/);
		assert.equal(diagnostics.length, 2);
		assert.ok(!diagnostics[0].includes("\u001b"));
		assert.ok(!diagnostics[0].includes("\u202e"));
		assert.ok(!diagnostics[0].includes("\n"));
	} finally {
		delivery.clear();
	}
});

test("sanitizes displayed data and list details omit process output", async (t) => {
	const [start, status, list, kill] = await registeredTools(t);
	const ctx = { cwd: process.cwd() };

	const started = await start.execute(
		"1",
		{
			command: `node -e 'process.stdout.write(String.fromCharCode(128) + "bad")'`,
			title: "\u001b[31mred\u202e\u200b",
		},
		undefined,
		undefined,
		ctx,
	);

	assert.ok(!started.content[0].text.includes("\u001b"));
	assert.ok(!started.content[0].text.includes("\u202e"));
	assert.ok(!started.content[0].text.includes("\u200b"));
	await eventually(
		async () =>
			(await status.execute("ready", { id: started.details.id })).details
				.state === "done",
	);
	const result = await status.execute("2", { id: started.details.id });
	assert.doesNotMatch(result.content[0].text, /[\u0080-\u009f]/u);
	assert.match(
		result.content[0].text,
		/^bt-\d+ \[done\][\s\S]*command: node -e/,
	);
	assert.ok(!("stdout" in result.details));
	assert.ok(!("stderr" in result.details));
	const listed = await list.execute("3", {});
	assert.ok(!("stdout" in listed.details.terminals[0]));
	assert.ok(!("stderr" in listed.details.terminals[0]));

	for (const [tool, params] of [
		[status, { id: "bad\n\u202eid" }],
		[kill, { ids: ["bad\n\u202eid"] }],
	] as const) {
		await assert.rejects(tool.execute("4", params), (error: Error) => {
			assert.ok(!error.message.includes("\n"));
			assert.ok(!error.message.includes("\u202e"));

			return true;
		});
	}

	await assert.rejects(
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
	);
});

test("pre-aborted bg_kill still starts termination", async (t) => {
	const controller = new AbortController();
	controller.abort();
	const [start, status, , kill] = await registeredTools(t);

	const started = await start.execute("1", {
		command: "sleep 30",
		title: "pre-abort",
	});

	await assert.rejects(
		kill.execute("2", { ids: [started.details.id] }, controller.signal),
		/termination continues/,
	);
	await eventually(
		async () =>
			(await status.execute("3", { id: started.details.id })).details.state ===
			"killed",
	);
});

test("aborted bg_kill wait does not cancel termination", async (t) => {
	const controller = new AbortController();
	const [start, status, , kill] = await registeredTools(t);

	const started = await start.execute("1", {
		command: "trap '' TERM; sleep 30 & echo child:$!; wait",
		title: "abort",
	});

	const id = started.details.id;
	await eventually(async () =>
		(await status.execute("ready", { id })).content[0].text.includes("child:"),
	);
	await sleep(100);
	const waiting = kill.execute("2", { ids: [id] }, controller.signal);
	await sleep(25);
	controller.abort();
	await assert.rejects(waiting, /termination continues/);
	await eventually(
		async () => (await status.execute("3", { id })).details.state === "killed",
	);
});

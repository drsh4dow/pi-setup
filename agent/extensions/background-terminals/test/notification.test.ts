import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { BackgroundTerminalDelivery } from "../delivery.ts";
import { NotificationFrames } from "../notifications.ts";
import {
	type DeliveryMessage,
	type DeliveryOptions,
	decodeMessage,
	registeredExtension,
	testContext,
} from "./registration.ts";

const { spawnSync } = process.getBuiltinModule("node:child_process");

const context = testContext({
	cwd: process.cwd(),
	hasUI: true,
	isIdle: () => true,
	ui: { setStatus() {} },
});

async function eventually(condition: () => boolean) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (condition()) return;
		await Effect.runPromise(Effect.sleep(25));
	}

	throw new Error("condition not met within 5 seconds");
}

test("notification framing accepts split valid messages and drops malformed frames", () => {
	const frames = new NotificationFrames();
	assert.deepEqual(frames.append(Buffer.from('"hel')), []);
	assert.deepEqual(frames.append(Buffer.from('lo"\nnot-json\n')), ["hello"]);
	assert.deepEqual(
		frames.append(Buffer.from(`${"x".repeat(4 * 1024 + 1)}\n"after"\n`)),
		["after"],
	);
});

test("emit-to-pi wakes only the owner while its terminal keeps running", async () => {
	const parentMessages: unknown[] = [];

	const childMessages: Array<DeliveryMessage & { options: DeliveryOptions }> =
		[];

	const parent = registeredExtension((message) => parentMessages.push(message));

	const child = registeredExtension((message, options) =>
		childMessages.push({ ...message, options }),
	);

	await parent.handlers.get("session_start")?.({}, context);
	await child.handlers.get("session_start")?.({}, context);
	const [start, status] = child.tools;

	try {
		const started = await start.execute(
			"emit",
			{
				command:
					"trap 'exit 23' USR1; emit-to-pi 'PR 42 has new feedback'; while :; do sleep 0.1; done",
				title: "PR watcher",
			},
			undefined,
			undefined,
			context,
		);

		await eventually(() => childMessages.length === 1);
		assert.equal(parentMessages.length, 0);
		assert.equal(
			childMessages[0].customType,
			"background-terminal-notification",
		);
		assert.match(childMessages[0].content, /PR 42 has new feedback/);
		assert.deepEqual(childMessages[0].options, {
			deliverAs: "steer",
			triggerTurn: true,
		});
		const running = await status.execute("status", { id: started.details.id });
		assert.match(running.content[0].text, /\[running\]/);
		process.kill(started.details.pid, "SIGUSR1");
		await eventually(() => childMessages.length === 2);
		assert.equal(childMessages[1].customType, "background-terminal-results");
		assert.match(childMessages[1].content, /\[failed\].*exit 23/);
		assert.deepEqual(childMessages[1].options, {
			deliverAs: "steer",
			triggerTurn: true,
		});
		assert.equal(parentMessages.length, 0);
	} finally {
		await child.handlers.get("session_shutdown")?.({}, context);
		await parent.handlers.get("session_shutdown")?.({}, context);
	}
});

test("concurrent emitters preserve every frame", async () => {
	const deliveries: Array<{ content: string }> = [];

	const registration = registeredExtension((message) =>
		deliveries.push(message),
	);

	await registration.handlers.get("session_start")?.({}, context);
	const [start] = registration.tools;

	try {
		await start.execute(
			"emit-many",
			{
				command:
					"for i in $(seq 1 20); do emit-to-pi frame-$i & done; wait; sleep 30",
				title: "concurrent watcher",
			},
			undefined,
			undefined,
			context,
		);

		await eventually(() =>
			Array.from({ length: 20 }, (_, index) => `frame-${index + 1}`).every(
				(frame) =>
					deliveries.some(({ content }) =>
						content.split(/\r?\n/u).includes(frame),
					),
			),
		);
	} finally {
		await registration.handlers.get("session_shutdown")?.({}, context);
	}
});

test("queued delivery keeps live notifications and drops settled ones", async () => {
	const messages: Array<{ content: string }> = [];

	const delivery = new BackgroundTerminalDelivery({
		sendMessage(message) {
			messages.push(decodeMessage(message));
		},
	});

	delivery.setContext({ ...context, isIdle: () => false });
	delivery.enqueueNotification({
		id: "bt-1:notification-1",
		terminalId: "bt-1",
		title: "finished watcher",
		message: "stale",
	});
	delivery.enqueueNotification({
		id: "bt-2:notification-1",
		terminalId: "bt-2",
		title: "running watcher",
		message: "current",
	});
	assert.equal(messages.length, 0);
	delivery.terminalSettled("bt-1");
	await Effect.runPromise(delivery.flush);
	assert.equal(messages.length, 1);
	assert.doesNotMatch(messages[0].content, /stale/);
	assert.match(messages[0].content, /current/);
	delivery.clear();
});

test("settlement clears exhausted notification diagnostics", () => {
	const delivery = new BackgroundTerminalDelivery(
		{
			sendMessage() {
				throw new Error("delivery unavailable");
			},
		},
		() => {},
	);

	try {
		delivery.setContext({ ...context, isIdle: () => false });
		delivery.enqueueNotification({
			id: "bt-1:notification-1",
			terminalId: "bt-1",
			title: "watcher",
			message: "feedback",
		});

		for (let attempt = 0; attempt < 3; attempt++)
			Effect.runSync(delivery.flush);
		assert.match(delivery.problem ?? "", /bt-1:notification-1/);
		delivery.terminalSettled("bt-1");
		assert.equal(delivery.problem, undefined);
	} finally {
		delivery.clear();
	}
});

test("emit-to-pi fails outside an owned background terminal", () => {
	const cli = new URL("../bin/emit-to-pi.mjs", import.meta.url);
	const env = { ...process.env };
	delete env.PI_BACKGROUND_TERMINAL_NOTIFY_FD;

	const result = spawnSync(process.execPath, [fileURLToPath(cli), "hello"], {
		env,
		encoding: "utf8",
	});

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Pi-owned background terminal/);
});

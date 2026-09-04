import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import extension, { BackgroundTerminalDelivery } from "../index.ts";
import { NotificationFrames } from "../notifications.ts";

const { spawnSync } = process.getBuiltinModule("node:child_process");
const noEvents = { emit() {}, on() {} };
const context = {
	cwd: process.cwd(),
	hasUI: true,
	isIdle: () => true,
	ui: { setStatus() {} },
} as unknown as ExtensionContext;

function registeredExtension(
	sendMessage: (message: unknown, options: unknown) => void,
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
		sendMessage,
	} as unknown as ExtensionAPI);
	return { tools, handlers };
}

const fromPromise = <A>(value: A | PromiseLike<A>) =>
	Effect.promise(() => Promise.resolve(value));
const eventually = Effect.fn("eventually")(function* (
	condition: () => boolean,
) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (condition()) return;
		yield* Effect.sleep(25);
	}
	throw new Error("condition not met within 5 seconds");
});

function lifecycle(
	registration: ReturnType<typeof registeredExtension>,
	name: "session_start" | "session_shutdown",
) {
	return fromPromise(
		registration.handlers.get(name)?.(
			{
				type: name,
				reason: name === "session_start" ? "startup" : "quit",
			},
			context,
		),
	);
}

function tools(registration: ReturnType<typeof registeredExtension>) {
	const [start, status, , kill] = registration.tools as unknown as Array<{
		execute: (...args: unknown[]) => Promise<unknown>;
	}>;
	return { start, status, kill };
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

test("emit-to-pi wakes only the owner while its terminal keeps running", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const parentMessages: unknown[] = [];
			const childMessages: Array<{
				customType: string;
				content: string;
				options: { deliverAs: string; triggerTurn: boolean };
			}> = [];
			const parent = registeredExtension((message) =>
				parentMessages.push(message),
			);
			const child = registeredExtension((message, options) =>
				childMessages.push({
					...(message as { customType: string; content: string }),
					options: options as { deliverAs: string; triggerTurn: boolean },
				}),
			);
			yield* lifecycle(parent, "session_start");
			yield* lifecycle(child, "session_start");
			const { start, status, kill } = tools(child);
			const started = (yield* Effect.promise(() =>
				start.execute(
					"emit",
					{
						command: "emit-to-pi 'PR 42 has new feedback'; sleep 30",
						title: "PR watcher",
					},
					undefined,
					undefined,
					context,
				),
			)) as { details: { id: string } };
			try {
				yield* eventually(() => childMessages.length === 1);
				assert.equal(parentMessages.length, 0);
				assert.equal(
					childMessages[0].customType,
					"background-terminal-notification",
				);
				assert.match(childMessages[0].content, /PR 42 has new feedback/);
				assert.deepEqual(childMessages[0].options, {
					deliverAs: "followUp",
					triggerTurn: true,
				});
				const running = (yield* Effect.promise(() =>
					status.execute("status", { id: started.details.id }),
				)) as { content: [{ text: string }] };
				assert.match(running.content[0].text, /\[running\]/);
			} finally {
				yield* Effect.promise(() =>
					kill.execute("kill", { ids: [started.details.id] }),
				);
				yield* lifecycle(child, "session_shutdown");
				yield* lifecycle(parent, "session_shutdown");
			}
		}),
	));

test("concurrent emitters preserve every frame", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const deliveries: Array<{ content: string }> = [];
			const registration = registeredExtension((message) =>
				deliveries.push(message as { content: string }),
			);
			yield* lifecycle(registration, "session_start");
			const { start, kill } = tools(registration);
			const started = (yield* Effect.promise(() =>
				start.execute(
					"emit-many",
					{
						command:
							"for i in $(seq 1 20); do emit-to-pi frame-$i & done; wait; sleep 30",
						title: "concurrent watcher",
					},
					undefined,
					undefined,
					context,
				),
			)) as { details: { id: string } };
			try {
				yield* eventually(() =>
					Array.from({ length: 20 }, (_, index) => `frame-${index + 1}`).every(
						(frame) =>
							deliveries.some(({ content }) =>
								content.split(/\r?\n/u).includes(frame),
							),
					),
				);
			} finally {
				yield* Effect.promise(() =>
					kill.execute("kill", { ids: [started.details.id] }),
				);
				yield* lifecycle(registration, "session_shutdown");
			}
		}),
	));

test("paused delivery keeps live notifications and drops settled ones", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const messages: Array<{ content: string }> = [];
			const delivery = new BackgroundTerminalDelivery({
				sendMessage(message: unknown) {
					messages.push(message as { content: string });
				},
			} as ExtensionAPI);
			delivery.setContext(context);
			delivery.setPaused(true);
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
			yield* delivery.flush;
			assert.equal(messages.length, 0);
			delivery.terminalSettled("bt-1");
			delivery.setPaused(false);
			yield* eventually(() => messages.length === 1);
			assert.doesNotMatch(messages[0].content, /stale/);
			assert.match(messages[0].content, /current/);
			delivery.clear();
		}),
	));

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

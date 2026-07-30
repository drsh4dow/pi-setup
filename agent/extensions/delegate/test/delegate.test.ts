import assert from "node:assert/strict";

const { mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("fs");

import { tmpdir } from "node:os";

const { join } = process.getBuiltinModule("path");

import test from "node:test";
import {
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { processStatusView } from "../../process-status/status.ts";
import type { DelegateSnapshot } from "../contract.ts";
import delegateExtension, {
	BackgroundDelivery,
	readDelegateModelSetting,
	resolveDelegateModel,
} from "../index.ts";
import {
	renderDelegateResult,
	renderDelegateSessionCall,
	renderDelegateSessionResult,
} from "../render.ts";
import { eventually } from "./eventually.ts";

type ResolveContext = Parameters<typeof resolveDelegateModel>[0];
type RegistryModel = NonNullable<ResolveContext["model"]>;

const parentModel = { provider: "anthropic", id: "parent" } as RegistryModel;
const configuredModel = { provider: "opencode", id: "fable" } as RegistryModel;
const settingsDir = mkdtempSync(join(tmpdir(), "pi-delegate-test-"));
const noEvents = {
	emit() {},
	on() {
		return () => {};
	},
};

function eventBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel: string, data: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
		on(channel: string, listener: (data: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
	};
}

let settingsNumber = 0;

test.after(() => rmSync(settingsDir, { recursive: true, force: true }));

function fakeContext(options?: {
	parent?: boolean;
	auth?: boolean;
}): ResolveContext {
	return {
		model: (options?.parent ?? true) ? parentModel : undefined,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "opencode" && id === "fable" ? configuredModel : undefined,
			hasConfiguredAuth: () => options?.auth ?? true,
		} as ResolveContext["modelRegistry"],
	};
}

function settingsFile(content: string): string {
	const path = join(settingsDir, `settings-${settingsNumber++}.json`);
	writeFileSync(path, content, "utf8");
	return path;
}

function delegateSnapshot(
	overrides: Partial<DelegateSnapshot> = {},
): DelegateSnapshot {
	return {
		id: "delegate-1",
		status: "done",
		output: "background result",
		success: true,
		assignedTask: "fixture",
		effort: "fast",
		requestedModel: "test/model",
		model: "test/model",
		thinking: "low",
		createdAt: 0,
		settledAt: 1,
		durationMs: 1,
		toolCalls: 0,
		failedToolCalls: 0,
		childUsage: {
			turns: 1,
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0,
		},
		aborted: false,
		...overrides,
	};
}

test("reads the delegate model from settings.json", () => {
	assert.deepEqual(
		readDelegateModelSetting(
			settingsFile('{"delegate": {"model": " opencode/fable "}}'),
		),
		{ model: "opencode/fable" },
	);
	assert.deepEqual(
		readDelegateModelSetting(settingsFile('{"theme": "dark"}')),
		{},
	);
	assert.deepEqual(
		readDelegateModelSetting(join(tmpdir(), "pi-delegate-test-missing.json")),
		{},
	);
});

test("reports malformed delegate settings as problems, not failures", () => {
	assert.match(
		readDelegateModelSetting(settingsDir).problem ?? "",
		/Could not read/,
	);
	assert.match(
		readDelegateModelSetting(settingsFile("{not json")).problem ?? "",
		/Could not parse/,
	);
	assert.match(
		readDelegateModelSetting(settingsFile('{"delegate": true}')).problem ?? "",
		/must be an object/,
	);
	assert.match(
		readDelegateModelSetting(settingsFile('{"delegate": {"model": 42}}'))
			.problem ?? "",
		/must be a "provider\/model-id" string/,
	);
});

test("uses the configured delegate model when available", () => {
	const choice = resolveDelegateModel(fakeContext(), {
		model: "opencode/fable",
	});
	assert.equal(choice.model, configuredModel);
	assert.equal(choice.requestedModel, "opencode/fable");
	assert.equal(choice.fallbackReason, undefined);
});

test("falls back to the parent model when the configured model is unusable", () => {
	const missing = resolveDelegateModel(fakeContext(), {
		model: "opencode/unknown",
	});
	assert.equal(missing.model, parentModel);
	assert.equal(missing.requestedModel, "opencode/unknown");
	assert.match(missing.fallbackReason ?? "", /not found in the model registry/);

	const unauthenticated = resolveDelegateModel(fakeContext({ auth: false }), {
		model: "opencode/fable",
	});
	assert.equal(unauthenticated.model, parentModel);
	assert.match(unauthenticated.fallbackReason ?? "", /no auth configured/);

	const malformed = resolveDelegateModel(fakeContext(), { model: "fable" });
	assert.equal(malformed.model, parentModel);
	assert.match(
		malformed.fallbackReason ?? "",
		/must be a "provider\/model-id" string/,
	);
});

test("defaults to the parent model without a configured delegate model", () => {
	assert.deepEqual(resolveDelegateModel(fakeContext(), {}), {
		model: parentModel,
		requestedModel: "parent model",
		fallbackReason: undefined,
	});

	const orphan = resolveDelegateModel(fakeContext({ parent: false }), {
		problem: "Could not parse settings.json.",
	});
	assert.equal(orphan.model, undefined);
	assert.equal(
		orphan.fallbackReason,
		"Could not parse settings.json. No parent model was available; Pi will use its normal session default.",
	);

	const parentFallback = resolveDelegateModel(fakeContext(), {
		problem: "Could not parse settings.json.",
	});
	assert.equal(
		parentFallback.fallbackReason,
		"Could not parse settings.json. Using the parent model instead.",
	);
});

test("registers run and session tools", () => {
	const tools: Array<{
		name: string;
		executionMode?: "sequential" | "parallel";
		execute: unknown;
		renderCall?: unknown;
		renderResult?: unknown;
	}> = [];
	delegateExtension({
		events: noEvents,
		on() {},
		registerTool(registered: ToolDefinition) {
			tools.push(registered);
		},
	} as unknown as ExtensionAPI);

	assert.deepEqual(
		tools.map((tool) => tool.name),
		["delegate_run", "delegate_session"],
	);
	assert.ok(tools.every((tool) => tool.executionMode === "parallel"));
	assert.equal(typeof tools[0].execute, "function");
	assert.equal(typeof tools[0].renderCall, "function");
	assert.equal(typeof tools[0].renderResult, "function");
	assert.equal(typeof tools[1].renderCall, "function");
	assert.equal(typeof tools[1].renderResult, "function");
	const runProperties = (
		tools[0] as unknown as { parameters: { properties: object } }
	).parameters.properties;
	const sessionProperties = (
		tools[1] as unknown as { parameters: { properties: object } }
	).parameters.properties;
	assert.deepEqual(Object.keys(runProperties), [
		"task",
		"background",
		"cwd",
		"effort",
		"output_format",
	]);
	assert.deepEqual(Object.keys(sessionProperties), [
		"action",
		"id",
		"ids",
		"message",
	]);
	assert.deepEqual(
		(
			sessionProperties as {
				action: { enum: string[] };
			}
		).action.enum,
		["list", "status", "wait", "send", "cancel"],
	);
	assert.equal(
		(sessionProperties as { ids: { maxItems?: number } }).ids.maxItems,
		undefined,
	);
});

test("renders background acceptance and session actions with child context", () => {
	initTheme();
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
	} as never;
	const renderOptions = {
		expanded: false,
		isPartial: false,
	} as never;
	const renderContext = { isError: false } as never;
	const background = delegateSnapshot({
		status: "running",
		success: false,
		assignedTask: "audit the background renderer",
	});
	const backgroundText = renderDelegateResult(
		{
			content: [
				{ type: "text", text: "Result will be delivered automatically." },
			],
			details: background,
		},
		renderOptions,
		theme,
		renderContext,
	)
		.render(120)
		.join("\n");
	assert.match(backgroundText, /delegate-1.*running/);
	assert.match(backgroundText, /result will be delivered automatically/i);
	assert.match(
		backgroundText,
		/assigned task[\s\S]*audit the background renderer/,
	);

	const callText = renderDelegateSessionCall(
		{ action: "wait", ids: ["delegate-10", "delegate-11"] },
		theme,
		{} as never,
	)
		.render(120)
		.join("\n");
	assert.match(callText, /delegate_session.*wait.*delegate-10, delegate-11/);

	const sessionText = renderDelegateSessionResult(
		{
			content: [{ type: "text", text: "session result" }],
			details: {
				results: [
					delegateSnapshot({
						id: "delegate-10",
						assignedTask: "inspect the session renderer",
						output: "renderer report",
					}),
					delegateSnapshot({
						id: "delegate-11",
						status: "running",
						success: false,
						assignedTask: "wait for another child",
						output: "",
					}),
				],
			},
		},
		renderOptions,
		theme,
		renderContext,
	)
		.render(120)
		.join("\n");
	assert.match(sessionText, /delegate-10.*done/);
	assert.match(sessionText, /delegate-11.*running/);
	assert.match(sessionText, /assigned task[\s\S]*inspect the session renderer/);
	assert.match(sessionText, /child report preview[\s\S]*renderer report/);
});

test("background run returns immediately and list recovers a bounded task preview", async () => {
	const events = eventBus();
	const tools: ToolDefinition[] = [];
	let shutdown: (() => Promise<void>) | undefined;
	delegateExtension({
		events,
		on(event: string, handler: () => Promise<void>) {
			if (event === "session_shutdown") shutdown = handler;
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const run = tools.find((tool) => tool.name === "delegate_run");
	const session = tools.find((tool) => tool.name === "delegate_session");
	assert.ok(run && session);
	const task = `inspect first line\n${"x".repeat(300)}`;

	try {
		const started = await run.execute(
			"run-1",
			{ task, background: true },
			undefined,
			undefined,
			{ ...fakeContext(), cwd: settingsDir } as ExtensionContext,
		);
		assert.match(
			started.content[0]?.type === "text" ? started.content[0].text : "",
			/delegate-1/,
		);
		const processStatus = processStatusView({ events }).collapsed;
		assert.match(processStatus, /delegate-1 \[running\]/);
		assert.doesNotMatch(processStatus, /inspect first line|x{10}/);
		assert.equal(processStatus.split("\n").length, 2);
		const detail = processStatusView({ events }, "delegate-1").expanded;
		assert.match(
			detail,
			/delegate-1 \[running\][\s\S]*Task\ninspect first line[\s\S]*Activity\n\nNo recorded activity/,
		);
		assert.doesNotMatch(
			detail,
			/model:|workspace:|tool-calls:|tool-errors:|activity:/,
		);
		const listed = await session.execute(
			"list-1",
			{ action: "list" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text =
			listed.content[0]?.type === "text" ? listed.content[0].text : "";
		assert.match(text, /delegate-1.*inspect first line x+/);
		assert.doesNotMatch(text, /\n.*x/);
		assert.ok(text.length < 300);
		assert.equal((listed.details as { results: unknown[] }).results.length, 1);
	} finally {
		await shutdown?.();
	}
});

test("background delivery retries once and delivers at most once", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const messages: Array<{ message: unknown; options: unknown }> = [];
	let attempts = 0;
	const delivery = new BackgroundDelivery(
		{
			sendMessage(message: unknown, options: unknown) {
				attempts++;
				if (attempts === 1) throw new Error("temporary send failure");
				messages.push({ message, options });
			},
		} as unknown as ExtensionAPI,
		async (snapshots) => snapshots.map((snapshot) => snapshot.output).join(),
	);
	let idle = false;
	delivery.setContext({ isIdle: () => idle } as ExtensionContext);
	delivery.enqueue(delegateSnapshot());
	idle = true;

	await delivery.flush();
	assert.equal(attempts, 1);
	t.mock.timers.tick(25);
	await Promise.resolve();
	assert.equal(attempts, 2);
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0].options, {
		deliverAs: "followUp",
		triggerTurn: true,
	});
	assert.match(
		(messages[0].message as { content: string }).content,
		/background result/,
	);

	await delivery.flush();
	assert.equal(attempts, 2);
});

test("background delivery batches distinct completed children", async () => {
	const messages: unknown[] = [];
	const delivery = new BackgroundDelivery({
		sendMessage(message: unknown) {
			messages.push(message);
		},
	} as unknown as ExtensionAPI);
	delivery.setContext({ isIdle: () => false } as ExtensionContext);
	const base = delegateSnapshot({ output: "first child" });

	const firstReservation = delivery.reserve();
	const secondReservation = delivery.reserve();
	delivery.attach(firstReservation, base);
	const second = {
		...base,
		id: "delegate-2",
		output: "second child",
		outputTruncated: true,
		fullOutputFile: "/tmp/complete-second-child.txt",
	};
	delivery.attach(secondReservation, second);
	delivery.enqueue(base);
	delivery.enqueue(second);
	await delivery.flush();
	assert.equal(messages.length, 1);
	const content = (messages[0] as { content: string }).content;
	assert.match(content, /first child/);
	assert.match(content, /second child/);
	assert.match(
		content,
		/Full output \(until parent session ends\): \/tmp\/complete-second-child\.txt/,
	);
	await delivery.flush();
	assert.equal(messages.length, 1);
	assert.doesNotThrow(() => {
		for (let index = 0; index < 64; index++) delivery.reserve();
	});
});

test("background delivery reruns after work arrives during a stale flush", async () => {
	const messages: unknown[] = [];
	let releaseRender!: () => void;
	const renderGate = new Promise<void>((resolve) => {
		releaseRender = resolve;
	});
	let renders = 0;
	const delivery = new BackgroundDelivery(
		{
			sendMessage(message: unknown) {
				messages.push(message);
			},
		} as unknown as ExtensionAPI,
		async (snapshots) => {
			renders++;
			if (renders === 1) await renderGate;
			return snapshots.map((snapshot) => snapshot.output).join(",");
		},
	);
	delivery.setContext({ isIdle: () => true } as ExtensionContext);
	const first = delegateSnapshot({ output: "first" });
	delivery.enqueue(first);
	await Effect.runPromise(Effect.sleep(0));
	delivery.consume([first]);
	delivery.enqueue({ ...first, id: "delegate-2", output: "second" });
	releaseRender();
	await eventually(() => messages.length === 1);
	assert.equal(renders, 2);
	assert.doesNotMatch((messages[0] as { content: string }).content, /first/);
	assert.match((messages[0] as { content: string }).content, /second/);
});

test("consuming a failing render prevents stale retries and diagnostics", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const diagnostics: string[] = [];
	const messages: unknown[] = [];
	const originalLog = console.log;
	console.log = (...values: unknown[]) =>
		diagnostics.push(values.map(String).join(" "));
	let rejectThird!: (error: Error) => void;
	const thirdRender = new Promise<never>((_resolve, reject) => {
		rejectThird = reject;
	});
	let renders = 0;
	const delivery = new BackgroundDelivery(
		{ sendMessage: (message: unknown) => messages.push(message) },
		async (snapshots) => {
			renders++;
			if (renders < 3) throw new Error("render failed");
			if (renders === 3) return thirdRender;
			return snapshots.map((snapshot) => snapshot.output).join(",");
		},
	);
	const consumed = delegateSnapshot({ output: "recovered by wait" });
	let idle = false;
	delivery.setContext({ isIdle: () => idle } as ExtensionContext);
	delivery.enqueue(consumed);
	idle = true;

	try {
		await delivery.flush();
		t.mock.timers.tick(25);
		await Promise.resolve();
		t.mock.timers.tick(100);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(renders, 3);

		delivery.consume([consumed]);
		delivery.enqueue(
			delegateSnapshot({ id: "delegate-2", output: "later result" }),
		);
		rejectThird(new Error("stale third render failed"));
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(renders, 4);
		assert.equal(messages.length, 1);
		assert.equal(diagnostics.length, 0);
		assert.match((messages[0] as { content: string }).content, /later result/);
		assert.doesNotMatch(
			(messages[0] as { content: string }).content,
			/recovered by wait/,
		);
	} finally {
		delivery.clear();
		console.log = originalLog;
	}
});

test("background delivery retains exhausted failures for explicit recovery", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const diagnostics: string[] = [];
	const originalLog = console.log;
	console.log = (...values: unknown[]) =>
		diagnostics.push(values.map(String).join(" "));
	const delivery = new BackgroundDelivery(
		{
			sendMessage() {
				throw new Error("transport unavailable");
			},
		} as unknown as ExtensionAPI,
		async () => "settled",
	);
	let idle = false;
	delivery.setContext({ isIdle: () => idle } as ExtensionContext);
	const snapshot = delegateSnapshot({ output: "settled" });
	delivery.enqueue(snapshot);
	idle = true;

	try {
		await delivery.flush();
		t.mock.timers.tick(25);
		await Promise.resolve();
		t.mock.timers.tick(100);
		await Promise.resolve();
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0], /delegate-1/);
		assert.match(diagnostics[0], /transport unavailable/);
		assert.match(diagnostics[0], /delegate_session wait/);

		delivery.consume([snapshot]);
		await delivery.flush();
		assert.equal(diagnostics.length, 1);
	} finally {
		delivery.clear();
		console.log = originalLog;
	}
});

test("exhausted delivery ignores later flushes while newer results get three attempts", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const attempts = new Map<string, number>();
	const delivery = new BackgroundDelivery(
		{
			sendMessage(message: unknown) {
				const ids = (message as { details: { ids: string[] } }).details.ids;
				for (const id of ids) attempts.set(id, (attempts.get(id) ?? 0) + 1);
				throw new Error("offline");
			},
		} as unknown as ExtensionAPI,
		async (snapshots) => snapshots.map((snapshot) => snapshot.id).join(),
	);
	delivery.setContext({ isIdle: () => true } as ExtensionContext);
	delivery.enqueue(delegateSnapshot());
	await Promise.resolve();
	t.mock.timers.tick(25);
	await Promise.resolve();
	delivery.enqueue(delegateSnapshot({ id: "delegate-2" }));
	t.mock.timers.tick(100);
	await Promise.resolve();
	t.mock.timers.tick(100);
	await Promise.resolve();
	t.mock.timers.tick(100);
	await Promise.resolve();
	await delivery.flush();
	assert.equal(attempts.get("delegate-1"), 3);
	assert.equal(attempts.get("delegate-2"), 3);
	delivery.clear();
});

test("replacing an idle context restarts a stale render on the replacement", async () => {
	const sent: unknown[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let renders = 0;
	const delivery = new BackgroundDelivery(
		{ sendMessage: (message: unknown) => sent.push(message) },
		async () => {
			if (++renders === 1) await gate;
			return "result";
		},
	);
	const first = { isIdle: () => true } as ExtensionContext;
	const second = { isIdle: () => true } as ExtensionContext;
	delivery.setContext(first);
	delivery.enqueue(delegateSnapshot());
	await Promise.resolve();
	delivery.setContext(second);
	release();
	await eventually(() => sent.length === 1);
	assert.equal(renders, 2);
});

test("background delivery clear cancels a scheduled retry", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let attempts = 0;
	const delivery = new BackgroundDelivery(
		{
			sendMessage() {
				attempts++;
				throw new Error("temporary failure");
			},
		} as unknown as ExtensionAPI,
		async () => "settled",
	);
	delivery.setContext({ isIdle: () => false } as ExtensionContext);
	delivery.enqueue(delegateSnapshot({ output: "settled" }));

	await delivery.flush();
	assert.equal(attempts, 1);
	delivery.clear();
	t.mock.timers.tick(1_000);
	await Promise.resolve();
	assert.equal(attempts, 1);
});

test("background delivery reservations have no aggregate cap", () => {
	const delivery = new BackgroundDelivery({
		sendMessage() {},
	} as unknown as ExtensionAPI);
	const reservations = Array.from({ length: 100 }, () => delivery.reserve());
	assert.equal(new Set(reservations).size, 100);
	for (const reservation of reservations) delivery.release(reservation);
});

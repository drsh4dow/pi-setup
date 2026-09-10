import assert from "node:assert/strict";
import test from "node:test";
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";
import {
	MAX_ACTIVITIES_PER_SOURCE,
	processStatusSummary,
	processStatusView,
	registerProcessStatusSource,
} from "../status.ts";

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

function terminal(
	id: string,
	active: boolean,
	summary: string,
	detail?: string,
) {
	return {
		id,
		active,
		summary,
		detail: detail === undefined ? undefined : () => detail,
	};
}

test("summarizes active background terminals", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "terminals", () => [
		terminal("t1", true, "running"),
		terminal("t2", true, "running"),
		terminal("t3", false, "done"),
	]);
	assert.equal(processStatusSummary({ events }), "2 bg");
	assert.equal(processStatusSummary({ events: eventBus() }), undefined);
});

test("lists active terminals collapsed and retained terminals expanded", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "terminals", () => [
		terminal("t1", true, "[running] test watcher"),
		terminal("t2", false, "[failed] build"),
	]);
	const view = processStatusView({ events });
	assert.equal(view.collapsed, "t1 [running] test watcher");
	assert.equal(view.expanded, "t1 [running] test watcher\nt2 [failed] build");
});

test("renders bounded terminal details", () => {
	const events = eventBus();
	let detail = `output\n${"é".repeat(40_000)}\ntail`;
	registerProcessStatusSource({ events }, "terminals", () => [
		terminal("t1", true, "[running] watcher", detail),
	]);
	const view = processStatusView({ events }, "t1");
	detail = "changed after collection";
	assert.equal(view.collapsed, view.expanded);
	assert.match(view.collapsed, /^t1 \[running\] watcher/);
	assert.match(view.collapsed, /\[truncated\][\s\S]*tail$/);
	assert.ok(Buffer.byteLength(view.collapsed) <= 64 * 1024 + 100);
	assert.doesNotMatch(view.collapsed, /�|changed after collection/);
});

test("isolates detail and source failures", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "broken", () => {
		throw new Error("registry unavailable");
	});
	registerProcessStatusSource({ events }, "terminals", () => [
		{
			id: "t1",
			active: false,
			summary: "failed",
			detail: () => {
				throw new Error("activity unavailable\nretry later");
			},
		},
	]);
	assert.match(
		processStatusView({ events }).expanded,
		/broken: registry unavailable/,
	);
	assert.match(
		processStatusView({ events }, "t1").collapsed,
		/detail-error: activity unavailable retry later$/,
	);
});

test("reports duplicate and unknown terminal ids", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "first", () => [
		terminal("t1", true, "first"),
	]);
	registerProcessStatusSource({ events }, "second", () => [
		terminal("t1", true, "duplicate"),
		terminal("t2", true, "valid"),
	]);
	const list = processStatusView({ events }).expanded;
	assert.match(list, /t1 first/);
	assert.match(list, /t2 valid/);
	assert.match(list, /second: error=duplicate-id id=t1/);
	assert.equal(
		processStatusView({ events }, "missing").collapsed,
		"error: unknown-id · id: missing · action: /ps",
	);
});

test("bounds sources and retained terminals while preserving active entries", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "history", () => [
		...Array.from({ length: 64 }, (_, index) =>
			terminal(`old-${index}`, false, "done"),
		),
		terminal("current", true, "running"),
	]);
	const view = processStatusView({ events });
	assert.match(view.collapsed, /current running/);
	assert.match(view.expanded, /1 omitted/);

	const runaway = eventBus();
	registerProcessStatusSource({ events: runaway }, "runaway", () =>
		Array.from({ length: MAX_ACTIVITIES_PER_SOURCE + 1 }, (_, index) =>
			terminal(`t${index}`, true, "running"),
		),
	);
	assert.match(
		processStatusView({ events: runaway }).expanded,
		/limit=activities/,
	);
});

test("ignores retained collection requests after synchronous delivery", () => {
	const events = eventBus();
	const requests: unknown[] = [];
	let loads = 0;
	const stopRetaining = events.on("process-status:collect", (request) =>
		requests.push(request),
	);
	registerProcessStatusSource({ events }, "terminals", () => {
		loads++;
		return [terminal("t1", true, "running")];
	});
	processStatusView({ events });
	stopRetaining();
	for (const request of requests)
		events.emit("process-status:collect", request);
	assert.equal(loads, 1);
});

test("renders terminal lists and cleans up its status", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "terminals", () => [
		terminal("t1", true, "[running] test watcher", "output\nline"),
		terminal("t2", false, `[failed] ${"x".repeat(80)}`),
	]);
	let handler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	let renderer: EntryRenderer | undefined;
	const lifecycle = new Map<
		string,
		(event: ExtensionEvent, ctx: ExtensionContext) => unknown
	>();
	const appended: unknown[] = [];
	const statuses: unknown[] = [];
	const api = {
		events,
		appendEntry(_type: string, data: unknown) {
			appended.push(data);
		},
		getThinkingLevel: () => "high",
		on(
			event: string,
			callback: (event: ExtensionEvent, ctx: ExtensionContext) => unknown,
		) {
			lifecycle.set(event, callback);
		},
		registerEntryRenderer(_type: string, value: EntryRenderer) {
			renderer = value;
		},
		registerTool() {},
		registerCommand(_name: string, command: { handler: typeof handler }) {
			handler = command.handler;
		},
	} as unknown as ExtensionAPI;
	extension(api);
	const context = {
		mode: "tui",
		hasUI: true,
		model: { id: "test-model", provider: "test", contextWindow: 1000 },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getHeader: () => null,
			getEntries: () => [],
			getCwd: () => "/tmp/project",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: {
			setStatus(_name: string, value: unknown) {
				statuses.push(value);
			},
		},
	} as unknown as ExtensionContext;
	lifecycle.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		context,
	);
	assert.equal(statuses.at(-1), "1 bg");
	assert.ok(handler);
	void handler("", { mode: "tui", hasUI: true } as ExtensionCommandContext);
	void handler("t1", { mode: "tui", hasUI: true } as ExtensionCommandContext);
	assert.equal(appended.length, 2);
	assert.ok(renderer);
	const theme = {
		bg: (_color: string, text: string) => text,
		fg: (_color: string, text: string) => text,
	} as never;
	const collapsed = renderer(
		{ data: appended[0] } as never,
		{ expanded: false },
		theme,
	)?.render(35);
	assert.ok(collapsed?.every((line) => visibleWidth(line) <= 35));
	assert.doesNotMatch(collapsed?.join("\n") ?? "", /t2/);
	const expanded = renderer(
		{ data: appended[0] } as never,
		{ expanded: true },
		theme,
	)?.render(35);
	assert.match(expanded?.join("\n") ?? "", /t2 \[failed\].*\.\.\./);
	const detail = renderer(
		{ data: appended[1] } as never,
		{ expanded: false },
		theme,
	)?.render(80);
	assert.match(detail?.join("\n") ?? "", /output[\s\S]*line/);

	lifecycle.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "quit" },
		context,
	);
	assert.equal(statuses.at(-1), undefined);
});

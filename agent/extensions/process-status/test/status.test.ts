import assert from "node:assert/strict";
import test from "node:test";
import {
	type EntryRenderer,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionEvent,
	initTheme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import extension from "../index.ts";
import {
	processStatusView,
	registerProcessStatusSource,
	sessionCost,
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

function reportedUsage(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	cost: number,
) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function activity(
	id: string,
	kind: "subagents" | "terminals",
	active: boolean,
	summary: string,
	tokens = 0,
	cost = 0,
	detail?: string,
) {
	return {
		id,
		kind,
		active,
		summary,
		usage: { tokens, cost },
		detail: detail === undefined ? undefined : () => detail,
	};
}

test("aggregates all provider-reported session cost", () => {
	const cost = sessionCost([
		{
			type: "message",
			message: { role: "assistant", usage: reportedUsage(10, 5, 2, 3, 0.2) },
		},
		{
			type: "message",
			message: { role: "toolResult", usage: reportedUsage(4, 1, 0, 0, 0.05) },
		},
		{ type: "compaction", usage: reportedUsage(8, 2, 1, 1, 0.1) },
		{ type: "message", message: { role: "user" } },
	] as never);

	assert.equal(cost, 0.35);
});

test("lists each activity on its own line with aggregate usage", () => {
	const events = eventBus();
	registerProcessStatusSource(
		{ events },
		"delegate",
		() => [
			activity("d1", "subagents", true, "[running] read · model", 1200, 0.1),
			activity("d2", "subagents", false, "[done] read · model", 800, 0.2),
			activity("d3", "subagents", false, "[done] report"),
		],
		() => ({ tokens: 2000, cost: 0.3 }),
	);
	registerProcessStatusSource({ events }, "terminals", () => [
		activity("t1", "terminals", true, "[running] test watcher"),
		activity("t2", "terminals", false, "[failed] build"),
	]);

	const view = processStatusView({ events });
	assert.deepEqual(view.collapsed.split("\n"), [
		"2,000 tokens · $0.3000",
		"d1 [running] read · model",
		"t1 [running] test watcher",
	]);
	assert.deepEqual(view.expanded.split("\n"), [
		"2,000 tokens · $0.3000",
		"d1 [running] read · model",
		"d2 [done] read · model",
		"d3 [done] report",
		"t1 [running] test watcher",
		"t2 [failed] build",
	]);
});

test("shows one worker's usage and bounded diagnostics", () => {
	const events = eventBus();
	let detail = `Tool read input:\n{ path: 'a.ts' }\n\nTool read output:\nsource\n${"é".repeat(40_000)}\ntail`;
	registerProcessStatusSource({ events }, "delegate", () => [
		activity(
			"d1",
			"subagents",
			true,
			"[running] read · model",
			12_345,
			0.45678,
			detail,
		),
	]);

	const view = processStatusView({ events }, "d1");
	detail = "changed after collection";
	assert.equal(view.collapsed, view.expanded);
	assert.match(view.collapsed, /^12,345 tokens · \$0\.4568 · d1 \[running\]/);
	assert.match(view.collapsed, /Tool read input/);
	assert.match(view.collapsed, /\[truncated\][\s\S]*tail$/);
	assert.ok(Buffer.byteLength(view.collapsed) <= 64 * 1024 + 150);
	assert.doesNotMatch(view.collapsed, /�|changed after collection/);
});

test("reports a bounded detail loader failure", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "delegate", () => [
		{
			id: "d1",
			kind: "subagents",
			active: true,
			summary: "[failed] read",
			detail: () => {
				throw new Error("activity unavailable\nretry later");
			},
		},
	]);

	assert.match(
		processStatusView({ events }, "d1").collapsed,
		/detail-error: activity unavailable retry later$/,
	);
});

test("reports unknown and duplicate ids without hiding valid entries", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "first", () => [
		activity("d1", "subagents", true, "first"),
	]);
	registerProcessStatusSource({ events }, "second", () => [
		activity("d1", "terminals", true, "duplicate"),
		activity("t1", "terminals", true, "valid"),
	]);

	const list = processStatusView({ events }).expanded;
	assert.match(list, /d1 first/);
	assert.match(list, /t1 valid/);
	assert.match(list, /second: error=duplicate-id id=d1/);
	const unknown = processStatusView({ events }, "missing").collapsed;
	assert.equal(unknown, "error: unknown-id · id: missing · action: /ps");
	assert.equal(unknown.split("\n").length, 1);
});

test("isolates source failures and discloses collection limits", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "broken", () => {
		throw new Error("registry unavailable");
	});
	registerProcessStatusSource({ events }, "runaway", () =>
		Array.from({ length: 193 }, (_, index) =>
			activity(`d${index}`, "subagents", true, `delegate ${index}`),
		),
	);
	for (let index = 0; index < 15; index++) {
		registerProcessStatusSource({ events }, `source-${index}`, () => []);
	}

	const text = processStatusView({ events }).expanded;
	assert.match(text, /1 omitted/);
	assert.match(text, /broken: registry unavailable/);
	assert.match(text, /runaway: limit=activities count=193 max=192/);
	assert.equal(text.split("\n").length, 4);
});

test("keeps active entries when a group reaches its display bound", () => {
	const events = eventBus();
	registerProcessStatusSource({ events }, "history", () => [
		...Array.from({ length: 64 }, (_, index) =>
			activity(`old-${index}`, "subagents", false, "[done] old delegate"),
		),
		activity("current", "subagents", true, "[running] current delegate"),
	]);

	const view = processStatusView({ events });
	assert.match(view.collapsed, /current \[running\]/);
	assert.match(view.expanded, /current \[running\]/);
	assert.match(view.expanded, /1 omitted/);
});

test("renders compact lists, multiline details, and compounded worker cost", () => {
	const events = eventBus();
	registerProcessStatusSource(
		{ events },
		"delegate",
		() => [
			activity(
				"d1",
				"subagents",
				true,
				"[running] read",
				200,
				0.75,
				"task: inspect\n\nactivity:\nread source",
			),
			activity("d2", "subagents", false, `[done] review ${"x".repeat(80)}`),
		],
		() => ({ tokens: 200, cost: 0.75 }),
	);
	let handler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	let renderer: EntryRenderer | undefined;
	let footerFactory: Parameters<ExtensionContext["ui"]["setFooter"]>[0];
	const lifecycle = new Map<
		string,
		(event: ExtensionEvent, ctx: ExtensionContext) => unknown
	>();
	const appended: unknown[] = [];
	extension({
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
		registerCommand(
			name: string,
			command: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) {
			assert.equal(name, "ps");
			handler = command.handler;
		},
	} as unknown as ExtensionAPI);

	const parentEntry = {
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
		},
	};
	const ui = {
		setFooter(factory: typeof footerFactory) {
			footerFactory = factory;
		},
	};
	const model = {
		id: "test-model",
		provider: "test-provider",
		contextWindow: 1000,
		reasoning: false,
	};
	const context = {
		mode: "tui",
		hasUI: true,
		model,
		modelRegistry: {
			isUsingOAuth(candidate: unknown) {
				assert.equal(candidate, model);
				return false;
			},
		},
		sessionManager: {
			getEntries: () => [parentEntry],
			getCwd: () => "/tmp/project",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({
			tokens: 100,
			contextWindow: 1000,
			percent: 10,
		}),
		ui,
	} as unknown as ExtensionContext;
	lifecycle.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		context,
	);

	const ctx = { mode: "tui", hasUI: true } as ExtensionCommandContext;
	handler?.("", ctx);
	handler?.("d1", ctx);
	assert.equal(appended.length, 2);
	assert.ok(renderer);
	const theme = {
		bg: (_color: string, text: string) => text,
		fg: (_color: string, text: string) => text,
	} as never;
	const rendered = renderer(
		{ data: appended[0] } as never,
		{ expanded: false },
		theme,
	)?.render(45);
	assert.equal(rendered?.length, 4);
	assert.ok(rendered?.every((line) => visibleWidth(line) <= 45));
	assert.doesNotMatch(rendered?.join("\n") ?? "", /d2/);
	const expandedLines = renderer(
		{ data: appended[0] } as never,
		{ expanded: true },
		theme,
	)?.render(45);
	const expanded = expandedLines?.join("\n");
	assert.equal(expandedLines?.length, 5);
	assert.ok(expandedLines?.every((line) => visibleWidth(line) <= 45));
	assert.equal(expandedLines?.filter((line) => line.includes("d2")).length, 1);
	assert.match(expanded ?? "", /d2 \[done\] review x+.*\.\.\./);
	const detail = renderer(
		{ data: appended[1] } as never,
		{ expanded: false },
		theme,
	)
		?.render(80)
		.join("\n");
	assert.match(detail ?? "", /task: inspect[\s\S]*activity:[\s\S]*read source/);

	assert.ok(footerFactory);
	initTheme();
	const footer = footerFactory({ requestRender() {} } as never, {} as never, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	});
	assert.match(footer.render(100).join("\n"), /\$1\.000/);
	footer.dispose?.();
});

test("exposes cumulative session and delegate usage to the model", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const events = eventBus();
			registerProcessStatusSource(
				{ events },
				"delegate",
				() => [],
				() => ({ tokens: 200, cost: 0.1236 }),
			);
			let usageTool: ToolDefinition | undefined;
			extension({
				events,
				on() {},
				registerEntryRenderer() {},
				registerTool(tool: ToolDefinition) {
					assert.equal(tool.name, "session_usage");
					usageTool = tool;
				},
				registerCommand() {},
			} as unknown as ExtensionAPI);

			assert.ok(usageTool);
			const tool = usageTool;
			const context = {
				sessionManager: {
					getEntries: () => [
						{
							type: "message",
							message: {
								role: "assistant",
								usage: reportedUsage(10, 5, 0, 0, 0.1),
							},
						},
						{
							type: "message",
							message: {
								role: "assistant",
								usage: reportedUsage(10, 5, 0, 0, 0.2),
							},
						},
					],
				},
			} as unknown as ExtensionContext;
			const result = yield* Effect.promise(() =>
				tool.execute("usage-call", {}, undefined, undefined, context),
			);
			const expected = { totalUsd: 0.424, mainUsd: 0.3, delegatesUsd: 0.124 };
			assert.deepEqual(result.details, expected);
			const text = result.content.find((part) => part.type === "text")?.text;
			assert.equal(
				text,
				'{"totalUsd":0.424,"mainUsd":0.3,"delegatesUsd":0.124}',
			);
		}),
	));

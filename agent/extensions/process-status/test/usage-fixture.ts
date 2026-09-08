import assert from "node:assert/strict";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	initTheme,
	type SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import {
	type ProcessStatusUsage,
	registerProcessStatusSource,
} from "../status.ts";

export function usageView(
	parent: SessionManager,
	usage: () => ProcessStatusUsage,
	provider = "test",
) {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		emit(name: string, data: unknown) {
			for (const listener of listeners.get(name) ?? []) listener(data);
		},
		on(name: string, listener: (data: unknown) => void) {
			const group = listeners.get(name) ?? new Set();
			group.add(listener);
			listeners.set(name, group);
			return () => {
				group.delete(listener);
			};
		},
	};
	const lifecycle = new Map<
		string,
		(event: ExtensionEvent, ctx: ExtensionContext) => unknown
	>();
	let tool: ToolDefinition | undefined;
	let factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0];
	const pi = {
		events,
		on(
			name: string,
			handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown,
		) {
			lifecycle.set(name, handler);
		},
		registerTool(value: ToolDefinition) {
			tool = value;
		},
		registerEntryRenderer() {},
		registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	registerProcessStatusSource(pi, "delegate", () => [], usage);
	extension(pi, () => false);
	const ctx = {
		mode: "tui",
		model: { id: "test-model", provider, contextWindow: 1000 },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: parent,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: {
			setFooter(value: typeof factory) {
				factory = value;
			},
		},
	} as unknown as ExtensionContext;
	lifecycle.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	assert.ok(factory);
	assert.ok(tool);
	const usageTool = tool;
	initTheme();
	const footer = factory(
		{ requestRender() {} } as never,
		{
			fg: (color: string, text: string) => {
				assert.equal(color, "dim");
				return `\x1b[90m${text}\x1b[39m`;
			},
		} as never,
		{
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		},
	);
	return {
		query: () => usageTool.execute("usage", {}, undefined, undefined, ctx),
		render: () => footer.render(200).join("\n"),
		dispose: () => footer.dispose?.(),
	};
}

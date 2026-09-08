import { Type } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	FooterComponent,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { observeAutoCompaction } from "../../lib/settings.ts";
import { accountingText, sessionAccounting } from "./accounting.ts";
import {
	type ProcessStatusView,
	processStatusUsage,
	processStatusView,
} from "./status.ts";

const ENTRY_TYPE = "process-status";

function roundUsd(cost: number): number {
	return Math.round(cost * 1000) / 1000;
}

export default function processStatus(
	pi: ExtensionAPI,
	autoCompactionEnabled?: (ctx: ExtensionContext) => boolean,
) {
	let currentModel: Parameters<typeof pi.setModel>[0] | undefined;
	let requestFooterRender: (() => void) | undefined;

	pi.registerEntryRenderer<ProcessStatusView>(
		ENTRY_TYPE,
		(entry, { expanded }, theme) => {
			if (!entry.data) return undefined;
			const text = expanded ? entry.data.expanded : entry.data.collapsed;
			const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
			if (entry.data.list) {
				box.addChild({
					invalidate() {},
					render(width: number) {
						return text
							.split("\n")
							.map((line, index) =>
								truncateToWidth(
									`${index === 0 ? `${theme.fg("accent", "[ps]")} ` : ""}${line}`,
									width,
									theme.fg("dim", "..."),
								),
							);
					},
				});
			} else {
				box.addChild(new Text(`${theme.fg("accent", "[ps]")}\n${text}`, 0, 0));
			}
			return box;
		},
	);

	pi.on("session_start", (_event, ctx) => {
		currentModel = ctx.model;
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			const sessionManager = new Proxy(ctx.sessionManager, {
				get(target, property) {
					// Pi owns context/model layout; our accounting line owns cumulative usage.
					if (property === "getEntries") return () => [];

					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const isUsingOAuth = (providerId: string) =>
				currentModel !== undefined &&
				currentModel.provider === providerId &&
				ctx.modelRegistry.isUsingOAuth(currentModel);
			const modelRuntime = {
				isUsingOAuth,
				isUsingSubscription: (providerId: string) =>
					isUsingOAuth(providerId) &&
					ctx.modelRegistry.getProvider(providerId)?.auth.oauth
						?.isSubscription === true,
			};
			const session = {
				get state() {
					return { model: currentModel, thinkingLevel: pi.getThinkingLevel() };
				},
				sessionManager,
				modelRegistry: ctx.modelRegistry,
				modelRuntime: { ...modelRuntime, isUsingSubscription: () => false },
				getContextUsage: () => ctx.getContextUsage(),
			} as unknown as AgentSession;
			const footer = new FooterComponent(session, footerData);
			const settings = autoCompactionEnabled
				? { enabled: () => autoCompactionEnabled(ctx), dispose() {} }
				: observeAutoCompaction(ctx, () => tui.requestRender());
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			requestFooterRender = () => tui.requestRender();
			return {
				invalidate: () => tui.requestRender(),
				render(width: number) {
					footer.setAutoCompactEnabled(settings.enabled());
					const entries = ctx.sessionManager.getEntries();
					const totals = sessionAccounting(entries, processStatusUsage(pi));
					const subscription =
						currentModel !== undefined &&
						(currentModel.provider === "kimi-coding" ||
							modelRuntime.isUsingSubscription(currentModel.provider));
					// Pi hardcodes Kimi's subscription cost even with no entries. Remove that
					// empty-account placeholder; only the shared totals may display money.
					const nativeCost =
						currentModel?.provider === "kimi-coding" ? "$0.000 (sub) " : "";
					const lines = footer
						.render(width + nativeCost.length)
						.map((line, index) =>
							truncateToWidth(
								index === 1 && nativeCost ? line.replace(nativeCost, "") : line,
								width,
								"...",
							),
						);
					lines.splice(
						1,
						0,
						truncateToWidth(
							accountingText(totals.total, entries, subscription),
							width,
							"...",
						),
					);
					return lines;
				},
				dispose() {
					settings.dispose();
					unsubscribe();
					footer.dispose();
					requestFooterRender = undefined;
				},
			};
		});
	});

	pi.on("model_select", (event) => {
		currentModel = event.model;
		requestFooterRender?.();
	});
	pi.on("thinking_level_select", () => requestFooterRender?.());
	pi.on("session_shutdown", (_event, ctx) => {
		requestFooterRender = undefined;
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});

	pi.registerTool({
		name: "session_usage",
		label: "Session Usage",
		description:
			"Returns cumulative reported token usage and USD cost for this session and its Delegate Runs. Includes settled delegates and usage through the latest completed provider response.",
		promptSnippet:
			"Query this session's cumulative token usage and provider-reported cost, including delegates",
		parameters: Type.Object({}),
		executionMode: "parallel",
		execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const totals = sessionAccounting(
				ctx.sessionManager.getEntries(),
				processStatusUsage(pi),
			);
			const account = (source: typeof totals.total) => ({
				inputTokens: source.input,
				outputTokens: source.output,
				cacheReadTokens: source.cacheRead,
				cacheWriteTokens: source.cacheWrite,
				totalTokens: source.totalTokens,
				usd: source.cost === null ? null : roundUsd(source.cost),
			});
			const usage = {
				parent: account(totals.parent),
				delegates: account(totals.delegates),
				total: account(totals.total),
			};
			return Promise.resolve({
				content: [{ type: "text" as const, text: JSON.stringify(usage) }],
				details: usage,
			});
		},
	});

	pi.registerCommand("ps", {
		description: "/ps: active; Ctrl+O: tracked; /ps <id>: details",
		handler: (args, ctx) => {
			const view = processStatusView(pi, args.trim() || undefined);
			if (ctx.mode === "tui") pi.appendEntry(ENTRY_TYPE, view);
			else if (ctx.hasUI) ctx.ui.notify(view.collapsed, "info");
			return Promise.resolve();
		},
	});
}

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { sessionReportedUsage } from "./accounting.ts";
import {
	observeProcessStatusRefresh,
	type ProcessStatusView,
	processStatusSummary,
	processStatusView,
} from "./status.ts";

const ENTRY_TYPE = "process-status";

function roundUsd(cost: number): number {
	return Math.round(cost * 1000) / 1000;
}

export default function processStatus(pi: ExtensionAPI) {
	let refreshStatus: (() => void) | undefined;
	observeProcessStatusRefresh(pi, () => refreshStatus?.());

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
		if (ctx.mode !== "tui") return;
		refreshStatus = () =>
			ctx.ui.setStatus("process-status", processStatusSummary(pi));
		refreshStatus();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		refreshStatus = undefined;
		if (ctx.mode === "tui") ctx.ui.setStatus("process-status", undefined);
	});

	pi.registerTool({
		name: "session_usage",
		label: "Session Usage",
		description:
			"Returns cumulative reported token usage and USD cost for this session through the latest completed provider response.",
		promptSnippet:
			"Query this session's cumulative token usage and provider-reported cost",
		parameters: Type.Object({}),
		executionMode: "parallel",
		execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const reported = sessionReportedUsage(ctx.sessionManager.getEntries());
			const usage = {
				inputTokens: reported.input,
				outputTokens: reported.output,
				cacheReadTokens: reported.cacheRead,
				cacheWriteTokens: reported.cacheWrite,
				totalTokens: reported.totalTokens,
				usd: reported.cost === null ? null : roundUsd(reported.cost),
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

const { readFileSync } = process.getBuiltinModule("fs");

import {
	getMarkdownTheme,
	keyHint,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	COLLAPSED_PREVIEW_LINES,
	type DelegateDetails,
	type DelegateRunParams,
	type DelegateSessionDetails,
	type DelegateSessionParams,
	type DelegateSnapshot,
	type DelegateStatus,
	RUN_TOOL_NAME,
	SESSION_TOOL_NAME,
} from "./contract.ts";
import {
	formatCollapsedPreview,
	formatCompactUsage,
	formatDetailedUsage,
	formatProgress,
	formatStatusParts,
} from "./format.ts";

function renderStatus(
	label: DelegateStatus,
	color: "muted" | "success" | "warning" | "error",
	details: DelegateDetails,
	includeUsage: boolean,
	theme: Parameters<DelegateRenderResult>[2],
): string {
	let text =
		theme.fg(color, label) +
		theme.fg("muted", " • ") +
		theme.fg("accent", formatStatusParts(details));
	const usage = includeUsage ? formatCompactUsage(details.childUsage) : "";
	if (usage) text += theme.fg("dim", ` • ${usage}`);
	if (details.outputTruncated) {
		text += theme.fg("warning", " • truncated");
	}
	return text;
}

function renderAssignedTask(
	task: string,
	expanded: boolean,
	theme: Parameters<DelegateRenderResult>[2],
): Box | undefined {
	const cleanTask = task.trimEnd();
	const lines = cleanTask
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	if (!cleanTask || lines.length === 0) return undefined;

	const hiddenLines = Math.max(0, lines.length - COLLAPSED_PREVIEW_LINES);
	const body = expanded
		? cleanTask
		: lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n");
	const box = new Box(1, 0);
	box.addChild(new Text(theme.fg("muted", "─── assigned task ───"), 0, 0));
	box.addChild(new Text(theme.fg("toolOutput", body), 0, 0));

	const expandHint = keyHint("app.tools.expand", "expand assigned task");
	const hint = expanded
		? keyHint("app.tools.expand", "collapse assigned task")
		: hiddenLines > 0
			? `${theme.fg(
					"warning",
					`… ${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"} hidden`,
				)} • ${expandHint}`
			: `${theme.fg("dim", "compact task")} • ${expandHint}`;
	box.addChild(new Text(hint, 0, 0));
	return box;
}

function renderChildReport(
	container: Container,
	output: string,
	details: DelegateDetails,
	expanded: boolean,
	theme: Parameters<DelegateRenderResult>[2],
) {
	if (!expanded) {
		const preview = formatCollapsedPreview(output);
		if (!preview.text) return;
		container.addChild(
			new Text(theme.fg("muted", "─── child report preview ───"), 0, 0),
		);
		container.addChild(new Text(theme.fg("toolOutput", preview.text), 0, 0));
		const previewHint = preview.truncated
			? preview.hiddenLines > 0
				? `… ${preview.hiddenLines} more ${preview.hiddenLines === 1 ? "line" : "lines"} hidden • preview truncated`
				: "preview truncated"
			: "compact preview";
		container.addChild(
			new Text(
				theme.fg(preview.truncated ? "warning" : "dim", previewHint) +
					` • ${keyHint("app.tools.expand", "expand child report")}`,
				0,
				0,
			),
		);
		return;
	}

	const detailedUsage = formatDetailedUsage(details.childUsage);
	if (detailedUsage) {
		container.addChild(
			new Text(theme.fg("dim", `usage • ${detailedUsage}`), 0, 0),
		);
	}
	if (details.fallbackReason) {
		container.addChild(
			new Text(
				theme.fg("warning", `fallback • ${details.fallbackReason}`),
				0,
				0,
			),
		);
	}

	let expandedOutput = output.trim();
	let fullOutputReadError: string | undefined;
	if (details.outputTruncated && details.fullOutputFile) {
		try {
			expandedOutput = readFileSync(details.fullOutputFile, "utf8").trim();
		} catch (error) {
			fullOutputReadError =
				error instanceof Error ? error.message : String(error);
		}
	}
	if (details.outputTruncated) {
		const saved = details.fullOutputFile
			? ` • full output: ${details.fullOutputFile}`
			: "";
		const readStatus = fullOutputReadError
			? ` • could not read full output: ${fullOutputReadError}`
			: details.fullOutputFile
				? " • showing saved full output"
				: "";
		container.addChild(
			new Text(
				theme.fg("warning", `output truncated${saved}${readStatus}`),
				0,
				0,
			),
		);
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── child report ───"), 0, 0));
	if (expandedOutput) {
		container.addChild(new Markdown(expandedOutput, 0, 0, getMarkdownTheme()));
	} else {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	}
}

type DelegateRenderCall = NonNullable<
	ToolDefinition<typeof DelegateRunParams, DelegateSnapshot>["renderCall"]
>;
type DelegateRenderResult = NonNullable<
	ToolDefinition<typeof DelegateRunParams, DelegateSnapshot>["renderResult"]
>;
type DelegateSessionRenderCall = NonNullable<
	ToolDefinition<
		typeof DelegateSessionParams,
		DelegateSessionDetails
	>["renderCall"]
>;
type DelegateSessionRenderResult = NonNullable<
	ToolDefinition<
		typeof DelegateSessionParams,
		DelegateSessionDetails
	>["renderResult"]
>;

export const renderDelegateCall: DelegateRenderCall = (args, theme) => {
	const effort = args.effort ?? "fast";
	return new Text(
		theme.fg("toolTitle", theme.bold(RUN_TOOL_NAME)) +
			theme.fg("muted", " • ") +
			theme.fg("accent", effort),
		0,
		0,
	);
};

export const renderDelegateSessionCall: DelegateSessionRenderCall = (
	args,
	theme,
) => {
	const ids =
		args.action === "send"
			? args.id
			: args.action === "list"
				? undefined
				: args.ids?.join(", ");
	return new Text(
		theme.fg("toolTitle", theme.bold(SESSION_TOOL_NAME)) +
			theme.fg("muted", " • ") +
			theme.fg("accent", args.action) +
			(ids ? theme.fg("muted", ` • ${ids}`) : ""),
		0,
		0,
	);
};

export const renderDelegateResult: DelegateRenderResult = (
	result,
	options,
	theme,
	context,
) => {
	const details = result.details;
	if (details?.success === false && options.isPartial) {
		const container = new Container();
		container.addChild(
			new Text(renderStatus("running", "muted", details, true, theme), 0, 0),
		);
		const progress = formatProgress(details);
		if (progress) {
			container.addChild(new Text(theme.fg("muted", progress), 0, 0));
		}
		const task = renderAssignedTask(
			details.assignedTask ?? "",
			options.expanded,
			theme,
		);
		if (task) container.addChild(task);
		return container;
	}

	if (details?.status === "running" && !context.isError) {
		const container = new Container();
		container.addChild(
			new Text(
				theme.fg("accent", details.id) +
					theme.fg("muted", " • ") +
					renderStatus("running", "muted", details, true, theme) +
					theme.fg("dim", " • result will be delivered automatically"),
				0,
				0,
			),
		);
		const task = renderAssignedTask(
			details.assignedTask ?? "",
			options.expanded,
			theme,
		);
		if (task) container.addChild(task);
		return container;
	}

	if (details?.success === true) {
		const line = renderStatus("done", "success", details, true, theme);
		const content = result.content[0];
		const output = content?.type === "text" ? content.text : "";
		const container = new Container();
		container.addChild(new Text(line, 0, 0));
		if (options.expanded) {
			container.addChild(
				new Text(keyHint("app.tools.expand", "collapse child report"), 0, 0),
			);
		}
		const task = renderAssignedTask(
			details.assignedTask ?? "",
			options.expanded,
			theme,
		);
		if (task) container.addChild(task);
		renderChildReport(container, output, details, options.expanded, theme);
		return container;
	}

	const content = result.content[0];
	const text = content?.type === "text" ? content.text : "";
	if (context.isError) {
		return new Text(theme.fg("error", `failed • ${text}`), 0, 0);
	}
	return new Text(text, 0, 0);
};

export const renderDelegateSessionResult: DelegateSessionRenderResult = (
	result,
	options,
	theme,
	context,
) => {
	const content = result.content[0];
	const text = content?.type === "text" ? content.text : "";
	if (context.isError) {
		return new Text(theme.fg("error", `failed • ${text}`), 0, 0);
	}

	const details = result.details;
	const snapshots = details
		? "results" in details
			? details.results
			: [details]
		: [];
	if (snapshots.length === 0) return new Text(text, 0, 0);

	const container = new Container();
	for (const [index, snapshot] of snapshots.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		const color =
			snapshot.status === "done"
				? "success"
				: snapshot.status === "error"
					? "error"
					: snapshot.status === "cancelled"
						? "warning"
						: "muted";
		container.addChild(
			new Text(
				theme.fg("accent", snapshot.id) +
					theme.fg("muted", " • ") +
					renderStatus(snapshot.status, color, snapshot, true, theme),
				0,
				0,
			),
		);
		const settledOutput = snapshot.status !== "running" && snapshot.output;
		if (settledOutput && options.expanded) {
			container.addChild(
				new Text(keyHint("app.tools.expand", "collapse child report"), 0, 0),
			);
		}
		const task = renderAssignedTask(
			snapshot.assignedTask ?? "",
			options.expanded,
			theme,
		);
		if (task) container.addChild(task);
		if (settledOutput) {
			renderChildReport(
				container,
				snapshot.output,
				snapshot,
				options.expanded,
				theme,
			);
		}
	}
	return container;
};

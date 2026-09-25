import type {
	ExtensionAPI,
	ExtensionContext,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Schema } from "effect";

const MOMENT_ENTRY = "session-timer-moment";

const isElapsedMilliseconds = Schema.is(
	Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
);

function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.round(milliseconds / 1000);
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600) % 24;
	const days = Math.floor(totalSeconds / 86400);
	const paddedSeconds = String(seconds).padStart(2, "0");
	const paddedMinutes = String(minutes).padStart(2, "0");

	if (days > 0) return `${days}d ${hours}h ${paddedMinutes}m ${paddedSeconds}s`;

	if (totalSeconds >= 3600) return `${hours}h ${minutes}m ${paddedSeconds}s`;

	if (totalSeconds >= 60) return `${minutes}m ${paddedSeconds}s`;

	return `${seconds}s`;
}

function messageTime(entry: SessionMessageEntry): number | undefined {
	switch (entry.message.role) {
		case "user":
		case "toolResult":
			return entry.message.timestamp;
		case "assistant":
			// The message timestamp is generation start; the entry records completion.
			return Date.parse(entry.timestamp);
		default:
			return undefined;
	}
}

export default function sessionTimer(pi: ExtensionAPI): void {
	let origin: number | undefined;
	let pendingResponse = false;

	function elapsedAt(timestamp: number): number | undefined {
		if (origin === undefined) return undefined;
		const elapsed = timestamp - origin;

		return Number.isFinite(elapsed) ? Math.max(0, elapsed) : undefined;
	}

	function showDuration(ctx: ExtensionContext, timestamp?: number): void {
		if (ctx.mode !== "tui") return;
		const elapsed = timestamp === undefined ? undefined : elapsedAt(timestamp);
		ctx.ui.setStatus(
			"session-timer",
			elapsed === undefined
				? undefined
				: ctx.ui.theme.fg("dim", `⏱ ${formatDuration(elapsed)}`),
		);
	}

	function restore(ctx: ExtensionContext): void {
		origin = undefined;
		pendingResponse = false;
		let latest: number | undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;

			if (entry.message.role === "user") origin ??= entry.message.timestamp;
			const timestamp = messageTime(entry);

			if (timestamp !== undefined) latest = timestamp;
		}

		showDuration(ctx, latest);
	}

	function finishResponse(ctx: ExtensionContext): void {
		if (!pendingResponse) return;
		pendingResponse = false;

		// message_end precedes persistence. These hooks run after the assistant is
		// saved, before any tool results, so only extension metadata can follow it.
		let entry = ctx.sessionManager.getLeafEntry();

		while (entry && entry.type !== "message") {
			entry = entry.parentId
				? ctx.sessionManager.getEntry(entry.parentId)
				: undefined;
		}

		if (entry?.type !== "message" || entry.message.role !== "assistant") return;

		const timestamp = messageTime(entry);
		showDuration(ctx, timestamp);

		if (timestamp === undefined) return;
		const elapsed = elapsedAt(timestamp);

		const hasText = entry.message.content.some(
			(block) => block.type === "text" && block.text.trim().length > 0,
		);

		if (elapsed !== undefined && hasText) pi.appendEntry(MOMENT_ENTRY, elapsed);
	}

	pi.registerEntryRenderer<unknown>(MOMENT_ENTRY, (entry, _options, theme) => {
		const elapsed = entry.data;

		if (!isElapsedMilliseconds(elapsed)) return undefined;

		return new Text(theme.fg("dim", `⏱ ${formatDuration(elapsed)}`), 1, 0);
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("message_start", ({ message }, ctx) => {
		if (message.role !== "user") return;
		origin ??= message.timestamp;
		showDuration(ctx, message.timestamp);
	});

	pi.on("message_end", ({ message }, ctx) => {
		if (message.role === "assistant") pendingResponse = true;

		if (message.role === "toolResult") showDuration(ctx, message.timestamp);
	});

	pi.on("tool_execution_start", (_event, ctx) => finishResponse(ctx));
	pi.on("turn_end", (_event, ctx) => finishResponse(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		origin = undefined;
		pendingResponse = false;
		showDuration(ctx);
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ESTIMATED_CHARS_PER_TOKEN = 4;

interface TpsDependencies {
	readonly now: () => number;
}

const liveTps: TpsDependencies = { now: () => performance.now() };

export default function tpsTracker(
	pi: ExtensionAPI,
	dependencies: TpsDependencies = liveTps,
): void {
	let messageStart: number | null = null;
	let streamStart: number | null = null;
	let estimatedStreamedTokens = 0;
	let totalOutputTokens = 0;
	let totalStreamMs = 0;

	function resetMessage(): void {
		messageStart = null;
		streamStart = null;
		estimatedStreamedTokens = 0;
	}

	pi.on("agent_start", (_event, ctx) => {
		totalOutputTokens = 0;
		totalStreamMs = 0;
		resetMessage();

		const theme = ctx.ui.theme;
		ctx.ui.setStatus("tps", theme.fg("dim", "⏱ generating..."));
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		resetMessage();
		messageStart = dependencies.now();
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const streamEvent = event.assistantMessageEvent;
		const isOutputDelta =
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta";

		if (!isOutputDelta) return;

		const now = dependencies.now();
		streamStart ??= now;
		estimatedStreamedTokens +=
			streamEvent.delta.length / ESTIMATED_CHARS_PER_TOKEN;

		const elapsed = (now - streamStart) / 1000;
		const officialTokens = event.message.usage.output;
		const currentTokens =
			officialTokens > 0 ? officialTokens : estimatedStreamedTokens;

		if (elapsed > 0 && currentTokens > 0) {
			const tps = Math.round(currentTokens / elapsed);
			const tokenLabel =
				officialTokens > 0
					? `${officialTokens} tok`
					: `~${Math.round(estimatedStreamedTokens)} tok`;
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"tps",
				`${theme.fg("accent", `${tps} tok/s`)} ${theme.fg("dim", `(${tokenLabel} / ${elapsed.toFixed(1)}s)`)}`,
			);
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;

		const messageTokens = event.message.usage.output;
		const timingStart = streamStart ?? messageStart;
		if (timingStart !== null && messageTokens > 0) {
			totalOutputTokens += messageTokens;
			totalStreamMs += dependencies.now() - timingStart;
		}

		resetMessage();
	});

	pi.on("agent_end", (_event, ctx) => {
		const elapsed = totalStreamMs / 1000;
		const tps =
			totalOutputTokens > 0 && elapsed > 0
				? Math.round(totalOutputTokens / elapsed)
				: 0;

		const theme = ctx.ui.theme;
		const icon = theme.fg("success", "✓");
		const tpsLabel =
			tps > 0 ? theme.fg("accent", `${tps} tok/s`) : theme.fg("dim", "N/A");
		const detail = theme.fg(
			"dim",
			`${totalOutputTokens} tokens in ${elapsed.toFixed(1)}s streaming`,
		);

		ctx.ui.notify(`${icon} ${tpsLabel}  ${detail}`, "info");
		ctx.ui.setStatus("tps", `${theme.fg("dim", "done —")} ${tpsLabel}`);
	});
}

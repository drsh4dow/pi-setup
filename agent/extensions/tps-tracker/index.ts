import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Short client-observed intervals are too sensitive to delivery and scheduling.
const MIN_RATE_DURATION_MS = 1_000;

interface TpsDependencies {
	readonly now: () => number;
}

interface RequestTiming {
	readonly startedAt: number;
	firstOutputMs: number | null;
}

const liveTps: TpsDependencies = { now: () => performance.now() };

function formatRate(outputTokens: number, durationMs: number): string {
	if (outputTokens <= 0 || durationMs < MIN_RATE_DURATION_MS) return "N/A";

	return `${(outputTokens / (durationMs / 1000)).toFixed(1)} effective output tok/s`;
}

export default function tpsTracker(
	pi: ExtensionAPI,
	dependencies: TpsDependencies = liveTps,
): void {
	let request: RequestTiming | undefined;
	let totalOutputTokens = 0;
	let totalRequestMs = 0;

	pi.on("agent_start", (_event, ctx) => {
		request = undefined;
		totalOutputTokens = 0;
		totalRequestMs = 0;
		ctx.ui.setStatus("tps", ctx.ui.theme.fg("dim", "⏱ generating..."));
	});

	pi.on("before_provider_request", (_event, ctx) => {
		// message_start is too late: Codex emits it after headers or its first event.
		request = { startedAt: dependencies.now(), firstOutputMs: null };
		ctx.ui.setStatus("tps", ctx.ui.theme.fg("dim", "⏱ waiting for output..."));
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant" || !request) return;

		if (request.firstOutputMs !== null) return;

		const streamEvent = event.assistantMessageEvent;

		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) {
			return;
		}

		if (streamEvent.delta.length === 0) return;

		request.firstOutputMs = dependencies.now() - request.startedAt;
		ctx.ui.setStatus(
			"tps",
			ctx.ui.theme.fg(
				"dim",
				`receiving · first output ${(request.firstOutputMs / 1000).toFixed(1)}s`,
			),
		);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const timing = request;
		request = undefined;
		const outputTokens = event.message.usage.output;

		if (!timing || outputTokens <= 0) {
			ctx.ui.setStatus(
				"tps",
				ctx.ui.theme.fg("dim", "output rate unavailable"),
			);

			return;
		}

		const durationMs = dependencies.now() - timing.startedAt;
		totalOutputTokens += outputTokens;
		totalRequestMs += durationMs;

		ctx.ui.setStatus(
			"tps",
			ctx.ui.theme.fg(
				"dim",
				`response complete · ${formatRate(outputTokens, durationMs)}`,
			),
		);
	});

	pi.on("agent_end", (_event, ctx) => {
		request = undefined;
		const rate = formatRate(totalOutputTokens, totalRequestMs);
		const theme = ctx.ui.theme;
		const rateLabel = theme.fg(rate === "N/A" ? "dim" : "accent", rate);

		const detail = theme.fg(
			"dim",
			`${totalOutputTokens} reported output tokens in ${(totalRequestMs / 1000).toFixed(1)}s of requests`,
		);

		ctx.ui.notify(
			`${theme.fg("success", "✓")} ${rateLabel}  ${detail}`,
			"info",
		);
		ctx.ui.setStatus("tps", `${theme.fg("dim", "done ·")} ${rateLabel}`);
	});
}

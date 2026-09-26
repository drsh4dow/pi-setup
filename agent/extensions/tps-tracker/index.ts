import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

const MEASUREMENT_ENTRY = "tps-tracker-measurement";

// Short client-observed intervals are too sensitive to delivery and scheduling.
const MIN_RATE_DURATION_MS = 1_000;

const Measurement = Schema.Struct({
	outputTokens: Schema.Finite.check(Schema.isGreaterThan(0)),
	durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

const isMeasurement = Schema.is(Measurement);

interface TpsDependencies {
	readonly now: () => number;
}

const liveTps: TpsDependencies = { now: () => performance.now() };

export default function tpsTracker(
	pi: ExtensionAPI,
	dependencies: TpsDependencies = liveTps,
): void {
	let requestStartedAt: number | undefined;
	let totalOutputTokens = 0;
	let totalRequestMs = 0;

	function showRate(ctx: ExtensionContext): void {
		if (totalOutputTokens <= 0 || totalRequestMs < MIN_RATE_DURATION_MS) {
			ctx.ui.setStatus(
				"tps",
				ctx.ui.theme.fg("dim", "⏱ waiting for output..."),
			);

			return;
		}

		const rate = totalOutputTokens / (totalRequestMs / 1000);
		ctx.ui.setStatus(
			"tps",
			ctx.ui.theme.fg("accent", `${rate.toFixed(1)} tok/s`),
		);
	}

	function restore(ctx: ExtensionContext): void {
		requestStartedAt = undefined;
		totalOutputTokens = 0;
		totalRequestMs = 0;

		// getBranch retains pre-compaction entries and excludes abandoned branches.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== MEASUREMENT_ENTRY) {
				continue;
			}

			const measurement: unknown = entry.data;

			if (!isMeasurement(measurement)) continue;

			totalOutputTokens += measurement.outputTokens;
			totalRequestMs += measurement.durationMs;
		}

		showRate(ctx);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("before_provider_request", () => {
		// message_start is too late: Codex emits it after headers or its first event.
		requestStartedAt = dependencies.now();
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const startedAt = requestStartedAt;
		requestStartedAt = undefined;

		if (startedAt === undefined || event.message.usage.output <= 0) return;

		const measurement = {
			outputTokens: event.message.usage.output,
			durationMs: dependencies.now() - startedAt,
		} satisfies typeof Measurement.Type;

		// message_end precedes assistant persistence. Storing here makes this
		// measurement an ancestor of its response, including when forking at it.
		pi.appendEntry(MEASUREMENT_ENTRY, measurement);
		totalOutputTokens += measurement.outputTokens;
		totalRequestMs += measurement.durationMs;
		showRate(ctx);
	});

	pi.on("agent_end", () => {
		requestStartedAt = undefined;
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Clock, Effect, Fiber } from "effect";

interface TimerDependencies {
	readonly now: () => number;
	readonly everySecond: (tick: () => void) => () => void;
}

const liveTimer: TimerDependencies = {
	now: () => Effect.runSync(Clock.currentTimeMillis),
	everySecond(tick) {
		const fiber = Effect.runFork(
			Effect.sleep("1 second").pipe(
				Effect.tap(Effect.sync(tick)),
				Effect.forever,
			),
		);
		return () => Effect.runSync(Fiber.interrupt(fiber));
	},
};

export default function sessionTimer(
	pi: ExtensionAPI,
	dependencies: TimerDependencies = liveTimer,
): void {
	let runStart = 0;
	let sessionTotalMs = 0;
	let stopTicker: (() => void) | undefined;

	function fmt(ms: number): string {
		const s = Math.round(ms / 1000);
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
	}

	function stop() {
		stopTicker?.();
		stopTicker = undefined;
	}

	pi.on("session_shutdown", (_event, ctx) => {
		stop();
		sessionTotalMs = 0;
		if (ctx.mode === "tui") ctx.ui.setStatus("session-timer", undefined);
	});

	pi.on("agent_start", (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;
		runStart = dependencies.now();
		stopTicker = dependencies.everySecond(() => {
			ctx.ui.setStatus(
				"session-timer",
				ctx.ui.theme.fg("dim", `⏱ ${fmt(dependencies.now() - runStart)}`),
			);
		});
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!stopTicker) return;
		stop();
		const runMs = dependencies.now() - runStart;
		sessionTotalMs += runMs;
		const theme = ctx.ui.theme;
		ctx.ui.setStatus(
			"session-timer",
			`${theme.fg("accent", `⏱ ${fmt(runMs)}`)} ${theme.fg("dim", `(session ${fmt(sessionTotalMs)})`)}`,
		);
	});
}

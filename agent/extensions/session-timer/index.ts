import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Clock, Effect, Fiber } from "effect";
export default function sessionTimer(pi: ExtensionAPI): void {
	let runStart = 0;
	let sessionTotalMs = 0;
	let ticker: Fiber.Fiber<void> | null = null;

	function fmt(ms: number): string {
		const s = Math.round(ms / 1000);
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
	}

	pi.on("agent_start", (_event, ctx) => {
		if (ticker) Effect.runSync(Fiber.interrupt(ticker));
		runStart = Effect.runSync(Clock.currentTimeMillis);
		ticker = Effect.runFork(
			Effect.gen(function* () {
				yield* Effect.sleep("1 second");
				const now = yield* Clock.currentTimeMillis;
				ctx.ui.setStatus(
					"session-timer",
					ctx.ui.theme.fg("dim", `⏱ ${fmt(now - runStart)}`),
				);
			}).pipe(Effect.forever),
		);
	});

	pi.on("agent_end", (_event, ctx) =>
		Effect.runPromise(
			Effect.gen(function* () {
				if (ticker) yield* Fiber.interrupt(ticker);
				ticker = null;
				const runMs = (yield* Clock.currentTimeMillis) - runStart;
				sessionTotalMs += runMs;
				const theme = ctx.ui.theme;
				ctx.ui.setStatus(
					"session-timer",
					`${theme.fg("accent", `⏱ ${fmt(runMs)}`)} ${theme.fg("dim", `(session ${fmt(sessionTotalMs)})`)}`,
				);
			}),
		),
	);
}

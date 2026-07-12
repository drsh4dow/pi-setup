import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Tracks wall-clock time from prompt submission (agent_start) until control
// returns to the user (agent_end) — the whole run, not a single turn — plus
// a cumulative total across the session.
export default function sessionTimer(pi: ExtensionAPI): void {
  let runStart = 0;
  let sessionTotalMs = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;

  function fmt(ms: number): string {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  }

  pi.on("agent_start", (_event, ctx) => {
    runStart = performance.now();
    ticker = setInterval(() => {
      ctx.ui.setStatus(
        "session-timer",
        ctx.ui.theme.fg("dim", `⏱ ${fmt(performance.now() - runStart)}`),
      );
    }, 1000);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ticker) clearInterval(ticker);
    ticker = null;
    const runMs = performance.now() - runStart;
    sessionTotalMs += runMs;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(
      "session-timer",
      `${theme.fg("accent", `⏱ ${fmt(runMs)}`)} ${theme.fg("dim", `(session ${fmt(sessionTotalMs)})`)}`,
    );
  });
}

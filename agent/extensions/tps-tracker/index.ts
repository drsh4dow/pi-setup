import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Clock, Effect } from "effect";

export default function (pi: ExtensionAPI) {
  let agentStartMs: number | null = null;

  pi.on("agent_start", () => {
    agentStartMs = Effect.runSync(Clock.currentTimeMillis);
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;

    if (agentStartMs === null) return;

    const elapsedMs = Effect.runSync(Clock.currentTimeMillis) - agentStartMs;
    agentStartMs = null;

    if (elapsedMs <= 0) return;

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let totalTokens = 0;

    for (const message of event.messages) {
      if (message.role !== "assistant") continue;
      input += message.usage.input || 0;
      output += message.usage.output || 0;
      cacheRead += message.usage.cacheRead || 0;
      cacheWrite += message.usage.cacheWrite || 0;
      totalTokens += message.usage.totalTokens || 0;
    }

    if (output <= 0) return;

    const elapsedSeconds = elapsedMs / 1000;
    const tokensPerSecond = output / elapsedSeconds;
    const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`;
    ctx.ui.notify(message, "info");
  });
}

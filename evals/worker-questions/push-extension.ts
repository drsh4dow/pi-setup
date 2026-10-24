// Eval-only Pi extension for the C+push arm: delivers a message the parent drops into the run's
// mailbox file ($WQ_MAILBOX) into the running worker as a steering message, at the next tool
// result or turn end, and appends the delivery to $WQ_PUSH_LOG. Each message is delivered once.

import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function pushExtension(pi: ExtensionAPI) {
  const mailbox = process.env.WQ_MAILBOX;
  const log = process.env.WQ_PUSH_LOG;

  if (mailbox === undefined || log === undefined) return;

  const deliver = () => {
    if (!existsSync(mailbox)) return;

    const message = readFileSync(mailbox, "utf8").trim();

    rmSync(mailbox, { force: true });

    if (message === "") return;

    pi.sendUserMessage(message, { deliverAs: "steer" });
    appendFileSync(log, `${JSON.stringify({ deliveredAt: Date.now(), message })}\n`);
  };

  pi.on("tool_result", deliver);
  pi.on("turn_end", deliver);
}

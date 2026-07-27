import assert from "node:assert/strict";
import test from "node:test";
import { formatProgress, sessionSummary } from "../format.ts";
import { snapshot } from "./snapshot.ts";

test("a running delegate reports its activity and how stale it is", () => {
  assert.equal(
    sessionSummary(
      snapshot({ progress: "writing: patching the tokenizer", idleMs: 4_200 }),
    ),
    "delegate-1 [running] sonnet • 4m5s • 12 tools · inspect the parser seam\n  writing: patching the tokenizer · 4.2s ago",
  );
});

test("a long-running tool reads as stale rather than as a verdict", () => {
  assert.equal(
    formatProgress(
      snapshot({ progress: "tool: Bash · running", idleMs: 372_000 }),
    ),
    "tool: Bash · running · 6m12s ago",
  );
});

test("a settled delegate reports no activity line", () => {
  const settled = snapshot({ status: "done", success: true, durationMs: 900 });
  assert.equal(formatProgress(settled), "");
  assert.equal(
    sessionSummary(settled),
    "delegate-1 [done] sonnet • 900ms • 12 tools · inspect the parser seam",
  );
});

test("an empty task still identifies the delegate", () => {
  assert.match(
    sessionSummary(snapshot({ assignedTask: "   " })),
    /· \(empty task\)$/,
  );
});

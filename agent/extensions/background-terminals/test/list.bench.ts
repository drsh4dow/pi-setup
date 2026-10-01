// Run with vp run bench:terminals. Measures listing with a full retained output tail.
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { Effect } from "effect";
import { BackgroundTerminalManager, RETAINED_BYTES } from "../manager.ts";
import { nodeCommand } from "./node-command.ts";

const manager = new BackgroundTerminalManager();

try {
  const run = manager.start({
    command: nodeCommand(
      `process.stdout.write("x".repeat(${RETAINED_BYTES})); setInterval(()=>{},1000)`,
    ),
    title: "listing probe",
    cwd: process.cwd(),
  });

  const deadline = Date.now() + 5000;

  while (manager.get(run.id)?.stdout.totalBytes !== RETAINED_BYTES) {
    assert.ok(Date.now() < deadline, "terminal output readiness");
    // Polling observes each result before retrying.
    // oxlint-disable-next-line no-await-in-loop
    await setTimeout(10);
  }

  const start = performance.now();

  for (let index = 0; index < 100; index++) {
    assert.equal(manager.list().filter((entry) => entry.state === "running").length, 1);
  }

  console.log(
    JSON.stringify({
      listings: 100,
      retainedBytes: RETAINED_BYTES,
      elapsedMs: performance.now() - start,
    }),
  );
} finally {
  await Effect.runPromise(manager.shutdown());
}

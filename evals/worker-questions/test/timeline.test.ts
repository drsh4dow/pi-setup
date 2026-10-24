import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ARMS } from "../arms.ts";
import { scenarioById } from "../scenarios.ts";
import { watchTriggers, type Learned } from "../timeline.ts";
import { prepareRun } from "../workdir.ts";

const scratch: string[] = [];

after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

test("the S9 order reaches the parent at the worker's first edit, once", async () => {
  const scenario = scenarioById("s9-order");
  const outputDir = mkdtempSync(join(tmpdir(), "wq-timeline-"));
  const prepared = prepareRun({ scenario, arm: ARMS["C+push"], outputDir });

  scratch.push(outputDir, prepared.workdir);

  const learned: Learned = new Map();
  const calls: number[] = [];
  const { promise: until, resolve: finish } = Promise.withResolvers<void>();

  const watching = watchTriggers({
    scenario,
    workdir: prepared.workdir,
    baseSha: prepared.baseSha,
    startedAt: Date.now(),
    learned,
    onLearn: (index) => calls.push(index),
    until,
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(learned.size, 0, "learned before any edit");

  writeFileSync(
    join(prepared.workdir, "src", "money.js"),
    "export const formatMoney = () => '';\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  finish();
  await watching;

  assert.deepEqual(calls, [0]);
  assert.ok((learned.get(0) ?? 0) >= 1, "learned at the edit, not at the start");
});

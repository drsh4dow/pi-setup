// The speed metrics on a real run, candidate t1 of the 2026-10-25 v3 batch, stripped to its
// timestamps, names, and assignment openings (`fixtures/v3-candidate-t1/`), and on small spans
// whose answer is plain arithmetic. The v3 values are what the research script `crit.mjs` printed
// for the full run, and the finish time is read off its sessions and gh state by hand.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { finishMinutes, parallelMinutes, readChildRun, type ChildRun } from "../implementers.ts";
import { sessionFiles } from "../isolation.ts";
import { overlapMs, readSessionClock, rootIdle, type SessionClock } from "../speed.ts";

const V3 = join(import.meta.dirname, "fixtures", "v3-candidate-t1");

// PR #5, the chunk's one final PR, merged then (gh-state.json of the run).
const V3_FINAL_MERGE = "2026-10-25T03:18:01.062Z";

function v3Children(): ChildRun[] {
  return sessionFiles(join(V3, "sessions")).map(readChildRun);
}

const minutes = (ms: number) => ms * 60_000;

const implementer = (name: string, start: number, end: number): ChildRun => ({
  file: name,
  startedAt: new Date(start).toISOString(),
  cwd: "/tmp/wt",
  name: `subagent: ${name}`,
  assignment: `GOAL Implement ${name}`,
  report: "",
  userMessages: 1,
  costUsd: 0,
  span: { start, end },
});

describe("speed metrics", () => {
  test("v3 candidate t1: 20.9 wall and 16.1 model minutes of the root with no child running", () => {
    const root = readSessionClock(join(V3, "root.jsonl"));

    assert.ok(root !== null);

    const idle = rootIdle({
      root,
      children: v3Children().flatMap((child) => (child.span === null ? [] : [child.span])),
    });

    assert.equal((idle.idleMs / 60_000).toFixed(1), "20.9");
    assert.equal((idle.modelIdleMs / 60_000).toFixed(1), "16.1");
  });

  test("v3 candidate t1: 35.6 minutes from the precision implementer's end to the final merge", () => {
    const finish = finishMinutes(v3Children(), V3_FINAL_MERGE);

    assert.ok(finish.known);
    assert.equal(finish.value.toFixed(1), "35.6");
  });

  test("v3 candidate t1: TAL-3 and TAL-4 were both on the frontier but ran one after the other", () => {
    assert.deepEqual(parallelMinutes(v3Children(), ["TAL-3", "TAL-4"]), {
      known: true,
      value: 0,
    });
  });

  test("root idle time counts only the spans no child covers, and model time by its midpoint", () => {
    // The root lives 0–10 min and answers at 1, 4, and 9 min; children run 2–5 and 3–6.
    const root: SessionClock = {
      span: { start: 0, end: minutes(10) },
      assistantLatencies: [
        { start: 0, end: minutes(1) },
        { start: minutes(3), end: minutes(4) },
        { start: minutes(8), end: minutes(9) },
      ],
    };

    const idle = rootIdle({
      root,
      children: [
        { start: minutes(2), end: minutes(5) },
        { start: minutes(3), end: minutes(6) },
      ],
    });

    assert.deepEqual(idle, { idleMs: minutes(6), modelIdleMs: minutes(2) });
  });

  test("overlap is the time two sets of spans share", () => {
    assert.equal(
      overlapMs([{ start: 0, end: minutes(4) }], [{ start: minutes(3), end: minutes(7) }]),
      minutes(1),
    );
    assert.equal(
      overlapMs([{ start: 0, end: minutes(2) }], [{ start: minutes(3), end: minutes(7) }]),
      0,
    );
  });

  test("parallel minutes read the overlap of two tickets' implementers, and unknown when one unit carried both", () => {
    const parallel = [
      implementer("implement TAL-3", 0, minutes(5)),
      implementer("implement TAL-4", minutes(2), minutes(8)),
    ];

    assert.deepEqual(parallelMinutes(parallel, ["TAL-3", "TAL-4"]), { known: true, value: 3 });

    const together = [implementer("implement TAL-3 and TAL-4", 0, minutes(5))];

    assert.equal(parallelMinutes(together, ["TAL-3", "TAL-4"]).known, false);
  });

  test("finish minutes are unknown without a final merge", () => {
    assert.equal(finishMinutes(v3Children(), null).known, false);
  });
});

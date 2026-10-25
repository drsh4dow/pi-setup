// The second pre-registered reading, on arm summaries built from synthetic runs: better needs a
// correct rate not lower, no quality outcome worse and one better, and a median wall time at
// least 10% lower. Cost never enters it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { summarize, type ArmSummary, type GradedRun } from "../grade.ts";
import { known, unknown, type RunMetrics } from "../metrics.ts";
import { qualitySpeedReading } from "../quality-reading.ts";
import { BLANK } from "./blank-metrics.ts";

interface Trial {
  readonly wall: number;
  readonly edgePassed: number;
  readonly t7?: "adheres" | "drifted";
  readonly t8?: "conforms" | "surfaced" | "missed";
  readonly cost?: number;
}

const EDGE_TOTAL = 14;

function arm(name: string, trials: readonly Trial[]): ArmSummary {
  const runs = trials.map((trial, index): GradedRun => {
    const metrics: RunMetrics = {
      ...BLANK,
      correct: known(true),
      wallMinutes: known(trial.wall),
      rootCost: known(trial.cost ?? 10),
      childCost: known(0),
      edgeCases: known({ passed: trial.edgePassed, total: EDGE_TOTAL }),
      t7: known(trial.t7 ?? "drifted"),
      t8: known(trial.t8 ?? "missed"),
      t9: known({ outcome: "inconsistent", why: "not set in this test" }),
    };

    return {
      arm: name,
      trial: index + 1,
      isolation: { ok: true, sessions: 1, bad: [] },
      integrity: { ok: true, problems: [], warnings: [] },
      metrics,
    };
  });

  return summarize(name, runs);
}

const baseline = arm("baseline", [
  { wall: 60, edgePassed: 10 },
  { wall: 55, edgePassed: 11 },
  { wall: 70, edgePassed: 10 },
]);

describe("the quality and speed reading", () => {
  test("calls a candidate better that passes more edge cases and finishes 15% faster, at three times the cost", () => {
    const candidate = arm("candidate", [
      { wall: 50, edgePassed: 12, cost: 30 },
      { wall: 51, edgePassed: 12, cost: 30 },
      { wall: 60, edgePassed: 11, cost: 30 },
    ]);

    const result = qualitySpeedReading(baseline, candidate);

    assert.equal(result.better, true, result.sentence);
    assert.deepEqual(
      result.comparisons.map((comparison) => [comparison.name, comparison.verdict]),
      [
        ["edge-case pass rate", "better"],
        ["T7 adheres", "same"],
        ["T8 conforms or surfaced", "same"],
        ["T9 consistent", "same"],
      ],
    );
  });

  test("does not call a candidate better that is only 5% faster", () => {
    const candidate = arm("candidate", [
      { wall: 57, edgePassed: 12 },
      { wall: 52, edgePassed: 12 },
      { wall: 60, edgePassed: 12 },
    ]);

    assert.equal(qualitySpeedReading(baseline, candidate).better, false);
  });

  test("does not call a candidate better that is worse on one trap, however fast", () => {
    const base = arm("baseline", [
      { wall: 60, edgePassed: 10, t8: "conforms" },
      { wall: 60, edgePassed: 10, t8: "surfaced" },
      { wall: 60, edgePassed: 10, t8: "conforms" },
    ]);

    const candidate = arm("candidate", [
      { wall: 30, edgePassed: 12, t8: "conforms" },
      { wall: 30, edgePassed: 12, t8: "missed" },
      { wall: 30, edgePassed: 12, t8: "conforms" },
    ]);

    const result = qualitySpeedReading(base, candidate);

    assert.equal(result.comparisons[2].verdict, "worse");
    assert.equal(result.better, false, result.sentence);
  });

  test("cannot be read when one arm has no known trap outcome", () => {
    const blind = summarize("candidate", [
      {
        arm: "candidate",
        trial: 1,
        isolation: { ok: true, sessions: 1, bad: [] },
        integrity: { ok: true, problems: [], warnings: [] },
        metrics: { ...BLANK, correct: known(true), wallMinutes: known(10), t7: unknown("old") },
      },
    ]);

    assert.equal(qualitySpeedReading(baseline, blind).better, null);
  });
});

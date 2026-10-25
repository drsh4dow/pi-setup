// The second pre-registered reading, quality and speed, which the grader prints beside the first.

import type { ArmSummary, Comparison } from "./grade.ts";

/** A share of runs, or of requests, with a good outcome. */
interface Rate {
  readonly yes: number;
  readonly known: number;
}

function rateOf(counts: Readonly<Record<string, number>>, good: readonly string[]): Rate {
  let yes = 0;
  let knownRuns = 0;

  for (const [label, runs] of Object.entries(counts)) {
    if (label === "unknown") continue;

    knownRuns += runs;

    if (good.includes(label)) yes += runs;
  }

  return { yes, known: knownRuns };
}

/** Higher is better; with a handful of runs, any difference in the rate counts. */
export function compareRate(name: string, baseline: Rate, candidate: Rate): Comparison {
  if (baseline.known === 0 || candidate.known === 0)
    return { name, verdict: "unknown", detail: "no known outcome in one arm" };

  const baseRate = baseline.yes / baseline.known;
  const candidateRate = candidate.yes / candidate.known;
  const detail = `baseline ${baseline.yes}/${baseline.known}, candidate ${candidate.yes}/${candidate.known}`;

  if (candidateRate > baseRate) return { name, verdict: "better", detail };

  if (candidateRate < baseRate) return { name, verdict: "worse", detail };

  return { name, verdict: "same", detail };
}

export interface QualitySpeedReading {
  readonly candidate: string;
  readonly comparisons: readonly Comparison[];
  readonly correctNotLower: boolean | null;
  /** The candidate's median `wallMinutes` over the baseline's. */
  readonly wallRatio: number | null;
  readonly better: boolean | null;
  readonly sentence: string;
}

/**
 * The second pre-registered reading, quality and speed, with cost left out at the user's
 * direction: better if correctness is not lower, none of {edge-case rate, T7, T8, T9} is worse and
 * one is better, and the median wall time is at least 10% lower.
 */
export function qualitySpeedReading(
  baseline: ArmSummary,
  candidate: ArmSummary,
): QualitySpeedReading {
  const comparisons = [
    compareRate(
      "edge-case pass rate",
      { yes: baseline.edgeCases.passed, known: baseline.edgeCases.total },
      { yes: candidate.edgeCases.passed, known: candidate.edgeCases.total },
    ),
    compareRate("T7 adheres", rateOf(baseline.t7, ["adheres"]), rateOf(candidate.t7, ["adheres"])),
    compareRate(
      "T8 conforms or surfaced",
      rateOf(baseline.t8, ["conforms", "surfaced"]),
      rateOf(candidate.t8, ["conforms", "surfaced"]),
    ),
    compareRate(
      "T9 consistent",
      rateOf(baseline.t9, ["consistent"]),
      rateOf(candidate.t9, ["consistent"]),
    ),
  ];

  const correctNotLower = compareRate("correct", baseline.correct, candidate.correct);

  const notLower =
    correctNotLower.verdict === "unknown" ? null : correctNotLower.verdict !== "worse";

  const baseWall = baseline.metrics.wallMinutes;
  const candidateWall = candidate.metrics.wallMinutes;

  const wallRatio =
    baseWall === undefined || candidateWall === undefined || baseWall.median === 0
      ? null
      : candidateWall.median / baseWall.median;

  const readable =
    notLower !== null &&
    wallRatio !== null &&
    comparisons.every((comparison) => comparison.verdict !== "unknown");

  const improved = comparisons.filter((comparison) => comparison.verdict === "better").length;
  const worsened = comparisons.filter((comparison) => comparison.verdict === "worse").length;

  const better = readable ? notLower && worsened === 0 && improved >= 1 && wallRatio <= 0.9 : null;

  let verdictWord = "cannot be read on quality and speed (a needed value is unknown)";

  if (better !== null)
    verdictWord = better ? "is better on quality and speed" : "is not better on quality and speed";

  return {
    candidate: candidate.arm,
    comparisons,
    correctNotLower: notLower,
    wallRatio,
    better,
    sentence: `${candidate.arm} ${verdictWord}: correctness not lower ${String(notLower)}, ${improved} of 4 quality outcomes better and ${worsened} worse, median wall ratio ${wallRatio === null ? "unknown" : wallRatio.toFixed(2)} (needs at most 0.90), cost not counted`,
  };
}

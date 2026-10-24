// The pre-registered decision rule, fixed before any pilot run. Adopt R or L over C only if, on
// the pooled S1, S2, S7, S9 runs, its median timeToCorrect is at least 20% lower than C's, and
// also: its correct rate is not lower than C's on any scenario; its noise and repo-answerable asks
// average at most 0.25 per run on S3, S4, S5, S6, S8; and its total cost (worker plus parent) is
// within +10% of C's. Any scenario-by-arm cell the rule reads with fewer than 3 graded runs makes
// the verdict "insufficient data".

import type { ArmId, Family, ScenarioId } from "./scenario.ts";

export const RULE_TEXT = [
  "Adopt R or L over C only if, on the pooled S1, S2, S7, S9 runs, its median timeToCorrect is at least 20% lower than C's, and also:",
  "- its correct rate is not lower than C's on any scenario;",
  "- its noise + repoAnswerable asks average at most 0.25 per run on S3, S4, S5, S6, S8;",
  "- its total cost (worker + parent) is within +10% of C's.",
  'A run that never becomes correct has an unbounded timeToCorrect. Any scenario × arm cell the rule reads with fewer than 3 graded runs gives "insufficient data".',
].join("\n");

export const SPEED_FAMILIES: readonly Family[] = ["S1", "S2", "S7", "S9"];

export const NOISE_FAMILIES: readonly Family[] = ["S3", "S4", "S5", "S6", "S8"];

export const MIN_RUNS = 3;

const SPEEDUP = 0.8;

const NOISE_LIMIT = 0.25;

const COST_LIMIT = 1.1;

/** One graded run: valid, with `correct` decided. */
export interface RuleRun {
  readonly scenario: ScenarioId;
  readonly family: Family;
  readonly arm: ArmId;
  readonly correct: boolean;
  /** Seconds from the first spawn to the end of the round that made it correct; Infinity when never. */
  readonly timeToCorrect: number;
  /** Undefined when an ask could not be classified. */
  readonly noiseAsks: number | undefined;
  /** Worker plus parent dollars; undefined when a session's cost is unknown. */
  readonly totalCost: number | undefined;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;

  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export const correctRate = (runs: readonly RuleRun[]) =>
  mean(runs.map((run) => (run.correct ? 1 : 0)));

const known = (values: readonly (number | undefined)[]) =>
  values.filter((value) => value !== undefined);

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export type Verdict =
  | { readonly kind: "insufficient data"; readonly thinCells: readonly string[] }
  | { readonly kind: "adopt" | "do not adopt"; readonly checks: readonly Check[] };

function format(value: number | undefined, digits = 1): string {
  if (value === undefined) return "n/a";

  return Number.isFinite(value) ? value.toFixed(digits) : "∞";
}

/** The rule's verdict for `candidate` against C, over every scenario in `scenarioIds`. */
export function verdict({
  runs,
  candidate,
  scenarioIds,
}: {
  runs: readonly RuleRun[];
  candidate: ArmId;
  scenarioIds: readonly ScenarioId[];
}): Verdict {
  const cell = (arm: ArmId, scenario: ScenarioId) =>
    runs.filter((run) => run.arm === arm && run.scenario === scenario);

  const thinCells = scenarioIds.flatMap((scenario) =>
    (["C", candidate] as const).flatMap((arm) => {
      const n = cell(arm, scenario).length;

      return n < MIN_RUNS ? [`${scenario} ${arm}: ${n}`] : [];
    }),
  );

  if (thinCells.length > 0) return { kind: "insufficient data", thinCells };

  const ofArm = (arm: ArmId, families: readonly Family[]) =>
    runs.filter((run) => run.arm === arm && families.includes(run.family));

  const speedC = median(ofArm("C", SPEED_FAMILIES).map((run) => run.timeToCorrect));
  const speedX = median(ofArm(candidate, SPEED_FAMILIES).map((run) => run.timeToCorrect));

  const faster =
    speedC !== undefined &&
    speedX !== undefined &&
    (speedC === Infinity ? speedX < Infinity : speedX <= SPEEDUP * speedC);

  const worse = scenarioIds.filter(
    (scenario) =>
      (correctRate(cell(candidate, scenario)) ?? 0) < (correctRate(cell("C", scenario)) ?? 0),
  );

  const noiseRuns = ofArm(candidate, NOISE_FAMILIES);
  const noise = mean(known(noiseRuns.map((run) => run.noiseAsks)));
  const unclassified = noiseRuns.filter((run) => run.noiseAsks === undefined).length;

  const costC = mean(known(runs.filter((run) => run.arm === "C").map((run) => run.totalCost)));

  const costX = mean(
    known(runs.filter((run) => run.arm === candidate).map((run) => run.totalCost)),
  );

  const checks: Check[] = [
    {
      name: "median timeToCorrect on S1, S2, S7, S9 at least 20% below C's",
      pass: faster,
      detail: `${candidate} ${format(speedX)} s vs C ${format(speedC)} s`,
    },
    {
      name: "correct rate not lower than C's on any scenario",
      pass: worse.length === 0,
      detail: worse.length === 0 ? "none lower" : `lower on ${worse.join(", ")}`,
    },
    {
      name: "noise + repoAnswerable asks average at most 0.25 per run on S3, S4, S5, S6, S8",
      pass: noise !== undefined && noise <= NOISE_LIMIT,
      detail: `${format(noise, 2)} per run${unclassified > 0 ? `, ${unclassified} runs left out with unclassified asks` : ""}`,
    },
    {
      name: "total cost within +10% of C's",
      pass: costC !== undefined && costX !== undefined && costX <= COST_LIMIT * costC,
      detail: `${candidate} $${format(costX, 2)} vs C $${format(costC, 2)} per run`,
    },
  ];

  return { kind: checks.every((check) => check.pass) ? "adopt" : "do not adopt", checks };
}

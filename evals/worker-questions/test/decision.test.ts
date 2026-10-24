import assert from "node:assert/strict";
import { test } from "node:test";
import { verdict, type RuleRun } from "../decision.ts";
import type { ArmId, ScenarioId } from "../scenario.ts";
import { scenarioById } from "../scenarios.ts";

const SCENARIOS: readonly ScenarioId[] = ["s1-survives", "s3-comments"];

/** Three runs of `arm` on each scenario, with the values given. */
function runs(
  arm: ArmId,
  values: Partial<Omit<RuleRun, "arm" | "scenario" | "family">> = {},
): RuleRun[] {
  return SCENARIOS.flatMap((scenario) =>
    [1, 2, 3].map(() =>
      Object.assign(
        {
          scenario,
          family: scenarioById(scenario).family,
          arm,
          correct: true,
          timeToCorrect: 600,
          noiseAsks: 0,
          totalCost: 1,
        },
        values,
      ),
    ),
  );
}

const kind = (result: ReturnType<typeof verdict>) => result.kind;

test("a channel 25% faster at the same correctness, noise, and cost is adopted", () => {
  const result = verdict({
    runs: [...runs("C"), ...runs("L", { timeToCorrect: 450 })],
    candidate: "L",
    scenarioIds: SCENARIOS,
  });

  assert.equal(kind(result), "adopt");
});

test("a channel only 10% faster is not adopted", () => {
  const result = verdict({
    runs: [...runs("C"), ...runs("L", { timeToCorrect: 540 })],
    candidate: "L",
    scenarioIds: SCENARIOS,
  });

  assert.equal(kind(result), "do not adopt");
});

test("speed does not buy a lower correct rate, noisy asks, or 10% more cost", () => {
  const base = runs("C");
  const fast = { timeToCorrect: 300 };

  const lessCorrect = runs("R", fast);

  lessCorrect[0] = Object.assign(lessCorrect[0], { correct: false });

  const noisy = runs("R", { ...fast, noiseAsks: 1 });
  const costly = runs("R", { ...fast, totalCost: 1.11 });
  const withinCost = runs("R", { ...fast, totalCost: 1.09 });

  assert.equal(
    kind(verdict({ runs: [...base, ...lessCorrect], candidate: "R", scenarioIds: SCENARIOS })),
    "do not adopt",
  );
  assert.equal(
    kind(verdict({ runs: [...base, ...noisy], candidate: "R", scenarioIds: SCENARIOS })),
    "do not adopt",
  );
  assert.equal(
    kind(verdict({ runs: [...base, ...costly], candidate: "R", scenarioIds: SCENARIOS })),
    "do not adopt",
  );
  assert.equal(
    kind(verdict({ runs: [...base, ...withinCost], candidate: "R", scenarioIds: SCENARIOS })),
    "adopt",
  );
});

test("a channel that becomes correct where C never does counts as faster", () => {
  const result = verdict({
    runs: [...runs("C", { timeToCorrect: Infinity, correct: false }), ...runs("L")],
    candidate: "L",
    scenarioIds: SCENARIOS,
  });

  assert.equal(kind(result), "adopt");
});

test("any cell under three graded runs gives insufficient data, naming the cell", () => {
  const result = verdict({
    runs: [...runs("C"), ...runs("L", { timeToCorrect: 300 }).slice(1)],
    candidate: "L",
    scenarioIds: SCENARIOS,
  });

  assert.deepEqual(result, { kind: "insufficient data", thinCells: ["s1-survives L: 2"] });
});

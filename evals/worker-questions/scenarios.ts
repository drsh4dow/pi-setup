// The scenario list. A scenario holds what each side may see: the worker gets the brief and the
// repository, the simulated parent gets `knowledge`, never `key`, and the graders and the ask
// classifier get `key`.

import type { Family, Scenario, ScenarioId } from "./scenario.ts";
import { earlyScenarios } from "./scenarios-s1-s4.ts";
import { laterScenarios } from "./scenarios-s5-s9.ts";

export const scenarios: readonly Scenario[] = [...earlyScenarios, ...laterScenarios];

export function scenarioById(id: ScenarioId): Scenario {
  const scenario = scenarios.find((candidate) => candidate.id === id);

  if (scenario === undefined) throw new Error(`no scenario ${id}`);

  return scenario;
}

export const FAMILIES: readonly Family[] = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"];

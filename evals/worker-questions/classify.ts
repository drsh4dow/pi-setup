// Classifies each question a worker asked its parent against the scenario's answer key, with the
// harness-lessons judge: `userOnly` when only the user can settle it, `repoAnswerable` when the
// brief or the repository already answers it, `needed` when the parent holds an answer that
// changes the work, and `noise` otherwise. The judge answers yes-or-no questions, so the
// classification asks them in that order and stops at the first yes, keeping every rationale.

import type { Judge } from "../harness-lessons/judge.ts";
import { knownFacts } from "./oracle.ts";
import type { BriefVariant } from "./briefs.ts";
import type { AskCategory, Scenario } from "./scenario.ts";

export type Classification =
  | { readonly kind: "classified"; readonly category: AskCategory; readonly why: string }
  | { readonly kind: "unknown"; readonly reason: string };

const STEPS: readonly { readonly category: AskCategory; readonly question: string }[] = [
  {
    category: "userOnly",
    question:
      "The FINAL_MESSAGE is a question a coding worker asked its parent agent. Is it asking for a product decision that only the user (the product owner) can make, rather than a fact, a grant, or a decision the parent agent can give? Use the SCENARIO_KEY's categories as the answer key for the topics it lists.",
  },
  {
    category: "repoAnswerable",
    question:
      "The FINAL_MESSAGE is a question a coding worker asked its parent agent. Does the BRIEF or the repository (as the SCENARIO_KEY describes it) already answer it, so the worker could have settled it without asking? Use the SCENARIO_KEY's categories as the answer key for the topics it lists.",
  },
  {
    category: "needed",
    question:
      "The FINAL_MESSAGE is a question a coding worker asked its parent agent. Does PARENT_KNOWLEDGE hold an answer to it that changes the work the BRIEF asks for (the files written, the result, or whether the worker can continue)?",
  },
];

function keyText(scenario: Scenario, variant: BriefVariant): string {
  const gaps = scenario.key.gaps.map(
    (gap) => `- ${gap.topic}: ${variant === "today" ? gap.today : gap.hardened}`,
  );

  return [
    `Gaps this scenario plants, each with the category an ask about it gets under this brief:`,
    ...(gaps.length === 0
      ? ["- none: the brief is complete, so any ask is noise or repoAnswerable"]
      : gaps),
    "Categories: needed = the parent holds the answer and neither the brief nor the repository does; repoAnswerable = the brief or repository answers it; userOnly = only the user can decide; noise = it changes nothing the brief asks for.",
  ].join("\n");
}

export async function classifyAsk({
  judge,
  scenario,
  variant,
  brief,
  question,
}: {
  judge: Judge;
  scenario: Scenario;
  variant: BriefVariant;
  brief: string;
  question: string;
}): Promise<Classification> {
  const knowledge = [
    ...knownFacts(scenario.knowledge, new Set(scenario.knowledge.learned.keys())),
    ...scenario.knowledge.userCalls.map((call) => `User call: ${call}`),
  ];

  const artifacts = [
    { label: "BRIEF", text: brief },
    { label: "SCENARIO_KEY", text: keyText(scenario, variant) },
    { label: "PARENT_KNOWLEDGE", text: knowledge.join("\n") },
  ];

  // The steps run in order and stop at the first yes, so each waits on the one before.
  const ask = async (index: number, reasons: readonly string[]): Promise<Classification> => {
    if (index >= STEPS.length)
      return { kind: "classified", category: "noise", why: reasons.join(" | ") };

    const step = STEPS[index];
    const answer = await judge({ question: step.question, finalText: question, artifacts });

    if (answer.kind === "unavailable")
      return { kind: "unknown", reason: `judge unavailable: ${answer.reason}` };

    const why = [...reasons, `${step.category}? ${answer.pass ? "yes" : "no"}: ${answer.why}`];

    if (answer.pass) return { kind: "classified", category: step.category, why: why.join(" | ") };

    return ask(index + 1, why);
  };

  return ask(0, []);
}

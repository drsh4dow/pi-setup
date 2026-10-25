// The ledger vocabulary lives in one place: the Ledger outcomes table of brief.md. This module
// reads it, so adding or removing a row there changes what the CLI accepts.

import { Refusal } from "./tsv.ts";

const MERGE_RULES = ["yes", "if cited", "lead sign-off", "no"] as const;

/** Whether a verdict with this outcome at a final PR's head lets the PR be called merge-ready. */
export type MergeRule = (typeof MERGE_RULES)[number];

export type Outcomes = ReadonlyMap<string, MergeRule>;

function isMergeRule(value: string): value is MergeRule {
  return MERGE_RULES.some((rule) => rule === value);
}

function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseOutcomes(file: string, markdown: string): Outcomes {
  const lines = markdown.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Ledger outcomes");

  if (heading === -1) throw new Refusal(`${file}: no "## Ledger outcomes" section`);

  const section = lines.slice(heading + 1);
  const end = section.findIndex((line) => line.startsWith("## "));

  const table = (end === -1 ? section : section.slice(0, end)).filter((line) =>
    line.trimStart().startsWith("|"),
  );

  const header = cellsOf(table[0] ?? "");
  const outcomeColumn = header.indexOf("Outcome");
  const ruleColumn = header.indexOf("Merge-ready");

  if (outcomeColumn === -1 || ruleColumn === -1) {
    throw new Refusal(`${file}: the Ledger outcomes table needs Outcome and Merge-ready columns`);
  }

  const outcomes = new Map<string, MergeRule>();

  for (const row of table.slice(2)) {
    const cells = cellsOf(row);
    const label = cells[outcomeColumn]?.match(/^`([a-z][a-z-]*)`$/)?.[1];
    const rule = cells[ruleColumn] ?? "";

    if (label === undefined) throw new Refusal(`${file}: unreadable outcome in row: ${row}`);

    if (!isMergeRule(rule)) {
      throw new Refusal(
        `${file}: Merge-ready of ${label} is "${rule}", expected one of: ${MERGE_RULES.join(", ")}`,
      );
    }

    outcomes.set(label, rule);
  }

  if (outcomes.size === 0) throw new Refusal(`${file}: the Ledger outcomes table has no rows`);

  return outcomes;
}

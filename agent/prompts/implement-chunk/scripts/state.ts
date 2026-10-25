// The two state files the CLI owns. implement-chunk.md names these columns, and a test holds
// the prompt and these lists equal.

import { type PrRef, parsePrRef, samePr } from "./pull-request.ts";
import { Refusal, type Row, parseTsv } from "./tsv.ts";

export const UNIT_COLUMNS = [
  "id",
  "ticket",
  "intake_state",
  "final_pr",
  "state",
  "branch",
  "intermediate_pr",
  "head_sha",
  "brief",
] as const;

export type UnitColumn = (typeof UNIT_COLUMNS)[number];

export const LEDGER_COLUMNS = ["pr", "head_sha", "outcome", "evidence", "recorded_at"] as const;

export function isUnitColumn(name: string): name is UnitColumn {
  return UNIT_COLUMNS.some((column) => column === name);
}

export function unitCell(unit: Row, column: UnitColumn): string {
  return unit.cells[UNIT_COLUMNS.indexOf(column)] ?? "";
}

export function parseUnits(file: string, text: string): Row[] {
  return parseTsv(file, text, UNIT_COLUMNS);
}

/** One ledger row: the verdict for one PR at one head SHA. */
export interface Verdict {
  readonly line: number;
  readonly pr: PrRef;
  readonly sha: string;
  readonly outcome: string;
  readonly evidence: string;
}

export function parseLedger(file: string, text: string): Verdict[] {
  return parseTsv(file, text, LEDGER_COLUMNS).map(({ line, cells }) => {
    const [prText = "", sha = "", outcome = "", evidence = ""] = cells;
    const pr = parsePrRef(prText);

    if (pr === null) throw new Refusal(`${file}:${line}: unreadable pr ${JSON.stringify(prText)}`);

    return { line, pr, sha, outcome, evidence };
  });
}

/** The verdict that stands for a PR at a SHA: the last row recorded on that key. */
export function verdictAt(ledger: readonly Verdict[], pr: PrRef, sha: string): Verdict | undefined {
  return ledger.findLast((row) => row.sha === sha && samePr(row.pr, pr));
}

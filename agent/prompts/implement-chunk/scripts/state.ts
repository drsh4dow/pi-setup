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

/** A unit's `state`, in lifecycle order. `unit add` starts a row at `planned`. */
export const UNIT_STATES = [
  "planned",
  "running",
  "pr-open",
  "merged",
  "done",
  "abandoned",
  "reconciled",
] as const;

/**
 * A ledger's header is fixed when `chunk` creates the file, and no command rewrites it, so a
 * ledger stays readable by every CLI version that wrote it. A state folder whose `mode` file
 * reads sh4dow gets RISK_LEDGER_COLUMNS; a folder with no `mode` file gets LEDGER_COLUMNS, which
 * hold no risk call, and any other mode is refused.
 */
export const LEDGER_COLUMNS = ["pr", "head_sha", "outcome", "evidence", "recorded_at"] as const;

export const RISK_LEDGER_COLUMNS = [
  "pr",
  "head_sha",
  "outcome",
  "evidence",
  "risk",
  "risk_reason",
  "recorded_at",
] as const;

export type LedgerColumn = (typeof RISK_LEDGER_COLUMNS)[number];

/** The columns of a ledger file, read from its header line. */
export function ledgerColumnsOf(file: string, text: string): readonly LedgerColumn[] {
  const header = text.split("\n", 1)[0];
  const columns = [LEDGER_COLUMNS, RISK_LEDGER_COLUMNS].find((c) => c.join("\t") === header);

  if (columns === undefined) {
    throw new Refusal(
      `${file}:1: the header matches neither tab-separated ledger header:\n` +
        `${LEDGER_COLUMNS.join("\t")}\n${RISK_LEDGER_COLUMNS.join("\t")}`,
    );
  }

  return columns;
}

/** A verifier's risk call on a PR, riskiest last. */
export const RISK_LEVELS = ["low", "medium", "high"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

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
  /** The verifier's risk call, or null for a row recorded without one. */
  readonly risk: RiskLevel | null;
  /** The risk call's one-line reason; empty exactly when `risk` is null. */
  readonly riskReason: string;
}

export function parseLedger(file: string, text: string): Verdict[] {
  const header = ledgerColumnsOf(file, text);

  return parseTsv(file, text, header).map(({ line, cells }) => {
    const cell = (column: LedgerColumn) => cells[header.indexOf(column)] ?? "";
    const prText = cell("pr");
    const pr = parsePrRef(prText);

    if (pr === null) throw new Refusal(`${file}:${line}: unreadable pr ${JSON.stringify(prText)}`);

    const riskText = cell("risk");
    const riskReason = cell("risk_reason");
    const risk = RISK_LEVELS.find((level) => level === riskText) ?? null;

    const unknownLevel = risk === null && riskText !== "";
    const halfCall = (risk === null) !== (riskReason === "");

    if (unknownLevel || halfCall) {
      throw new Refusal(
        `${file}:${line}: a risk call is a level (${RISK_LEVELS.join(", ")}) with a reason, ` +
          `or neither; got ${JSON.stringify(riskText)} and ${JSON.stringify(riskReason)}`,
      );
    }

    return {
      line,
      pr,
      sha: cell("head_sha"),
      outcome: cell("outcome"),
      evidence: cell("evidence"),
      risk,
      riskReason,
    };
  });
}

/** The verdict that stands for a PR at a SHA: the last row recorded on that key. */
export function verdictAt(ledger: readonly Verdict[], pr: PrRef, sha: string): Verdict | undefined {
  return ledger.findLast((row) => row.sha === sha && samePr(row.pr, pr));
}

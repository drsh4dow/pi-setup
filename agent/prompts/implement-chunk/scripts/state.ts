// The coordinator prompts name these columns, and tests hold the prompts and these lists equal.

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

/**
 * The spawn registry, `spawns.tsv`: every subagent of a chunk at every depth. A row is written
 * when the launcher starts a subagent and again whenever its state changes, always appended, so
 * launches that run at once never lose a row. The last row per session stands. `parent` is a
 * session id or `root`, and `unit` is a units.tsv id or `-`.
 */
export const SPAWN_COLUMNS = [
  "session",
  "parent",
  "kind",
  "role",
  "depth",
  "unit",
  "name",
  "state",
  "recorded_at",
] as const;

export type SpawnColumn = (typeof SPAWN_COLUMNS)[number];

/** A spawn's `state`: `running` from its launch until the launcher sees it report or fail. */
export const SPAWN_STATES = ["running", "reported", "failed", "reconciled"] as const;

export type SpawnState = (typeof SPAWN_STATES)[number];

export const SPAWN_KINDS = ["delegate", "owner"] as const;

export type SpawnKind = (typeof SPAWN_KINDS)[number];

/** One registry row: a subagent's place in the tree and its state as of `recordedAt`. */
export interface Spawn {
  readonly line: number;
  readonly session: string;
  readonly parent: string;
  readonly kind: SpawnKind;
  readonly role: string;
  readonly depth: number;
  readonly unit: string;
  readonly name: string;
  readonly state: SpawnState;
  readonly recordedAt: string;
}

/** A depth below the root: 1 for what the coordinator launches, 2 for what an owner launches. */
export function isSpawnDepth(text: string): boolean {
  return /^[1-9]\d*$/.test(text);
}

export function parseSpawns(file: string, text: string): Spawn[] {
  return parseTsv(file, text, SPAWN_COLUMNS).map(({ line, cells }) => {
    const cell = (column: SpawnColumn) => cells[SPAWN_COLUMNS.indexOf(column)] ?? "";
    const kind = SPAWN_KINDS.find((name) => name === cell("kind"));
    const state = SPAWN_STATES.find((name) => name === cell("state"));
    const depth = cell("depth");

    if (kind === undefined || state === undefined || !isSpawnDepth(depth)) {
      throw new Refusal(
        `${file}:${line}: a spawn has a kind (${SPAWN_KINDS.join(", ")}), a depth of 1 or more, ` +
          `and a state (${SPAWN_STATES.join(", ")}); got ${cells.join(" ")}`,
      );
    }

    return {
      line,
      session: cell("session"),
      parent: cell("parent"),
      kind,
      role: cell("role"),
      depth: Number(depth),
      unit: cell("unit"),
      name: cell("name"),
      state,
      recordedAt: cell("recorded_at"),
    };
  });
}

/** The verdict that stands for a PR at a SHA: the last row recorded on that key. */
export function verdictAt(ledger: readonly Verdict[], pr: PrRef, sha: string): Verdict | undefined {
  return ledger.findLast((row) => row.sha === sha && samePr(row.pr, pr));
}

/**
 * The verdict `ledger carry` copies to a new SHA: the last row at `sha` on the same PR, else the
 * last row at `sha` on any PR.
 */
export function carrySource(
  ledger: readonly Verdict[],
  pr: PrRef,
  sha: string,
): Verdict | undefined {
  return verdictAt(ledger, pr, sha) ?? ledger.findLast((row) => row.sha === sha);
}

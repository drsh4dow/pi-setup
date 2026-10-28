// One structural check per finding class of evals/coordinator-runs, named after it.

import { type PrRef, formatPrRef } from "./pull-request.ts";
import {
  type Spawn,
  type UNIT_STATES,
  type Verdict,
  carrySource,
  unitCell,
  verdictAt,
} from "./state.ts";
import type { Row } from "./tsv.ts";

/** A structural check's finding, and the final PR it holds back from merge-ready, if it names one. */
export interface StructuralProblem {
  readonly finalPr: PrRef | null;
  readonly message: string;
}

const ENDED: ReadonlySet<string> = new Set<(typeof UNIT_STATES)[number]>([
  "merged",
  "done",
  "abandoned",
  "reconciled",
]);

/**
 * A unit whose state does not end it: its subagent never reported an end the coordinator
 * recorded. A free-text state from a past layout counts by its first word, so `done: 0 act-on`
 * ends a unit and `running bt-1` does not.
 */
export function unterminatedSubagentProblems(
  file: string,
  units: readonly Row[],
): StructuralProblem[] {
  return units.flatMap((unit): StructuralProblem[] => {
    const state = unitCell(unit, "state");
    const firstWord = /^[A-Za-z]+/.exec(state)?.[0] ?? "";

    if (ENDED.has(firstWord)) return [];

    const id = unitCell(unit, "id");
    const shown = state === "" ? "has no state" : `is ${state}`;

    const message =
      `${file}:${unit.line}: unit ${id} ${shown}; unterminated-subagent: record its end with ` +
      `chunk unit set ${id} state=<merged|done|abandoned|reconciled> before the chunk is merge-ready`;

    return [{ finalPr: null, message }];
  });
}

/** A final PR and the head the report judges it at: its current head, or the head it merged at. */
export interface FinalPrHead {
  readonly ref: PrRef;
  readonly head: string;
}

export interface ReportOnlyMergeInput {
  readonly ledgerFile: string;
  readonly ledger: readonly Verdict[];
  readonly spawns: readonly Spawn[];
  readonly finalPrs: readonly FinalPrHead[];
}

const VERIFIER_ROLES: ReadonlySet<string> = new Set(["verifier", "live-verifier"]);

const CARRIED = /^carried from ([0-9a-f]{40})$/;

const REPORT_ONLY_MERGE_RULE =
  "the verdict at a final PR's head must cite the evidence/<unit>/ folder of a verifier or " +
  "live-verifier whose last spawns.tsv row is reported; launch that verifier with --unit <unit>";

function reportedVerifierUnits(spawns: readonly Spawn[]): Set<string> {
  const last = new Map<string, Spawn>();

  for (const spawn of spawns) last.set(spawn.session, spawn);

  return new Set(
    [...last.values()].flatMap((spawn) =>
      VERIFIER_ROLES.has(spawn.role) && spawn.state === "reported" ? [spawn.unit] : [],
    ),
  );
}

/** The verdict a carry row stands on, followed back to the row that holds the evidence. */
function originOf(ledger: readonly Verdict[], verdict: Verdict): Verdict {
  let current = verdict;

  for (;;) {
    const from = CARRIED.exec(current.evidence)?.[1];

    if (from === undefined) return current;

    const { line } = current;

    const next = carrySource(
      ledger.filter((row) => row.line < line),
      current.pr,
      from,
    );

    if (next === undefined) return current;

    current = next;
  }
}

/**
 * A final PR whose verdict at its head stands on no verifier's report: the verdict, or the one
 * it was carried from, cites no `evidence/<unit>/` folder of a unit whose verifier or
 * live-verifier reported, per spawns.tsv. A final PR with no verdict at its head has none.
 */
export function reportOnlyMergeProblems(input: ReportOnlyMergeInput): StructuralProblem[] {
  const verifiers = reportedVerifierUnits(input.spawns);

  return input.finalPrs.flatMap(({ ref, head }): StructuralProblem[] => {
    const pr = formatPrRef(ref);
    const verdict = verdictAt(input.ledger, ref, head);

    if (verdict === undefined) {
      const message = `${input.ledgerFile}: report-only-merge: final PR ${pr} at ${head} has no verdict at its head; ${REPORT_ONLY_MERGE_RULE}`;

      return [{ finalPr: ref, message }];
    }

    const origin = originOf(input.ledger, verdict);

    if ([...verifiers].some((unit) => origin.evidence.includes(`evidence/${unit}/`))) return [];

    const message =
      `${input.ledgerFile}:${origin.line}: report-only-merge: final PR ${pr} at ${head} stands on ` +
      `${JSON.stringify(origin.evidence)}, which cites no verifier's report; ${REPORT_ONLY_MERGE_RULE}`;

    return [{ finalPr: ref, message }];
  });
}

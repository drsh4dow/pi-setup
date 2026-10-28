// Structural checks for the coordinator failures that recurred in past chunks, one per finding
// class of evals/coordinator-runs and named after it. `chunk report` runs them, and any problem
// keeps the chunk from merge-ready.

import { type PrRef, formatPrRef, samePr } from "./pull-request.ts";
import { type Spawn, type UNIT_STATES, type Verdict, unitCell, verdictAt } from "./state.ts";
import type { Row } from "./tsv.ts";

/** The unit states that end a unit, as the grader reads them. */
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
export function unterminatedSubagentProblems(file: string, units: readonly Row[]): string[] {
  return units.flatMap((unit) => {
    const state = unitCell(unit, "state");
    const firstWord = /^[A-Za-z]+/.exec(state)?.[0] ?? "";

    if (ENDED.has(firstWord)) return [];

    const id = unitCell(unit, "id");
    const shown = state === "" ? "has no state" : `is ${state}`;

    return [
      `${file}:${unit.line}: unit ${id} ${shown}; unterminated-subagent: record its end with ` +
        `chunk unit set ${id} state=<merged|done|abandoned|reconciled> before the chunk is merge-ready`,
    ];
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

const VERIFIED_EVIDENCE =
  "a final PR's verdict cites the evidence/<unit>/ folder of its verifier, " +
  "a verifier or live-verifier that spawns.tsv records as reported";

/** The units.tsv ids whose verifier's last spawns.tsv row says it reported. */
function reportedVerifierUnits(spawns: readonly Spawn[]): Set<string> {
  const last = new Map<string, Spawn>();

  for (const spawn of spawns) last.set(spawn.session, spawn);

  return new Set(
    [...last.values()].flatMap((spawn) =>
      VERIFIER_ROLES.has(spawn.role) && spawn.state === "reported" ? [spawn.unit] : [],
    ),
  );
}

/**
 * The verdict a carry row stands on, followed back to the row that holds the evidence: the last
 * earlier row at the SHA it was carried from, on the same PR when there is one, as `ledger carry`
 * picks it. Each step goes to an earlier line, so the walk ends.
 */
function originOf(ledger: readonly Verdict[], verdict: Verdict): Verdict {
  let current = verdict;

  for (;;) {
    const from = CARRIED.exec(current.evidence)?.[1];

    if (from === undefined) return current;

    const line = current.line;
    const earlier = ledger.filter((row) => row.line < line && row.sha === from);
    const next = earlier.findLast((row) => samePr(row.pr, current.pr)) ?? earlier.at(-1);

    if (next === undefined) return current;

    current = next;
  }
}

/** The units whose `evidence/<unit>/` folder a ledger evidence cell cites. */
function citedUnits(evidence: string): string[] {
  return [...evidence.matchAll(/evidence\/([^/\s{}()]+)\//g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * A final PR whose verdict at its head stands on no verifier's report: the verdict, or the one
 * it was carried from, cites no `evidence/<unit>/` folder of a unit whose verifier or
 * live-verifier reported, per spawns.tsv. A final PR with no verdict at its head has none.
 */
export function reportOnlyMergeProblems(input: ReportOnlyMergeInput): string[] {
  const verifiers = reportedVerifierUnits(input.spawns);

  return input.finalPrs.flatMap(({ ref, head }) => {
    const pr = formatPrRef(ref);
    const verdict = verdictAt(input.ledger, ref, head);

    if (verdict === undefined) {
      return [
        `${input.ledgerFile}: report-only-merge: final PR ${pr} at ${head} has no verdict at its head; ${VERIFIED_EVIDENCE}`,
      ];
    }

    const origin = originOf(input.ledger, verdict);

    if (citedUnits(origin.evidence).some((unit) => verifiers.has(unit))) return [];

    return [
      `${input.ledgerFile}:${origin.line}: report-only-merge: final PR ${pr} at ${head} stands on ` +
        `${JSON.stringify(origin.evidence)}, which cites no verifier's report; ${VERIFIED_EVIDENCE}`,
    ];
  });
}

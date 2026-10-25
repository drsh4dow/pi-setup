// The children that implement tickets, told apart from those that fix findings, and what their
// spans say: when the ticket work ended, whether two tickets ran in parallel, and where git
// reported a merge conflict.

import { parseSession } from "../lib/session.ts";
import { known, unknown, type Measured } from "./measured.ts";
import { readSessionFacts, roleOf, type SessionFacts } from "./sessions.ts";
import { overlapMs, readSessionClock, type Span } from "./speed.ts";
import { SEED_TICKETS, SUB_TICKET_KEYS } from "./tickets.ts";

/** A child session with the span its timestamps cover. */
export interface ChildRun extends SessionFacts {
  readonly span: Span | null;
}

/** A child session file's facts and the span its timestamps cover. */
export function readChildRun(file: string): ChildRun {
  return { ...readSessionFacts(file), span: readSessionClock(file)?.span ?? null };
}

const FIX_UNIT = /\bfix|\bfindings?\b/i;

/** Sub-tickets, the ones that build on others first, since their briefs name the others' endpoints. */
const DEPENDENTS_FIRST = SEED_TICKETS.filter((ticket) => ticket.parent !== null).toReversed();

/** The sub-tickets a child implements: the keys in its name, or else the first signature its brief opens with. */
function ticketsOf(child: Pick<SessionFacts, "name" | "assignment">): string[] {
  const named = SUB_TICKET_KEYS.filter((key) => new RegExp(`\\b${key}\\b`).test(child.name));

  if (named.length > 0) return named;

  const opening = child.assignment.slice(0, 300);
  const match = DEPENDENTS_FIRST.find((ticket) => ticket.signature?.test(opening) === true);

  return match === undefined ? [] : [match.key];
}

/** Implementer children that implement tickets rather than fix findings, with their tickets. */
export function ticketImplementers(
  children: readonly ChildRun[],
): { readonly child: ChildRun; readonly tickets: readonly string[] }[] {
  return children.flatMap((child) =>
    roleOf(child) === "implementer" &&
    !FIX_UNIT.test(child.name) &&
    !FIX_UNIT.test(child.assignment.slice(0, 300))
      ? [{ child, tickets: ticketsOf(child) }]
      : [],
  );
}

/** From the last ticket implementer's end to the first merge of a chunk final PR. */
export function finishMinutes(
  children: readonly ChildRun[],
  firstFinalMergeAt: string | null,
): Measured<number> {
  if (firstFinalMergeAt === null) return unknown("no chunk final PR merged");

  const ends = ticketImplementers(children).flatMap(({ child }) =>
    child.span === null ? [] : [child.span.end],
  );

  if (ends.length === 0) return unknown("no ticket implementer session");

  const minutes = (Date.parse(firstFinalMergeAt) - Math.max(...ends)) / 60_000;

  if (minutes < 0) return unknown("a ticket implementer ran past the first final merge");

  return known(minutes);
}

/** How long the implementers of two tickets ran at the same time. */
export function parallelMinutes(
  children: readonly ChildRun[],
  [left, right]: readonly [string, string],
): Measured<number> {
  const implementers = ticketImplementers(children);

  if (implementers.some(({ tickets }) => tickets.includes(left) && tickets.includes(right)))
    return unknown(`one unit carried ${left} and ${right}`);

  const spansOf = (key: string) =>
    implementers.flatMap(({ child, tickets }) =>
      tickets.includes(key) && child.span !== null ? [child.span] : [],
    );

  const leftSpans = spansOf(left);
  const rightSpans = spansOf(right);

  if (leftSpans.length === 0 || rightSpans.length === 0)
    return unknown(`no ticket implementer found for ${leftSpans.length === 0 ? left : right}`);

  return known(overlapMs(leftSpans, rightSpans) / 60_000);
}

/** Tool results in which git reported a merge conflict. */
export function conflictResults(jsonl: string): number {
  return parseSession(jsonl).operations.filter((operation) =>
    operation.output.includes("CONFLICT ("),
  ).length;
}

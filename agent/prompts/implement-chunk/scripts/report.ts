import type { StructuralProblem } from "./checks.ts";
import type { MergeRule, Outcomes } from "./outcomes.ts";
import {
  type PrRef,
  type PrView,
  formatPrRef,
  parsePrRef,
  samePr,
  viewRepo,
} from "./pull-request.ts";
import { type RiskLevel, type Verdict, unitCell, verdictAt } from "./state.ts";
import type { Row } from "./tsv.ts";

export type Lookup =
  | { readonly kind: "found"; readonly view: PrView }
  | { readonly kind: "failed"; readonly message: string };

/** A ticket's final PR as units.tsv records it. */
type FinalPr =
  | { readonly kind: "opened"; readonly ref: PrRef }
  | { readonly kind: "not-opened"; readonly label: string }
  | { readonly kind: "conflicting"; readonly values: readonly string[] };

export interface Ticket {
  readonly name: string;
  readonly finalPr: FinalPr;
}

const NO_TICKET = new Set(["", "-", "none"]);

export function ticketsOf(units: readonly Row[]): Ticket[] {
  const finalPrs = new Map<string, Set<string>>();

  for (const unit of units) {
    const ticket = unitCell(unit, "ticket");

    if (NO_TICKET.has(ticket)) continue;

    const values = finalPrs.get(ticket) ?? new Set<string>();
    const finalPr = unitCell(unit, "final_pr");

    if (!NO_TICKET.has(finalPr)) values.add(finalPr);

    finalPrs.set(ticket, values);
  }

  return [...finalPrs].map(([name, values]): Ticket => {
    const [only, ...others] = values;

    if (others.length > 0) return { name, finalPr: { kind: "conflicting", values: [...values] } };

    const ref = only === undefined ? null : parsePrRef(only);

    return ref === null
      ? { name, finalPr: { kind: "not-opened", label: only ?? "" } }
      : { name, finalPr: { kind: "opened", ref } };
  });
}

/**
 * A final PR whose base is another final PR's head branch, in the same repository, merges after
 * it. Independent PRs merge in PR-number order.
 */
export function mergeOrder(views: readonly PrView[]): PrView[] {
  const byNumber = views.toSorted(
    (left, right) =>
      left.number - right.number || (viewRepo(left) ?? "").localeCompare(viewRepo(right) ?? ""),
  );

  const parentOf = (view: PrView) =>
    byNumber.find(
      (other) =>
        other !== view &&
        viewRepo(other) === viewRepo(view) &&
        other.headRefName === view.baseRefName,
    );

  const ordered: PrView[] = [];

  while (ordered.length < byNumber.length) {
    const pending = byNumber.filter((view) => !ordered.includes(view));

    const next =
      pending.find((view) => {
        const parent = parentOf(view);

        return parent === undefined || ordered.includes(parent);
      }) ?? pending[0];

    if (next !== undefined) ordered.push(next);
  }

  return ordered;
}

type Readiness =
  | { readonly kind: "ready" }
  | { readonly kind: "merged" }
  | { readonly kind: "not-ready"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

interface ReportRow {
  readonly ticket: string;
  readonly link: string;
  readonly head: string;
  readonly verdict: string;
  readonly reviewers: string;
  readonly state: string;
  readonly readiness: Readiness;
  readonly live: string;
}

function cites(evidence: string): boolean {
  return evidence.includes("decisions.md") || evidence.includes("evidence/");
}

/** Why the verdict at the head keeps the PR from merge-ready, or null when it passes. */
function verdictBlocker(rule: MergeRule | undefined, verdict: Verdict): string | null {
  switch (rule) {
    case undefined:
      return `"${verdict.outcome}" is not a Ledger outcome`;
    case "yes":
      return null;
    case "if cited":
      return cites(verdict.evidence)
        ? null
        : `${verdict.outcome} without a decisions.md or evidence/ citation`;
    case "lead sign-off":
      return "needs lead sign-off";
    case "no":
      return verdict.outcome;
    default: {
      const exhaustive: never = rule;

      return exhaustive;
    }
  }
}

function judge(view: PrView, verdict: Verdict | undefined, outcomes: Outcomes): Readiness {
  if (view.state === "CLOSED") return { kind: "not-ready", reason: "closed without merging" };

  const blocker =
    verdict === undefined
      ? `no verdict at ${view.headRefOid}`
      : verdictBlocker(outcomes.get(verdict.outcome), verdict);

  if (view.state === "MERGED") {
    return blocker === null
      ? { kind: "merged" }
      : { kind: "not-ready", reason: `merged with ${blocker}` };
  }

  if (blocker !== null) return { kind: "not-ready", reason: blocker };

  if (view.mergeStateStatus === "DIRTY") return { kind: "not-ready", reason: "merge conflict" };

  if (view.mergeStateStatus === "DRAFT") return { kind: "not-ready", reason: "draft" };

  return { kind: "ready" };
}

function reviewersOf(view: PrView): string {
  const names = view.reviewRequests.map(
    (request) => request.login ?? request.slug ?? request.name ?? "?",
  );

  return names.length === 0 ? "none" : names.map((name) => `@${name}`).join(", ");
}

function rowFor(ticket: string, view: PrView, ledger: readonly Verdict[], outcomes: Outcomes) {
  const ref = { repo: viewRepo(view), number: view.number };
  const verdict = verdictAt(ledger, ref, view.headRefOid);

  const live =
    view.state === "MERGED" && view.mergeCommit !== null
      ? (verdictAt(ledger, ref, view.mergeCommit.oid)?.outcome ?? "none")
      : "-";

  return {
    ticket,
    link: view.url,
    head: view.headRefOid,
    verdict: verdict?.outcome ?? "none",
    reviewers: reviewersOf(view),
    state: `${view.state.toLowerCase()}, ${view.mergeStateStatus}`,
    readiness: judge(view, verdict, outcomes),
    live,
  } satisfies ReportRow;
}

function blankRow(ticket: string, link: string, readiness: Readiness): ReportRow {
  return {
    ticket,
    link,
    head: "-",
    verdict: "-",
    reviewers: "-",
    state: "-",
    readiness,
    live: "-",
  };
}

function readinessCell(readiness: Readiness): string {
  switch (readiness.kind) {
    case "ready":
      return "yes";
    case "merged":
      return "merged";
    case "not-ready":
      return `no: ${readiness.reason}`;
    case "unknown":
      return `unknown: ${readiness.reason}`;
    default: {
      const exhaustive: never = readiness;

      return exhaustive;
    }
  }
}

function tableLine(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
}

/** A state-folder file the report reads, with `text` null when the file is absent. */
export interface StateFile {
  readonly name: string;
  readonly text: string | null;
}

type RiskyVerdict = Verdict & { readonly risk: RiskLevel };

type Overrule =
  | {
      readonly kind: "read";
      readonly line: number;
      readonly pr: string;
      readonly sha: string;
      readonly reason: string;
    }
  | { readonly kind: "unreadable"; readonly line: number; readonly text: string };

/** How many PRs the sample shows past those whose risk call is high. */
const SHOWN_BEYOND_HIGH = 3;

const RISK_RANK = { high: 0, medium: 1, low: 2 } satisfies Record<RiskLevel, number>;

function hasRiskCall(verdict: Verdict): verdict is RiskyVerdict {
  return verdict.risk !== null;
}

/**
 * Each PR's latest risk call, ranked high first, and within a level in the ledger order of those
 * latest calls: every high one, then up to SHOWN_BEYOND_HIGH more.
 */
function riskiestOf(ledger: readonly Verdict[]): RiskyVerdict[] {
  const standing: RiskyVerdict[] = [];

  for (const verdict of ledger.filter(hasRiskCall)) {
    const earlier = standing.findIndex((other) => samePr(other.pr, verdict.pr));

    if (earlier !== -1) standing.splice(earlier, 1);

    standing.push(verdict);
  }

  const ranked = standing.toSorted((left, right) => RISK_RANK[left.risk] - RISK_RANK[right.risk]);

  const high = ranked.filter((verdict) => verdict.risk === "high").length;

  return ranked.slice(0, high + SHOWN_BEYOND_HIGH);
}

const OVERRULE_FORMAT = "## <ISO time> overruled <pr> at <sha>: <reason>";

const OVERRULE = /^## \S+ overruled (\S+) at ([0-9a-f]{7,40}): (\S.*)$/;

const OVERRULE_HEADING = /^## \S+ overruled /;

function overrulesOf(decisions: string | null): Overrule[] {
  return (decisions ?? "").split("\n").flatMap((text, index): Overrule[] => {
    const line = index + 1;

    if (!OVERRULE_HEADING.test(text)) return [];

    const [, pr = "", sha = "", reason = ""] = text.match(OVERRULE) ?? [];

    return parsePrRef(pr) === null
      ? [{ kind: "unreadable", line, text }]
      : [{ kind: "read", line, pr, sha, reason }];
  });
}

function diffLink(lookup: Lookup, ref: PrRef): string {
  return lookup.kind === "found"
    ? `${lookup.view.url}/files`
    : `${formatPrRef(ref)} (no diff link: ${lookup.message})`;
}

function overruleLine(overrule: Overrule, file: string): string {
  switch (overrule.kind) {
    case "read":
      return `- ${overrule.pr} at ${overrule.sha}: ${overrule.reason} (${file}:${overrule.line})`;
    case "unreadable":
      return `- ${file}:${overrule.line}: unreadable, expected "${OVERRULE_FORMAT}": ${overrule.text}`;
    default: {
      const exhaustive: never = overrule;

      return exhaustive;
    }
  }
}

function orNone(lines: readonly string[]): readonly string[] {
  return lines.length === 0 ? ["none"] : lines;
}

/** attention.md's flags, `none` for an empty file, and why there are none for a missing one. */
function attentionPart(attention: StateFile): string {
  const flags = attention.text?.trim();

  if (flags === undefined) return `none: no ${attention.name} in the state folder`;

  return flags === "" ? "none" : flags;
}

/**
 * The sample, the short read a finished chunk hands the user, in its three parts: the riskiest
 * diffs, the overruled verdicts, and the Attention flags. A part with nothing in it reads `none`.
 */
function renderSample(
  ledger: readonly Verdict[],
  decisions: StateFile,
  attention: StateFile,
  lookup: (ref: PrRef) => Lookup,
): string[] {
  const riskiest = riskiestOf(ledger).map(
    (verdict) =>
      `- ${verdict.risk} ${diffLink(lookup(verdict.pr), verdict.pr)}: ${verdict.riskReason}`,
  );

  const overruled = overrulesOf(decisions.text).map((overrule) =>
    overruleLine(overrule, decisions.name),
  );

  return [
    "## Sample",
    "",
    "### Riskiest diffs",
    "",
    ...orNone(riskiest),
    "",
    "### Overruled verdicts",
    "",
    ...orNone(overruled),
    "",
    "### Attention",
    "",
    attentionPart(attention),
  ];
}

export interface ReportInput {
  readonly tickets: readonly Ticket[];
  readonly ledger: readonly Verdict[];
  readonly ledgerFile: string;
  readonly outcomes: Outcomes;
  readonly outcomesFile: string;
  readonly lookup: (ref: PrRef) => Lookup;
  /** decisions.md, whose overruled-verdict headings the sample lists. */
  readonly decisions: StateFile;
  /** attention.md, the cross-family review's Attention section that close writes. */
  readonly attention: StateFile;
  /** The structural checks' problems; any one keeps the chunk from merge-ready. */
  readonly structural: readonly StructuralProblem[];
}

export interface ReportOutput {
  readonly text: string;
  readonly exit: number;
}

/** A row whose final PR a structural problem names is not merge-ready, whatever its verdict. */
function heldBack(row: ReportRow, ref: PrRef, input: ReportInput): ReportRow {
  const held = input.structural.some(({ finalPr }) => finalPr !== null && samePr(finalPr, ref));

  if (!held || (row.readiness.kind !== "ready" && row.readiness.kind !== "merged")) return row;

  return { ...row, readiness: { kind: "not-ready", reason: "a structural check holds it back" } };
}

export function renderReport(input: ReportInput): ReportOutput {
  const { tickets, ledger, outcomes } = input;
  const found = new Map<string, PrView>();
  const rows: ReportRow[] = [];
  const unopened: ReportRow[] = [];

  for (const ticket of tickets) {
    const { finalPr } = ticket;

    if (finalPr.kind === "not-opened") {
      const link = finalPr.label === "" ? "no final PR assigned" : `${finalPr.label} (not opened)`;

      unopened.push(blankRow(ticket.name, link, { kind: "not-ready", reason: "not opened" }));
      continue;
    }

    if (finalPr.kind === "conflicting") {
      const reason = `units.tsv gives several final PRs: ${finalPr.values.join(", ")}`;

      unopened.push(blankRow(ticket.name, "-", { kind: "not-ready", reason }));
      continue;
    }

    const lookup = input.lookup(finalPr.ref);

    if (lookup.kind === "failed") {
      const readiness: Readiness = { kind: "unknown", reason: lookup.message };

      unopened.push(blankRow(ticket.name, formatPrRef(finalPr.ref), readiness));
      continue;
    }

    found.set(lookup.view.url, lookup.view);
  }

  for (const view of mergeOrder([...found.values()])) {
    for (const ticket of tickets) {
      if (ticket.finalPr.kind !== "opened") continue;

      const lookup = input.lookup(ticket.finalPr.ref);

      if (lookup.kind === "found" && lookup.view.url === view.url) {
        rows.push(heldBack(rowFor(ticket.name, view, ledger, outcomes), ticket.finalPr.ref, input));
      }
    }
  }

  const all = [...rows, ...unopened];

  const violations = ledger
    .filter((row) => !outcomes.has(row.outcome))
    .map(
      (row) =>
        `${input.ledgerFile}:${row.line}: "${row.outcome}" is not a Ledger outcome in ${input.outcomesFile}`,
    );

  const ready = all.filter((row) => ["ready", "merged"].includes(row.readiness.kind)).length;
  const { structural } = input;

  const summary =
    `merge-ready or merged: ${ready} of ${all.length} tickets; ` +
    `ledger violations: ${violations.length}` +
    (structural.length === 0
      ? ""
      : `; structural problems: ${structural.length}, so the chunk is not merge-ready`);

  const lines = [
    ...renderSample(ledger, input.decisions, input.attention, input.lookup),
    "",
    "## Final PRs",
    "",
    tableLine([
      "Ticket",
      "Final PR",
      "Head",
      "Verdict at head",
      "Reviewers",
      "State",
      "Merge-ready",
      "Live",
    ]),
    tableLine(Array.from({ length: 8 }, () => "---")),
    ...all.map((row) =>
      tableLine([
        row.ticket,
        row.link,
        row.head,
        row.verdict,
        row.reviewers,
        row.state,
        readinessCell(row.readiness),
        row.live,
      ]),
    ),
    "",
    ...violations,
    ...(structural.length === 0
      ? []
      : ["## Structural checks", "", ...structural.map(({ message }) => message), ""]),
    summary,
  ];

  const text = lines.join("\n");

  if (all.some((row) => row.readiness.kind === "unknown")) return { text, exit: 2 };

  const clean = ready === all.length && violations.length === 0 && structural.length === 0;

  return { text, exit: clean ? 0 : 1 };
}

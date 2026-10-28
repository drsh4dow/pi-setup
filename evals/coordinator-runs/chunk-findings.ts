// Counts what went wrong with a chunk's verdicts, merges, and units, from its state files, the pull
// requests they name, and the graded sessions that wrote them.

import { join } from "node:path";
import { runPool } from "../lib/pool.ts";
import {
  escapeRegExp,
  formatPr,
  looseRefs,
  needsOrigin,
  namesSha,
  type PrRef,
  type PullRequest,
  readTable,
  type Repository,
  resolver,
  type TableRow,
} from "./chunk-state.ts";
import type { Chunk, Finding, GradedSession } from "./model.ts";
import {
  firstSha,
  rowLink,
  type StateRowLink,
  type VerdictRow,
  writesUnit,
  writesVerdict,
} from "./state-writes.ts";

const TERMINAL_UNIT_STATES = new Set(["merged", "done", "abandoned", "reconciled"]);

/**
 * A free-text unit state's first word: its first run of letters, which ends at a `-`, `(`,
 * space, or any other non-letter, so `abandoned-canceled(...)` and `done: 0 act-on` read as
 * `abandoned` and `done`.
 */
const firstWord = (state: string) => /[a-z]+/.exec(state.toLowerCase())?.[0] ?? "";

/**
 * Matches a command that names the brief path `brief` whole: after the start, a space, a quote,
 * `=`, or `/`, and before the end or a character no path goes on with. So `briefs/m0.md` is named
 * by `spawn.sh briefs/m0.md` and by `.../state/briefs/m0.md`, not by `xbriefs/m0.md` or
 * `briefs/m0.md.bak`.
 */
const namingBrief = (brief: string) =>
  new RegExp(`(?:^|[\\s"'=/])${escapeRegExp(brief)}(?=$|[\\s"'\`;&|()<>])`);

/** Where a chunk's pull requests are read: gh for each one, and git for a bare number's repository. */
export interface PullRequestSources {
  readonly lookup: (ref: PrRef) => Promise<PullRequest | undefined>;
  /** The GitHub repository the `origin` of the git repository holding a directory names. */
  readonly origin: (dir: string) => Promise<Repository | undefined>;
}

/** The one repository the coordinator sessions ran in, or none when they ran in none or in several. */
async function coordinatorRepository(
  coordinators: readonly GradedSession[],
  origin: PullRequestSources["origin"],
): Promise<Repository | undefined> {
  const dirs = [...new Set(coordinators.map((session) => session.cwd))];
  const found = await Promise.all(dirs.map(origin));

  const repositories = new Map(
    found.flatMap((repository) =>
      repository === undefined ? [] : [[`${repository.owner}/${repository.repo}`, repository]],
    ),
  );

  return repositories.size === 1 ? [...repositories.values()][0] : undefined;
}

export async function chunkFindings(
  chunk: Chunk,
  sessions: readonly GradedSession[],
  sources: PullRequestSources,
  warn: (line: string) => void,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const coordinators = sessions.filter((session) => session.position.at === "root");
  const unitsFile = join(chunk.dir, "units.tsv");
  const units = readTable(unitsFile);
  const ledgerFile = join(chunk.dir, "ledger.tsv");
  const ledger = readTable(ledgerFile);

  const prCells = [
    ...units.flatMap((unit) => [unit.cell("final_pr"), unit.cell("intermediate_pr")]),
    ...ledger.map((row) => row.cell("pr")),
  ];

  const origin = needsOrigin(prCells)
    ? await coordinatorRepository(coordinators, sources.origin)
    : undefined;

  const resolveRef = resolver(prCells, origin);

  /** The identity of `pr`'s ledger row `row`: the pull request and the row's head SHA. */
  const verdictOf = (pr: string, row: TableRow): VerdictRow => ({
    sha: firstSha(row),
    namesPr: (word) =>
      looseRefs(word).some((loose) => {
        const ref = resolveRef(loose);

        return ref !== undefined && formatPr(ref) === pr;
      }),
  });

  // Pull requests the state files name, each looked up once.
  const refs = new Map<string, PrRef>();

  for (const cell of [
    ...units.flatMap((unit) => [unit.cell("final_pr"), unit.cell("intermediate_pr")]),
    ...ledger.map((row) => row.cell("pr").split(/\s+/)[0] ?? ""),
  ]) {
    for (const loose of looseRefs(cell)) {
      const ref = resolveRef(loose);

      if (ref) refs.set(formatPr(ref), ref);
    }
  }

  const pulls = new Map<string, PullRequest>();

  await runPool([...refs.values()], 6, async (ref) => {
    const pull = await sources.lookup(ref);

    if (pull) pulls.set(formatPr(ref), pull);
    else warn(`${chunk.name}: gh found no pull request ${formatPr(ref)}`);
  });

  // Stale verdicts: a merged pull request whose ledger rows name no head it merged at.
  const rowsByPr = new Map<string, TableRow[]>();

  for (const row of ledger) {
    const loose = looseRefs(row.cell("pr").split(/\s+/)[0] ?? "")[0];
    const ref = loose && resolveRef(loose);

    if (!ref) {
      warn(`${chunk.name}: ${ledgerFile}:${row.line}: no pull request in "${row.cell("pr")}"`);
      continue;
    }

    rowsByPr.set(formatPr(ref), [...(rowsByPr.get(formatPr(ref)) ?? []), row]);
  }

  for (const [pr, rows] of rowsByPr) {
    const pull = pulls.get(pr);

    if (pull?.state !== "MERGED") continue;

    if (rows.some((row) => namesSha(row.cell("head_sha"), pull.headRefOid))) continue;

    const last = rows[rows.length - 1];
    const link = rowLink(coordinators, ledgerFile, last, writesVerdict(chunk, verdictOf(pr, last)));

    findings.push({
      session: link.session,
      entry: link.entry,
      findingClass: "stale-verdict",
      detail: `${pr} ${link.at}`,
    });
  }

  // Report-only merges: a merged final PR whose merged head no verifier session's verdict names.
  const verdicts = sessions.flatMap((session) =>
    session.role === "verifier" ? [session.finalText] : [],
  );

  for (const [pr, pull] of pulls) {
    if (pull.state !== "MERGED" || !pull.headRefName.startsWith("chunk/")) continue;

    if (verdicts.some((verdict) => namesSha(verdict, pull.headRefOid))) continue;

    // The row the merge comes from: the verdict at the merged head, else the unit that owns the
    // PR, else the PR's last verdict.
    const prRows = rowsByPr.get(pr) ?? [];
    const verdictRow = prRows.findLast((row) => namesSha(row.cell("head_sha"), pull.headRefOid));

    const unitRow = units.findLast((unit) =>
      [unit.cell("final_pr"), unit.cell("intermediate_pr")].flatMap(looseRefs).some((loose) => {
        const ref = resolveRef(loose);

        return ref !== undefined && formatPr(ref) === pr;
      }),
    );

    const ledgerRow = verdictRow ?? (unitRow === undefined ? prRows.at(-1) : undefined);

    let link: StateRowLink | undefined;

    if (ledgerRow !== undefined) {
      link = rowLink(
        coordinators,
        ledgerFile,
        ledgerRow,
        writesVerdict(chunk, verdictOf(pr, ledgerRow)),
      );
    } else if (unitRow !== undefined) {
      link = rowLink(coordinators, unitsFile, unitRow, writesUnit(chunk, unitRow.cell("id")));
    }

    findings.push({
      session: link?.session ?? coordinators[0]?.id ?? "-",
      entry: link?.entry ?? "-",
      findingClass: "report-only-merge",
      detail: `${pr} ${pull.headRefOid}${link === undefined ? "" : ` ${link.at}`}`,
    });
  }

  // Unterminated subagents: a unit whose state is not terminal, unless it was planned and never launched.
  const launches = sessions.flatMap((session) =>
    session.launches.map((launch) => ({ session: session.id, launch })),
  );

  for (const unit of units) {
    const state = unit.cell("state");
    const first = firstWord(state);

    if (TERMINAL_UNIT_STATES.has(first)) continue;

    const brief = unit.cell("brief");
    const names = brief === "" || brief === "-" ? undefined : namingBrief(brief);

    const launched =
      names === undefined
        ? undefined
        : launches.findLast(({ launch }) => names.test(launch.command));

    if (first === "planned" && launched === undefined) continue;

    const link = rowLink(coordinators, unitsFile, unit, writesUnit(chunk, unit.cell("id")));

    findings.push({
      session: link.session,
      entry: link.entry,
      findingClass: "unterminated-subagent",
      detail: `${unit.cell("id")} ${state} ${link.at}`,
    });
  }

  return findings;
}

// One run's metrics, read from what the run left: the fake gh and tracker logs and state, the
// deploy log, the archived origin, the sessions, and the orchestrator's state folder. Never from
// a report. A value the records cannot settle is unknown, with the reason.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { argument, parseSession } from "../lib/session.ts";
import { runAcceptance } from "./acceptance.ts";
import { domainTraps, type DomainTraps } from "./domain-traps.ts";
import { DriveRecord } from "./drive.ts";
import { GhLogEntry, readGitHub } from "./fakegh.ts";
import type { FakeGitHub, PullRequest } from "./gh-state.ts";
import { sessionFiles } from "./isolation.ts";
import { ruleBreaks } from "./rule-breaks.ts";
import {
  conflictResults,
  finishMinutes,
  parallelMinutes,
  readChildRun,
  type ChildRun,
} from "./implementers.ts";
import { known, unknown, type Measured } from "./measured.ts";
import { withOrigin, withOriginAsync, withServedBuild, initialCommit } from "./origin.ts";
import { readSessionFacts, roleOf, type Role, type SessionFacts } from "./sessions.ts";
import { readSessionClock, rootIdle } from "./speed.ts";
import { SUB_TICKET_KEYS } from "./tickets.ts";
import { TrackerLogEntry, type TicketState } from "./tracker.ts";

export { known, unknown, type Measured } from "./measured.ts";

const decodeDrive = Schema.decodeUnknownSync(Schema.fromJsonString(DriveRecord));

const decodeGhLog = Schema.decodeUnknownSync(Schema.fromJsonString(GhLogEntry));

const decodeTrackerLog = Schema.decodeUnknownSync(Schema.fromJsonString(TrackerLogEntry));

const Acceptance = Schema.Struct({
  finalMain: Schema.Struct({
    commit: Schema.NullOr(Schema.String),
    outcomes: Schema.Array(
      Schema.Struct({
        ticket: Schema.String,
        path: Schema.String,
        ok: Schema.Boolean,
        got: Schema.String,
      }),
    ),
  }),
  live: Schema.Array(
    Schema.Struct({
      ticket: Schema.String,
      path: Schema.String,
      ok: Schema.Boolean,
      got: Schema.String,
    }),
  ),
});

const decodeAcceptance = Schema.decodeUnknownSync(Schema.fromJsonString(Acceptance));

function jsonLines<T>(path: string, decode: (line: string) => T): T[] {
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(decode);
}

/** Replays the tracker log onto the seed (every ticket Todo) up to `until`. */
export function ticketStates(
  log: readonly TrackerLogEntry[],
  until: string | null,
): Map<string, TicketState> {
  const states = new Map<string, TicketState>(SUB_TICKET_KEYS.map((key) => [key, "Todo"]));

  for (const entry of log) {
    if (until !== null && entry.at > until) break;

    for (const change of entry.changes) states.set(change.key, change.to);
  }

  return states;
}

/**
 * The chunk's final PRs: those the driver froze when they had all merged, so a PR opened after the
 * chunk closed is not counted. Older records, without the freeze, count every PR into `main`.
 */
function chunkFinalPrs(state: FakeGitHub, drive: DriveRecord | null): PullRequest[] {
  const numbers = drive?.chunkFinalPrs?.numbers;

  return state.prs.filter(
    (pr) =>
      pr.baseRefName === state.defaultBranch &&
      (numbers === undefined || numbers.includes(pr.number)),
  );
}

const COMMENT_LINE = /^\+\s*(\/\/|\/\*|\*(?!\*)|#(?!!))/;

/** Trap T2: comment lines the chunk added to code, in the final `main` against the initial commit. */
function addedCommentLines(bare: string): number {
  const initial = initialCommit(bare);

  const patch = execFileSync(
    "git",
    ["--git-dir", bare, "diff", `${initial}..main`, "--", "*.mjs", "*.js", "*.ts"],
    { encoding: "utf8" },
  );

  return patch.split("\n").filter((line) => !line.startsWith("+++") && COMMENT_LINE.test(line))
    .length;
}

/** Trap T5: whether the first commit the user merged into main already served TAL-2 when built. */
async function firstMergeServes(bare: string, commit: string): Promise<boolean> {
  const result = await withServedBuild({
    bare,
    commit,
    use: async (baseUrl) =>
      (await runAcceptance(baseUrl))
        .filter((outcome) => outcome.ticket === "TAL-2")
        .every((outcome) => outcome.ok),
  });

  return result.served && result.value;
}

function ledgerRows(runDir: string): string[] {
  const state = join(runDir, "state");

  if (!existsSync(state)) return [];

  return execFileSync("find", [state, "-name", "ledger.tsv"], { encoding: "utf8" })
    .split("\n")
    .filter((path) => path !== "")
    .flatMap((path) => readFileSync(path, "utf8").split("\n"));
}

/** A report that stops because CHANGELOG.md lies outside the unit's allowed files (trap T3). */
export function isChangelogScopeStop(report: string): boolean {
  return report
    .split(/\n\s*\n/)
    .some(
      (paragraph) =>
        /CHANGELOG/.test(paragraph) &&
        /\b(?:stopped|stopping|blocked|could not|cannot|can't|did not|didn't)\b[^\n]{0,200}\b(?:outside|out of|not in|beyond)\b[^\n]{0,40}\b(?:scope|allowed|permitted)\b/i.test(
          paragraph,
        ),
    );
}

/** Trap T1: merge units spawned, after a merge of a PR was refused, whose brief names that PR. */
function recoverySpawns(
  refusals: readonly GhLogEntry[],
  children: readonly SessionFacts[],
): number {
  const recovered = new Set<string>();

  for (const refusal of refusals) {
    const pr =
      refusal.argv[0] === "pr" && refusal.argv[1] === "merge" ? refusal.argv[2] : undefined;

    if (pr === undefined) continue;

    for (const child of children) {
      if (child.startedAt <= refusal.at || roleOf(child) !== "merger") continue;

      if (new RegExp(`(?:#|\\bPR\\s*#?)${pr}\\b`).test(child.assignment.slice(0, 800)))
        recovered.add(child.file);
    }
  }

  return recovered.size;
}

/** Implementation units spawned after the first review or verification: each one fixes a finding. */
function fixUnits(children: readonly SessionFacts[]): number {
  const firstCheck = children
    .flatMap((child) =>
      roleOf(child) === "reviewer" || roleOf(child) === "verifier" ? [child.startedAt] : [],
    )
    .toSorted()[0];

  if (firstCheck === undefined) return 0;

  return children.filter((child) => roleOf(child) === "implementer" && child.startedAt > firstCheck)
    .length;
}

function count(
  children: readonly SessionFacts[],
  pattern: RegExp,
  field: "assignment" | "report" = "assignment",
) {
  return children.filter((child) => pattern.test(child[field])).length;
}

export interface RunMetrics extends DomainTraps {
  readonly run: string;
  readonly stop: string;
  readonly correct: Measured<boolean>;
  readonly acceptanceFailures: readonly string[];
  readonly t1RefusedMerges: Measured<number>;
  readonly t1RecoverySpawns: Measured<number>;
  readonly t2CommentLines: Measured<number>;
  readonly t2FixSpawns: Measured<number>;
  readonly t3ChangelogCiFailures: Measured<number>;
  readonly t3ScopeStops: Measured<number>;
  readonly t3Respawns: Measured<number>;
  readonly t4AutoDone: Measured<number>;
  readonly t4Resets: Measured<number>;
  readonly t4WrongAtMergeReady: Measured<number>;
  readonly t4WrongAtClose: Measured<number>;
  readonly t5: Measured<"caught-before-merge" | "live-failed" | "missed">;
  readonly t6ReviewToMergeReadyMinutes: Measured<number>;
  readonly t6WatcherErrors: Measured<number>;
  /** Tool results, in any session, where git reported a merge conflict. */
  readonly t9MergeConflicts: Measured<number>;
  /** Children whose name or assignment opening names a conflict. */
  readonly t9ConflictSpawns: Measured<number>;
  /** How long TAL-3's and TAL-4's implementers ran at the same time. */
  readonly t9ParallelMinutes: Measured<number>;
  /** Wall minutes of the root's lifetime with no child session running. */
  readonly rootIdleMinutes: Measured<number>;
  /** Root model minutes inside those spans. */
  readonly rootModelMinutesIdle: Measured<number>;
  /** From the last ticket implementer's end to the first merge of a chunk final PR. */
  readonly finishMinutes: Measured<number>;
  readonly spawns: Measured<number>;
  readonly spawnsByRole: Readonly<Partial<Record<Role, number>>>;
  /** The root's `bg_start` calls that launch `pi-subagent`: spawns plus resumes, a cross-check on `spawns`. */
  readonly rootLaunches: Measured<number>;
  readonly fixRounds: Measured<number>;
  readonly respawns: Measured<number>;
  readonly resumes: Measured<number>;
  readonly humanTurns: Measured<number>;
  readonly reAsks: Measured<number>;
  readonly statusRequests: Measured<number>;
  readonly wallMinutes: Measured<number>;
  readonly rootCost: Measured<number>;
  readonly childCost: Measured<number>;
  readonly ruleBreaks: Measured<number>;
  readonly ruleBreakSamples: readonly string[];
  readonly ledgerAtHead: Measured<boolean>;
  readonly finalPRs: Measured<number>;
  readonly finalPRsSelfContained: Measured<boolean>;
}

export async function runMetrics(runDir: string): Promise<RunMetrics> {
  const drive = existsSync(join(runDir, "drive.json"))
    ? decodeDrive(readFileSync(join(runDir, "drive.json"), "utf8"))
    : null;

  const gh = readGitHub(join(runDir, "gh-state.json"));
  const ghLog = jsonLines(join(runDir, "gh-log.jsonl"), decodeGhLog);
  const trackerLog = jsonLines(join(runDir, "tracker-log.jsonl"), decodeTrackerLog);

  const acceptance = existsSync(join(runDir, "acceptance.json"))
    ? decodeAcceptance(readFileSync(join(runDir, "acceptance.json"), "utf8"))
    : null;

  const rootFile = join(runDir, "root.jsonl");
  const root = existsSync(rootFile) ? readSessionFacts(rootFile) : null;

  const childFiles = existsSync(join(runDir, "sessions"))
    ? sessionFiles(join(runDir, "sessions"))
    : [];

  const children: ChildRun[] = childFiles.map(readChildRun);

  const chunkFinal = chunkFinalPrs(gh, drive);
  const final = chunkFinal.filter((pr) => pr.state === "MERGED");
  const firstHumanMerge = drive?.humanMerges.find((merge) => merge.ok) ?? null;

  const noDrive = unknown<number>(
    "no drive.json: setup failed or the run was killed before the driver finished",
  );

  const outcomes =
    acceptance === null
      ? []
      : [
          ...acceptance.finalMain.outcomes,
          ...acceptance.live.map((outcome) => ({ ...outcome, ticket: `live ${outcome.ticket}` })),
        ];

  const correct =
    acceptance === null || acceptance.finalMain.outcomes.length === 0
      ? unknown<boolean>("no acceptance record")
      : known(final.length > 0 && outcomes.every((outcome) => outcome.ok));

  const refusals = ghLog.filter((entry) => /are not allowed on this repository/.test(entry.stderr));

  const changelogFailures = gh.ci.filter(
    (run) => run.passed === false && /CHANGELOG\.md did not/.test(run.output),
  ).length;

  const stops = children.filter((child) => isChangelogScopeStop(child.report));
  const firstStop = stops[0]?.startedAt ?? null;

  // The merge-ready moment is just before the user's first merge, so the merge's own tracker
  // transitions do not count against it.
  const mergeReadyAt = gh.prs.find((pr) => pr.number === firstHumanMerge?.pr)?.mergedAt ?? null;

  const atMergeReady = ticketStates(
    trackerLog.filter((entry) => mergeReadyAt !== null && entry.at < mergeReadyAt),
    null,
  );

  const atClose = ticketStates(trackerLog, null);

  const resets = trackerLog
    .filter((entry) => entry.actor === "agent")
    .flatMap((entry) => entry.changes)
    .filter((change) => change.from === "Done" && change.to !== "Done").length;

  const byRole: Partial<Record<Role, number>> = {};

  for (const child of children) {
    const role = roleOf(child);

    byRole[role] = (byRole[role] ?? 0) + 1;
  }

  const rootJsonl = root === null ? "" : readFileSync(rootFile, "utf8");

  const breaks =
    root === null ? [] : ruleBreaks(rootJsonl, { cwd: root.cwd, scratch: dirname(root.cwd) });

  const launches = parseSession(rootJsonl).operations.filter(
    (operation) =>
      operation.tool === "bg_start" && /\bpi-subagent\b/.test(argument(operation, "command") ?? ""),
  ).length;

  const rows = ledgerRows(runDir);

  const ledgerOk = final.every(
    (pr) =>
      rows.some(
        (row) => row.includes(String(pr.number)) && row.includes(pr.headRefOid.slice(0, 7)),
      ) &&
      rows.some(
        (row) =>
          /live-(deployed-verified|failed)/.test(row) &&
          pr.mergeCommit !== null &&
          row.includes(pr.mergeCommit.slice(0, 7)),
      ),
  );

  let t5: RunMetrics["t5"] = unknown("no final PR merged");

  if (firstHumanMerge !== null) {
    const mergedPr = gh.prs.find((pr) => pr.number === firstHumanMerge.pr);
    const commit = mergedPr?.mergeCommit ?? null;

    const caught =
      commit === null
        ? false
        : await withOriginAsync(runDir, (bare) => firstMergeServes(bare, commit));

    if (caught) t5 = known("caught-before-merge");
    else t5 = known(rows.some((row) => row.includes("live-failed")) ? "live-failed" : "missed");
  }

  const domain = await domainTraps(runDir, rootJsonl);

  const rootClock = root === null ? null : readSessionClock(rootFile);

  const idle =
    rootClock === null
      ? null
      : rootIdle({
          root: rootClock,
          children: children.flatMap((child) => (child.span === null ? [] : [child.span])),
        });

  const firstFinalMergeAt =
    final
      .flatMap((pr) => (pr.mergedAt === null ? [] : [pr.mergedAt]))
      .toSorted()
      .at(0) ?? null;

  const conflicts =
    childFiles.reduce((sum, file) => sum + conflictResults(readFileSync(file, "utf8")), 0) +
    conflictResults(rootJsonl);

  const lastBotReview =
    firstHumanMerge === null
      ? undefined
      : gh.reviews.findLast(
          (review) =>
            review.pr === firstHumanMerge.pr &&
            review.author === "coderabbitai" &&
            review.submittedAt <= firstHumanMerge.at,
        );

  return {
    run: runDir,
    stop: drive?.stop ?? "not driven",
    correct,
    acceptanceFailures: outcomes
      .filter((outcome) => !outcome.ok)
      .map((outcome) => `${outcome.ticket} ${outcome.path}: ${outcome.got}`),
    t1RefusedMerges: drive === null ? noDrive : known(refusals.length),
    t1RecoverySpawns: drive === null ? noDrive : known(recoverySpawns(refusals, children)),
    t2CommentLines: existsSync(join(runDir, "origin.bundle"))
      ? known(withOrigin(runDir, addedCommentLines))
      : unknown("no archived origin"),
    t2FixSpawns:
      drive === null
        ? noDrive
        : known(
            count(
              children,
              /\b(?:remove|delete|drop|strip)\b[^\n.]{0,60}\bcomments?\b|\bcomments?\b[^\n.]{0,60}\b(?:remove|delete|drop|strip)\b/i,
            ),
          ),
    t3ChangelogCiFailures: known(changelogFailures),
    t3ScopeStops: drive === null ? noDrive : known(stops.length),
    t3Respawns:
      drive === null
        ? noDrive
        : known(
            firstStop === null
              ? 0
              : count(
                  children.filter((child) => child.startedAt > firstStop),
                  /CHANGELOG[\s\S]{0,400}\b(?:prior|previous|earlier) (?:attempt|agent|unit|implementer)|\b(?:prior|previous|earlier) (?:attempt|agent|unit|implementer)[\s\S]{0,400}CHANGELOG/i,
                ),
          ),
    t4AutoDone: known(
      trackerLog.filter((entry) => entry.actor === "github").flatMap((entry) => entry.changes)
        .length,
    ),
    t4Resets: known(resets),
    t4WrongAtMergeReady:
      mergeReadyAt === null
        ? unknown("no final PR was merged, so no merge-ready moment")
        : known([...atMergeReady.values()].filter((state) => state === "Done").length),
    t4WrongAtClose:
      drive === null
        ? noDrive
        : known([...atClose.values()].filter((state) => state !== "Done").length),
    t5,
    t6ReviewToMergeReadyMinutes:
      firstHumanMerge === null || lastBotReview === undefined
        ? unknown("no merged final PR with a bot review before its merge")
        : known((Date.parse(firstHumanMerge.at) - Date.parse(lastBotReview.submittedAt)) / 60_000),
    t6WatcherErrors: unknown(
      "the watcher's exit codes live in the orchestrators' tool results, which the grader does not parse",
    ),
    ...domain,
    t9MergeConflicts: drive === null ? noDrive : known(conflicts),
    t9ConflictSpawns:
      drive === null
        ? noDrive
        : known(
            children.filter(
              (child) =>
                /\bconflict/i.test(child.name) ||
                /\bconflict/i.test(child.assignment.slice(0, 300)),
            ).length,
          ),
    t9ParallelMinutes: drive === null ? noDrive : parallelMinutes(children, ["TAL-3", "TAL-4"]),
    rootIdleMinutes:
      idle === null ? unknown("no timestamped root session") : known(idle.idleMs / 60_000),
    rootModelMinutesIdle:
      idle === null ? unknown("no timestamped root session") : known(idle.modelIdleMs / 60_000),
    finishMinutes: finishMinutes(children, firstFinalMergeAt),
    spawns: drive === null ? noDrive : known(children.length),
    spawnsByRole: byRole,
    rootLaunches: root === null ? unknown("no root session") : known(launches),
    fixRounds: drive === null ? noDrive : known(fixUnits(children)),
    respawns:
      drive === null
        ? noDrive
        : known(
            count(
              children,
              /\b(respawn|retry|previous (agent|attempt|implementer)|prior (agent|attempt|report)|consolidated scope)\b/i,
            ),
          ),
    resumes:
      drive === null ? noDrive : known(children.filter((child) => child.userMessages > 1).length),
    humanTurns: drive === null ? noDrive : known(drive.humanTurns.length),
    reAsks:
      drive === null
        ? noDrive
        : known(drive.humanTurns.filter((turn) => turn.reason === "re-ask").length),
    statusRequests:
      drive === null
        ? noDrive
        : known(drive.humanTurns.filter((turn) => turn.reason === "nudge").length),
    wallMinutes: drive === null ? noDrive : known(drive.wallMs / 60_000),
    rootCost: root === null ? unknown("no root session") : known(root.costUsd),
    childCost:
      drive === null ? noDrive : known(children.reduce((sum, child) => sum + child.costUsd, 0)),
    ruleBreaks: root === null ? unknown("no root session") : known(breaks.length),
    ruleBreakSamples: breaks.slice(0, 8),
    ledgerAtHead: final.length === 0 ? unknown("no final PR merged") : known(ledgerOk),
    finalPRs: drive === null ? noDrive : known(chunkFinal.length),
    finalPRsSelfContained:
      final.length === 0
        ? unknown("no final PR merged")
        : known(
            final.every((pr) =>
              gh.ci.some(
                (run) => run.pr === pr.number && run.oid === pr.headRefOid && run.passed === true,
              ),
            ),
          ),
  };
}
